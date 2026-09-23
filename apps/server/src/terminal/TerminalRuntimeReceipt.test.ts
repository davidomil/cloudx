import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { recordTerminalRuntime } from "./TerminalRuntimeReceipt.js";

it.skipIf(process.platform !== "linux")("records the running web and broker identity and pinned helper privately", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-runtime-"));
  try {
    for (const role of ["web", "broker"] as const) {
      await recordTerminalRuntime(root, role);
      const file = path.join(root, "terminal-runtime", `${role}.json`);
      const receipt = JSON.parse(await fs.readFile(file, "utf8"));
      expect(receipt).toMatchObject({
        version: 1, role, pid: process.pid, started: expect.stringMatching(/^\d+$/),
        bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
        brokerProtocol: 1, supervisor: { pinned: true, contract: "execution-json-v1", sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
      });
      expect(receipt.attachmentExitBeforeReady).toBe(role === "broker" ? true : undefined);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      await recordTerminalRuntime(root, role);
    }
    expect(await fs.readdir(path.join(root, "terminal-runtime"))).toEqual(["broker.json", "web.json"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("refuses a symlinked receipt directory without writing outside its owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-runtime-"));
  try {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, path.join(root, "terminal-runtime"));
    await expect(recordTerminalRuntime(root, "web")).rejects.toThrow("receipt directory");
    expect(await fs.readdir(outside)).toEqual([]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
