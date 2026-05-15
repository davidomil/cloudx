import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.mjs"],
    coverage: {
      reporter: ["text", "html"],
      include: ["packages/**/*.ts", "apps/server/src/**/*.ts"]
    }
  },
  resolve: {
    alias: {
      "@cloudx/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      "@cloudx/plugin-api": path.join(repoRoot, "packages/plugin-api/src/index.ts")
    }
  }
});
