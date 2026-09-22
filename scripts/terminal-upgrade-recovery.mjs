import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STATE_LIMIT = 16 * 1024 * 1024;
const TRANSCRIPT_LIMIT = 256 * 1024 * 1024;
const TOTAL_LIMIT = 512 * 1024 * 1024;
const FILE_LIMIT = 10_000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/u;
const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const FORGE_STATE = `plugin-data/forge-${createHash("sha256").update("forge").digest("hex")}.json`;
const WORKER_GUIDANCE = "Stop or recover the worker through CloudX first. Resolve missing ownership evidence explicitly; service restarts do not prove a worker ended. Local resources were preserved.";
const LEGACY_RECOVERY = "Legacy workspace has no saved session identities. Its exact layout will be backed up, but in-memory tabs and terminal processes cannot be restored. Record working directories and exact Codex conversation IDs before confirming interruption. No commands or prompts will be replayed.";

/** Run before stopping the web service; snapshotTerminalRecovery checks again after it stops. */
export function assertTerminalMigrationSafe({ dataDir }) {
  const snapshot = new RecoverySnapshot(dataDir);
  snapshot.readForgeState();
}

export function inspectTerminalRecovery({ dataDir, allowLegacyState = false }) {
  const snapshot = new RecoverySnapshot(dataDir, allowLegacyState);
  snapshot.readForgeState();
  snapshot.readSessions();
  return { legacySessionIdentitiesUnavailable: snapshot.legacySessions, warnings: snapshot.legacySessions ? [LEGACY_RECOVERY] : [] };
}

/** The caller must stop the web service before this runs, and stop the broker only after it returns. */
export function snapshotTerminalRecovery({ dataDir, log = console.warn, allowLegacyState = false }) {
  const snapshot = new RecoverySnapshot(dataDir, allowLegacyState);
  snapshot.readForgeState();
  snapshot.readSessions();
  if (!snapshot.files.size) return undefined;
  const backup = snapshot.save();
  if (snapshot.legacySessions) log(LEGACY_RECOVERY);
  log(`Verified terminal recovery snapshot: ${backup}. Broker replacement interrupts processes. Reopen shells explicitly and select an exact saved Codex conversation in each existing tab; no commands or prompts are replayed.`);
  return backup;
}

class RecoverySnapshot {
  files = new Map();
  conversations = [];
  sources = [];
  bytes = 0;
  entries = 0;
  legacySessions = false;

  constructor(dataDir, allowLegacyState = false) {
    this.dataDir = path.resolve(dataDir);
    this.present = safeDirectory(this.dataDir, true);
    this.allowLegacyState = allowLegacyState;
  }

  capture(relative, optional = false, source = path.join(this.dataDir, relative), limit = STATE_LIMIT) {
    if (this.files.has(relative)) return this.files.get(relative).bytes;
    const bytes = readFile(source, limit, optional);
    if (bytes === undefined) return undefined;
    this.bytes += bytes.length;
    if (this.files.size >= FILE_LIMIT || this.bytes > TOTAL_LIMIT)
      throw new Error("Terminal recovery snapshot exceeds its file or size limit; preserve sessions manually before replacement.");
    this.files.set(relative, { source, bytes });
    return bytes;
  }

