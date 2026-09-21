import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "smol-toml";

import { discoverCodexDefaultSkills, readCodexLaunchPreferences, writeCodexLaunchPreferences } from "./CodexLaunchPreferences.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true }))); });

describe("Codex launch preferences", () => {
  it("retains existing launch defaults when no preferences were saved", () => {
    expect(readCodexLaunchPreferences(undefined)).toEqual({ yoloMode: true, autoTrustWorkspace: false, defaultSkills: { imagegen: true } });
  });

  it("reads independent choices and leaves unrelated preferences intact", () => {
    const text = '# CloudX launch preferences: {"yoloMode":false,"autoTrustWorkspace":true,"defaultSkills":{"imagegen":false,"skill-creator":true}}\nmodel = "chosen"\n';
    expect(readCodexLaunchPreferences(text)).toEqual({ yoloMode: false, autoTrustWorkspace: true, defaultSkills: { imagegen: false, "skill-creator": true } });
    expect(parse(text)).toEqual({ model: "chosen" });
  });

  it.each([
    'not JSON',
    'null',
    '[]',
    '{"yoloMode":"false"}',
    '{"autoTrustWorkspace":1}',
    '{"defaultSkills":null}',
    '{"defaultSkills":[]}',
    '{"defaultSkills":{"imagegen":"true"}}',
    '{"defaultSkills":{"../outside":true}}',
    '{"synthetic-private-token":"unknown setting"}',
  ])("rejects malformed launch preferences: %s", (text) => {
    const config = `# CloudX launch preferences: ${text}\n`;
    expect(() => readCodexLaunchPreferences(config)).toThrow(/CloudX/);
    expect(() => writeCodexLaunchPreferences(config, readCodexLaunchPreferences(undefined))).toThrow(/CloudX/);
    try { readCodexLaunchPreferences(config); } catch (error) { expect(String(error)).not.toContain("synthetic-private-token"); }
  });

  it("ignores apparent metadata inside strings and keeps native configuration unchanged", () => {
    const text = 'instructions = """\n# CloudX launch preferences: {"yoloMode":false}\n"""\n[cloudx]\nyolo_mode = false\n';
    expect(readCodexLaunchPreferences(text).yoloMode).toBe(true);
    const preferences = { ...readCodexLaunchPreferences(undefined), yoloMode: false };
    const updated = writeCodexLaunchPreferences(text, preferences);
    expect(updated.endsWith(text)).toBe(true);
    expect(readCodexLaunchPreferences(updated)).toEqual(preferences);
    expect(parse(updated)).toEqual(parse(text));
  });

  it("rejects duplicate actual metadata comments without exposing their contents", () => {
    const text = '# CloudX launch preferences: {}\nmodel = "chosen" # CloudX launch preferences: {"private":"synthetic-private-token"}\n';
    expect(() => readCodexLaunchPreferences(text)).toThrow("duplicate CloudX launch preference comments");
    expect(() => writeCodexLaunchPreferences(text, readCodexLaunchPreferences(undefined))).toThrow("duplicate CloudX launch preference comments");
  });

  it("replaces only the actual managed comment while preserving its surrounding TOML", () => {
    const text = '# Personal settings\nmodel = "chosen" # CloudX launch preferences: {"yoloMode":true}\n\n[features]\nfast_mode = true # keep\n';
    const preferences = { ...readCodexLaunchPreferences(text), yoloMode: false, autoTrustWorkspace: true };
    const updated = writeCodexLaunchPreferences(text, preferences);
    expect(updated).toBe(text.replace('# CloudX launch preferences: {"yoloMode":true}', `# CloudX launch preferences: ${JSON.stringify(preferences)}`));
    expect(readCodexLaunchPreferences(updated)).toEqual(preferences);
    expect(parse(updated)).toEqual(parse(text));
  });

  it("lists direct installed skill folders deterministically without following symlinks", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-default-skills-"));
    homes.push(home);
    await expect(discoverCodexDefaultSkills(home)).resolves.toEqual([]);
    const root = path.join(home, "skills", ".system");
    for (const id of ["skill-installer", "imagegen", "incomplete", "invalid name"]) await fs.mkdir(path.join(root, id), { recursive: true });
    for (const id of ["skill-installer", "imagegen", "invalid name"]) await fs.writeFile(path.join(root, id, "SKILL.md"), "Skill");
    await fs.symlink(path.join(root, "imagegen"), path.join(root, "linked-directory"));
    await fs.symlink(path.join(root, "imagegen", "SKILL.md"), path.join(root, "incomplete", "SKILL.md"));
    await expect(discoverCodexDefaultSkills(home)).resolves.toEqual([{ id: "imagegen" }, { id: "skill-installer" }]);
  });

  it("rejects a default skill root that redirects to another directory", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-default-skills-"));
    homes.push(home);
    await fs.mkdir(path.join(home, "skills"));
    await fs.symlink(home, path.join(home, "skills", ".system"));
    await expect(discoverCodexDefaultSkills(home)).rejects.toThrow("must be a directory");
  });
});
