import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const runner = fileURLToPath(new URL("test-codex-recovery.mjs", import.meta.url));
const fixtures = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fs.rm(fixture, { recursive: true, force: true }))); });

function run(env = {}) {
  const base = { ...process.env };
  delete base.CLOUDX_NATIVE_CODEX;
  delete base.CLOUDX_NATIVE_CODEX_VERSION;
  return spawnSync(process.execPath, [runner], { env: { ...base, ...env }, encoding: "utf8", timeout: 5_000 });
}

it("fails required native validation when no executable is selected", () => {
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Native recovery validation must not be skipped");
});

it("rejects a selected executable that cannot report its version", () => {
  const result = run({ CLOUDX_NATIVE_CODEX: "/bin/false" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("did not return its installed version");
});

it.each([
  ["0.155.1", undefined, "Expected supported Codex 0.156.1 or 0.157.1; found 0.155.1"],
  ["0.156.1", "0.157.1", "Expected supported Codex 0.157.1; found 0.156.1"]
])("rejects unsupported or mismatched native version %s", async (version, expected, diagnostic) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-version-"));
  fixtures.push(fixture);
  const binary = path.join(fixture, "codex");
  await fs.writeFile(binary, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`, { mode: 0o700 });
  const result = run({ CLOUDX_NATIVE_CODEX: binary, ...(expected ? { CLOUDX_NATIVE_CODEX_VERSION: expected } : {}) });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(diagnostic);
  expect(result.stdout).not.toContain("RUN");
});
