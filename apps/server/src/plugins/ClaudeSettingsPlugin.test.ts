import { Ajv } from "ajv";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLaunchRecords } from "../agents/AgentLaunchRecords.js";

import { ClaudeSettingsPlugin } from "./ClaudeSettingsPlugin.js";
import { ClaudeSettingsService } from "../agents/claude/ClaudeSettingsService.js";
import { HookRegistry } from "../hooks/HookRegistry.js";

describe("Claude settings API contract", () => {
  it("reads only the requested provider-owned launch record through the public hook", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-record-hook-"));
    try {
      const records = new AgentLaunchRecords(root);
      await records.record({ providerId: "claude", tabId: "tab-1", executionId: "execution-1", accountId: "selected", command: "/vendor/claude", version: "2.1.316", cwd: root,
        args: ["--", "private prompt"], env: { ANTHROPIC_API_KEY: "private-token" }, enforcedEnvironmentKeys: ["ANTHROPIC_API_KEY"], configurationPaths: [] });
      const hooks = new HookRegistry();
      const settings = new ClaudeSettingsService(root, () => path.join(root, "home"));
      new ClaudeSettingsPlugin(settings).hooks.forEach(hook => hooks.register(hook));
      const call = (tabId: string) => hooks.call("claude-settings.inspect-launch", { tabId }, { caller: { kind: "http" } });
      const observed = await call("tab-1");
      expect(observed).toMatchObject({ launchRecord: { accountId: "selected", version: "2.1.316", executionId: "execution-1", arguments: ["--", "[omitted]"] } });
      expect(JSON.stringify(observed)).not.toContain("private-token");
      expect(await call("other-tab")).toEqual({ launchRecord: undefined });
      await expect(call("../escape")).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("validates native channels and per-model effort at the hook schema boundary", () => {
    const plugin = new ClaudeSettingsPlugin({} as ClaudeSettingsService);
    const schema = plugin.hooks.find(hook => hook.id === "claude-settings.update")!.inputSchema;
    const validate = new Ajv().compile(schema);
    const base = { expectedRevision: "a".repeat(64) };
    for (const launchMode of ["native-project", "cloudx-managed", null]) expect(validate({ ...base, launchMode })).toBe(true);
    for (const launchMode of ["", "restricted", false]) expect(validate({ ...base, launchMode })).toBe(false);
    for (const autoUpdatesChannel of ["latest", "stable", null]) expect(validate({ ...base, autoUpdatesChannel })).toBe(true);
    expect(validate({ ...base, autoUpdatesChannel: "rc", permissionMode: "plan" })).toBe(false);
    expect(validate({ ...base, effortModel: "claude-opus-5-5", effortLevel: "xhigh" })).toBe(true);
    expect(validate({ ...base, effortLevel: "max" })).toBe(false);
    expect(validate({ ...base, nativeOptions: { autoScrollEnabled: false, showTurnDuration: null } })).toBe(true);
    expect(validate({ ...base, nativeOptions: { apiKeyHelper: "fake-command" } })).toBe(false);
    expect(validate({ ...base, nativeOptions: { autoScrollEnabled: "false" } })).toBe(false);
  });
});
