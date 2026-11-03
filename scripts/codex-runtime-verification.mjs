import { pathToFileURL } from "node:url";
import { CODEX_STATE_ERROR_PREFIX, CodexStateVerificationError } from "./codex-state-errors.mjs";
import { CODEX_RUNTIME_ERROR_PREFIX, CodexRuntimeVerificationError } from "./codex-runtime-errors.mjs";

export async function verifyCodexRuntime(options) {
  let runtime;
  try {
    runtime = await import("../apps/server/dist/plugins/CodexRuntimeVerification.js");
  } catch (error) {
    throw new CodexRuntimeVerificationError({ stage: "load", code: "failed" }, { cause: error });
  }
  return runtime.verifyCodexRuntime(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort(new Error(`Native runtime verification cancelled by ${signal}.`)));
  try {
    const options = { assistantBin: process.argv[2], signal: controller.signal, onOutput: text => process.stdout.write(text) };
    for (let index = 3; index < process.argv.length; index += 2) {
      const flag = process.argv[index];
      const value = process.argv[index + 1];
      if (flag === "--allow-startup-recovery") {
        if (value !== "true") throw new Error("Invalid native verification arguments.");
        options.allowStartupRecovery = true;
        continue;
      }
      const key = { "--shared-state-home": "sharedStateHome", "--cloudx-data-dir": "dataDir", "--previous-bin": "previousAssistantBin" }[flag];
      if (!value || !key) throw new Error("Invalid native verification arguments.");
      options[key] = value;
    }
    await verifyCodexRuntime(options);
  } catch (error) {
    console.error("Codex native runtime verification failed:", error);
    if (error instanceof CodexStateVerificationError) console.error(`${CODEX_STATE_ERROR_PREFIX}${JSON.stringify(error.diagnostic)}`);
    if (error instanceof CodexRuntimeVerificationError) console.error(`${CODEX_RUNTIME_ERROR_PREFIX}${JSON.stringify(error.diagnostic)}`);
    process.exitCode = 1;
  }
}
