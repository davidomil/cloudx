import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { CodexRuntimeVerificationError, parseCodexRuntimeDiagnostic } from "./codex-runtime-errors.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it.each([
  undefined, null, [], {}, { stage: "private-secret", code: "failed" },
  { stage: "interactive-evidence", code: "private-secret" },
  { stage: "interactive-evidence", code: {} },
  { stage: "launch", code: "workspace-roots" },
  { stage: "forge-finish", code: "transcript" },
  { stage: "__proto__", code: "failed" },
])("rejects unknown runtime diagnostic stages and causes %#", value => {
  expect(parseCodexRuntimeDiagnostic(value)).toBeUndefined();
  expect(() => new CodexRuntimeVerificationError(value)).toThrow("Invalid Codex runtime diagnostic");
});

it.each(["load", "launch", "interactive-readiness", "interactive-turn", "interactive-evidence", "forge-resume", "forge-turn", "forge-evidence", "forge-finish"])("names the reached %s stage and preserves the private cause", stage => {
  const cause = new Error("private-secret /host/path");
  const error = new CodexRuntimeVerificationError({ stage, code: "failed" }, { cause });
  expect(error.diagnostic).toEqual({ stage, code: "failed" });
  expect(error.message).toContain("failed at");
  expect(error.message).toContain("The active selection is unchanged");
  expect(error.message).not.toContain("private-secret");
  expect(error.cause).toBe(cause);
});

it.each(["transcript", "conversation", "cwd", "approval-policy", "sandbox-policy", "workspace-roots"])("exposes only the fixed %s evidence cause", code => {
  const diagnostic = parseCodexRuntimeDiagnostic({ stage: "interactive-evidence", code, path: "/private-secret", message: "private-secret" });
  expect(diagnostic).toEqual({ stage: "interactive-evidence", code });
  const error = new CodexRuntimeVerificationError(diagnostic);
  expect(error.message).toContain("interactive turn evidence");
  expect(error.message).not.toMatch(/Forge|shared-state|private-secret/);
});

it.each([
  { stage: "interactive-evidence", code: "transcript" },
  { stage: "interactive-evidence", code: "workspace-roots" },
  { stage: "forge-evidence", code: "approval-policy" },
])("serializes the reached stage through the verifier CLI while retaining private details ($stage/$code)", async diagnostic => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-runtime-verifier-cli-"));
  roots.push(root);
  const scripts = path.join(root, "scripts");
  const plugins = path.join(root, "apps/server/dist/plugins");
  await Promise.all([scripts, plugins].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  for (const name of ["codex-state-errors.mjs", "codex-runtime-errors.mjs", "codex-runtime-verification.mjs"]) await fs.copyFile(new URL(name, import.meta.url), path.join(scripts, name));
  await fs.writeFile(path.join(plugins, "CodexRuntimeVerification.js"), `import { CodexRuntimeVerificationError } from '../../../../scripts/codex-runtime-errors.mjs'; export async function verifyCodexRuntime() { throw new CodexRuntimeVerificationError(${JSON.stringify(diagnostic)}, { cause: new Error('private-secret '.repeat(1000)) }); }`);
  let failure;
  try { execFileSync(process.execPath, [path.join(scripts, "codex-runtime-verification.mjs"), "/isolated/codex"], { stdio: "pipe" }); }
  catch (error) { failure = error; }
  expect(failure.status).toBe(1);
  const log = failure.stderr.toString();
  expect(log).toContain("private-secret");
  expect(log).toContain(new CodexRuntimeVerificationError(diagnostic).message);
  expect(log.trim().split("\n").at(-1)).toBe(`CLOUDX_CODEX_RUNTIME_ERROR=${JSON.stringify(diagnostic)}`);
});
