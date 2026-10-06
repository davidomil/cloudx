import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
      theme: "dark", hooks: { Stop: [] }, model: "claude-sonnet-5-5", effortLevel: "high", alwaysThinkingEnabled: false,
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
    await expect(service.update({ expectedRevision: (await service.read()).revision, allowedSkills: ["missing"] })).rejects.toThrow("Claude skill missing is not installed.");
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
    await expect(service.update({ expectedRevision, language: "x\n" })).rejects.toThrow("short name");
    await expect(service.update({ expectedRevision, unexpected: true } as never)).rejects.toThrow("Invalid Claude settings update");
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
