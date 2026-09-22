import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.env.CLOUDX_NATIVE_CODEX;
if (!binary || !path.isAbsolute(binary)) {
  console.error("Set CLOUDX_NATIVE_CODEX to the absolute installed Codex executable. Native recovery validation must not be skipped.");
  process.exit(1);
}
const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 65_536 });
if (version.error || version.status !== 0 || !/^codex-cli \S+\s*$/u.test(version.stdout)) {
  console.error("The configured Codex executable did not return its installed version.");
  process.exit(1);
}
console.log(`Validating native conversation recovery with ${version.stdout.trim()}`);
const root = fileURLToPath(new URL("..", import.meta.url));
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json"))), "run",
  "apps/server/src/plugins/CodexConversationRecovery.native.test.ts",
  "apps/server/src/plugins/CodexWorkerBridge.native.test.ts"
], { cwd: root, env: process.env, stdio: "inherit", timeout: 120_000 });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
