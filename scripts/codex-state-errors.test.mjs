import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { CodexStateVerificationError, parseCodexStateDiagnostic } from "./codex-state-errors.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it.each([
  undefined, null, [], {}, { stage: "snapshot", code: "private-secret" },
  { stage: "snapshot", code: {} }, { stage: "verify", code: "snapshot-budget" },
  { stage: "snapshot", code: "database-size", observedBytes: "secret", limitBytes: 8 },
  { stage: "snapshot", code: "database-size", observedBytes: 9, limitBytes: 0 },
  { stage: "snapshot", code: "database-size", observedBytes: 8, limitBytes: 8 },
  { stage: "snapshot", code: "database-size", observedBytes: Number.MAX_SAFE_INTEGER + 1, limitBytes: 8 },
])("rejects untrusted or invalid diagnostics %#", value => {
  expect(parseCodexStateDiagnostic(value)).toBeUndefined();
});

it("keeps only safe diagnostic fields and separates preparation from candidate compatibility", () => {
  const diagnostic = parseCodexStateDiagnostic({ stage: "snapshot", code: "database-size", observedBytes: 9, limitBytes: 8, message: "private-secret", path: "/private" });
  expect(diagnostic).toEqual({ stage: "snapshot", code: "database-size", observedBytes: 9, limitBytes: 8 });
  expect(new CodexStateVerificationError(diagnostic).message).toContain("snapshot preparation failed");
  expect(new CodexStateVerificationError(diagnostic).message).not.toContain("private");
  expect(new CodexStateVerificationError({ stage: "verify", code: "candidate-state" }).message).toContain("compatibility verification failed");
});

it("reports a disk-space shortage with the required and available byte counts", () => {
  const diagnostic = { stage: "snapshot", code: "disk-space", observedBytes: 16384, limitBytes: 0 };
  expect(parseCodexStateDiagnostic(diagnostic)).toEqual(diagnostic);
  expect(new CodexStateVerificationError(diagnostic).message).toContain("16384 bytes; available disk space is 0 bytes");
});

it.each([
  { stage: "snapshot", code: "snapshot-budget", observedBytes: 65536, limitBytes: 50000 },
  { stage: "verify", code: "candidate-state" },
])("serializes the safe diagnostic through the actual verifier CLI ($stage)", async diagnostic => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-state-verifier-cli-"));
  roots.push(root);
  const scripts = path.join(root, "scripts");
  const plugins = path.join(root, "apps/server/dist/plugins");
  await Promise.all([scripts, plugins].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  for (const name of ["codex-state-errors.mjs", "codex-runtime-verification.mjs"]) await fs.copyFile(new URL(name, import.meta.url), path.join(scripts, name));
  await fs.writeFile(path.join(plugins, "CodexRuntimeVerification.js"), `import { CodexStateVerificationError } from '../../../../scripts/codex-state-errors.mjs'; export async function verifyCodexRuntime() { throw new CodexStateVerificationError(${JSON.stringify(diagnostic)}); }`);
  let failure;
  try { execFileSync(process.execPath, [path.join(scripts, "codex-runtime-verification.mjs"), "/isolated/codex"], { stdio: "pipe" }); }
  catch (error) { failure = error; }
  expect(failure.status).toBe(1);
  expect(failure.stderr.toString()).toContain(`CLOUDX_CODEX_STATE_ERROR=${JSON.stringify(diagnostic)}`);
  expect(failure.stderr.toString()).toContain(new CodexStateVerificationError(diagnostic).message);
});
