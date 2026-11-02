import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";
import { claudeSkillPolicy, discoverClaudeUserSkills } from "./claudeSkillPolicy.js";

async function skill(directory: string, name?: string) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), `---\n${name ? `name: "${name}"\n` : ""}description: Fixture.\n---\nBody.\n`);
}

// Claude Code's built-in plugin skill that disableBundledSkills leaves on.
const BUILT_IN = { "plugin-authoring": "off" };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-skills-"));
  const providerHome = path.join(root, "home", ".claude");
  const repo = path.join(root, "repo");
  const cwd = path.join(repo, "packages", "app");
  await skill(path.join(providerHome, "skills", "notes"), "release-notes");
  await skill(path.join(providerHome, "skills", "synced", "account-1", "docx"), "docx");
  await skill(path.join(providerHome, "skills", "synced", "account-1", "pdf"));
  await fs.mkdir(path.join(providerHome, "skills", ".trash", "old"), { recursive: true });
  await fs.writeFile(path.join(providerHome, "settings.json"), JSON.stringify({ enabledPlugins: { "review@market": true, "lint@market": false } }));
  await fs.mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await skill(path.join(repo, ".claude", "skills", "deploy"));
  // Below the start directory: Claude loads it once it works in packages/other.
  await skill(path.join(repo, "packages", "other", ".claude", "skills", "nested-deploy"));
  await fs.mkdir(path.join(repo, ".claude", "commands", "frontend"), { recursive: true });
  await fs.writeFile(path.join(repo, ".claude", "commands", "frontend", "component.md"), "Build a component.\n");
  await fs.mkdir(path.join(providerHome, "commands"), { recursive: true });
  await fs.writeFile(path.join(providerHome, "commands", "legacy.md"), "Old command.\n");
  // Claude Code reads ignored and symlinked skills from the filesystem too.
  await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\n.claude/skills/private/\n");
  await skill(path.join(repo, "node_modules", "pkg", ".claude", "skills", "vendored"));
  await skill(path.join(repo, ".claude", "skills", "private"));
  await skill(path.join(root, "shared-skills", "linked"));
  await fs.symlink(path.join(root, "shared-skills", "linked"), path.join(repo, ".claude", "skills", "linked"));
  await fs.mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
  await fs.writeFile(path.join(root, "shared-command.md"), "Shared.\n");
  await fs.symlink(path.join(root, "shared-command.md"), path.join(cwd, ".claude", "commands", "shared.md"));
  // A frontmatter name does not rename a skill; Claude Code uses the directory.
  await skill(path.join(cwd, ".claude", "skills", "local-tool"));
  await fs.writeFile(path.join(repo, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "format@market": true } }));
  return { root, providerHome, repo, cwd };
}

