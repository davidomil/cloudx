import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import { buildServer, type AppServices } from "./server.js";

describe("buildServer", () => {
  it("serves built frontend index.html when configured", async () => {
    const webDistDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-web-"));
    await fs.writeFile(path.join(webDistDir, "index.html"), "<!doctype html><title>Cloudx Test</title>");
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: [os.tmpdir()],
      asrUrl: "http://127.0.0.1:7810",
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir,
      appServerEnabled: false
    };
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      voice: {},
      asr: {}
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({ method: "GET", url: "/" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Cloudx Test");
  });
});
