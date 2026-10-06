import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";

afterEach(() => { vi.unstubAllEnvs(); });

describe("Claude automation exec through the server composition", () => {
  it("runs a Claude exec node on the default Claude account", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-automation-"));
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture" } }));
    const capture = path.join(root, "claude-call.json");
    const claude = path.join(root, "claude");
    await fs.writeFile(claude, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR }));
process.stdout.write(JSON.stringify({ type: "result", result: "done" }));
`, { mode: 0o755 });
    vi.stubEnv("HOME", home);
    vi.stubEnv("CLOUDX_CLAUDE_BIN", claude);
    const config = loadConfig({
      CLOUDX_DATA_DIR: path.join(root, ".cloudx"), CLOUDX_ALLOWED_ROOTS: root, CLOUDX_APP_SERVER_ENABLED: "false",
      CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:1", CLOUDX_WEB_DIST_DIR: path.join(root, "missing-web-dist")
    });
    const now = new Date(0).toISOString();
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(path.join(config.dataDir, "automation.json"), JSON.stringify({
      schemaVersion: 2,
      groups: [{
        id: "claude-exec", name: "Claude exec", enabled: false, createdAt: now, updatedAt: now,
        graph: {
          schemaVersion: 2,
          allowedSafety: ["read", "write", "external"],
          nodes: [
            { id: "trigger", typeId: "trigger:worktree.created", position: { x: 0, y: 0 } },
            {
              id: "claude", typeId: "primitive:codex.exec", position: { x: 200, y: 0 },
              config: { prompt: "summarize", model: "claude-haiku-4-5", sandbox: "read-only", approvalPolicy: "never", json: true, cwd: root, timeoutMs: 10_000 }
            }
          ],
          edges: [{ id: "exec", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "claude", targetPortId: "exec" }],
          variables: []
        }
      }],
      runs: [],
      triggerEvents: []
    }));
    const services = buildServices(config);
    const app = await buildServer(config, services);
    try {
      const result = await services.automation!.startTest("claude-exec");
      expect(result.sample, JSON.stringify(result.sample.error ?? result.sample.trace.slice(-3))).toMatchObject({ status: "succeeded" });
      const call = JSON.parse(await fs.readFile(capture, "utf8")) as { args: string[]; configDir: string };
      expect(call.args).toEqual(expect.arrayContaining(["-p", "--model", "claude-haiku-4-5"]));
      expect(call.configDir).toBe(path.join(home, ".claude"));
    } finally {
      await app.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
