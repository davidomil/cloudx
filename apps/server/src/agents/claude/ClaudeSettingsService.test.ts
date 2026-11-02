import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ClaudeSettingsService, ensureClaudeSettingsFile } from "./ClaudeSettingsService.js";
import { materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";

async function setup(settings?: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-settings-"));
  const providerHome = path.join(root, ".claude");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);
  if (settings !== undefined) {
    await fs.mkdir(providerHome);
    await fs.writeFile(path.join(providerHome, "settings.json"), JSON.stringify(settings));
  }
  return { root, providerHome, dataDir, service: new ClaudeSettingsService(dataDir, () => providerHome, { PATH: process.env.PATH, CLOUDX_CLAUDE_BIN: "/nonexistent/claude" }) };
}

describe("ClaudeSettingsService", () => {
  it("leaves an absent launch mode unset until the user saves a choice", async () => {
    const { service, providerHome, dataDir } = await setup({ theme: "dark" });
    expect((await service.read()).launchMode).toBeNull();
    expect(await service.launchPreferences()).not.toHaveProperty("launchMode");
    await expect(fs.stat(path.join(dataDir, "claude-launch-preferences.json"))).rejects.toThrow();
    await service.update({ expectedRevision: (await service.read()).revision, autoTrustWorkspace: false });
    expect(JSON.parse(await fs.readFile(path.join(dataDir, "claude-launch-preferences.json"), "utf8"))).not.toHaveProperty("launchMode");
    const nativeBefore = await fs.readFile(path.join(providerHome, "settings.json"), "utf8");
    await service.update({ expectedRevision: (await service.read()).revision, launchMode: "cloudx-managed" });
    expect((await service.read()).launchMode).toBe("cloudx-managed");
    expect(await fs.readFile(path.join(providerHome, "settings.json"), "utf8")).toBe(nativeBefore);
    await service.update({ expectedRevision: (await service.read()).revision, launchMode: null });
    expect((await service.read()).launchMode).toBeNull();
    expect(await service.launchPreferences()).toEqual({ permissionMode: "bypassPermissions", autoTrustWorkspace: false, allowedSkills: [] });
  });

  it("preserves existing choices and rejects invalid saved or requested modes before writes", async () => {
    const { service, providerHome, dataDir } = await setup({ theme: "dark" });
    const target = path.join(dataDir, "claude-launch-preferences.json");
    const original = JSON.stringify({ permissionMode: "plan", autoTrustWorkspace: false, allowedSkills: ["missing"], launchMode: "native-project" });
    await fs.writeFile(target, original);
    const revision = (await service.read()).revision;
    await expect(service.update({ expectedRevision: revision, launchMode: "restricted" as never, model: "sonnet" })).rejects.toThrow("launch mode");
    expect(await fs.readFile(target, "utf8")).toBe(original);
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
    await service.update({ expectedRevision: revision, launchMode: "cloudx-managed" });
    expect(await service.launchPreferences()).toEqual({ permissionMode: "plan", autoTrustWorkspace: false, allowedSkills: ["missing"], launchMode: "cloudx-managed" });
    await fs.writeFile(target, original.replace("native-project", "restricted"));
    await expect(service.read()).rejects.toThrow("launch preferences are invalid");
  });

  it("reads absent settings as Claude Code defaults with CloudX launch defaults", async () => {
    const { service, providerHome } = await setup();
    expect(await service.read()).toMatchObject({
      settingsPath: path.join(providerHome, "settings.json"),
      model: null, effortLevel: null, alwaysThinkingEnabled: null, fastMode: null, outputStyle: null, language: null, autoUpdatesChannel: null,
      permissionMode: "bypassPermissions", autoTrustWorkspace: true, bypassAccepted: false, bypassDisabled: false
    });
    expect(await service.cliStatus()).toMatchObject({ installed: false, command: "/nonexistent/claude" });
    await service.update({ expectedRevision: (await service.read()).revision, model: "opus" });
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"))).toEqual({ model: "opus" });
  });

  it("edits native keys in place, keeps unrelated settings and removes cleared keys", async () => {
    const { service, providerHome } = await setup({ theme: "dark", hooks: { Stop: [] }, model: "opus", fastMode: true });
    const before = await service.read();
    const after = await service.update({
      expectedRevision: before.revision, model: "claude-sonnet-5-5", effortLevel: "high", alwaysThinkingEnabled: false,
      fastMode: null, outputStyle: "Explanatory", language: "english", autoUpdatesChannel: "stable"
    });
    expect(after).toMatchObject({ model: "claude-sonnet-5-5", effortLevel: "high", alwaysThinkingEnabled: false, fastMode: null, outputStyle: "Explanatory" });
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"))).toEqual({
      theme: "dark", hooks: { Stop: [] }, model: "claude-sonnet-5-5", modelSettings: { "claude-sonnet-5-5": { effortLevel: "high" } }, alwaysThinkingEnabled: false,
      outputStyle: "Explanatory", language: "english", autoUpdatesChannel: "stable"
    });
    await expect(service.update({ expectedRevision: before.revision, model: "opus" })).rejects.toThrow("changed. Reload");
  });

  it("keeps CloudX launch preferences out of the shared Claude settings", async () => {
    const { service, providerHome, dataDir } = await setup({ theme: "dark" });
    const saved = await service.update({ expectedRevision: (await service.read()).revision, permissionMode: "acceptEdits", autoTrustWorkspace: false });
    expect(saved).toMatchObject({ permissionMode: "acceptEdits", autoTrustWorkspace: false });
    expect(await service.launchPreferences()).toEqual({ permissionMode: "acceptEdits", autoTrustWorkspace: false, allowedSkills: [] });
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
    expect(JSON.parse(await fs.readFile(path.join(dataDir, "claude-launch-preferences.json"), "utf8"))).toEqual({ permissionMode: "acceptEdits", autoTrustWorkspace: false, allowedSkills: [] });
  });

  it("lists personal and synced skills and saves which ones CloudX tabs may use", async () => {
    const { service, providerHome, dataDir } = await setup();
    for (const directory of ["notes", "synced/account-1/docx"]) {
      await fs.mkdir(path.join(providerHome, "skills", directory), { recursive: true });
      await fs.writeFile(path.join(providerHome, "skills", directory, "SKILL.md"), "---\ndescription: Fixture.\n---\n");
    }
    expect((await service.read()).skills).toEqual([
      { name: "notes", origin: "personal", allowed: false, available: true },
      { name: "docx", origin: "synced", allowed: false, available: true }
    ]);
    // A rejected update writes neither the native settings nor the preferences.
    await expect(service.update({ expectedRevision: (await service.read()).revision, model: "sonnet", allowedSkills: ["missing"] })).rejects.toThrow("Claude skill missing is not installed.");
    expect((await service.read()).model).toBeNull();
    await expect(fs.stat(path.join(providerHome, "settings.json"))).rejects.toThrow();
    const saved = await service.update({ expectedRevision: (await service.read()).revision, allowedSkills: ["docx", "notes", "docx"] });
    expect(saved.skills.filter(skill => skill.allowed).map(skill => skill.name)).toEqual(["notes", "docx"]);
    expect(await service.launchPreferences()).toMatchObject({ allowedSkills: ["docx", "notes"] });

    // An allowed skill that was removed stays listed until the user clears it.
    await fs.rm(path.join(providerHome, "skills", "notes"), { recursive: true });
    expect((await service.read()).skills).toContainEqual({ name: "notes", origin: "personal", allowed: true, available: false });

    // Preferences saved before skill choices existed still load.
    await fs.writeFile(path.join(dataDir, "claude-launch-preferences.json"), JSON.stringify({ permissionMode: "plan", autoTrustWorkspace: true }));
    expect(await service.launchPreferences()).toEqual({ permissionMode: "plan", autoTrustWorkspace: true, allowedSkills: [] });
  });

  it("writes through a linked settings file and reports consent and policy", async () => {
    const { service, providerHome, root } = await setup();
    const real = path.join(root, "dotfiles.json");
    await fs.writeFile(real, JSON.stringify({ skipDangerousModePermissionPrompt: true, permissions: { disableBypassPermissionsMode: "disable" } }));
    await fs.mkdir(providerHome);
    await fs.symlink(real, path.join(providerHome, "settings.json"));
    const current = await service.read();
    expect(current).toMatchObject({ bypassAccepted: true, bypassDisabled: true });
    await service.update({ expectedRevision: current.revision, model: "haiku" });
    expect((await fs.lstat(path.join(providerHome, "settings.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(real, "utf8"))).toMatchObject({ model: "haiku", skipDangerousModePermissionPrompt: true });
  });

  it("rejects values Claude Code would not accept", async () => {
    const { service } = await setup({});
    const expectedRevision = (await service.read()).revision;
    await expect(service.update({ expectedRevision, model: "gpt-6.1-sol" })).rejects.toThrow("Claude model id or alias");
    await expect(service.update({ expectedRevision, effortLevel: "max" as never })).rejects.toThrow("effort level");
    await expect(service.update({ expectedRevision, autoUpdatesChannel: "rc" as never, permissionMode: "plan" })).rejects.toThrow("update channel");
    await expect(service.update({ expectedRevision, language: "x\n" })).rejects.toThrow("short name");
    await expect(service.update({ expectedRevision, unexpected: true } as never)).rejects.toThrow("Invalid Claude settings update");
  });

  it("keeps per-model effort, compaction settings and legacy values separate", async () => {
    const { service, providerHome } = await setup({
      model: "claude-opus-5-5", effortLevel: "low", modelSettings: {
        "claude-opus-5-5": { effortLevel: "high", maxEffortLevel: "xhigh", autoCompactWindow: 200000 },
        "claude-sonnet-5-5": { effortLevel: "medium" }
      }
    });
    vi.spyOn(service, "cliStatus").mockResolvedValue({ installed: true, command: "fixture", version: "2.1.290 (Claude Code)" });
    expect(await service.read()).toMatchObject({ effortLevel: "high", legacyEffortLevel: "low", modelEffortLevels: { "claude-sonnet-5-5": "medium" } });
    await service.update({ expectedRevision: (await service.read()).revision, effortModel: "claude-opus-5-5", effortLevel: "xhigh" });
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"))).toMatchObject({
      effortLevel: "low", modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh", maxEffortLevel: "xhigh", autoCompactWindow: 200000 }, "claude-sonnet-5-5": { effortLevel: "medium" } }
    });
    await service.update({ expectedRevision: (await service.read()).revision, effortLevel: null });
    expect(await service.read()).toMatchObject({ effortLevel: null, legacyEffortLevel: "low" });
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8")).modelSettings["claude-opus-5-5"])
      .toEqual({ maxEffortLevel: "xhigh", autoCompactWindow: 200000 });
  });

  it("rejects ambiguous models, old native effort and malformed model entries before writing either owner", async () => {
    const { service, providerHome, dataDir } = await setup({ model: "opus", effortLevel: "high" });
    const expectedRevision = (await service.read()).revision;
    await expect(service.update({ expectedRevision, effortLevel: "xhigh", autoTrustWorkspace: false })).rejects.toThrow("full Claude model ID");
    vi.spyOn(service, "cliStatus").mockResolvedValue({ installed: true, command: "fixture", version: "2.1.250 (Claude Code)" });
    await expect(service.update({ expectedRevision, effortModel: "claude-opus-5-5", effortLevel: "xhigh", autoTrustWorkspace: false })).rejects.toThrow("2.1.251");
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"))).toEqual({ model: "opus", effortLevel: "high" });
    await expect(fs.stat(path.join(dataDir, "claude-launch-preferences.json"))).rejects.toThrow();
    vi.mocked(service.cliStatus).mockResolvedValue({ installed: true, command: "fixture", version: "2.1.251 (Claude Code)" });
    await fs.writeFile(path.join(providerHome, "settings.json"), JSON.stringify({ modelSettings: { "claude-opus-5-5": [] } }));
    await expect(service.update({ expectedRevision: (await service.read()).revision, effortModel: "claude-opus-5-5", effortLevel: "high" })).rejects.toThrow("must be an object");
  });

  it("rejects unsupported model effort rather than silently saving an ineffective or lowered choice", async () => {
    const { service, providerHome } = await setup({ model: "claude-haiku-4-5-20251001", modelSettings: { unrelated: { autoCompactWindow: "auto" } } });
    const expectedRevision = (await service.read()).revision;
    await expect(service.update({ expectedRevision, effortLevel: "high" })).rejects.toThrow("not supported for this model");
    await expect(service.update({ expectedRevision, effortModel: "claude-opus-4-6", effortLevel: "xhigh" })).rejects.toThrow("does not support saved xhigh");
    await service.update({ expectedRevision, effortModel: "claude-opus-4-6-20260205[1m]", effortLevel: "high" });
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8")).modelSettings)
      .toEqual({ unrelated: { autoCompactWindow: "auto" }, "claude-opus-4-6": { effortLevel: "high" } });
  });

  it("lets the user remove an unsupported model effort without discarding unrelated model configuration", async () => {
    const { service, providerHome } = await setup({ model: "claude-haiku-4-5-20251001", modelSettings: { "claude-haiku-4-5-20251001": { effortLevel: "high", autoCompactWindow: "auto" } } });
    expect((await service.read()).effortLevel).toBe("high");
    await service.update({ expectedRevision: (await service.read()).revision, effortLevel: null });
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8")).modelSettings)
      .toEqual({ "claude-haiku-4-5-20251001": { autoCompactWindow: "auto" } });
  });

  it("preserves unsupported saved channels until corrected, and refuses to invoke the updater", async () => {
    const { service, providerHome, dataDir } = await setup({ autoUpdatesChannel: "rc", unknown: "keep" });
    const before = await service.read();
    expect(before.autoUpdatesChannel).toBe("rc");
    await expect(service.update({ expectedRevision: before.revision, autoUpdatesChannel: "rc" as never, permissionMode: "plan" })).rejects.toThrow("update channel");
    await expect(fs.stat(path.join(dataDir, "claude-launch-preferences.json"))).rejects.toThrow();
    await expect(service.updateCli()).rejects.toThrow("unsupported");
    await service.update({ expectedRevision: before.revision, language: "english" });
    expect((await service.read()).autoUpdatesChannel).toBe("rc");
    for (const channel of ["stable", "latest", null] as const) {
      await service.update({ expectedRevision: (await service.read()).revision, autoUpdatesChannel: channel });
      expect((await service.read()).autoUpdatesChannel).toBe(channel);
    }
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"))).toEqual({ unknown: "keep", language: "english" });
  });

  it("round-trips typed native Boolean options without exposing or replacing unrelated native configuration", async () => {
    const { service, providerHome } = await setup({ autoScrollEnabled: true, autoCompactEnabled: false, env: { ANTHROPIC_API_KEY: "fake-private" }, sandbox: { enabled: true }, unknown: { keep: 1 } });
    const before = await service.read();
    expect(before.nativeOptions).toMatchObject({ autoScrollEnabled: true, autoCompactEnabled: false, prefersReducedMotion: null });
    expect(JSON.stringify(before)).not.toContain("fake-private");
    const saved = await service.update({ expectedRevision: before.revision, nativeOptions: { autoScrollEnabled: false, autoCompactEnabled: null, prefersReducedMotion: true } });
    expect(saved.nativeOptions).toMatchObject({ autoScrollEnabled: false, autoCompactEnabled: null, prefersReducedMotion: true });
    const native = JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"));
    expect(native).toEqual({ autoScrollEnabled: false, prefersReducedMotion: true, env: { ANTHROPIC_API_KEY: "fake-private" }, sandbox: { enabled: true }, unknown: { keep: 1 } });
    for (const nativeOptions of [{ apiKeyHelper: true }, { autoScrollEnabled: "false" }, { disableAllHooks: true }])
      await expect(service.update({ expectedRevision: saved.revision, nativeOptions } as never)).rejects.toThrow("supported Boolean");
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"))).toEqual(native);
  });

  it("rejects a documented newer native option before changing either settings owner", async () => {
    const { service, providerHome, dataDir } = await setup({ bashEditDiffEnabled: true, unrelated: "keep" });
    vi.spyOn(service, "cliStatus").mockResolvedValue({ installed: true, command: "fixture", version: "2.1.268 (Claude Code)" });
    const before = await service.read();
    await expect(service.update({ expectedRevision: before.revision, nativeOptions: { bashEditDiffEnabled: false }, autoTrustWorkspace: false })).rejects.toThrow("requires native 2.1.269");
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8"))).toEqual({ bashEditDiffEnabled: true, unrelated: "keep" });
    await expect(fs.stat(path.join(dataDir, "claude-launch-preferences.json"))).rejects.toThrow();
    await service.update({ expectedRevision: before.revision, nativeOptions: { bashEditDiffEnabled: null } });
    vi.mocked(service.cliStatus).mockResolvedValue({ installed: true, command: "fixture", version: "2.1.269 (Claude Code)" });
    await service.update({ expectedRevision: (await service.read()).revision, nativeOptions: { bashEditDiffEnabled: false } });
    expect((await service.read()).nativeOptions?.bashEditDiffEnabled).toBe(false);
    vi.mocked(service.cliStatus).mockResolvedValue({ installed: true, command: "fixture", version: "unparseable native output" });
    await expect(service.update({ expectedRevision: (await service.read()).revision, nativeOptions: { bashEditDiffEnabled: true } })).rejects.toThrow("Cannot establish");
  });
});

