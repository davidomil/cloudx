import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexVersion } from "../../../../scripts/codex-updater.mjs";
import { AgentLaunchRecords } from "../agents/AgentLaunchRecords.js";
import { readDirectoryIdentity } from "../directoryIdentity.js";
import type { ReviewConversationBinding } from "../forge/ForgeReviewConversation.js";
import { CodexHistoryMaintenance } from "./CodexHistoryMaintenance.js";
import { CodexStateSources } from "./CodexStateSources.js";

vi.mock("../../../../scripts/codex-updater.mjs", () => ({ readCodexVersion: vi.fn(async () => "0.166.0") }));
const cleanup: Array<() => Promise<void>> = [];
const admit = <T>(task: () => Promise<T>) => task();
afterEach(async () => { vi.mocked(readCodexVersion).mockResolvedValue("0.166.0"); for (const run of cleanup.splice(0).reverse()) await run(); });

async function fixture(options: { failure?: boolean; attachments?: boolean; descendants?: boolean; beforeArtifacts?: () => Promise<void> } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-retirement-"));
  const home = path.join(root, "native"), data = path.join(root, "data");
  await fs.mkdir(home);
  const sources = new CodexStateSources(data, { CODEX_HOME: home });
  cleanup.push(async () => { await sources.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const tabId = randomUUID(), threadId = randomUUID();
  const view = await sources.bind(tabId, await sources.resolve());
  const binding: ReviewConversationBinding = { source: await sources.resolve(), sqliteHome: await readDirectoryIdentity(home, "Native source"), sqliteHomeVerified: true, originView: await readDirectoryIdentity(view, "Native view"), creating: false, threadId };
  await fs.mkdir(path.join(home, "sessions"));
  const rollout = path.join(home, "sessions", `${threadId}.jsonl`);
  await fs.writeFile(rollout, "history".repeat(100_000));
  await fs.writeFile(path.join(home, "auth.json"), "private");
  await new AgentLaunchRecords(data).record({ providerId: "codex", tabId, executionId: randomUUID(), command: "/native/codex", version: "0.166.0", cwd: root, args: [], env: {}, enforcedEnvironmentKeys: [], configurationPaths: [] });
  const requests: string[] = [];
  let listener: (value: Record<string, unknown>) => void;
  const transport = {
    onMessage: (callback: typeof listener) => { listener = callback; },
    send: (message: Record<string, unknown>) => {
      if (!message.id) return;
      requests.push(message.method as string);
      void (async () => {
        if (message.method === "thread/attachment/list") await options.beforeArtifacts?.();
        if (message.method === "thread/delete") {
          await fs.unlink(rollout);
          if (options.failure) { listener({ id: message.id, error: { code: -32603, message: "Interrupted native projection cleanup" } }); return; }
        }
        listener({ id: message.id, result: message.method === "thread/attachment/list" ? { data: options.attachments ? [{ id: "artifact" }] : [], nextCursor: null }
          : message.method === "thread/list" ? { data: options.descendants ? [{ id: "child" }] : [], nextCursor: null } : {} });
      })();
    },
    close: vi.fn(), finish: vi.fn(async () => {}), terminate: vi.fn(async () => {}),
  };
  const createTransport = vi.fn(async () => transport);
  const service = new CodexHistoryMaintenance(data, { CODEX_HOME: home, HOME: root, CLOUDX_ASSISTANT_BIN: "/native/codex" }, createTransport);
  const disposable = vi.fn(async () => {});
  return { root, home, data, binding, rollout, requests, service, disposable, createTransport, transport };
}

describe("owned native history maintenance", () => {
  it("uses only the versioned native lifecycle and journals measured allocation with retained credentials intact", async () => {
    const f = await fixture();
    const result = await f.service.retire("worker", f.binding, f.disposable, admit);
    expect(result).toMatchObject({ state: "removed", selectedVersion: "0.166.0" });
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(result.beforeAllocatedBytes! - result.afterAllocatedBytes!).toBe(result.reclaimedBytes);
    expect(f.requests).toEqual(["initialize", "thread/list", "thread/list", "thread/attachment/list", "thread/delete"]);
    expect(f.disposable).toHaveBeenCalledTimes(3);
    expect(f.transport.finish).toHaveBeenCalledOnce();
    expect(f.transport.terminate).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(f.home, "auth.json"), "utf8")).toBe("private");
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toEqual(result);
    expect(f.createTransport).toHaveBeenCalledOnce();
  });

  it("reports unsupported versions without opening a native client or removing history", async () => {
    const f = await fixture();
    vi.mocked(readCodexVersion).mockResolvedValue("0.156.1");
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toMatchObject({ state: "retained", selectedVersion: "0.156.1" });
    expect(f.createTransport).not.toHaveBeenCalled();
    expect((await fs.stat(f.rollout)).size).toBeGreaterThan(0);
  });

  it("preserves active, recovering or held work when the lifecycle authority rejects disposal", async () => {
    const f = await fixture();
    f.disposable.mockRejectedValue(new Error("Active recovery hold"));
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toMatchObject({ state: "retained", reason: expect.stringContaining("Active recovery hold") });
    expect(f.requests).toEqual([]);
    expect((await fs.stat(f.rollout)).size).toBeGreaterThan(0);
  });

  it("does not erase native attachments or invoke deletion on unverified artifact ownership", async () => {
    const f = await fixture({ attachments: true });
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toMatchObject({ state: "retained", reason: expect.stringContaining("attachments") });
    expect(f.requests).not.toContain("thread/delete");
    expect((await fs.stat(f.rollout)).size).toBeGreaterThan(0);
  });

  it("preserves the complete spawned subtree without inheriting disposal authority for descendants", async () => {
    const f = await fixture({ descendants: true });
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toMatchObject({ state: "retained", reason: expect.stringContaining("spawned descendants") });
    expect(f.requests).not.toContain("thread/delete");
    expect((await fs.stat(f.rollout)).size).toBeGreaterThan(0);
  });

  it("preserves historical bindings whose effective SQLite home was never verified", async () => {
    const f = await fixture();
    delete f.binding.sqliteHomeVerified;
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toMatchObject({ state: "retained", reason: expect.stringContaining("effective-configuration receipt") });
    expect(f.createTransport).not.toHaveBeenCalled();
  });

  it("keeps history when a concurrent resume admission owns the conversation", async () => {
    const f = await fixture();
    const refused = async <T>(_task: () => Promise<T>): Promise<T> => { throw new Error("Pending resume owns this conversation"); };
    expect(await f.service.retire("worker", f.binding, f.disposable, refused)).toMatchObject({ state: "retained", reason: expect.stringContaining("Pending resume") });
    expect(f.createTransport).not.toHaveBeenCalled();
    expect((await fs.stat(f.rollout)).size).toBeGreaterThan(0);
  });

  it("does not confirm removal or replay deletion when descendant shutdown is unresolved", async () => {
    const f = await fixture();
    f.transport.terminate.mockRejectedValue(new Error("Descendant shutdown is unconfirmed"));
    const result = await f.service.retire("worker", f.binding, f.disposable, admit);
    expect(result).toMatchObject({ state: "removing", reason: expect.stringContaining("Descendant shutdown") });
    expect(result.reclaimedBytes).toBeUndefined();
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toEqual(result);
    expect(f.requests.filter(request => request === "thread/delete")).toHaveLength(1);
  });

  it("leaves interrupted native cleanup held across restart without claiming reclamation or replaying deletion", async () => {
    const f = await fixture({ failure: true });
    const result = await f.service.retire("worker", f.binding, f.disposable, admit);
    expect(result).toMatchObject({ state: "removing", reason: expect.stringContaining("Interrupted native projection cleanup") });
    expect(result.reclaimedBytes).toBeUndefined();
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toEqual(result);
    expect(f.requests.filter(request => request === "thread/delete")).toHaveLength(1);
  });

  it("preserves a replaced source or SQLite directory instead of following its links", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside");
    await fs.mkdir(outside);
    await fs.rename(f.home, `${f.home}-old`);
    await fs.symlink(outside, f.home);
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toMatchObject({ state: "retained" });
    expect(f.requests).toEqual([]);
    expect((await fs.stat(f.rollout.replace(f.home, `${f.home}-old`))).size).toBeGreaterThan(0);
  });
  it("preserves directory replacements that occur after the native client starts", async () => {
    let replace!: () => Promise<void>;
    const f = await fixture({ beforeArtifacts: () => replace() });
    replace = async () => { await fs.rename(f.home, `${f.home}-old`); await fs.mkdir(f.home); };
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toMatchObject({ state: "removing", reason: expect.stringMatching(/stale|changed|identity/i) });
    expect(f.requests).not.toContain("thread/delete");
    expect((await fs.stat(f.rollout.replace(f.home, `${f.home}-old`))).size).toBeGreaterThan(0);
    expect(await fs.readdir(f.home)).toEqual([]);
  });

});
