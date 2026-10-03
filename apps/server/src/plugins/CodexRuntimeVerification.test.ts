import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
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
});

it("probes the requested executable without consulting its prefix's active selection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-verification-executable-"));
  try {
    const assistantBin = path.join(root, "bin/codex");
    const launched = path.join(root, "launched");
    await fs.mkdir(path.dirname(assistantBin));
    await fs.writeFile(path.join(root, ".cloudx-codex-selection.json"), "invalid active selection");
    await fs.writeFile(assistantBin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(launched)}, 'requested executable');\nprocess.exit(86);\n`, { mode: 0o700 });

    await expect(verifyCodexRuntime({ assistantBin })).rejects.toThrow("did not save a selected conversation");

    expect(await fs.readFile(launched, "utf8")).toBe("requested executable");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 10_000);

it("retains private bounded phase evidence after a rejected launch without inheriting credentials", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-verification-diagnostics-"));
  const output: string[] = [];
  try {
    await expect(verifyCodexRuntime({
      assistantBin: "/bin/false",
      env: { PATH: process.env.PATH, CLOUDX_CODEX_VERIFICATION_DIAGNOSTICS_DIR: directory, OPENAI_API_KEY: "must-not-be-retained" },
      onOutput: text => output.push(text)
    })).rejects.toThrow("did not save a selected conversation");
    const files = await fs.readdir(directory);
    expect(files).toHaveLength(1);
    const file = path.join(directory, files[0]!);
    const content = await fs.readFile(file, "utf8");
    const diagnostic = JSON.parse(content);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(content)).toBeLessThan(16_384);
    expect(content).not.toContain("must-not-be-retained");
    expect(diagnostic).toMatchObject({
      version: 1, phase: "launch", elapsedMs: expect.any(Number),
      phases: [{ phase: "launch", elapsedMs: expect.any(Number) }],
      providerRequests: { count: 0, purposes: [] }, transcriptEvents: [],
      process: { exited: true }, error: { name: "Error" }, evidenceErrors: []
    });
    expect(output).toContain(`Private native verification diagnostics: ${file}\n`);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}, 10_000);

it("refuses to put private launch evidence in a public directory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-public-verification-diagnostics-"));
  const output: string[] = [];
  try {
    await fs.chmod(directory, 0o755);
    await expect(verifyCodexRuntime({
      assistantBin: "/bin/false", env: { PATH: process.env.PATH, CLOUDX_CODEX_VERIFICATION_DIAGNOSTICS_DIR: directory }, onOutput: text => output.push(text)
    })).rejects.toThrow("did not save a selected conversation");
    expect(await fs.readdir(directory)).toEqual([]);
    expect(output).toContain("Private native verification diagnostics could not be saved.\n");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}, 10_000);
