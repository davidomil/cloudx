import { randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, linkSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const MAX_PENDING = 32;
const MAX_PAGES = 1000;
const MAX_LISTINGS = 32;

/** CloudX workspace ownership is independent of Codex's Git worktree grouping. */
export class CodexWorkspaceScope {
  constructor(binding) {
    if (!binding || typeof binding.cwd !== "string" || !path.isAbsolute(binding.cwd) ||
        typeof binding.provenanceDirectory !== "string" || !path.isAbsolute(binding.provenanceDirectory) ||
        binding.workspaceId !== undefined && (typeof binding.workspaceId !== "string" || !binding.workspaceId) ||
        ![binding.all, binding.includeNonInteractive, binding.owned].every(value => typeof value === "boolean"))
      throw new Error("Invalid Codex workspace scope.");
    this.binding = binding;
    this.cwd = realpathSync(binding.cwd);
    this.pending = new Map();
    this.listings = new Map();
  }

  recordSelection(identity, { created = false } = {}) {
    if (identity.authority !== "selected" || !created && !this.binding.owned || !this.binding.workspaceId) return;
    const target = this.provenancePath(identity.sessionId);
    if (this.readOwnership(identity.sessionId)) return;
    const value = { version: 1, sessionId: identity.sessionId, workspaceId: this.binding.workspaceId,
      cwd: realpathSync(identity.cwd), owned: this.binding.owned };
    const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    const file = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(file, JSON.stringify(value));
      fsyncSync(file);
    } finally { closeSync(file); }
    try {
      // Linking publishes a complete record without replacing original ownership.
      try { linkSync(temporary, target); }
      catch (error) { if (error.code !== "EEXIST") throw error; this.readOwnership(identity.sessionId); }
      const directory = openSync(this.binding.provenanceDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { unlinkSync(temporary); }
  }

  fromClient(message) {
    if (message.method !== "thread/list") return;
    if (message.id == null || this.pending.has(message.id) || this.pending.size >= MAX_PENDING)
      throw new Error("Codex workspace listing has an invalid or excessive pending request identity.");
    message.params ??= {};
    // Native source filters remain separate from directory and workspace scope.
    if (this.binding.includeNonInteractive && !message.params.parentThreadId && !message.params.ancestorThreadId)
      message.params.sourceKinds = ["cli", "vscode", "exec", "appServer"];
    // Every CloudX launch supplies --cd. A null cwd is the native picker's
    // explicit All choice; preserve it, including later toolbar toggles.
    if (message.params.cwd == null || message.params.parentThreadId || message.params.ancestorThreadId) return;
    message.params.cwd = this.cwd;
    const limit = message.params.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid Codex workspace listing limit.");
    if (limit === 1) {
      // --last must compare the authoritative filesystem order, even when the
      // native index has not yet discovered a newer rollout.
      message.params.useStateDbOnly = false;
      this.pending.set(message.id, { params: { ...message.params }, limit, cursors: new Set(), pages: 0 });
      return;
    }
    const query = JSON.stringify(Object.entries(message.params).filter(([key]) => !["cursor", "useStateDbOnly"].includes(key)).sort());
    let listing;
    if (message.params.cursor != null) {
      listing = this.listings.get(message.params.cursor);
      if (!listing || listing.query !== query) throw new Error("Codex workspace listing cursor is expired or belongs to a different query.");
      this.listings.delete(message.params.cursor);
    } else listing = { query, indexed: true, cursor: null, pages: 0, seen: new Set(), cursors: new Set() };
    message.params.cursor = listing.cursor;
    message.params.useStateDbOnly = listing.indexed;
    this.pending.set(message.id, { params: { ...message.params }, listing });
  }

  fromServer(message, nextPage) {
    if (message.method) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    if (message.error) { this.pending.delete(message.id); return; }
    if (!Array.isArray(message.result?.data)) throw new Error("Codex workspace listing returned invalid data.");
    const data = message.result.data.filter(thread => this.belongsToWorkspace(thread));
    const cursor = message.result.nextCursor;
    if (cursor != null && typeof cursor !== "string") throw new Error("Codex workspace listing returned an invalid cursor.");
    if (request.listing) {
      const listing = request.listing;
      if (++listing.pages > MAX_PAGES || cursor != null && listing.cursors.has(`${listing.indexed}:${cursor}`))
        throw new Error("Codex workspace listing did not finish within its pagination limit.");
      if (cursor != null) listing.cursors.add(`${listing.indexed}:${cursor}`);
      message.result.data = data.filter(thread => {
        if (listing.seen.has(thread.id)) return false;
        listing.seen.add(thread.id);
        return true;
      });
      this.pending.delete(message.id);
      // Deliver indexed rows immediately. Continuing after the index exhausts
      // reconciles rollouts through the native scan-and-repair path. The native
      // picker requests each page itself, keeping cancellation and search live.
      const reconcile = listing.indexed && cursor == null;
      if (reconcile) listing.indexed = false;
      listing.cursor = cursor ?? null;
      message.result.nextCursor = cursor != null || reconcile ? this.continueListing(listing) : null;
      return;
    }
    if (!data.length && cursor != null) {
      if (request.cursors.has(cursor) || ++request.pages > MAX_PAGES)
        throw new Error("Codex workspace listing did not finish within its pagination limit.");
      request.cursors.add(cursor);
      // Continue the same bounded query until its page contains eligible rows.
      // This is pagination, including --last's one-row page, rather than a retry.
      nextPage({ id: message.id, method: "thread/list", params: { ...request.params,
        cursor, limit: request.limit } });
      return false;
    }
    message.result.data = data;
    this.pending.delete(message.id);
  }

  continueListing(listing) {
    const cursor = `cloudx-workspace:${randomBytes(16).toString("hex")}`;
    this.listings.set(cursor, listing);
    // Abandoned picker/search queries do not retain unbounded cursor state.
    if (this.listings.size > MAX_LISTINGS) this.listings.delete(this.listings.keys().next().value);
    return cursor;
  }

  belongsToWorkspace(thread) {
    if (!CONVERSATION_ID.test(thread?.id) || typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd)) return false;
    const ownership = this.readOwnership(thread.id);
    // A cwd cannot prove ownership of pre-existing conversations or shared-cwd layouts.
    if (!ownership || ownership.owned || ownership.workspaceId !== this.binding.workspaceId || ownership.cwd !== this.cwd) return false;
    try { return realpathSync(thread.cwd) === this.cwd; }
    catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return false; throw error; }
  }

  provenancePath(sessionId) {
    if (!CONVERSATION_ID.test(sessionId)) throw new Error("Invalid Codex workspace conversation identity.");
    return path.join(this.binding.provenanceDirectory, `${sessionId.toLowerCase()}.json`);
  }

  readOwnership(sessionId) {
    let file;
    try { file = openSync(this.provenancePath(sessionId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid Codex workspace provenance file.");
      const buffer = Buffer.alloc(4097);
      const size = readSync(file, buffer, 0, buffer.length, 0);
      if (size > 4096) throw new Error("Codex workspace provenance exceeds its size limit.");
      const value = JSON.parse(buffer.subarray(0, size).toString("utf8"));
      if (value?.version !== 1 || !CONVERSATION_ID.test(value.sessionId) || value.sessionId.toLowerCase() !== sessionId.toLowerCase() ||
          typeof value.workspaceId !== "string" || !value.workspaceId || typeof value.cwd !== "string" ||
          !path.isAbsolute(value.cwd) || typeof value.owned !== "boolean") throw new Error("Invalid Codex workspace provenance.");
      return value;
    } finally { closeSync(file); }
  }
}
