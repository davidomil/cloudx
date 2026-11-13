import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BoundedProcessSet } from "./BoundedProcess.js";

const signal = () => new AbortController().signal;

describe("bounded hardware transport processes", () => {
  it("recognizes a split stderr confirmation after output truncation without exposing its bytes", async () => {
    const processes = new BoundedProcessSet();
    try {
      const marker = "\ncompletion-marker\n";
      const result = await processes.run({ executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(1000));process.stderr.write('diagnostic'+process.argv[1].slice(0,5));setTimeout(()=>process.stderr.write(process.argv[1].slice(5)),30)", marker], stderrMarker: marker, timeoutMs: 1000, maxOutputBytes: 10, signal: signal() });
      expect(result).toMatchObject({ state: "exited", exitCode: 0, stdout: "x".repeat(10), stderr: "", truncated: true, stderrMarkerSeen: true });
      const exact = await processes.run({ executable: process.execPath, args: ["-e", "process.stderr.write('1234567890'+process.argv[1])", marker], stderrMarker: marker, timeoutMs: 1000, maxOutputBytes: 10, signal: signal() });
      expect(exact).toMatchObject({ stderr: "1234567890", truncated: false, stderrMarkerSeen: true });
      const followed = await processes.run({ executable: process.execPath, args: ["-e", "process.stderr.write('before'+process.argv[1].slice(0,5));setTimeout(()=>process.stderr.write(process.argv[1].slice(5)+'after'+process.argv[1].slice(0,5)),30)", marker], stderrMarker: marker, timeoutMs: 1000, maxOutputBytes: 100, signal: signal() });
      expect(followed).toMatchObject({ stderr: "beforeafter" + marker.slice(0, 5), truncated: false, stderrMarkerSeen: true });
    } finally { await processes.close(signal()); }
  });

  it("preserves unmatched stderr tails and redacts a truncated credential before returning diagnostics", async () => {
    const processes = new BoundedProcessSet();
    try {
      const result = await processes.run({ executable: process.execPath, args: ["-e", "process.stderr.write('private-password')"], stderrMarker: "absent-marker", secrets: ["private-password"], timeoutMs: 1000, maxOutputBytes: 7, signal: signal() });
      expect(result).toMatchObject({ stderrMarkerSeen: false, truncated: true });
      expect(result.stderr).not.toContain("private");
      expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(7);
      const tail = await processes.run({ executable: process.execPath, args: ["-e", "process.stderr.write('short')"], stderrMarker: "absent-marker", timeoutMs: 1000, maxOutputBytes: 100, signal: signal() });
      expect(tail).toMatchObject({ stderr: "short", truncated: false, stderrMarkerSeen: false });
    } finally { await processes.close(signal()); }
  });

  it("passes only the selected transport environment and redacts secret output before enforcing its byte bound", async () => {
    const processes = new BoundedProcessSet();
    const result = await processes.run({ executable: process.execPath, args: ["-e", "process.stdout.write(process.env.SSH_AUTH_SOCK+':'+(process.env.HOME??'missing'));process.stderr.write('private-password')"], environment: { SSH_AUTH_SOCK: "/tmp/selected-agent" }, secrets: ["private-password"], timeoutMs: 1000, maxOutputBytes: 100, signal: signal() });
    expect(result).toMatchObject({ state: "exited", stdout: "/tmp/selected-agent:missing", stderr: "[redacted]" });
    const truncated = await processes.run({ executable: process.execPath, args: ["-e", "process.stdout.write('private-password')"], secrets: ["private-password"], timeoutMs: 1000, maxOutputBytes: 4, signal: signal() });
    expect(truncated.stdout).not.toContain("priv");
    expect(Buffer.byteLength(truncated.stdout)).toBeLessThanOrEqual(4);
    const unicode = await processes.run({ executable: process.execPath, args: ["-e", "process.stdout.write('private-password€')"], secrets: ["private-password€"], timeoutMs: 1000, maxOutputBytes: 17, signal: signal() });
    expect(unicode.stdout).not.toContain("private-password");
    expect(Buffer.byteLength(unicode.stdout)).toBeLessThanOrEqual(17);
    await processes.close(signal());
  });

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
