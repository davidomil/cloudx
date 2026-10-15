import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexConversationForks } from "./CodexConversationForks.js";

const executionId = "01a08470-d118-7b72-b1df-439e72e5c744";
const childId = "01a08470-d118-7b72-b1df-439e72e5c745";
let home: string;
let forks: CodexConversationForks;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-forks-"));
  forks = new CodexConversationForks(home);
});
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
const journal = (entries: unknown[]) => ({ version: 1, tabId: "parent", executionId, forks: entries });
async function writeReceipt(contents: string) {
  await fs.writeFile(`${forks.receiptPath}.tmp`, contents);
  await fs.rename(`${forks.receiptPath}.tmp`, forks.receiptPath);
}

it("delivers each confirmed fork once and stops observing with its session", async () => {
  const child = { sessionId: childId, cwd: home };
  const open = vi.fn(async () => undefined);
  const failed = vi.fn();
  const stop = forks.observe("parent", executionId, open, failed);
  try {
    expect(forks.read("parent", executionId)).toEqual([]);
    await writeReceipt(JSON.stringify(journal([child])));
    await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(child));
    await writeReceipt(JSON.stringify(journal([child, child])));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(open).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  } finally { stop(); }
  await writeReceipt(JSON.stringify(journal([{ sessionId: executionId, cwd: home }])));
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(open).toHaveBeenCalledOnce();
});

it("reports a placement failure without automatically trying that fork again", async () => {
  const child = { sessionId: childId, cwd: home };
  await writeReceipt(JSON.stringify(journal([child])));
  const open = vi.fn(async () => { throw new Error("Pane closed"); });
  const failed = vi.fn();
  const stop = forks.observe("parent", executionId, open, failed);
  try {
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    await writeReceipt(JSON.stringify(journal([child])));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(open).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it("does not update a detached source when an in-flight placement later fails", async () => {
  await writeReceipt(JSON.stringify(journal([{ sessionId: childId, cwd: home }])));
  let reject!: (error: Error) => void;
  const open = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const failed = vi.fn();
  const stop = forks.observe("parent", executionId, open, failed);
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  stop();
  reject(new Error("Source closed during placement"));
  await new Promise(resolve => setImmediate(resolve));
  expect(failed).not.toHaveBeenCalled();
});

it.each([
  { ...journal([]), tabId: "another-tab" },
  { ...journal([]), executionId: childId },
  { ...journal([]), executionId: undefined },
  { ...journal([]), version: 2 },
  journal([{ sessionId: "last", cwd: "/tmp" }]),
  journal([{ sessionId: childId, cwd: "relative" }]),
  journal([{ sessionId: childId, cwd: "/tmp", transcriptPath: "relative" }]),
  journal(Array.from({ length: 129 }, () => ({ sessionId: childId, cwd: "/tmp" })))
])("rejects invalid or foreign fork receipts", async value => {
  await writeReceipt(JSON.stringify(value));
  expect(() => forks.read("parent", executionId)).toThrow("invalid fork");
});

it("refuses symlinks and oversized journals", async () => {
  const other = path.join(home, "other.json");
  await fs.writeFile(other, JSON.stringify(journal([])));
  await fs.symlink(other, forks.receiptPath);
  expect(() => forks.read("parent", executionId)).toThrow();
  await fs.unlink(forks.receiptPath);
  await fs.writeFile(forks.receiptPath, " ".repeat(2 * 1024 * 1024 + 1));
  expect(() => forks.read("parent", executionId)).toThrow("size limit");
});
