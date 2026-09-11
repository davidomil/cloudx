import fs from "node:fs/promises";
import { stopTestProcess } from "./test-terminal-broker.mjs";

export async function cleanupTerminalRecovery({
  server,
  broker,
  root,
  attachLogs,
}) {
  const failures = [];
  for (const [step, cleanup] of [
    ["Stop web server", () => stopTestProcess(server)],
    ["Stop terminal broker", () => stopTestProcess(broker)],
    ["Attach diagnostic logs", attachLogs],
    [
      "Remove fixture directory",
      () => fs.rm(root, { recursive: true, force: true }),
    ],
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push({ step, error });
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Terminal recovery cleanup failed:\n${failures.map(({ step, error }) => `${step}: ${error}`).join("\n")}`,
    );
  }
}
