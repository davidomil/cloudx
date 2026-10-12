import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexNativeWorkReceipt } from "./CodexNativeWork.js";

const work = { version: 1, tabId: "tab-1", executionId: "execution-1", threadId: "thread-1", updatedAt: "2026-10-12T20:28:20.356Z", turnStatus: "failed", goalStatus: "blocked" };
let home: string;
let receipt: CodexNativeWorkReceipt;
let dispose: (() => void) | undefined;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-work-")); receipt = new CodexNativeWorkReceipt(home); });
afterEach(async () => { dispose?.(); dispose = undefined; await fs.rm(home, { recursive: true, force: true }); });

describe("native work receipt authority", () => {
  it("requires the exact tab and execution while restoring diagnostics", async () => {
    expect(receipt.readForExecution(work.tabId, work.executionId)).toBeUndefined();
    await fs.writeFile(receipt.receiptPath, JSON.stringify(work));
    expect(receipt.readForExecution(work.tabId, work.executionId)).toEqual(work);
    expect(() => receipt.readForExecution("other", work.executionId)).toThrow("different tab or execution");
    expect(() => receipt.readForExecution(work.tabId, "stale")).toThrow("different tab or execution");
  });

  it.each(["oversize", "symlink", "directory", "invalid"])("rejects %s receipts", async kind => {
    if (kind === "oversize") await fs.writeFile(receipt.receiptPath, " ".repeat(16_385));
    if (kind === "symlink") { await fs.writeFile(path.join(home, "other"), JSON.stringify(work)); await fs.symlink(path.join(home, "other"), receipt.receiptPath); }
    if (kind === "directory") await fs.mkdir(receipt.receiptPath);
    if (kind === "invalid") await fs.writeFile(receipt.receiptPath, JSON.stringify({ ...work, goalStatus: "guess" }));
    expect(() => receipt.readForExecution(work.tabId, work.executionId)).toThrow();
  });

  it("refreshes durable diagnostics, clears stale authority and releases the watcher", async () => {
    await fs.writeFile(receipt.receiptPath, JSON.stringify(work));
    const observed = vi.fn();
    dispose = receipt.observe(work.tabId, work.executionId, observed);
    expect(observed).toHaveBeenCalledExactlyOnceWith(work);
    await fs.writeFile(receipt.receiptPath, JSON.stringify({ ...work, executionId: "stale" }));
    await vi.waitFor(() => expect(observed).toHaveBeenLastCalledWith(undefined));
    dispose(); dispose = undefined;
    const count = observed.mock.calls.length;
    await fs.writeFile(receipt.receiptPath, JSON.stringify({ ...work, goalStatus: "active" }));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(observed).toHaveBeenCalledTimes(count);
  });
});
