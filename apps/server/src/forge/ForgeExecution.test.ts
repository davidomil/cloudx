import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ForgeExecutionRecovery } from "./ForgeExecution.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("Forge execution recovery evidence", () => {
  it("accepts only completion bound to the launched execution and supervisor", async () => {
    const { recovery, execution, receipt } = await fixture();
    await receipt("complete", { exitCode: 0 });
    await expect(recovery.assertEnded(execution)).resolves.toBeUndefined();
    expect(await fs.readdir(execution.directory)).toEqual(["complete.json", "ready.json"]);
    await recovery.remove(execution);
    await expect(recovery.remove(execution)).resolves.toBeUndefined();
  });

  it.each([
    { executionId: randomUUID() }, { bootId: randomUUID() }, { pidNamespace: "pid:[1]" },
    { pid: 2_147_483_647 }, { started: "0" }, { exitCode: "0" }, { exitCode: -1 }, { exitCode: 256 }, { signal: 0 }, { signal: 65 },
  ])("rejects unrelated or invalid completion: %j", async invalid => {
    const { recovery, execution, receipt } = await fixture();
    await receipt("complete", { exitCode: 0, ...invalid });
    await expect(recovery.assertEnded(execution)).rejects.toThrow("still alive");
    expect(await fs.readdir(execution.directory)).toContain("complete.json");
  });

  it("does not treat a disappeared or reused supervisor PID as proof that descendants stopped", async () => {
    const { recovery, execution, receipt } = await fixture();
    await receipt("ready", { started: "0" });
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(recovery.assertEnded(execution)).rejects.toThrow("descendants may still be running");
    await receipt("ready", { pid: 2_147_483_647 });
    await expect(recovery.assertEnded(execution)).rejects.toThrow("descendants may still be running");
  });

  it("accepts a confirmed host reboot without receipts", async () => {
    const { recovery, execution } = await fixture();
    await fs.rm(execution.directory, { recursive: true });
    await expect(recovery.assertEnded({ ...execution, bootId: randomUUID() })).resolves.toBeUndefined();
  });

  it("does not treat switching PID namespaces as proof of container termination", async () => {
    const { recovery, execution } = await fixture();
    await expect(recovery.assertEnded({ ...execution, pidNamespace: "pid:[1]" })).rejects.toThrow("different PID namespace");
  });

  it("accepts bound completion from the old container namespace", async () => {
    const { recovery, execution, receipt } = await fixture();
    await receipt("ready", { pidNamespace: "pid:[1]" });
    await receipt("complete", { pidNamespace: "pid:[1]", exitCode: 0 });
    await expect(recovery.assertEnded({ ...execution, pidNamespace: "pid:[1]" })).resolves.toBeUndefined();
  });

  it("blocks missing launch evidence even if an alleged completion exists", async () => {
    const { recovery, execution, receipt } = await fixture();
    await receipt("complete", { exitCode: 0 });
    await fs.rm(path.join(execution.directory, "ready.json"));
    await expect(recovery.assertEnded(execution)).rejects.toThrow("launch receipt is missing or invalid");
  });

  it("preserves replaced receipt directories and rejects path escape records", async () => {
    const { recovery, execution, receipt } = await fixture();
    await receipt("complete", { exitCode: 0 });
    await fs.rename(execution.directory, `${execution.directory}-original`);
    await fs.mkdir(execution.directory);
    await fs.writeFile(path.join(execution.directory, "keep.txt"), "unrelated");
    await expect(recovery.assertEnded(execution)).rejects.toThrow("ownership changed");
    await expect(recovery.remove(execution)).rejects.toThrow("ownership changed");
    await expect(recovery.remove({ ...execution, directory: os.tmpdir() })).rejects.toThrow("record is invalid");
    expect(await fs.readFile(path.join(execution.directory, "keep.txt"), "utf8")).toBe("unrelated");
  });

  it("refuses symbolic links and malformed receipt data", async () => {
    const { recovery, execution } = await fixture();
    await fs.symlink(path.join(execution.directory, "ready.json"), path.join(execution.directory, "complete.json"));
    await expect(recovery.assertEnded(execution)).rejects.toThrow("symbolic link");
    await fs.unlink(path.join(execution.directory, "complete.json"));
    await fs.writeFile(path.join(execution.directory, "complete.json"), "{");
    await expect(recovery.assertEnded(execution)).rejects.toThrow();
  });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-forge-execution-"));
  roots.push(root);
  const recovery = new ForgeExecutionRecovery(root);
  const execution = await recovery.prepare();
  const stat = await fs.readFile(`/proc/${process.pid}/stat`, "utf8");
  const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const receipt = (name: string, fields: Record<string, unknown> = {}) => fs.writeFile(path.join(execution.directory, `${name}.json`), JSON.stringify({
    executionId: execution.executionId, bootId: execution.bootId, pidNamespace: execution.pidNamespace, pid: process.pid, started, ...fields,
  }));
  await receipt("ready");
  return { recovery, execution, receipt };
}
