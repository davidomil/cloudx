import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "apps/server/src/terminal/TerminalBroker.test.ts",
      "apps/server/src/terminal/TerminalReplayBuffer.test.ts",
      "apps/server/src/sessionRecovery.server.test.ts",
    ],
    testNamePattern:
      /durable terminal broker|terminal replay history|restores a full 32 MiB replay/,
    retry: 0,
    maxWorkers: 2,
    coverage: {
      ...base.test?.coverage,
      enabled: true,
      provider: "v8",
      reporter: ["json-summary"],
      // Whole-repository thresholds remain enforced by the full coverage job.
      thresholds: undefined,
    },
  },
});
