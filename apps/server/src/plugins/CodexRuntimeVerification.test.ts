import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { NodePtyTerminalProcess } from "../terminal/NodePtyTerminalProcess.js";
import { verifyCodexRuntime } from "./CodexRuntimeVerification.js";

it("rejects a CLI that exits before saving any native conversation", async () => {
  await expect(verifyCodexRuntime({ assistantBin: "/bin/false" })).rejects.toThrow(/did not save a selected conversation/i);
}, 10_000);

it("cancels native verification and reaps the launched candidate", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-verification-cancel-"));
  const binary = path.join(fixture, "codex");
  const pidPath = path.join(fixture, "pid");
  try {
    await fs.writeFile(binary, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const controller = new AbortController();
    const verification = verifyCodexRuntime({ assistantBin: binary, signal: controller.signal });
    const rejected = expect(verification).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(async () => fs.readFile(pidPath, "utf8").catch(() => ""), { timeout: 5_000 }).toMatch(/^\d+$/u);
    const pid = Number(await fs.readFile(pidPath, "utf8"));
    controller.abort();
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}, 10_000);

it("requires an explicitly selected absolute CLI path", async () => {
  await expect(verifyCodexRuntime({ assistantBin: "codex" })).rejects.toThrow("absolute executable path");
  await expect(verifyCodexRuntime({ assistantBin: "/bin/false", previousAssistantBin: "codex" })).rejects.toThrow("absolute executable path");
});

it("reports isolated process cleanup failure instead of accepting verification", async () => {
  const terminate = NodePtyTerminalProcess.prototype.terminate;
  const cleanup = vi.spyOn(NodePtyTerminalProcess.prototype, "terminate").mockImplementation(async function (this: NodePtyTerminalProcess) {
    await terminate.call(this);
    throw new Error("fixture cleanup failure");
  });
  try {
    await expect(verifyCodexRuntime({ assistantBin: "/bin/false" })).rejects.toThrow("could not stop every isolated session");
  } finally {
    cleanup.mockRestore();
  }
}, 10_000);