  json(relative, optional = false) {
    const bytes = this.capture(relative, optional);
    if (bytes === undefined) return undefined;
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error(`Invalid recovery state: ${relative}. Repair the original state before replacing the broker.`); }
  }

  readForgeState() {
    if (!this.present) return;
    const workers = this.json(FORGE_STATE, true) ?? [];
    if (!Array.isArray(workers) || workers.length > FILE_LIMIT) throw new Error(`Invalid Forge worker state. ${WORKER_GUIDANCE}`);
    const ownership = new Map();
    for (const relative of this.stateFiles("forge-workers/workspaces")) {
      const owned = this.json(relative);
      if (!owned || typeof owned.id !== "string" || !SAFE_ID.test(owned.id) || path.basename(relative) !== `${owned.id}.json` ||
          typeof owned.launchPending !== "boolean" || typeof owned.gitPending !== "boolean" || typeof owned.cleaned !== "boolean")
        throw new Error(`Invalid Forge ownership: ${relative}. ${WORKER_GUIDANCE}`);
      if (owned.launchPending || owned.gitPending)
        throw new Error(`Forge worker ${owned.id} has a pending launch or Git operation. ${WORKER_GUIDANCE}`);
      ownership.set(owned.id, owned);
    }
    for (const worker of workers) {
      if (!worker || typeof worker.id !== "string" || !SAFE_ID.test(worker.id) ||
          !["paused", "awaiting_review", "stopped", "completed", "failed"].includes(worker.status) ||
          worker.pendingPublication || worker.mergeAttempted || ["creating", "uncertain"].includes(worker.publicationState) || ["posting", "post_failed"].includes(worker.draft?.status))
        throw new Error(`Forge worker ${worker?.id ?? "unknown"} is active or has unresolved work. ${WORKER_GUIDANCE}`);
      if ((worker.worktreePath || worker.tabId || worker.attemptId) && !ownership.has(worker.id))
        throw new Error(`Forge worker ${worker.id} has missing workspace ownership. ${WORKER_GUIDANCE}`);
    }
    const tabs = new Map();
    for (const relative of this.stateFiles("forge-workers/tabs")) {
      const tab = this.json(relative);
      if (!tab || typeof tab.tabId !== "string" || !SAFE_ID.test(tab.tabId) || path.basename(relative) !== `${tab.tabId}.json` ||
          tabs.has(tab.tabId) || !ownership.has(tab.workerId) || typeof tab.closed !== "boolean" || typeof tab.quiescent !== "boolean" || !tab.closed && !tab.quiescent)
        throw new Error(`Forge terminal ownership is active or unresolved: ${relative}. ${WORKER_GUIDANCE}`);
      tabs.set(tab.tabId, tab);
    }
    for (const worker of workers) {
      if (worker.tabId === undefined) continue;
      const tab = tabs.get(worker.tabId);
      if (!tab || tab.workerId !== worker.id || tab.attemptId !== undefined && tab.attemptId !== worker.attemptId)
        throw new Error(`Forge worker ${worker.id} has missing or conflicting terminal ownership. ${WORKER_GUIDANCE}`);
    }
    for (const directory of ["executions", "turns", "history"])
      for (const relative of this.stateFiles(`forge-workers/${directory}`)) this.capture(relative);
  }

  stateFiles(relative, depth = 0) {
    if (depth > 32) throw new Error("Forge recovery state exceeds its directory depth limit.");
    const directory = path.join(this.dataDir, relative);
    if (!safeDirectory(directory, true)) return [];
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++this.entries > FILE_LIMIT) throw new Error("Forge recovery state exceeds its entry limit.");
      const candidate = path.join(relative, entry.name);
      if (entry.isDirectory()) files.push(...this.stateFiles(candidate, depth + 1));
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(candidate);
      else throw new Error(`Unsafe or unexpected recovery state: ${candidate}`);
      if (files.length > FILE_LIMIT) throw new Error("Forge recovery state exceeds its file limit.");
    }
    return files;
  }

  readSessions() {
    if (!this.present) return;
    const workspace = this.json("workspace.json", true);
    const saved = this.json("sessions.json", true);
    if (workspace !== undefined && saved === undefined && (!validWorkspace(workspace) || workspace.windows.some(window => layoutTabIds(window.layout).length))) {
      if (!this.allowLegacyState) throw new Error(LEGACY_RECOVERY);
      this.legacySessions = true;
    }
    if (saved === undefined) return;
    if (!saved || saved.version !== 1 || !Array.isArray(saved.sessions) || saved.sessions.length > FILE_LIMIT ||
        saved.sessions.some(session => !session || !validSession(session)))
      throw new Error("Invalid saved tab identities; broker replacement stopped.");
    const ids = saved.sessions.map(({ tab }) => tab.id);
    const savedIds = new Set(ids);
    if (savedIds.size !== ids.length || saved.activeTabId !== undefined && !savedIds.has(saved.activeTabId))
      throw new Error("Duplicate or unknown active tab identity; broker replacement stopped.");
    if ((workspace !== undefined || ids.length) && !validWorkspace(workspace))
      throw new Error("Saved tabs have no recoverable workspace layout; broker replacement stopped.");
    if (workspace)
      for (const window of workspace.windows)
        for (const tabId of layoutTabIds(window.layout))
          if (!savedIds.has(tabId))
            throw new Error(`Workspace tab ${tabId} has no saved session identity; broker replacement stopped. Preserve and close the tab manually, or repair sessions.json before migration.`);
    for (const session of saved.sessions)
      if (session.tab.pluginId === "codex-terminal") this.readConversation(session);
  }

  readConversation({ tab, initialInput }) {
    const view = `codex-launches/${tab.id}`;
    const binding = this.json(`${view}/.cloudx-source.json`, true);
    if (!isRecord(binding) || Object.keys(binding).sort().join(",") !== "dev,home,ino,sourceId,version" ||
        binding.version !== 1 || binding.sourceId !== "shared" ||
        ![binding.home, binding.sourceId, binding.dev, binding.ino].every(value => typeof value === "string") || !path.isAbsolute(binding.home))
      throw new Error(`Codex tab ${tab.id} has invalid source ownership.`);
    assertSourceIdentity(binding);
    this.sources.push(binding);
    const receipt = this.json(`${view}/.cloudx-conversation.json`, true);
    const launchId = initialInput?.resume?.mode === "session" ? initialInput.resume.sessionId : undefined;
    if (!receipt || !CONVERSATION_ID.test(receipt.sessionId) ||
        typeof receipt.cwd !== "string" || !path.isAbsolute(receipt.cwd) ||
        typeof receipt.transcriptPath !== "string" || !path.isAbsolute(receipt.transcriptPath) ||
        launchId !== undefined && launchId !== receipt.sessionId)
      throw new Error(`Codex tab ${tab.id} has missing or conflicting conversation identity. Select and save its exact conversation before replacement.`);
    const transcriptPath = path.resolve(receipt.transcriptPath);
    const relative = path.relative(path.join(binding.home, "sessions"), transcriptPath);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative === ".." ||
        !path.basename(transcriptPath).endsWith(`-${receipt.sessionId}.jsonl`))
      throw new Error(`Codex tab ${tab.id} transcript is outside its bound session store or has a different identity.`);
    const destination = `transcripts/${tab.id}.jsonl`;
    const transcript = this.capture(destination, false, transcriptPath, TRANSCRIPT_LIMIT);
    const end = transcript.indexOf(10);
    const header = transcript.subarray(0, end === -1 ? transcript.length : end);
    let metadata;
    try { if (header.length <= 1024 * 1024) metadata = JSON.parse(header.toString("utf8")); } catch {}
    if (metadata?.type !== "session_meta" || metadata.payload?.id !== receipt.sessionId || metadata.payload?.cwd !== receipt.cwd)
      throw new Error(`Codex tab ${tab.id} transcript metadata does not match its conversation receipt.`);
    this.conversations.push({ tabId: tab.id, lastObservedSessionId: receipt.sessionId, transcriptPath, snapshot: destination });
  }

  save() {
    const backup = fs.mkdtempSync(path.join(this.dataDir, "terminal-recovery-"));
    try {
      const files = [];
      for (const [relative, { source, bytes }] of this.files) {
        const target = path.join(backup, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600, flush: true });
        if (!readFile(target, TRANSCRIPT_LIMIT).equals(bytes)) throw new Error(`Backup verification failed: ${relative}`);
        files.push({ source, snapshot: relative, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      // Detect state or transcript changes across the whole snapshot, including ongoing Codex writes.
      for (const { source, bytes } of this.files.values())
        if (!readFile(source, TRANSCRIPT_LIMIT).equals(bytes)) throw new Error(`Recovery source changed during snapshot: ${source}`);
      for (const source of this.sources) assertSourceIdentity(source);
      fs.writeFileSync(path.join(backup, "manifest.json"), `${JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), files, conversations: this.conversations,
        legacySessionIdentitiesUnavailable: this.legacySessions,
        warnings: this.legacySessions ? [LEGACY_RECOVERY] : [],
        recovery: "Keep existing tabs and layouts. Start shells explicitly. Select an exact saved Codex session in its existing tab; lastObservedSessionId is not proof of the current native selection. Never replay saved shell commands or AI prompts. Forge ownership records remain unchanged." }, null, 2)}\n`,
      { flag: "wx", mode: 0o600, flush: true });
      syncDirectories(backup);
      syncDirectory(this.dataDir);
      return backup;
    } catch (error) {
      fs.rmSync(backup, { recursive: true, force: true });
      throw new Error(`Terminal recovery backup failed; do not stop the broker. Original state was preserved. ${error.message}`, { cause: error });
    }
  }
}

function validSession({ tab, initialInput }) {
  return isRecord(tab) && typeof tab.id === "string" && SAFE_ID.test(tab.id) &&
    ["pluginId", "title", "cwd", "createdAt", "updatedAt"].every(key => typeof tab[key] === "string") &&
    ["idle", "starting", "running", "waiting_approval", "failed", "completed", "stopped"].includes(tab.status) &&
    isRecord(tab.indicator) && ["green", "yellow", "red"].includes(tab.indicator.color) &&
    typeof tab.indicator.label === "string" && typeof tab.indicator.updatedAt === "string" &&
    optionalText(tab.indicator.message) && optionalText(tab.contextPath) && optionalText(tab.statusMessage) &&
    (tab.pluginMetadata === undefined || validPluginMetadata(tab.pluginMetadata)) &&
    (tab.recovery === undefined || isRecord(tab.recovery) && ["missing", "unavailable", "retired"].includes(tab.recovery.state) &&
      typeof tab.recovery.message === "string" && optionalText(tab.recovery.conversationId) &&
      (tab.recovery.canResume === undefined || typeof tab.recovery.canResume === "boolean")) &&
    tab.ownerPluginId === undefined &&
    (initialInput === undefined || isRecord(initialInput));
}

// This updater is staged without node_modules or built packages; keep these checks aligned
// with SessionStateStore, readWindow, and isUsableTabLayoutState (covered by production-validator tests).
function validWorkspace(workspace) {
  return isRecord(workspace) && Array.isArray(workspace.windows) && workspace.windows.length > 0 && workspace.windows.length <= FILE_LIMIT &&
    uniqueIds(workspace.windows.map(window => window?.id)) &&
    (workspace.activeWindowId === undefined || workspace.windows.some(window => window.id === workspace.activeWindowId)) &&
    workspace.windows.every(window => isRecord(window) && ["id", "name", "defaultCwd"].every(key => typeof window[key] === "string") &&
      validLayout(window.layout));
}

function validLayout(layout) {
  if (!isRecord(layout) || typeof layout.activePaneId !== "string") return false;
  const pending = [layout.root];
  const panes = [], splits = [], tabs = [];
  let nodes = 0;
  while (pending.length) {
    const node = pending.pop();
    if (++nodes > FILE_LIMIT || !isRecord(node)) return false;
    if (node.type === "pane") {
      const pane = node.pane;
      if (!isRecord(pane) || !Array.isArray(pane.tabIds) || !uniqueIds(pane.tabIds) ||
          pane.activeTabId !== undefined && !pane.tabIds.includes(pane.activeTabId)) return false;
      panes.push(pane.id);
      tabs.push(...pane.tabIds);
    } else if (node.type === "split") {
      if (!["row", "column"].includes(node.direction) || !Array.isArray(node.sizes) || node.sizes.length !== 2 ||
          !node.sizes.every(size => typeof size === "number" && Number.isFinite(size) && size > 0) ||
          Math.abs(node.sizes[0] + node.sizes[1] - 100) > 0.001 || !Array.isArray(node.children) || node.children.length !== 2) return false;
      splits.push(node.id);
      pending.push(...node.children);
    } else return false;
  }
  return uniqueIds(panes) && uniqueIds(splits) && uniqueIds(tabs) && panes.includes(layout.activePaneId);
}

function uniqueIds(ids) {
  return ids.every(id => typeof id === "string" && id.length > 0) && new Set(ids).size === ids.length;
}

function layoutTabIds(layout) {
  const nodes = [layout.root];
  const tabs = [];
  while (nodes.length) {
    const node = nodes.pop();
    if (node.type === "pane") tabs.push(...node.pane.tabIds);
    else nodes.push(...node.children);
  }
  return tabs;
}

function validPluginMetadata(metadata) {
  return isRecord(metadata) && Object.values(metadata).every(isRecord);
}

function optionalText(value) {
  return value === undefined || typeof value === "string";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSourceIdentity(binding) {
  safeDirectory(binding.home);
  const home = fs.statSync(binding.home);
  if (String(home.dev) !== binding.dev || String(home.ino) !== binding.ino)
    throw new Error(`Codex source ownership changed: ${binding.home}`);
}

function safeDirectory(directory, optional = false) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat && optional) return false;
  if (!stat?.isDirectory() || stat.uid !== process.getuid() || fs.realpathSync(directory) !== path.resolve(directory))
    throw new Error(`Recovery path must be an owned real directory without symlinks: ${directory}`);
  return true;
}

function readFile(filePath, limit, optional = false) {
  if (!safeDirectory(path.dirname(filePath), optional)) return undefined;
  const named = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!named && optional) return undefined;
  if (!named?.isFile() || named.uid !== process.getuid() || named.size > limit)
    throw new Error(`Recovery file must be an owned regular file within its size limit: ${filePath}`);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.ino !== named.ino || before.dev !== named.dev || before.size > limit)
      throw new Error(`Recovery file changed before reading: ${filePath}`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(filePath);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.ino !== current.ino || before.dev !== current.dev || !current.isFile())
      throw new Error(`Recovery file changed during reading: ${filePath}`);
    return bytes;
  } finally { fs.closeSync(fd); }
}

function syncDirectories(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    if (entry.isDirectory()) syncDirectories(path.join(directory, entry.name));
  syncDirectory(directory);
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
