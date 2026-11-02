import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertClaudeCatalogOwnership, assertClaudeManagedCompatibility } from "./ClaudeManagedPolicy.js";
import { materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";
import { readClaudeSkillSnapshot, writeClaudeSkillSnapshot } from "./ClaudeSkillSnapshot.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-managed-policy-")); roots.push(root);
  const providerHome = path.join(root, "personal"); const cwd = path.join(root, "project"); const accountHome = path.join(root, "account");
  await Promise.all([providerHome, cwd, accountHome].map(directory => fs.mkdir(directory)));
  const managed = path.join(root, "policy", "managed-settings.json");
  const options = { dataDir: path.join(root, "data"), tabId: "one", providerHome, cwd, accountHome, executionId: "11111111-1111-4111-8111-111111111111", nativeVersion: "2.1.316", launchMode: "cloudx-managed" as const };
  return { root, managed, options, check: () => assertClaudeManagedCompatibility({ ...options, skillNames: ["notes"] }, [managed]) };
}
async function write(file: string, content: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }

it("rejects unsupported versions and existing local inputs before materializing any launch", async () => {
  const { options } = await fixture();
  await expect(materializeClaudeHomeOverlay({ ...options, nativeVersion: "2.1.315" })).rejects.toThrow("verified only");
  for (const [file, body] of [[path.join(options.cwd, "CLAUDE.local.md"), "Keep local instructions"], [path.join(options.cwd, ".claude", "settings.local.json"), '{"permissions":{"deny":["Bash"]}}']]) {
    await write(file!, body!);
    await expect(materializeClaudeHomeOverlay(options)).rejects.toThrow("Choose Native project");
    await expect(fs.stat(path.join(options.dataDir, "claude-launches"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(file!, "utf8")).toBe(body);
    await fs.unlink(file!);
  }
});

it.each([
  { strictPluginOnlyCustomization: ["skills"] }, { policyHelper: { path: "unobserved" } },
  { enabledPlugins: { "unexpected@market": true } }, { extraKnownMarketplaces: { unexpected: {} } },
  { skillOverrides: { notes: "off" } }, { disableBundledSkills: false }, { skillOverrides: { design: "on" } }, { env: { DISABLE_DOCTOR_COMMAND: "" } }, { env: { CLAUDE_CODE_PLUGIN_DIRS: "/other" } }
])("rejects incompatible administrator policy without rewriting it: %j", async policy => {
  const { managed, check } = await fixture();
  const original = JSON.stringify(policy); await write(managed, original);
  await expect(check()).rejects.toThrow("CloudX-managed Claude cannot use");
  expect(await fs.readFile(managed, "utf8")).toBe(original);
});

it("preserves compatible managed permissions and diagnoses unmanaged policy skill trees", async () => {
  const { managed, check } = await fixture();
  await write(managed, JSON.stringify({ permissions: { deny: ["Bash"] }, allowManagedPermissionRulesOnly: true }));
  await expect(check()).resolves.toBeUndefined();
  await write(path.join(path.dirname(managed), ".claude", "skills", "admin", "SKILL.md"), "Administrator skill.");
  await expect(check()).rejects.toThrow("managed skills/commands");
});

it("supplies immutable selected personal and account-scoped synced snapshots and records their actual native source", async () => {
  const { options } = await fixture();
  const personal = path.join(options.providerHome, "skills", "notes", "SKILL.md");
  const synced = path.join(options.providerHome, "skills", "synced", "account-one", "docx", "SKILL.md");
  await write(personal, "---\ndescription: Selected personal.\n---\nFirst notes.");
  await write(synced, "---\ndescription: Selected synced.\n---\nFirst document.");
  await write(path.join(options.providerHome, "settings.json"), '{"permissions":{"deny":["Bash"]}}');
  const first = await materializeClaudeHomeOverlay({ ...options, allowedSkills: ["notes", "docx"] });
  expect(first.configurationArgs).toEqual(["--setting-sources", "user"]);
  expect(first.launchPolicy).toMatchObject({ mode: "cloudx-managed", exclusiveSkills: true, activation: "next-launch", settingSources: ["user"] });
  expect(first.launchPolicy.skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: "docx", origin: "synced", nativeSource: "user", account: "account-one", sourcePath: path.dirname(synced) })]));
  expect((await fs.lstat(path.join(first.configDir, "plugins"))).isFile()).toBe(true);
  expect((await fs.lstat(path.join(first.configDir, "skills", "notes"))).isSymbolicLink()).toBe(false);
  await write(personal, "Second notes."); await write(synced, "Second document.");
  await write(path.join(options.providerHome, "settings.json"), '{"language":"french"}');
  expect(await fs.readFile(path.join(first.configDir, "skills", "notes", "SKILL.md"), "utf8")).toContain("First notes");
  expect(await fs.readFile(path.join(first.configDir, "settings.json"), "utf8")).not.toContain("french");
  const second = await materializeClaudeHomeOverlay({ ...options, tabId: "two", allowedSkills: ["docx"] });
  expect(await fs.readFile(path.join(second.configDir, "skills", "docx", "SKILL.md"), "utf8")).toBe("Second document.");
  await expect(fs.stat(path.join(second.configDir, "skills", "notes"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(first.launchPolicy.skills.find(skill => skill.name === "docx")!.sha256).not.toBe(second.launchPolicy.skills.find(skill => skill.name === "docx")!.sha256);
  expect(await fs.readFile(path.join(first.configDir, "skills", "docx", "SKILL.md"), "utf8")).toContain("First document");
});

it("ignores same-name excluded project sources but refuses selected cross-account collisions", async () => {
  const { options } = await fixture();
  for (const target of [path.join(options.providerHome, "skills", "synced", "one", "docx"), path.join(options.cwd, ".claude", "skills", "docx")]) await write(path.join(target, "SKILL.md"), "---\ndescription: Selected.\n---\nBody");
  await expect(materializeClaudeHomeOverlay({ ...options, allowedSkills: ["docx"] })).resolves.toMatchObject({ launchPolicy: { exclusiveSkills: true } });
  await write(path.join(options.providerHome, "skills", "synced", "two", "docx", "SKILL.md"), "Other account.");
  await expect(materializeClaudeHomeOverlay({ ...options, tabId: "two", allowedSkills: ["docx"] })).rejects.toThrow("conflicting sources");
});

it("copies supporting files and rejects links outside a selected source instead of retaining mutable aliases", async () => {
  const { root } = await fixture(); const source = path.join(root, "skill");
  await write(path.join(source, "SKILL.md"), "Body"); await write(path.join(source, "scripts", "run.sh"), "echo fixture");
  const snapshot = await readClaudeSkillSnapshot(source);
  expect(snapshot.files.map(file => file.relative)).toEqual(["SKILL.md", "scripts/run.sh"]);
  await write(path.join(root, "outside.md"), "Unselected bytes");
  await fs.symlink(path.join(root, "outside.md"), path.join(source, "mutable.md"));
  await expect(readClaudeSkillSnapshot(source)).rejects.toThrow("not self-contained");
});


it("rejects main-checkout local settings inherited by a linked worktree outside its ancestry", async () => {
  const { root, options } = await fixture();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: options.cwd });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "Fixture"], { cwd: options.cwd });
  const worktree = path.join(root, "linked");
  execFileSync("git", ["worktree", "add", "-q", "--detach", worktree], { cwd: options.cwd });
  const local = path.join(options.cwd, ".claude", "settings.local.json");
  await write(local, '{"permissions":{"deny":["Bash"]}}');
  await expect(materializeClaudeHomeOverlay({ ...options, cwd: worktree })).rejects.toThrow(`cannot use ${local}`);
  expect(await fs.readFile(local, "utf8")).toContain("Bash");
});


