import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CLAUDE_BOOLEAN_SETTINGS } from "@cloudx/shared";
import { ClaudeSettingsService } from "./ClaudeSettingsService.js";
import { inspectClaudeNativeSettings } from "./ClaudeNativeSettings.js";

const command = process.env.CLOUDX_NATIVE_CLAUDE;

it.skipIf(!command)("native 2.1.316 merges typed persistent user controls, preserves other model values and observes unset", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-settings-native-"));
  try {
    const home = path.join(root, "home");
    const providerHome = path.join(home, ".claude");
    const project = path.join(root, "project");
    const settingsPath = path.join(providerHome, "settings.json");
    const generated = path.join(root, "launch.json");
    await fs.mkdir(providerHome, { recursive: true });
    await fs.mkdir(project);
    await fs.writeFile(generated, "{}\n");
    const preserved = { modelSettings: { "claude-sonnet-4-6": { effortLevel: "low", maxThinkingTokens: 1234 } }, env: { CLOUDX_SYNTHETIC_VALUE: "retained" } };
    await fs.writeFile(settingsPath, JSON.stringify(preserved));
    const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: providerHome, CLOUDX_CLAUDE_BIN: command!,
      ANTHROPIC_API_KEY: "synthetic-no-model-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
    const service = new ClaudeSettingsService(path.join(root, "data"), () => providerHome, env);
    const inspect = () => inspectClaudeNativeSettings({ command: command!, cwd: project, env, settingsPath: generated });
    for (const value of [true, false]) {
      const current = await service.read();
      const nativeOptions = Object.fromEntries(CLAUDE_BOOLEAN_SETTINGS.map(key => [key, value]));
      await service.update({ expectedRevision: current.revision, nativeOptions, language: "French", autoUpdatesChannel: "stable" });
      const observed = await inspect();
      expect(observed.version).toBe("2.1.316");
      expect(observed.effective).toMatchObject({ ...nativeOptions, language: "French", autoUpdatesChannel: "stable", ...preserved });
      expect(observed.sources.some(source => source.settings.autoUpdatesChannel === "stable")).toBe(true);
    }
    const saved = await service.read();
    await service.update({ expectedRevision: saved.revision, effortModel: "claude-opus-5-5", effortLevel: "xhigh" });
    expect((await inspect()).effective).toMatchObject({ modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" }, ...preserved.modelSettings } });
    const withEffort = await service.read();
    await service.update({ expectedRevision: withEffort.revision, effortModel: "claude-opus-5-5", effortLevel: null, nativeOptions: Object.fromEntries(CLAUDE_BOOLEAN_SETTINGS.map(key => [key, null])), language: null, autoUpdatesChannel: null });
    const unset = await inspect();
    for (const key of [...CLAUDE_BOOLEAN_SETTINGS, "language", "autoUpdatesChannel"]) expect(Object.hasOwn(unset.effective, key), key).toBe(false);
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual(preserved);
    expect(unset.effective).toMatchObject(preserved);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.skipIf(!command)("native 2.1.316 identifies launch overrides separately from project and user settings without model work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-layers-native-"));
  try {
    const home = path.join(root, "home");
    const providerHome = path.join(home, ".claude");
    const project = path.join(root, "project");
    await fs.mkdir(providerHome, { recursive: true });
    await fs.mkdir(path.join(project, ".claude"), { recursive: true });
    await fs.writeFile(path.join(providerHome, "settings.json"), JSON.stringify({ language: "French", outputStyle: "concise" }));
    await fs.writeFile(path.join(project, ".claude/settings.json"), JSON.stringify({ language: "German" }));
    const settingsPath = path.join(root, "launch.json");
    await fs.writeFile(settingsPath, JSON.stringify({ language: "Spanish" }));
    const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: providerHome, ANTHROPIC_API_KEY: "synthetic-no-model-key",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
    const observed = await inspectClaudeNativeSettings({ command: command!, cwd: project, env, settingsPath });
    expect(observed.version).toBe("2.1.316");
    expect(observed.effective).toMatchObject({ language: "Spanish", outputStyle: "concise" });
    const languages = observed.sources.map(source => source.settings.language).filter(Boolean);
    expect(languages).toEqual(expect.arrayContaining(["French", "German", "Spanish"]));
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"))).toMatchObject({ language: "French" });
    expect(JSON.parse(await fs.readFile(path.join(project, ".claude/settings.json"), "utf8"))).toEqual({ language: "German" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
