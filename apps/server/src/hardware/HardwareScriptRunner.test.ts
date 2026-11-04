import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BashScript } from "@cloudx/shared";
import { PathPolicy } from "../pathPolicy.js";
import { HardwareScriptRunner } from "./HardwareScriptRunner.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-script-")); roots.push(root);
  const script: BashScript = { source: "printf true", cwd: root, timeoutMs: 1000, maxOutputBytes: 4096, credentialRefIds: [] };
  const runner = new HardwareScriptRunner({ pathPolicy: new PathPolicy([root]), resolveCredential: async id => { if (id !== "lab-token") throw new Error("Missing credential"); return "secret-test-token"; } });
  return { root, script, runner };
}

describe("bounded Hardware Bash execution", () => {
  it("runs in the literal root directory without admitting root to the general path policy", async () => {
    const { root, script } = await fixture();
    const pathPolicy = new PathPolicy([root]);
    const runner = new HardwareScriptRunner({ pathPolicy });
    await expect(pathPolicy.ensureDirectory("/", false)).rejects.toThrow();
    expect(await runner.run({ ...script, cwd: "/", source: "pwd -P" }, {}, new AbortController().signal)).toMatchObject({ state: "completed", exitCode: 0, stdout: "/\n", cleanupConfirmed: true });
    await expect(pathPolicy.ensureDirectory("/", false)).rejects.toThrow();
    await expect(pathPolicy.ensureDirectory("/etc", false)).rejects.toThrow();
  });

  it("passes structured context on stdin, isolates inherited environment, and uses pipefail", async () => {
    const { runner, script } = await fixture();
    process.env.HARDWARE_TEST_PRIVATE = "private-parent-value";
    try {
      const result = await runner.run({ ...script, source: 'read -r context; printf "%s\\n%s" "$context" "${HARDWARE_TEST_PRIVATE:-absent}"' }, { purpose: "status", generation: 7 }, new AbortController().signal);
      expect(result).toMatchObject({ state: "completed", exitCode: 0, cleanupConfirmed: true, stdout: '{"purpose":"status","generation":7}\nabsent' });
      expect((await runner.run({ ...script, source: "false | cat" }, {}, new AbortController().signal)).state).toBe("failed");
    } finally { delete process.env.HARDWARE_TEST_PRIVATE; }
  });

  it("exposes only resolved credential references and redacts diagnostic output", async () => {
    const { runner, script } = await fixture();
    const result = await runner.run({ ...script, credentialRefIds: ["lab-token"], source: 'printf "%s" "$CLOUDX_HARDWARE_CREDENTIAL_LAB_TOKEN"; printf "%s" "$CLOUDX_HARDWARE_CREDENTIAL_LAB_TOKEN" >&2' }, {}, new AbortController().signal);
    expect(result).toMatchObject({ state: "completed", stdout: "[redacted]", stderr: "[redacted]" });
    await expect(new HardwareScriptRunner({}).run({ ...script, credentialRefIds: ["lab-token"] }, {}, new AbortController().signal)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    const truncated = await runner.run({ ...script, credentialRefIds: ["lab-token"], maxOutputBytes: 4, source: 'printf "%s" "$CLOUDX_HARDWARE_CREDENTIAL_LAB_TOKEN"' }, {}, new AbortController().signal);
    expect(truncated.stdout).toBe("[redacted]");
    expect(truncated.errorCode).toBe("OUTPUT_LIMIT");
  });

  it.each(["outside", "missing", "file"])("rejects a %s working directory as a known input failure before executing", async kind => {
    const { root, runner, script } = await fixture();
    const cwd = kind === "outside" ? "/etc" : path.join(root, kind);
    if (kind === "file") await fs.writeFile(cwd, "not a directory");
    expect(await runner.run({ ...script, cwd, source: `printf executed > '${path.join(root, "executed")}'` }, {}, new AbortController().signal)).toMatchObject({ state: "failed", errorCode: "INVALID_INPUT", stderr: expect.stringContaining("working directory"), cleanupConfirmed: true });
    await expect(fs.stat(path.join(root, "executed"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps directory-policy internals out of configuration errors and script diagnostics", async () => {
    const { script } = await fixture();
    const runner = new HardwareScriptRunner({ pathPolicy: { ensureDirectory: async () => { throw new Error("private-policy-detail-marker"); } } });
    await expect(runner.validateWorkingDirectory(script.cwd)).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("configured CloudX allowed roots") });
    const result = await runner.run(script, {}, new AbortController().signal);
    expect(result).toMatchObject({ state: "failed", errorCode: "INVALID_INPUT", cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toContain("private-policy-detail-marker");
  });

  it("terminates a TERM-resistant local process group and retains uncertain timeout effects", async () => {
    const { root, runner, script } = await fixture();
    const result = await runner.run({ ...script, timeoutMs: 100, source: "trap '' TERM; printf '%s' $$ > pid; while :; do sleep 10; done" }, {}, new AbortController().signal);
    expect(result).toMatchObject({ state: "unknown", timedOut: true, cleanupConfirmed: true, errorCode: "TIMEOUT" });
    const pid = Number(await fs.readFile(path.join(root, "pid"), "utf8"));
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    expect(stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
  });

  it("bounds aggregate stdout and stderr and reports explicit cancellation", async () => {
    const { runner, script } = await fixture();
    const limited = await runner.run({ ...script, maxOutputBytes: 64, source: "head -c 4096 /dev/zero; printf stderr >&2" }, {}, new AbortController().signal);
    expect(limited).toMatchObject({ state: "failed", errorCode: "OUTPUT_LIMIT", cleanupConfirmed: true });
    expect(Buffer.byteLength(limited.stdout) + Buffer.byteLength(limited.stderr)).toBeLessThanOrEqual(64);
    const controller = new AbortController();
    const pending = runner.run({ ...script, source: "sleep 10" }, {}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toMatchObject({ state: "unknown", cancelled: true, cleanupConfirmed: true });
    await expect(runner.run(script, {}, controller.signal)).rejects.toThrow();
  });
});
