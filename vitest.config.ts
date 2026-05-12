import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
      include: ["packages/**/*.ts", "apps/server/src/**/*.ts"]
    }
  },
  resolve: {
    alias: {
      "@cloudx/shared": "/workspace/cloudx/packages/shared/src/index.ts",
      "@cloudx/plugin-api": "/workspace/cloudx/packages/plugin-api/src/index.ts"
    }
  }
});
