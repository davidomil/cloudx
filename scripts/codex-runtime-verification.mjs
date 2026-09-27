import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";

export async function verifyCodexRuntime(options) {
  let runtime;
  try {
    runtime = await import("../apps/server/dist/plugins/CodexRuntimeVerification.js");
  } catch (error) {
    throw new Error("CloudX's native runtime verifier could not load. Build the server with npm run build -w @cloudx/server before verifying a Codex update.", { cause: error });
  }
  return runtime.verifyCodexRuntime(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort(new Error(`Native runtime verification cancelled by ${signal}.`)));
  try {
    const assistantBin = await fs.realpath(process.argv[2]);
    const previousAssistantBin = process.argv[3] ? await fs.realpath(process.argv[3]) : undefined;
    await verifyCodexRuntime({ assistantBin, previousAssistantBin, signal: controller.signal, onOutput: text => process.stdout.write(text) });
  } catch (error) {
    console.error(`Codex native runtime verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
