import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import { ClaudeSettingsPlugin } from "./ClaudeSettingsPlugin.js";
import type { ClaudeSettingsService } from "../agents/claude/ClaudeSettingsService.js";

describe("Claude settings API contract", () => {
  it("validates native channels and per-model effort at the hook schema boundary", () => {
    const plugin = new ClaudeSettingsPlugin({} as ClaudeSettingsService);
    const schema = plugin.hooks.find(hook => hook.id === "claude-settings.update")!.inputSchema;
    const validate = new Ajv().compile(schema);
    const base = { expectedRevision: "a".repeat(64) };
    for (const autoUpdatesChannel of ["latest", "stable", null]) expect(validate({ ...base, autoUpdatesChannel })).toBe(true);
    expect(validate({ ...base, autoUpdatesChannel: "rc", permissionMode: "plan" })).toBe(false);
    expect(validate({ ...base, effortModel: "claude-opus-5-5", effortLevel: "xhigh" })).toBe(true);
    expect(validate({ ...base, effortLevel: "max" })).toBe(false);
    expect(validate({ ...base, nativeOptions: { autoScrollEnabled: false, showTurnDuration: null } })).toBe(true);
    expect(validate({ ...base, nativeOptions: { apiKeyHelper: "fake-command" } })).toBe(false);
    expect(validate({ ...base, nativeOptions: { autoScrollEnabled: "false" } })).toBe(false);
  });
});