it("preserves required CloudX ownership in both modes by rejecting incompatible native or administrator suppression", async () => {
  const { managed, options } = await fixture();
  await write(managed, JSON.stringify({ strictPluginOnlyCustomization: true }));
  await expect(assertClaudeCatalogOwnership(options.providerHome, ["cloudx-system-owned"], [managed])).rejects.toThrow("prevents required CloudX skills");
  await write(managed, "{}");
  await write(path.join(path.dirname(managed), ".claude", "skills", "cloudx-system-owned", "SKILL.md"), "Conflicting administrator source.");
  await expect(assertClaudeCatalogOwnership(options.providerHome, ["cloudx-system-owned"], [managed])).rejects.toThrow("conflicts with the required CloudX skill");
  await write(path.join(options.providerHome, "settings.json"), JSON.stringify({ skillOverrides: { "cloudx-system-owned": "off" } }));
  await expect(assertClaudeCatalogOwnership(options.providerHome, ["cloudx-system-owned"], [])).rejects.toThrow("disables required CloudX skill");
});


it("bounds selected source bytes and directory entries while retaining executable support-file modes", async () => {
  const { root } = await fixture(); const source = path.join(root, "bounded");
  await write(path.join(source, "SKILL.md"), "Skill body.");
  const script = path.join(source, "scripts", "run.sh"); await write(script, "echo local"); await fs.chmod(script, 0o751);
  await expect(readClaudeSkillSnapshot(source, { bytes: 1, entries: 100 })).rejects.toThrow("bounded snapshot size");
  await expect(readClaudeSkillSnapshot(source, { bytes: 100, entries: 1 })).rejects.toThrow("bounded snapshot entry count");
  const snapshot = await readClaudeSkillSnapshot(source);
  const target = path.join(root, "copied"); await writeClaudeSkillSnapshot(snapshot, target);
  expect((await fs.stat(path.join(target, "scripts", "run.sh"))).mode & 0o777).toBe(0o751);
  expect((await readClaudeSkillSnapshot(target)).sha256).toBe(snapshot.sha256);
  await fs.symlink(source, path.join(source, "cycle"));
  await expect(readClaudeSkillSnapshot(source)).rejects.toThrow("cyclic directory link");
});

it("bounds the combined selected snapshots before materializing the overlay", async () => {
  const { options } = await fixture();
  for (const name of ["first", "second"]) {
    const directory = path.join(options.providerHome, "skills", name);
    await write(path.join(directory, "SKILL.md"), "---\ndescription: Selected.\n---\nBody.");
    const asset = path.join(directory, "large.fixture"); await write(asset, ""); await fs.truncate(asset, 64 * 1024 * 1024);
  }
  await expect(materializeClaudeHomeOverlay({ ...options, allowedSkills: ["first", "second"] })).rejects.toThrow("bounded snapshot size");
  await expect(fs.stat(path.join(options.dataDir, "claude-launches"))).rejects.toMatchObject({ code: "ENOENT" });
});


it.each(["settings.json", "settings.local.json"])("rejects suppression of required CloudX system and template skills in loaded Native project %s", async file => {
  const { options } = await fixture();
  const source = path.join(options.cwd, ".claude", file);
  for (const name of ["cloudx-system-create-cloudx-skill", "cloudx-template-owned"]) {
    const original = JSON.stringify({ skillOverrides: { [name]: "off" } });
    await write(source, original);
    await expect(assertClaudeCatalogOwnership(options.providerHome, [name], [], { cwd: options.cwd, mode: "native-project" })).rejects.toThrow(`disables required CloudX skill ${name}`);
    expect(await fs.readFile(source, "utf8")).toBe(original);
  }
});