describe("Claude skill policy", () => {
  it("finds personal and synced skills by directory name", async () => {
    const { providerHome } = await fixture();
    expect(await discoverClaudeUserSkills(providerHome)).toEqual([
      { name: "notes", origin: "personal", source: "skills/notes" },
      { name: "legacy", origin: "personal", source: "commands/legacy.md" },
      { name: "docx", origin: "synced", source: "skills/synced/account-1/docx" },
      { name: "pdf", origin: "synced", source: "skills/synced/account-1/pdf" }
    ]);
    expect(await discoverClaudeUserSkills(path.join(providerHome, "missing"))).toEqual([]);
  });

  it("preserves native project discovery while supplied selections remain separate additions", async () => {
    const { providerHome, cwd } = await fixture();
    const policy = await claudeSkillPolicy({ providerHome, cwd, allowedSkills: [], cloudxSkillNames: ["cloudx-system-create-cloudx-skill"] });
    expect(policy).toEqual({ settings: { disableBundledSkills: true, autoMemoryEnabled: false, syncClaudeAiPlugins: false,
      syncClaudeAiSkills: false, skillOverrides: BUILT_IN, enabledPlugins: { "format@market": false, "review@market": false } }, selected: [] });
  });

  it("preserves allowed personal names and source identities without enabling synced loading", async () => {
    const { providerHome, cwd } = await fixture();
    const policy = await claudeSkillPolicy({ providerHome, cwd, allowedSkills: ["notes", "legacy"], cloudxSkillNames: [] });
    expect(policy.selected.map(skill => skill.source)).toEqual(["skills/notes", "commands/legacy.md"]);
    expect(policy.settings.syncClaudeAiSkills).toBe(false);
    expect(policy.settings.skillOverrides).toEqual(BUILT_IN);
  });

  it("selects account-scoped synced sources for an immutable next-launch snapshot, without enabling native sync", async () => {
    const { providerHome, cwd } = await fixture();
    const allowedSkills = ["notes", "docx"];
    const original = await fs.readFile(path.join(providerHome, "settings.json"), "utf8");
    const policy = await claudeSkillPolicy({ providerHome, cwd, allowedSkills, cloudxSkillNames: [] });
    expect(policy.selected).toEqual(expect.arrayContaining([{ name: "docx", origin: "synced", source: "skills/synced/account-1/docx" }]));
    expect(policy.settings.syncClaudeAiSkills).toBe(false);
    expect(allowedSkills).toEqual(["notes", "docx"]);
    expect(await fs.readFile(path.join(providerHome, "settings.json"), "utf8")).toBe(original);
  });

  it("does not supply an unavailable saved selection as a CloudX addition, while native project discovery stays native", async () => {
    const { providerHome, cwd } = await fixture();
    await fs.rm(path.join(providerHome, "skills", "notes"), { recursive: true });
    await skill(path.join(cwd, ".claude", "skills", "notes"));
    const allowedSkills = ["notes"];
    const policy = await claudeSkillPolicy({ providerHome, cwd, allowedSkills, cloudxSkillNames: [] });
    expect(policy.selected).toEqual([]);
    expect(policy.settings.skillOverrides).not.toHaveProperty("notes");
    expect(allowedSkills).toEqual(["notes"]);
  });

  it.each(["commands", "project", "CloudX", "account"])("rejects a selected name shared with %s without authorizing both sources", async source => {
    const { providerHome, cwd } = await fixture();
    const name = source === "account" ? "docx" : "notes";
    if (source === "commands") await fs.writeFile(path.join(providerHome, "commands", "notes.md"), "Other source.");
    if (source === "project") await skill(path.join(cwd, ".claude", "skills", name));
    if (source === "account") await skill(path.join(providerHome, "skills", "synced", "account-2", name));
    await expect(claudeSkillPolicy({ providerHome, cwd, allowedSkills: [name], cloudxSkillNames: source === "CloudX" ? [name] : [] }))
      .rejects.toThrow(/conflicting sources.*name-only overrides/u);
  });

  it("rejects a project skill colliding with a CloudX system skill", async () => {
    const { providerHome, cwd } = await fixture();
    await skill(path.join(cwd, ".claude", "skills", "cloudx-system-create-cloudx-skill"));
    await expect(claudeSkillPolicy({ providerHome, cwd, allowedSkills: [], cloudxSkillNames: ["cloudx-system-create-cloudx-skill"] }))
      .rejects.toThrow(/cloudx-system-create-cloudx-skill.*CloudX, project/u);
  });

  it("preserves native main-checkout discovery in a linked worktree that has none of its own", async () => {
    const { root, providerHome, repo } = await fixture();
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: repo });
    const worktree = path.join(root, "worktree");
    execFileSync("git", ["worktree", "add", "-q", "--detach", worktree], { cwd: repo });
    const policy = await claudeSkillPolicy({ providerHome, cwd: worktree, allowedSkills: [], cloudxSkillNames: [] });
    // Untracked in the main checkout, so only the inherited root skills apply.
    expect(Object.keys(policy.settings.skillOverrides as object)).not.toContain("deploy");
    expect(Object.keys(policy.settings.skillOverrides as object)).not.toContain("nested-deploy");
  });

  it("copies only allowed skill additions into the tab and passes the policy with the CloudX hooks", async () => {
    const { root, providerHome, cwd } = await fixture();
    const dataDir = path.join(root, "data");
    const accountHome = path.join(root, "account");
    await fs.mkdir(accountHome, { recursive: true });
    await fs.writeFile(path.join(accountHome, ".credentials.json"), "{}");
    const options = { dataDir, tabId: "tab-1", accountHome, providerHome, executionId: "11111111-1111-4111-8111-111111111111", cwd };

    const overlay = await materializeClaudeHomeOverlay({ ...options, allowedSkills: ["notes", "legacy"] });
    expect(await fs.readFile(path.join(overlay.configDir, "commands", "legacy.md"), "utf8")).toBe("Old command.\n");
    const entries = await fs.readdir(path.join(overlay.configDir, "skills"));
    expect(entries).toContain("notes");
    expect(entries).not.toContain("synced");
    expect(entries.filter(name => name.startsWith("cloudx-system-")).length).toBeGreaterThan(0);
    const settings = JSON.parse(await fs.readFile(overlay.settingsPath, "utf8"));
    expect(settings).toMatchObject({ disableBundledSkills: true, autoMemoryEnabled: false, syncClaudeAiSkills: false });
    expect(settings.skillOverrides.notes).toBeUndefined();
    expect(settings.skillOverrides["cloudx-system-create-cloudx-skill"]).toBeUndefined();
    expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"]);

    await materializeClaudeHomeOverlay({ ...options, allowedSkills: ["docx"] });
    expect(await fs.readFile(path.join(overlay.configDir, "skills", "docx", "SKILL.md"), "utf8")).toContain("Fixture");
    await materializeClaudeHomeOverlay({ ...options, allowedSkills: [] });
    const relaunched = await fs.readdir(path.join(overlay.configDir, "skills"));
    expect(relaunched).not.toContain("synced");
    expect(relaunched).not.toContain("notes");
    await expect(fs.readdir(path.join(overlay.configDir, "commands"))).rejects.toThrow();
  });

  it("rejects selected cross-account ambiguity before creating or replacing an overlay", async () => {
    const { root, providerHome, cwd } = await fixture();
    const dataDir = path.join(root, "data");
    await skill(path.join(providerHome, "skills", "synced", "account-2", "docx"));
    await expect(materializeClaudeHomeOverlay({ dataDir, tabId: "blocked", accountHome: path.join(root, "account"), providerHome, cwd,
      executionId: "11111111-1111-4111-8111-111111111111", allowedSkills: ["docx"] })).rejects.toThrow("conflicting sources");
    await expect(fs.stat(path.join(dataDir, "claude-launches", "blocked"))).rejects.toThrow();
  });
});
