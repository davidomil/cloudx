import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { CodexWorkspaceScope } = await import(new URL("../../helpers/codex-workspace-scope.mjs", import.meta.url).href);
let root: string;
let provenanceDirectory: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-scope-"));
  provenanceDirectory = path.join(root, "provenance");
  await fs.mkdir(provenanceDirectory);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function scope(workspaceId = "workspace-a", options: Record<string, unknown> = {}) {
  return new CodexWorkspaceScope({ workspaceId, cwd: root, provenanceDirectory,
    all: false, includeNonInteractive: false, owned: false, ...options });
}
function created(owner = scope(), cwd = root) {
  const thread = { id: randomUUID(), cwd };
  owner.recordSelection({ authority: "selected", sessionId: thread.id, cwd }, { created: true });
  return thread;
}
function list(owner: InstanceType<typeof CodexWorkspaceScope>, data: unknown[], params: Record<string, unknown> = { cwd: root }) {
  const request = { id: 1, method: "thread/list", params };
  owner.fromClient(request);
  const response = { id: 1, result: { data, nextCursor: null } };
  owner.fromServer(response, () => { throw new Error("Unexpected next page."); });
  return { request, response };
}

describe("Codex workspace conversation scope", () => {
  it("distinguishes named workspaces sharing a cwd and excludes owned Forge conversations", async () => {
    const mine = created();
    const sharedCwd = created(scope("workspace-b"));
    const forge = created(scope("workspace-a", { owned: true }));
    const other = path.join(root, "workspace-b");
    await fs.mkdir(other);
    const differentCwd = created(scope("workspace-b", { cwd: other }), other);
    const unproven = { id: randomUUID(), cwd: root };
    const { request, response } = list(scope(), [sharedCwd, forge, differentCwd, unproven, mine], { cwd: [root, other] });
    expect(request.params).toMatchObject({ cwd: root });
    expect(response.result.data).toEqual([mine]);
  });

  it("keeps linked worktrees outside the exact canonical directory policy", async () => {
    const worktree = path.join(root, "forge-worktree");
    const alias = path.join(root, "alias");
    await fs.mkdir(worktree);
    await fs.symlink(root, alias);
    const mine = created(scope("workspace-a", { cwd: alias }), alias);
    const linked = created(scope("workspace-a", { cwd: worktree }), worktree);
    expect(list(scope(), [linked, mine], { cwd: [root, worktree] }).response.result.data).toEqual([mine]);
  });

  it.each([false, true])("supports explicit broader browsing independently from exec inclusion (%s)", includeNonInteractive => {
    const owner = scope("workspace-a", { all: true, includeNonInteractive });
    const foreign = created(scope("workspace-b"));
    const mine = created();
    const { request, response } = list(owner, [foreign, mine], { sourceKinds: ["cli", "vscode"], cwd: null });
    expect(response.result.data).toEqual([foreign, mine]);
    expect(request.params).toMatchObject({ cwd: null, sourceKinds: includeNonInteractive ? ["cli", "vscode", "exec", "appServer"] : ["cli", "vscode"] });
    expect(owner.pending.size).toBe(0);
  });

  it("refills Resume last's one-row page after newer conversations from other workspaces", () => {
    const owner = scope();
    const mine = created();
    const foreign = created(scope("workspace-b"));
    owner.fromClient({ id: 1, method: "thread/list", params: { limit: 1, sortKey: "updated_at", cwd: [root, "/foreign"] } });
    const nextPage = vi.fn();
    expect(owner.fromServer({ id: 1, result: { data: [foreign], nextCursor: "older" } }, nextPage)).toBe(false);
    expect(nextPage).toHaveBeenCalledExactlyOnceWith({ id: 1, method: "thread/list", params: { limit: 1, sortKey: "updated_at", cwd: root, cursor: "older", useStateDbOnly: false } });
    const response = { id: 1, result: { data: [mine], nextCursor: null } };
    owner.fromServer(response, nextPage);
    expect(response.result.data).toEqual([mine]);
    expect(owner.pending.size).toBe(0);
  });

  it("delivers partial indexed rows immediately and reconciles filesystem history through native pagination", () => {
    const owner = scope();
    const first = created();
    const older = created();
    const oldest = created();
    const params = { cwd: root, limit: 3, modelProviders: ["openai"], sourceKinds: ["cli"], archived: true, sortKey: "updated_at", searchTerm: "fix" };
    owner.fromClient({ id: 1, method: "thread/list", params: { ...params } });
    const next = vi.fn();
    const initial = { id: 1, result: { data: [created(scope("workspace-b")), first], nextCursor: null } };
    owner.fromServer(initial, next);
    expect(initial.result.data).toEqual([first]);
    expect(initial.result.nextCursor).toMatch(/^cloudx-workspace:/);
    expect(next).not.toHaveBeenCalled();
    const continuation = { id: 2, method: "thread/list", params: { ...params, cursor: initial.result.nextCursor } };
    owner.fromClient(continuation);
    expect(continuation.params).toEqual({ ...params, cursor: null, useStateDbOnly: false });
    const reconciled = { id: 2, result: { data: [first, older, oldest], nextCursor: "more" } };
    owner.fromServer(reconciled, next);
    expect(reconciled.result.data).toEqual([older, oldest]);
    const final = { id: 3, method: "thread/list", params: { ...params, cursor: reconciled.result.nextCursor } };
    owner.fromClient(final);
    expect(final.params).toEqual({ ...params, cursor: "more", useStateDbOnly: false });
    const end = { id: 3, result: { data: [oldest], nextCursor: null } };
    owner.fromServer(end, next);
    expect(end.result).toEqual({ data: [], nextCursor: null });
  });

  it("returns each of nine sparse backend pages instead of hiding eight responses", () => {
    const owner = scope();
    const mine = Array.from({ length: 4 }, () => created());
    let cursor: string | null = null;
    const next = vi.fn();
    for (let page = 0; page < 9; page++) {
      const request = { id: page, method: "thread/list", params: { cwd: root, cursor, limit: 25 } };
      owner.fromClient(request);
      expect(request.params).toMatchObject({ useStateDbOnly: true });
      const response = { id: page, result: { data: page === 8 ? mine : Array.from({ length: 25 }, () => ({ id: randomUUID(), cwd: root })), nextCursor: page === 8 ? null : `page-${page}` } };
      expect(owner.fromServer(response, next)).toBeUndefined();
      expect(response.result.data).toEqual(page === 8 ? mine : []);
      cursor = response.result.nextCursor;
      expect(cursor).toMatch(/^cloudx-workspace:/);
    }
    expect(next).not.toHaveBeenCalled();
    expect(owner.pending.size).toBe(0);
  });

  it("keeps search queries independent and rejects stale or mismatched cursors", () => {
    const owner = scope();
    const first = list(owner, [created()], { cwd: root, searchTerm: "camera" });
    expect(() => owner.fromClient({ id: 2, method: "thread/list", params: { cwd: root, searchTerm: "other", cursor: first.response.result.nextCursor } })).toThrow("different query");
    const next = { id: 3, method: "thread/list", params: { cwd: root, searchTerm: "camera", cursor: first.response.result.nextCursor } };
    owner.fromClient(next);
    const failure = { id: 3, error: { code: -32603, message: "History unavailable" } };
    owner.fromServer(failure, () => {});
    expect(owner.pending.size).toBe(0);
    expect(() => owner.fromClient({ id: 4, method: "thread/list", params: { cwd: root, searchTerm: "camera", cursor: first.response.result.nextCursor } })).toThrow("expired");
  });

  it("bounds abandoned queries and discovers owned rollouts absent from the index", () => {
    const owner = scope();
    const cursors: string[] = [];
    for (let index = 0; index < 33; index++) cursors.push(list(owner, []).response.result.nextCursor!);
    expect(owner.listings.size).toBe(32);
    expect(() => owner.fromClient({ id: 2, method: "thread/list", params: { cwd: root, cursor: cursors[0] } })).toThrow("expired");
    const request = { id: 3, method: "thread/list", params: { cwd: root, cursor: cursors.at(-1) } };
    owner.fromClient(request);
    expect(request.params).toMatchObject({ cursor: null, useStateDbOnly: false });
    const mine = created();
    const response = { id: 3, result: { data: [mine], nextCursor: null } };
    owner.fromServer(response, () => {});
    expect(response.result).toEqual({ data: [mine], nextCursor: null });
  });

  it("honors the native picker's explicit All toggle and return to workspace scope", () => {
    const mine = created();
    const foreign = created(scope("workspace-b"));
    expect(list(scope(), [foreign, mine], { cwd: null }).response.result.data).toEqual([foreign, mine]);
    expect(list(scope("workspace-a", { all: true }), [foreign, mine], { cwd: root }).response.result.data).toEqual([mine]);
  });

  it("releases a failed native list request and leaves exact conversation replies unchanged", () => {
    const owner = scope();
    owner.fromClient({ id: 1, method: "thread/list", params: { cwd: root } });
    const failure = { id: 1, error: { code: -32603, message: "Native history unavailable." } };
    owner.fromServer(failure, () => {});
    expect(owner.pending.size).toBe(0);
    expect(failure.error.message).toBe("Native history unavailable.");
    const exact = { id: 2, result: { thread: created(scope("workspace-b")) } };
    const copy = structuredClone(exact);
    owner.fromServer(exact, () => {});
    expect(exact).toEqual(copy);
    expect(() => owner.fromClient({ id: 3, method: "thread/list", params: { cwd: root, limit: 101 } })).toThrow("listing limit");
  });

  it("does not reassign original ownership during exact-ID resume or a later creation claim", () => {
    const thread = created();
    scope("workspace-b").recordSelection({ authority: "selected", sessionId: thread.id, cwd: root }, { created: true });
    expect(scope().readOwnership(thread.id)).toMatchObject({ workspaceId: "workspace-a" });
    const unowned = { authority: "selected", sessionId: randomUUID(), cwd: root };
    scope().recordSelection(unowned);
    expect(scope().readOwnership(unowned.sessionId)).toBeUndefined();
    const exact = { id: 1, method: "thread/resume", params: { threadId: thread.id } };
    scope("workspace-b").fromClient(exact);
    expect(exact.params).toEqual({ threadId: thread.id });
  });

  it("fails clearly for corrupt ownership and repeated native pagination cursors", async () => {
    const thread = created();
    await fs.writeFile(path.join(provenanceDirectory, `${thread.id}.json`), '{}');
    expect(() => list(scope(), [thread])).toThrow("Invalid Codex workspace provenance");
    const owner = scope();
    owner.fromClient({ id: 1, method: "thread/list", params: { cwd: root, limit: 1 } });
    const empty = { id: 1, result: { data: [], nextCursor: "same" } };
    owner.fromServer(empty, () => {});
    expect(() => owner.fromServer(empty, () => {})).toThrow("pagination limit");
  });
});
