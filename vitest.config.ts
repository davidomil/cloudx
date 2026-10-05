import { configDefaults, defineConfig } from "vitest/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MeasuredSequencer from "./scripts/ci/shards.mjs";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
// Match the CI verifier, whose candidate runs in UTC with an empty home and
// no user Git configuration. Workers inherit these, so date parsing and the
// real Git operations in tests behave the same on a developer machine; a
// user's filters or hooks (git-lfs, for example) would otherwise run in them.
process.env.TZ = "UTC";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
// The verifier also keeps temporary files on tmpfs. Tests that do real Git
// and disk-space work are several times slower on a busy disk, so a host run
// uses the user's runtime tmpfs unless TMPDIR is set. It must not be
// /dev/shm, which tests use as a second filesystem.
const TMPFS_MAGIC = 0x01021994;
const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
if (
  !process.env.TMPDIR &&
  runtimeDirectory &&
  isSeparateTmpfs(runtimeDirectory)
) {
  const temporary = fs.mkdtempSync(
    path.join(runtimeDirectory, "cloudx-vitest-"),
  );
  process.env.TMPDIR = temporary;
  process.on("exit", () =>
    fs.rmSync(temporary, { recursive: true, force: true }),
  );
}

function isSeparateTmpfs(directory: string): boolean {
  try {
    return (
      fs.statfsSync(directory).type === TMPFS_MAGIC &&
      fs.statSync(directory).dev !== fs.statSync("/dev/shm").dev
    );
  } catch {
    return false;
  }
}

export default defineConfig({
  test: {
    environment: "node",
    sequence: { sequencer: MeasuredSequencer },
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    exclude: [...configDefaults.exclude, "apps/server/dist/updater/**"],
    coverage: {
      reporter: ["text", "html", "json-summary"],
      include: [
        "packages/**/*.ts",
        "apps/server/src/**/*.ts",
        "apps/web/src/**/*.{ts,tsx}",
        "scripts/ai-change/**/*.mjs",
      ],
      exclude: ["scripts/ai-change/**/*.test.mjs"],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
  resolve: {
    alias: {
      "@cloudx/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      "@cloudx/plugin-api": path.join(
        repoRoot,
        "packages/plugin-api/src/index.ts",
      ),
    },
  },
});
