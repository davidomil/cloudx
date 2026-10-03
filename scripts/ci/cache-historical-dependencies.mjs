import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const historicalDependencyPackages = [
  "@vitest/coverage-v8@4.1.6",
  "@vitest/expect@4.1.6",
  "@vitest/mocker@4.1.6",
  "@vitest/pretty-format@4.1.6",
  "@vitest/runner@4.1.6",
  "@vitest/snapshot@4.1.6",
  "@vitest/spy@4.1.6",
  "@vitest/utils@4.1.6",
  "brace-expansion@5.0.9",
  "dompurify@3.4.11",
  "fast-uri@3.1.7",
  "fast-uri@4.1.4",
  "fastify@5.10.0",
  "process-warning@5.0.0",
  "smol-toml@1.7.0",
  "vitest@4.1.6",
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  execFileSync("npm", ["cache", "add", ...historicalDependencyPackages], {
    stdio: "inherit",
    timeout: 120_000,
  });
