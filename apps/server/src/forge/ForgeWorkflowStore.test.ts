import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ForgeWorkerReports,
  ForgeWorkflowStore,
} from "./ForgeWorkflowStore.js";
import { PluginDataStore } from "../plugins/PluginDataStore.js";
import { parseReview, parseWorkers } from "./ForgeWorkflowValidation.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function temp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-reports-"));
  roots.push(root);
  return root;
}
describe("Forge completion reports and state validation", () => {
  it("reads only the current attempt and removes its report", async () => {
    const reports = new ForgeWorkerReports(await temp());
    const id = randomUUID();
    const { reportPath: file } = await reports.prepare(id, {});
    expect(await reports.read(id)).toBeUndefined();
    await fs.writeFile(
      file,
      JSON.stringify({ kind: "issue", title: "Fix", body: "Tested" }),
    );
    expect(await reports.read(id)).toEqual({
      kind: "issue",
      title: "Fix",
      body: "Tested",
    });
    expect(await reports.read(randomUUID())).toBeUndefined();
    await reports.remove(id);
    expect(await reports.read(id)).toBeUndefined();
  });
  it("rejects symlink reports and oversized or invalid JSON", async () => {
    const root = await temp();
    const reports = new ForgeWorkerReports(root);
    const id = randomUUID();
    const { reportPath: file } = await reports.prepare(id, {});
    const target = path.join(root, "target");
    await fs.writeFile(target, "{}");
    await fs.symlink(target, file);
    await expect(reports.read(id)).rejects.toThrow();
    await reports.remove(id);
    await fs.writeFile(file, "x".repeat(1_000_001));
    await expect(reports.read(id)).rejects.toThrow(/1 MB/);
    await fs.writeFile(file, "not json");
    await expect(reports.read(id)).rejects.toThrow();
  });
  it("rejects path traversal and substituted report directories", async () => {
    const root = await temp();
    const reports = new ForgeWorkerReports(root);
    await expect(reports.prepare("../escape", {})).rejects.toThrow(/attempt/);
    await fs.rmdir(path.join(root, "forge-reports"));
    await fs.symlink(await temp(), path.join(root, "forge-reports"));
    await expect(reports.read(randomUUID())).rejects.toThrow();
  });
  it("rejects corrupt persistent state instead of dropping workers", async () => {
    const data = new PluginDataStore(await temp());
    const store = new ForgeWorkflowStore(data);
    expect(await store.read()).toEqual([]);
    await data.write("forge", [{ id: "invalid" }]);
    await expect(store.read()).rejects.toThrow();
    expect(() => parseWorkers({})).toThrow();
  });
  it("rejects invalid inline comments and empty reports", () => {
    const review = {
      headSha: "a".repeat(40),
      event: "comment",
      body: "Review",
      comments: [{ body: "Fix this", path: "../outside", line: 1 }],
    };
    expect(() => parseReview(review)).toThrow(/relative/);
    expect(() =>
      parseReview({ ...review, comments: [{ body: "Fix", line: 1 }] }),
    ).toThrow(/path/);
    expect(() =>
      parseReview({ ...review, comments: [], headSha: "bad" }),
    ).toThrow(/head/);
    expect(() => parseReview({ ...review, comments: [], body: "" })).toThrow(
      /summary/,
    );
  });
});
