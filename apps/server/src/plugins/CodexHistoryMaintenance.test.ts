import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexVersion } from "../../../../scripts/codex-updater.mjs";
import { readDirectoryIdentity } from "../directoryIdentity.js";
import { JsonStateFile } from "../jsonStateFile.js";
import type { ReviewConversationBinding } from "../forge/ForgeReviewConversation.js";
import { CodexHistoryMaintenance, type NativeHistoryRetirement } from "./CodexHistoryMaintenance.js";
import { CodexStateSources } from "./CodexStateSources.js";

vi.mock("../../../../scripts/codex-updater.mjs", () => ({ readCodexVersion: vi.fn(async () => "0.166.0") }));
const cleanup: Array<() => Promise<void>> = [];
const admit = <T>(task: () => Promise<T>) => task();
afterEach(async () => { vi.mocked(readCodexVersion).mockResolvedValue("0.166.0"); for (const run of cleanup.splice(0).reverse()) await run(); });

async function fixture() {
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
  const original = "history".repeat(100_000);
  await fs.writeFile(rollout, original);
  await fs.writeFile(path.join(home, "auth.json"), "private");
  const receipt = new JsonStateFile(data, `codex-history-retirement/worker-${threadId}.json`, "Native retirement");
  const service = new CodexHistoryMaintenance(data, { CODEX_HOME: home, HOME: root, CLOUDX_ASSISTANT_BIN: "/native/codex" });
  const disposable = vi.fn(async () => {});
  return { home, binding, original, rollout, receipt, service, disposable };
}

describe("owned native history maintenance", () => {
  it.each(["0.156.1", "0.157.1", "0.166.0", "0.999.0"])("retains history on %s without an atomic native eligibility operation", async version => {
    const f = await fixture();
    vi.mocked(readCodexVersion).mockResolvedValue(version);
    const result = await f.service.retire("worker", f.binding, f.disposable, admit);
    expect(result).toMatchObject({ state: "retained", selectedVersion: version, reason: expect.stringMatching(/atomic/) });
    expect(result.reclaimedBytes).toBeUndefined();
    expect(await fs.readFile(f.rollout, "utf8")).toBe(f.original);
    expect(await fs.readFile(path.join(f.home, "auth.json"), "utf8")).toBe("private");
    expect(await f.receipt.read()).toEqual({ binding: f.binding, result });
  });

  it("preserves history when the native version cannot be established", async () => {
    const f = await fixture();
    vi.mocked(readCodexVersion).mockRejectedValue(new Error("Version unavailable"));
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toMatchObject({ state: "retained", selectedVersion: null });
    expect(await fs.readFile(f.rollout, "utf8")).toBe(f.original);
  });

  it("preserves active, recovering or held work when the lifecycle authority rejects disposal", async () => {
    const f = await fixture();
    f.disposable.mockRejectedValue(new Error("Active recovery hold"));
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toMatchObject({ state: "retained", reason: expect.stringContaining("Active recovery hold") });
    expect(await fs.readFile(f.rollout, "utf8")).toBe(f.original);
  });

  it("preserves historical bindings whose effective SQLite home was never verified", async () => {
    const f = await fixture();
    delete f.binding.sqliteHomeVerified;
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toMatchObject({ state: "retained", reason: expect.stringContaining("effective-configuration receipt") });
    expect(f.disposable).not.toHaveBeenCalled();
  });

  it("keeps history when a concurrent resume admission owns the conversation", async () => {
    const f = await fixture();
    const refused = async <T>(_task: () => Promise<T>): Promise<T> => { throw new Error("Pending resume owns this conversation"); };
    expect(await f.service.retire("worker", f.binding, f.disposable, refused)).toMatchObject({ state: "retained", reason: expect.stringContaining("Pending resume") });
    expect(f.disposable).not.toHaveBeenCalled();
    expect(await fs.readFile(f.rollout, "utf8")).toBe(f.original);
  });

  it.each(["removing", "removed"] as const)("keeps an earlier %s receipt without replaying or relabeling native deletion", async state => {
    const f = await fixture();
    const result: NativeHistoryRetirement = { state, threadId: f.binding.threadId!, selectedVersion: "0.166.0", reason: "Historical native operation receipt." };
    await f.receipt.write({ binding: f.binding, result });
    expect(await f.service.retire("worker", f.binding, f.disposable, admit)).toEqual(result);
    expect(f.disposable).not.toHaveBeenCalled();
    expect(await fs.readFile(f.rollout, "utf8")).toBe(f.original);
  });

  it("rejects changed receipt ownership while preserving both the receipt and history", async () => {
    const f = await fixture();
    const saved = { binding: { ...f.binding, creating: true }, result: { state: "removing", threadId: f.binding.threadId } };
    await f.receipt.write(saved);
    await expect(f.service.retire("worker", f.binding, f.disposable, admit)).rejects.toThrow("ownership changed");
    expect(await f.receipt.read()).toEqual(saved);
    expect(await fs.readFile(f.rollout, "utf8")).toBe(f.original);
  });
});
