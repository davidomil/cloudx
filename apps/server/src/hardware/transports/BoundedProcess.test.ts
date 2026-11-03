import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BoundedProcessSet } from "./BoundedProcess.js";

const signal = () => new AbortController().signal;

describe("bounded hardware transport processes", () => {
  it("reports actual exit status, writes stdin separately from argv, and captures both streams", async () => {
    const processes = new BoundedProcessSet();
    const result = await processes.run({ executable: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout);process.stderr.write('error');process.exitCode=7"], stdin: "untrusted $(printf value)\n", timeoutMs: 1000, maxOutputBytes: 100, signal: signal() });
    expect(result).toMatchObject({ state: "exited", exitCode: 7, stdout: "untrusted $(printf value)\n", stderr: "error", interrupted: false });
    await expect(processes.close(signal())).resolves.toEqual({ state: "completed", value: null });
  });

  it("bounds combined output including invalid or truncated UTF-8", async () => {
    for (const maxOutputBytes of [1, 2, 3, 10]) {
      const processes = new BoundedProcessSet();
      const result = await processes.run({ executable: process.execPath, args: ["-e", "process.stdout.write(Buffer.from([255,255,255,255]));process.stderr.write('€€.');"], timeoutMs: 1000, maxOutputBytes, signal: signal() });
      expect(result.state).toBe("exited");
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(maxOutputBytes);
      await processes.close(signal());
    }
  });

  it("distinguishes failure to spawn and cancellation before dispatch from uncertain running work", async () => {
    const processes = new BoundedProcessSet();
    await expect(processes.run({ executable: "/no-such-cloudx-test-executable", args: [], timeoutMs: 50, maxOutputBytes: 50, signal: signal() })).resolves.toMatchObject({ state: "not_started" });
    const cancelled = await processes.run({ executable: process.execPath, args: ["-e", "throw Error('must not dispatch')"], timeoutMs: 50, maxOutputBytes: 50, signal: AbortSignal.abort() });
    expect(cancelled).toMatchObject({ state: "not_started", interrupted: true });
    const timedOut = await processes.run({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 50, maxOutputBytes: 50, signal: signal() });
    expect(timedOut).toMatchObject({ state: "exited", interrupted: true });
    expect(timedOut.signal).toBe("SIGTERM");
    await processes.close(signal());
  });

  it("escalates ignored cancellation and confirms local exit before cleanup succeeds", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-transport-process-"));
    const ready = path.join(directory, "ready");
    const processes = new BoundedProcessSet();
    try {
      const running = processes.run({ executable: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)", ready], timeoutMs: 5000, maxOutputBytes: 100, signal: signal() });
      await waitForFile(ready);
      await expect(processes.close(signal())).resolves.toEqual({ state: "completed", value: null });
      await expect(running).resolves.toMatchObject({ state: "exited", interrupted: true, signal: "SIGKILL" });
      await expect(processes.run({ executable: process.execPath, args: ["-e", "throw Error('closed')"], timeoutMs: 50, maxOutputBytes: 50, signal: signal() })).resolves.toMatchObject({ state: "not_started" });
    } finally { await processes.close(signal()); await fs.rm(directory, { recursive: true, force: true }); }
  });
});

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (true) {
    try { await fs.access(file); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (Date.now() >= deadline) throw new Error("Controlled process did not become ready.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
