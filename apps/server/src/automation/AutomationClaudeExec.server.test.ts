import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeLaunchMode } from "@cloudx/shared";

import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";
import { ClaudeSettingsService } from "../agents/claude/ClaudeSettingsService.js";

afterEach(() => { vi.unstubAllEnvs(); });

const modeCases: { requested?: ClaudeLaunchMode; saved?: ClaudeLaunchMode; mode: ClaudeLaunchMode; source: string; version: string; rejected?: boolean }[] = [
  { mode: "native-project", source: "default", version: "2.1.316" },
  { requested: "native-project", saved: "cloudx-managed", mode: "native-project", source: "launch", version: "2.1.316" },
  { requested: "cloudx-managed", mode: "cloudx-managed", source: "launch", version: "2.1.316" },
  { saved: "cloudx-managed", mode: "cloudx-managed", source: "saved", version: "2.1.316" },
  { requested: "cloudx-managed", mode: "cloudx-managed", source: "launch", version: "2.1.999", rejected: true },
];

describe("Claude automation exec through the server composition", () => {
  it.each(modeCases)("runs or rejects Claude exec mode $mode from $source on native $version", async ({ requested, saved, mode, source, version, rejected }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-automation-"));
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture" } }));
    const capture = path.join(root, "claude-call.json");
    const claude = path.join(root, "claude");
    await fs.writeFile(claude, `#!${process.execPath}
if (process.argv[2] === "--version") { console.log(${JSON.stringify(`${version} (Claude Code)`)}); process.exit(0); }
if (process.argv.includes("status")) { console.log(JSON.stringify({ configDirectory: process.env.CLAUDE_CONFIG_DIR, apiProvider: "firstParty", loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
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
    if (saved) {
      const settings = new ClaudeSettingsService(config.dataDir, () => path.join(home, ".claude"));
      const current = await settings.read();
      await settings.update({ expectedRevision: current.revision, launchMode: saved });
    }
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
              config: { prompt: "summarize", model: "claude-haiku-4-5", sandbox: "read-only", approvalPolicy: "never", json: true, cwd: root, timeoutMs: 10_000, ...(requested ? { claudeLaunchMode: requested } : {}) }
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
      if (rejected) {
        expect(result.sample).toMatchObject({ status: "failed" });
        expect(result.sample.error).toContain("CloudX-managed");
        await expect(fs.stat(capture)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      expect(result.sample, JSON.stringify(result.sample.error ?? result.sample.trace.slice(-3))).toMatchObject({ status: "succeeded" });
      const call = JSON.parse(await fs.readFile(capture, "utf8")) as { args: string[]; configDir: string };
      expect(call.args).toEqual(expect.arrayContaining(["-p", "--model", "claude-haiku-4-5"]));
      expect(call.configDir).toContain(path.join(config.dataDir, "claude-launches"));
      const records = await fs.readdir(path.join(config.dataDir, "agent-launch-records"));
      expect(records).toHaveLength(1);
      const record = JSON.parse(await fs.readFile(path.join(config.dataDir, "agent-launch-records", records[0]), "utf8"));
      expect(record).toMatchObject({ claudeLaunchPolicy: { mode, exclusiveSkills: mode === "cloudx-managed", activation: "next-launch" }, claudeLaunchModeSource: source });
      expect(result.sample.trace).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Claude execution launch policy recorded.", data: expect.objectContaining({ executionId: record.executionId, mode, exclusiveSkills: mode === "cloudx-managed" }) })]));
      expect(record.claudeLaunchPolicy.skills).toEqual(expect.any(Array));
      expect(call.args).toEqual(expect.arrayContaining(["--settings", "--append-system-prompt-file"]));
      if (mode === "cloudx-managed") {
        expect(call.args).toEqual(expect.arrayContaining(["--setting-sources", "user"]));
        expect(record.claudeLaunchPolicy.excludedSources).toEqual(expect.arrayContaining([expect.stringContaining("project")]));
      } else expect(call.args).not.toContain("--setting-sources");
    } finally {
      await app.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
