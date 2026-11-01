import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";
import { assertClaudeHookCompatibility } from "./ClaudeHookPolicy.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-preferences-"));
  const providerHome = path.join(root, "personal home", ".claude");
  const accountHome = path.join(root, "account");
  await fs.mkdir(providerHome, { recursive: true });
  await fs.mkdir(accountHome);
  const userStatePath = path.join(root, ".claude.json");
  return { root, providerHome, accountHome, userStatePath, dataDir: path.join(root, "data"), executionId: "11111111-1111-4111-8111-111111111111", tabId: "first" };
}

describe("Claude personal configuration inheritance", () => {
  it.each([false, true])("preserves only the current project's native import approval (%s) and keeps later tab decisions", async approved => {
    const input = await fixture();
    const cwd = path.join(input.root, "project");
    const project = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: approved, hasClaudeMdExternalIncludesWarningShown: true };
    const personal = { oauthAccount: "private", projects: { [cwd]: { ...project, allowedTools: ["private"] }, "/other": { hasTrustDialogAccepted: true } } };
    await fs.writeFile(input.userStatePath, JSON.stringify(personal));
    const overlay = await materializeClaudeHomeOverlay({ ...input, cwd });
    const statePath = path.join(overlay.configDir, ".claude.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(state.projects).toEqual({ [cwd]: project });
    state.projects[cwd].hasClaudeMdExternalIncludesApproved = !approved;
    await fs.writeFile(statePath, JSON.stringify(state));
    await materializeClaudeHomeOverlay({ ...input, cwd });
    expect(JSON.parse(await fs.readFile(statePath, "utf8")).projects[cwd].hasClaudeMdExternalIncludesApproved).toBe(!approved);
    expect(JSON.parse(await fs.readFile(input.userStatePath, "utf8"))).toEqual(personal);
  });

  it("inherits only the supported personal preferences while isolating account and tab state", async () => {
    const input = await fixture();
    const personal = { copyOnSelect: false, copyFullResponse: true, externalEditorContext: true, oauthAccount: { token: "fake-personal" }, unrelated: "private", projects: { "/trusted": { hasTrustDialogAccepted: true } } };
    await fs.writeFile(input.userStatePath, JSON.stringify(personal));
    await fs.writeFile(path.join(input.providerHome, "keybindings.json"), JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+y": "chat:copy" } }] }));
    const first = await materializeClaudeHomeOverlay(input);
    const statePath = path.join(first.configDir, ".claude.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(state).toEqual({ copyOnSelect: false, copyFullResponse: true, externalEditorContext: true, hasCompletedOnboarding: true });
    expect(await fs.readlink(path.join(first.configDir, "keybindings.json"))).toBe(path.join(input.providerHome, "keybindings.json"));
    await fs.writeFile(statePath, JSON.stringify({ ...state, copyOnSelect: true, nativeTabOnly: "keep" }));
    await materializeClaudeHomeOverlay(input);
    expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toMatchObject({ copyOnSelect: true, nativeTabOnly: "keep" });
    const second = await materializeClaudeHomeOverlay({ ...input, tabId: "second" });
    expect(JSON.parse(await fs.readFile(path.join(second.configDir, ".claude.json"), "utf8"))).toMatchObject({ copyOnSelect: true });
    expect(JSON.parse(await fs.readFile(input.userStatePath, "utf8"))).toEqual(personal);
  });

  it("preserves absent defaults and keybinding bytes for native validation, and diagnoses invalid personal global state", async () => {
    const input = await fixture();
    const overlay = await materializeClaudeHomeOverlay(input);
    expect(JSON.parse(await fs.readFile(path.join(overlay.configDir, ".claude.json"), "utf8"))).toEqual({ hasCompletedOnboarding: true });
    await fs.writeFile(path.join(input.providerHome, "keybindings.json"), "{ malformed");
    await materializeClaudeHomeOverlay(input);
    expect(await fs.readFile(path.join(overlay.configDir, "keybindings.json"), "utf8")).toBe("{ malformed");
    await fs.rm(path.join(input.providerHome, "keybindings.json"));
    await fs.writeFile(input.userStatePath, "{ malformed");
    await expect(materializeClaudeHomeOverlay(input)).rejects.toThrow("global preferences");
  });

  it("retains native preference writes across new tabs, account changes and owner restart without copying credentials", async () => {
    const input = await fixture();
    await fs.writeFile(input.userStatePath, JSON.stringify({ copyOnSelect: false, copyFullResponse: true, oauthAccount: "fake-personal" }));
    const first = await materializeClaudeHomeOverlay(input);
    const firstPath = path.join(first.configDir, ".claude.json");
    const initial = JSON.parse(await fs.readFile(firstPath, "utf8"));
    await fs.writeFile(firstPath, JSON.stringify({ ...initial, copyOnSelect: true, externalEditorContext: true, oauthAccount: "fake-account", projects: { "/private": { hasTrustDialogAccepted: true } } }));
    const otherAccount = path.join(input.root, "other-account");
    await fs.mkdir(otherAccount);
    await fs.writeFile(path.join(otherAccount, ".credentials.json"), JSON.stringify({ token: "fake-other-account" }));
    const second = await materializeClaudeHomeOverlay({ ...input, accountHome: otherAccount, tabId: "second" });
    const state = JSON.parse(await fs.readFile(path.join(second.configDir, ".claude.json"), "utf8"));
    expect(state).toEqual({ copyOnSelect: true, copyFullResponse: true, externalEditorContext: true, hasCompletedOnboarding: true });
    expect(await fs.readlink(path.join(second.configDir, ".credentials.json"))).toBe(path.join(otherAccount, ".credentials.json"));
    // No native change in the second tab: an unrelated write must not reapply
    // its old preference after the first tab changes it again.
    await fs.writeFile(firstPath, JSON.stringify({ ...initial, copyOnSelect: false }));
    await fs.writeFile(path.join(second.configDir, ".claude.json"), JSON.stringify({ ...state, unrelated: true }));
    const third = await materializeClaudeHomeOverlay({ ...input, tabId: "third" });
    expect(JSON.parse(await fs.readFile(path.join(third.configDir, ".claude.json"), "utf8"))).toEqual({ copyOnSelect: false, copyFullResponse: true, hasCompletedOnboarding: true });
    const saved = await fs.readFile(path.join(input.dataDir, "claude-global-preferences.json"), "utf8");
    expect(saved).not.toContain("fake-");
    expect(saved).not.toContain("/private");
    expect(JSON.parse(await fs.readFile(firstPath, "utf8"))).toEqual({ ...initial, copyOnSelect: false });
  });

  it("inherits later personal-file changes and serializes simultaneous new-tab seeding", async () => {
    const input = await fixture();
    await fs.writeFile(input.userStatePath, JSON.stringify({ copyFullResponse: false }));
    await materializeClaudeHomeOverlay(input);
    await fs.writeFile(input.userStatePath, JSON.stringify({ copyFullResponse: true }));
    const overlays = await Promise.all(["a", "b"].map(tabId => materializeClaudeHomeOverlay({ ...input, tabId })));
    for (const overlay of overlays) expect(JSON.parse(await fs.readFile(path.join(overlay.configDir, ".claude.json"), "utf8"))).toMatchObject({ copyFullResponse: true });
  });

  it.each([false, { version: 1, values: {}, overlays: { "../outside": {} } }, { version: 1, values: { token: "fake" }, overlays: {} }])("rejects invalid shared preference ownership without reading unrelated paths: %j", async saved => {
    const input = await fixture();
    await fs.mkdir(input.dataDir);
    await fs.writeFile(path.join(input.dataDir, "claude-global-preferences.json"), JSON.stringify(saved));
    await expect(materializeClaudeHomeOverlay(input)).rejects.toThrow("Invalid CloudX Claude global preferences");
  });

  it("retains the personal source file and import depth while adding CloudX instructions separately", async () => {
    const input = await fixture();
    const base = "Personal instructions.\n@rules/preferences.md\n@missing.md\n";
    const scoped = "---\npaths:\n  - '**/*.ts'\n---\nUse TypeScript conventions.\n";
    await fs.mkdir(path.join(input.providerHome, "rules", "nested"), { recursive: true });
    await fs.writeFile(path.join(input.providerHome, "CLAUDE.md"), base);
    await fs.writeFile(path.join(input.providerHome, "rules", "preferences.md"), "@nested/format.md\n");
    await fs.writeFile(path.join(input.providerHome, "rules", "nested", "format.md"), scoped);
    const overlay = await materializeClaudeHomeOverlay(input);
    const instructions = await fs.readFile(path.join(overlay.configDir, "CLAUDE.md"), "utf8");
    expect(instructions).toBe(base);
    expect(await fs.readlink(path.join(overlay.configDir, "CLAUDE.md"))).toBe(path.join(input.providerHome, "CLAUDE.md"));
    expect(instructions).not.toContain(`@${path.join(input.providerHome, "CLAUDE.md").replace(/ /gu, "\\ ")}`);
    expect(instructions).not.toContain("Use TypeScript conventions");
    const additions = await fs.readFile(overlay.instructionsPath, "utf8");
    expect(additions).toContain("# CloudX Claude Session Instructions");
    expect(additions).not.toContain("Personal instructions");
    expect(await fs.readlink(path.join(overlay.configDir, "rules"))).toBe(path.join(input.providerHome, "rules"));
    expect(await fs.readFile(path.join(overlay.configDir, "rules", "nested", "format.md"), "utf8")).toBe(scoped);
    expect(await fs.readFile(path.join(input.providerHome, "CLAUDE.md"), "utf8")).toBe(base);
  });
});

describe("Claude required receipt hook policy", () => {
  it("rejects a disabling user setting before materializing a tracked launch without rewriting it", async () => {
    const input = await fixture();
    const settingsPath = path.join(input.providerHome, "settings.json");
    const original = JSON.stringify({ disableAllHooks: true, env: { ANTHROPIC_API_KEY: "fake-secret" } });
    await fs.writeFile(settingsPath, original);
    await expect(materializeClaudeHomeOverlay(input)).rejects.toThrow("disableAllHooks");
    await expect(materializeClaudeHomeOverlay(input)).rejects.not.toThrow("fake-secret");
    expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
    await expect(fs.stat(path.join(input.dataDir, "claude-launches"))).rejects.toThrow();
  });

  it("respects managed-only hooks and higher-precedence disabling policy", async () => {
    const input = await fixture();
    const managed = path.join(input.root, "managed-settings.json");
    await fs.writeFile(path.join(input.providerHome, "settings.json"), JSON.stringify({ disableAllHooks: false, allowManagedHooksOnly: true }));
    // A managed-only key in user settings is ignored by native Claude.
    await expect(assertClaudeHookCompatibility(input.providerHome, undefined, [])).resolves.toBeUndefined();
    await fs.writeFile(managed, JSON.stringify({ allowManagedHooksOnly: true }));
    await expect(assertClaudeHookCompatibility(input.providerHome, undefined, [managed])).rejects.toThrow("allowManagedHooksOnly");
    await fs.writeFile(managed, JSON.stringify({ disableAllHooks: true }));
    await expect(assertClaudeHookCompatibility(input.providerHome, undefined, [managed])).rejects.toThrow("disableAllHooks");
  });

  it("keeps compatible hooks and diagnoses unreadable policy without including configuration values", async () => {
    const input = await fixture();
    const cwd = path.join(input.root, "repo");
    await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
    await fs.writeFile(path.join(input.providerHome, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }));
    await expect(assertClaudeHookCompatibility(input.providerHome, cwd, [])).resolves.toBeUndefined();
    await fs.writeFile(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
    await expect(assertClaudeHookCompatibility(input.providerHome, cwd, [])).rejects.toThrow("settings.local.json");
    await fs.writeFile(path.join(cwd, ".claude", "settings.local.json"), "fake-secret not json");
    await expect(assertClaudeHookCompatibility(input.providerHome, cwd, [])).rejects.toThrow("Cannot verify Claude receipt hook policy");
  });

  it("merges managed fragments alphabetically while ignoring hidden and non-JSON files", async () => {
    const input = await fixture();
    const managed = path.join(input.root, "managed-settings.json");
    const fragments = path.join(input.root, "managed-settings.d");
    await fs.mkdir(fragments);
    await fs.writeFile(managed, "");
    await fs.writeFile(path.join(fragments, ".hidden.json"), "invalid hidden file");
    await fs.writeFile(path.join(fragments, "notes.txt"), "invalid non-json file");
    await fs.writeFile(path.join(fragments, "10-hooks.json"), JSON.stringify({ disableAllHooks: true }));
    await expect(assertClaudeHookCompatibility(input.providerHome, undefined, [managed])).rejects.toThrow("10-hooks.json");
    await fs.writeFile(path.join(fragments, "20-hooks.json"), JSON.stringify({ disableAllHooks: false }));
    await expect(assertClaudeHookCompatibility(input.providerHome, undefined, [managed])).resolves.toBeUndefined();
    await fs.writeFile(path.join(fragments, "30-policy.json"), JSON.stringify({ allowManagedHooksOnly: true }));
    await expect(assertClaudeHookCompatibility(input.providerHome, undefined, [managed])).rejects.toThrow("30-policy.json");
  });
});

it("keeps the writer's installed tools and outputs in the catalog across Claude tabs and refreshes", async ({ onTestFinished }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-writing-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const options = {
    dataDir: path.join(root, "data"), tabId: "tab-1", providerHome: path.join(root, "provider"),
    accountHome: path.join(root, "account"), executionId: "execution-1", cwd: path.join(root, "task")
  };
  await Promise.all([options.providerHome, options.accountHome, options.cwd].map(directory => fs.mkdir(directory, { recursive: true })));
  const first = await materializeClaudeHomeOverlay(options);
  const skillDir = path.join(first.rulesSkillsRoot, "system-skills", "source-grounded-writing");
  const files = [".venv/local-install", ".tools/local-tool", "node_modules/local-package/index.js", "build/report.md"];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(skillDir, file)), { recursive: true });
    await fs.writeFile(path.join(skillDir, file), file);
  }
  const originalFiles = await Promise.all(files.map(file => fs.stat(path.join(skillDir, file))));

  await materializeClaudeHomeOverlay({ ...options, executionId: "execution-2" });
  const second = await materializeClaudeHomeOverlay({ ...options, tabId: "tab-2", executionId: "execution-3" });

  for (const overlay of [first, second]) {
    const entry = path.join(overlay.configDir, "skills", "cloudx-system-source-grounded-writing");
    expect(await fs.readdir(entry)).toEqual(["SKILL.md"]);
    expect((await fs.lstat(path.join(entry, "SKILL.md"))).isFile()).toBe(true);
    const instructions = await fs.readFile(path.join(entry, "SKILL.md"), "utf8");
    expect(instructions).toContain('name: "source-grounded-writing"');
    expect(instructions).toContain(`Read the original instructions at ${JSON.stringify(path.join(skillDir, "SKILL.md"))}`);
    expect(instructions).toContain(`against ${JSON.stringify(skillDir)}`);
    expect(instructions).toContain("Resolve task input and output paths from the task working directory");
  }
  for (const [index, file] of files.entries()) {
    expect(await fs.readFile(path.join(skillDir, file), "utf8")).toBe(file);
    expect((await fs.stat(path.join(skillDir, file))).ino).toBe(originalFiles[index]!.ino);
  }
});