describe("Claude overlay trust", () => {
  it("keeps folders the user already trusted and trusts others only when asked", async () => {
    const { root, providerHome, dataDir } = await setup({});
    const cwd = path.join(root, "work");
    const userStatePath = path.join(root, ".claude.json");
    await fs.writeFile(userStatePath, JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
    const base = { dataDir, accountHome: providerHome, providerHome, executionId: "0b8a3c1e-1111-4222-8333-944455556666", userStatePath };
    const state = async (tabId: string) => JSON.parse(await fs.readFile(path.join(dataDir, "claude-launches", tabId, ".claude.json"), "utf8"));

    await materializeClaudeHomeOverlay({ ...base, tabId: "trusted", cwd, trustProject: false });
    expect((await state("trusted")).projects[cwd]).toEqual({ hasTrustDialogAccepted: true });
    const other = path.join(root, "other");
    await materializeClaudeHomeOverlay({ ...base, tabId: "untrusted", cwd: other, trustProject: false });
    expect((await state("untrusted")).projects).toBeUndefined();
    await materializeClaudeHomeOverlay({ ...base, tabId: "auto", cwd: other, trustProject: true });
    expect((await state("auto")).projects[other]).toEqual({ hasTrustDialogAccepted: true });
  });
});

describe("Claude bypass consent", () => {
  it("records acceptance and keeps the user's other settings", async () => {
    const { service, providerHome } = await setup({ theme: "dark", hooks: { Stop: [] } });
    expect((await service.read()).bypassAccepted).toBe(false);
    expect((await service.acceptBypass()).bypassAccepted).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(providerHome, "settings.json"), "utf8")))
      .toEqual({ theme: "dark", hooks: { Stop: [] }, skipDangerousModePermissionPrompt: true });
  });

  it("accepts before Claude Code has created its home", async () => {
    const { service } = await setup();
    expect((await service.acceptBypass()).bypassAccepted).toBe(true);
  });

  it("refuses to rewrite invalid settings and creates a missing file empty", async () => {
    const { service, providerHome } = await setup();
    await ensureClaudeSettingsFile(providerHome);
    expect(await fs.readFile(path.join(providerHome, "settings.json"), "utf8")).toBe("{}\n");
    await fs.writeFile(path.join(providerHome, "settings.json"), "{ broken");
    await ensureClaudeSettingsFile(providerHome);
    await expect(service.acceptBypass()).rejects.toThrow("not valid JSON");
    expect(await fs.readFile(path.join(providerHome, "settings.json"), "utf8")).toBe("{ broken");
  });
});
