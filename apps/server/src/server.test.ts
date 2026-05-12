import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import { PathPolicy } from "./pathPolicy.js";
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
      appServerEnabled: false,
      terminalReplayBytes: 1024
    };
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([os.tmpdir()]),
      voice: {},
      asr: {}
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({ method: "GET", url: "/" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Cloudx Test");
  });

  it("returns path options from the configured path policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-path-options-"));
    await fs.mkdir(path.join(root, "workspace"));
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      terminalReplayBytes: 1024
    };
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {}
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({ method: "GET", url: `/api/paths/options?query=${encodeURIComponent(`${root}/wor`)}` });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      options: [
        {
          value: `${root}/workspace`,
          label: `${root}/workspace`,
          detail: path.join(root, "workspace"),
          kind: "directory"
        }
      ]
    });
  });
});
