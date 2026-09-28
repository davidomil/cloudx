import { pathToFileURL } from "node:url";

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
    const options = { assistantBin: process.argv[2], signal: controller.signal, onOutput: text => process.stdout.write(text) };
    for (let index = 3; index < process.argv.length; index += 2) {
      const flag = process.argv[index];
      const value = process.argv[index + 1];
      const key = { "--shared-state-home": "sharedStateHome", "--cloudx-data-dir": "dataDir", "--previous-bin": "previousAssistantBin" }[flag];
      if (!value || !key) throw new Error("Invalid native verification arguments.");
      options[key] = value;
    }
    await verifyCodexRuntime(options);
  } catch (error) {
    console.error(`Codex native runtime verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
