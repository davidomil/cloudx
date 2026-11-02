import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { assertClaudeInstructionSourceCompatibility } from "./ClaudeInstructionPolicy.js";

const roots: string[] = [];
const run = promisify(execFile);
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(personalRoot = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-instruction-policy-"));
  roots.push(root);
  const providerHome = path.join(root, "personal home", ".claude");
  const cwd = path.join(root, "project", "nested");
  await fs.mkdir(providerHome, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  if (personalRoot) await fs.writeFile(path.join(providerHome, "CLAUDE.md"), "PERSONAL_SOURCE_MARKER\n");
  return {
    root, providerHome, cwd,
    write: async (file: string, settings: unknown) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(settings));
      return fs.readFile(file, "utf8");
    },
    check: (managed: string[] = []) => assertClaudeInstructionSourceCompatibility(providerHome, cwd, managed)
  };
}

it.each([
  { name: "absent", value: undefined }, { name: "empty list", value: [] }, { name: "empty pattern", value: [""] }
])("accepts native personal sources without active exclusions ($name)", async ({ value: claudeMdExcludes }) => {
  const input = await fixture();
  await input.write(path.join(input.providerHome, "settings.json"), { claudeMdExcludes });
  await expect(input.check()).resolves.toBeUndefined();
});

it("leaves native rule exclusions available when no personal root is aliased", async () => {
  const input = await fixture(false);
  await input.write(path.join(input.providerHome, "settings.json"), { claudeMdExcludes: ["**/.claude/rules/skip.md"] });
  await expect(input.check()).resolves.toBeUndefined();
});

it.each(["user", "project", "local", "ancestor", "managed", "fragment"])("rejects the unsupported personal root and %s exclusion combination without changing its source", async layer => {
  const input = await fixture();
  const managed = path.join(input.root, "managed", "managed-settings.json");
  const sources: Record<string, string> = {
    user: path.join(input.providerHome, "settings.json"),
    project: path.join(input.cwd, ".claude", "settings.json"),
    local: path.join(input.cwd, ".claude", "settings.local.json"),
    ancestor: path.join(path.dirname(input.cwd), ".claude", "settings.local.json"),
    managed,
    fragment: path.join(path.dirname(managed), "managed-settings.d", "20-memory.json")
  };
  const file = sources[layer]!;
  const content = await input.write(file, { claudeMdExcludes: [path.join(input.providerHome, "CLAUDE.md")], env: { ANTHROPIC_API_KEY: "fake-secret-not-for-errors" } });
  await expect(input.check([managed])).rejects.toThrow(`claudeMdExcludes in ${file}`);
  await expect(input.check([managed])).rejects.toThrow("Launch Claude directly with the original personal configuration");
  try { await input.check([managed]); }
  catch (error) { expect(String(error)).not.toContain("fake-secret-not-for-errors"); }
  expect(await fs.readFile(file, "utf8")).toBe(content);
  expect(await fs.readFile(path.join(input.providerHome, "CLAUDE.md"), "utf8")).toBe("PERSONAL_SOURCE_MARKER\n");
});

it("does not treat an empty higher layer as clearing merged native exclusion arrays", async () => {
  const input = await fixture();
  await input.write(path.join(input.providerHome, "settings.json"), { claudeMdExcludes: ["**/CLAUDE.md"] });
  await input.write(path.join(input.cwd, ".claude", "settings.local.json"), { claudeMdExcludes: [] });
  await expect(input.check()).rejects.toThrow(path.join(input.providerHome, "settings.json"));
});

it.each([
  { name: "null", value: null }, { name: "string", value: "**/CLAUDE.md" }, { name: "null entry", value: [null] }, { name: "number entry", value: [1] }
])("rejects unverified exclusion values without returning configuration contents ($name)", async ({ value: claudeMdExcludes }) => {
  const input = await fixture();
  const file = path.join(input.providerHome, "settings.json");
  await input.write(file, { claudeMdExcludes });
  await expect(input.check()).rejects.toThrow(`claudeMdExcludes in ${file}`);
});

it("diagnoses unreadable settings with the source and key, and ignores hidden or non-JSON managed fragments", async () => {
  const input = await fixture();
  const managed = path.join(input.root, "managed-settings.json");
  const directory = path.join(input.root, "managed-settings.d");
  await input.write(path.join(directory, ".hidden.json"), { claudeMdExcludes: ["**/CLAUDE.md"] });
  await input.write(path.join(directory, "ignored.txt"), { claudeMdExcludes: ["**/CLAUDE.md"] });
  await expect(input.check([managed])).resolves.toBeUndefined();
  const file = path.join(input.providerHome, "settings.json");
  await fs.writeFile(file, '{"env":{"ANTHROPIC_API_KEY":"fake-private-value"},');
  await expect(input.check([managed])).rejects.toThrow(`Cannot verify Claude claudeMdExcludes in ${file}`);
  try { await input.check([managed]); }
  catch (error) { expect(String(error)).not.toContain("fake-private-value"); }
});

it("diagnoses an unreadable managed fragments directory before reading policy values", async () => {
  const input = await fixture();
  const managed = path.join(input.root, "managed-settings.json");
  const directory = path.join(input.root, "managed-settings.d");
  await fs.writeFile(directory, "not a directory");
  await expect(input.check([managed])).rejects.toThrow(`Cannot verify Claude claudeMdExcludes in ${directory}`);
});

it("diagnoses a personal source that cannot be resolved", async () => {
  const input = await fixture(false);
  const source = path.join(input.providerHome, "CLAUDE.md");
  await fs.symlink(source, source);
  await expect(input.check()).rejects.toThrow(`Cannot verify the Claude personal instruction source at ${source}`);
});

it("checks the native local settings owner in a main checkout outside the linked worktree's ancestors", async () => {
  const input = await fixture();
  const main = path.join(input.root, "main");
  const linked = path.join(input.root, "linked");
  await fs.mkdir(main);
  await run("git", ["init", "-q", main]);
  await run("git", ["-C", main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Fixture"]);
  await run("git", ["-C", main, "worktree", "add", "-qb", "linked", linked]);
  const source = path.join(main, ".claude", "settings.local.json");
  await input.write(source, { claudeMdExcludes: [path.join(input.providerHome, "CLAUDE.md")] });
  await expect(assertClaudeInstructionSourceCompatibility(input.providerHome, linked, [])).rejects.toThrow(`claudeMdExcludes in ${source}`);
});

it("diagnoses linked metadata that cannot establish the native local-settings owner", async () => {
  const input = await fixture();
  const entry = path.join(input.cwd, ".git");
  await fs.writeFile(entry, "gitdir: missing\n");
  await expect(input.check()).rejects.toThrow(`Cannot verify Claude claudeMdExcludes sources through ${entry}`);
});
