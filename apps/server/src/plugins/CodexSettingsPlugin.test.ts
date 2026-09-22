import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HookRegistry } from "../hooks/HookRegistry.js";
import { readCodexLaunchPreferences, writeCodexLaunchPreferences } from "./CodexLaunchPreferences.js";
import { CodexSettingsPlugin } from "./CodexSettingsPlugin.js";
import { CodexSettingsService } from "./CodexSettingsService.js";
import { CodexUpdateService } from "./CodexUpdateService.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { materializeCodexTemplate } from "./CodexTerminalPlugin.js";

const roots: string[] = [];
const sourcesToDispose: CodexStateSources[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sourcesToDispose.splice(0).map((sources) => sources.dispose()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(config?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-settings-"));
  roots.push(root);
  const home = path.join(root, "codex-home");
  const configPath = path.join(home, "config.toml");
  await fs.mkdir(home);
  if (config !== undefined) await fs.writeFile(configPath, config);
  const instance = (name: string, codexHome = home, dependencies: ConstructorParameters<typeof CodexStateSources>[2] = {}) => {
    const dataDir = path.join(root, name);
    const sources = new CodexStateSources(dataDir, { CODEX_HOME: codexHome }, dependencies);
    sourcesToDispose.push(sources);
    return { dataDir, sources, service: new CodexSettingsService(sources) };
  };
  return { root, home, configPath, instance, ...instance("first") };
}

describe("shared Codex settings", () => {
  it("defaults installed Codex skills to disabled except image generation without writing on read", async () => {
    const f = await fixture();
    for (const id of ["imagegen", "slides", "skill-creator"]) {
      const directory = path.join(f.home, "skills", ".system", id);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "SKILL.md"), `# ${id}`);
    }
    await expect(f.service.read()).resolves.toMatchObject({
      yoloMode: true, autoTrustWorkspace: false, reasoningEffort: null, webSearch: null, personality: null,
      defaultSkills: [{ id: "imagegen", enabled: true, available: true }, { id: "skill-creator", enabled: false, available: true }, { id: "slides", enabled: false, available: true }],
    });
    await expect(fs.stat(f.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares saved launch, skill, and behavior defaults across instances and applies them only to new overlays", async () => {
    const original = '# Keep personal settings\ncustom = "keep"\n';
    const f = await fixture(original);
    for (const id of ["imagegen", "slides"]) {
      const directory = path.join(f.home, "skills", ".system", id);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "SKILL.md"), `# ${id}`);
    }
    const second = f.instance("second");
    const launch = (tabId: string) => materializeCodexTemplate(undefined, { CODEX_HOME: f.home, HOME: f.root }, { dataDir: second.dataDir, sources: second.sources, tabId, cwd: f.root });
    const before = await launch("before");
    const settings = await f.service.read();
    const saved = await f.service.update({ expectedRevision: settings.revision, yoloMode: false, autoTrustWorkspace: true,
      defaultSkills: { imagegen: false, slides: true }, reasoningEffort: "high", webSearch: "live", personality: "pragmatic" });
    await expect(second.service.read()).resolves.toEqual(saved);
    const after = await launch("after");
    expect(before.args).toContain("--yolo");
    expect(after.args).not.toContain("--yolo");
    expect(before.overlay!.skillPaths.some(file => file.endsWith("/imagegen/SKILL.md"))).toBe(true);
    expect(after.overlay!.skillPaths.some(file => file.endsWith("/imagegen/SKILL.md"))).toBe(false);
    expect(after.overlay!.skillPaths.some(file => file.endsWith("/slides/SKILL.md"))).toBe(true);
    const launched = parse(await fs.readFile(after.overlay!.configPath, "utf8"));
    expect(launched).toMatchObject({ model_reasoning_effort: "high", web_search: "live", personality: "pragmatic", projects: { [f.root]: { trust_level: "trusted" } } });
    expect(launched.cloudx).toBeUndefined();
    expect(parse(await fs.readFile(before.overlay!.configPath, "utf8")).projects).toBeUndefined();
    const text = await fs.readFile(f.configPath, "utf8");
    expect(text).toContain(original);
    expect(readCodexLaunchPreferences(text)).toMatchObject({ yoloMode: false, autoTrustWorkspace: true, defaultSkills: { imagegen: false, slides: true } });
    expect(parse(text).projects).toBeUndefined();
  });

  it.each([
    '# personal comment\n[features]\nfast_mode = false\n',
    'features.fast_mode = false\n',
    'features = { fast_mode = false }\n',
    'instructions = """\n# CloudX launch preferences: invalid marker inside a string\n"""\n',
  ])("edits managed launch preferences without discarding unrelated TOML or comments %#", async config => {
    const f = await fixture(config);
    const skill = path.join(f.home, "skills", ".system", "imagegen");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, "SKILL.md"), "# imagegen");
    const settings = await f.service.read();
    const first = await f.service.update({ expectedRevision: settings.revision, yoloMode: false, autoTrustWorkspace: true, defaultSkills: { imagegen: false } });
    await f.service.update({ expectedRevision: first.revision, yoloMode: true });
    const saved = await fs.readFile(f.configPath, "utf8");
    expect(readCodexLaunchPreferences(saved)).toEqual({ yoloMode: true, autoTrustWorkspace: true, defaultSkills: { imagegen: false } });
    expect(saved).toContain(config);
    expect(parse(saved)).toEqual(parse(config));
  });

  it("removes native behavior overrides while preserving unknown existing choices on unrelated saves", async () => {
    const f = await fixture('model_reasoning_effort = "future-effort"\nweb_search = "future-search"\npersonality = "future-personality"\n');
    const settings = await f.service.read();
    const saved = await f.service.update({ expectedRevision: settings.revision, yoloMode: false });
    expect(saved).toMatchObject({ reasoningEffort: "future-effort", webSearch: "future-search", personality: "future-personality" });
    const reset = await f.service.update({ expectedRevision: saved.revision, reasoningEffort: null, webSearch: null, personality: null });
    expect(reset).toMatchObject({ reasoningEffort: null, webSearch: null, personality: null });
    expect(parse(await fs.readFile(f.configPath, "utf8"))).toEqual({});
  });

  it("allows disabling a saved skill that is no longer installed without allowing it to be enabled", async () => {
    const f = await fixture(writeCodexLaunchPreferences("", { yoloMode: true, autoTrustWorkspace: false, defaultSkills: { imagegen: true, slides: true } }));
    const settings = await f.service.read();
    expect(settings.defaultSkills).toContainEqual({ id: "slides", enabled: true, available: false });
    expect(settings.defaultSkills).toContainEqual({ id: "imagegen", enabled: true, available: false });
    await expect(f.service.update({ expectedRevision: settings.revision, defaultSkills: { slides: true } })).rejects.toThrow(/no longer installed/);
    const saved = await f.service.update({ expectedRevision: settings.revision, defaultSkills: { slides: false, imagegen: false } });
    expect(saved.defaultSkills.every(skill => !skill.enabled)).toBe(true);
  });

  it("rejects a missing or caller-invented default skill before saving any fields", async () => {
    const f = await fixture('model = "original-model"\n');
    const settings = await f.service.read();
    await expect(f.service.update({ expectedRevision: settings.revision, yoloMode: false, defaultSkills: { absent: true } })).rejects.toThrow(/no longer installed/);
    expect(await fs.readFile(f.configPath, "utf8")).toBe('model = "original-model"\n');
  });

  it.each(['# CloudX launch preferences: {"yoloMode":"true"}', '# CloudX launch preferences: {"autoTrustWorkspace":1}', '# CloudX launch preferences: {"defaultSkills":[]}', '# CloudX launch preferences: {"defaultSkills":{"imagegen":"yes"}}', 'web_search = false'])
  ("rejects invalid persisted settings without exposing unrelated values: %s", async malformed => {
    const f = await fixture(`private_token = "synthetic-private-token"\n${malformed}\n`);
    await expect(f.service.read()).rejects.toThrow(/Codex|CloudX/);
    const message = await f.service.read().catch((error: Error) => error.message);
    expect(message).not.toContain("synthetic-private-token");
  });

  it("makes a saved model visible to another CloudX instance and after reopening", async () => {
    const f = await fixture('model = "original-model"\nservice_tier = "priority"\n');
    const second = f.instance("second");
    const original = await second.service.read();

    const saved = await f.service.update({ expectedRevision: original.revision, model: "chosen-model" });

    expect(saved).toMatchObject({ model: "chosen-model", serviceTier: "priority" });
    expect(saved.revision).not.toBe(original.revision);
    await expect(second.service.read()).resolves.toEqual(saved);
    await expect(f.instance("reopened").service.read()).resolves.toEqual(saved);
    expect(await fs.readFile(f.configPath, "utf8")).toContain('model = "chosen-model"');
  });

  it("changes only the selected model while preserving comments and unknown settings", async () => {
    const original = '# Personal defaults\n"model" = \'original-model\' # preferred model\nservice_tier = "flex"\ncustom = { token = "synthetic-private-token", enabled = true }\n\n[features]\nfast_mode = false # intentionally disabled\nother_feature = true\n';
    const f = await fixture(original);
    const settings = await f.service.read();

    const saved = await f.service.update({ expectedRevision: settings.revision, model: "chosen-model" });

    expect(await fs.readFile(f.configPath, "utf8")).toBe(original.replace("'original-model'", '"chosen-model"'));
    expect(saved).toMatchObject({ model: "chosen-model", serviceTier: "flex", fastModeEnabled: false });
    expect(JSON.stringify(saved)).not.toContain("synthetic-private-token");
    expect(Object.keys(saved).sort()).toEqual(["autoTrustWorkspace", "defaultSkills", "fastModeEnabled", "model", "personality", "reasoningEffort", "revision", "serviceTier", "webSearch", "yoloMode"]);
  });

  it.each(["priority", "default", "flex"] as const)("saves service tier %s and enables Codex's fast-mode feature", async (serviceTier) => {
    const f = await fixture('model = "original-model"\n[features]\nfast_mode = false\nother_feature = true\n');
    const settings = await f.service.read();

    const saved = await f.service.update({ expectedRevision: settings.revision, serviceTier });

    expect(saved).toMatchObject({ model: "original-model", serviceTier, fastModeEnabled: true });
    expect(parse(await fs.readFile(f.configPath, "utf8"))).toEqual({
      model: "original-model",
      service_tier: serviceTier,
      features: { fast_mode: true, other_feature: true },
    });
  });

  it("removes explicit defaults while preserving the existing fast-mode feature", async () => {
    const f = await fixture('model = "original-model" # model choice\nservice_tier = "priority"\n[features]\nfast_mode = true\n');
    const settings = await f.service.read();

    const saved = await f.service.update({ expectedRevision: settings.revision, model: null, serviceTier: null });

    expect(saved).toMatchObject({ model: null, serviceTier: null, fastModeEnabled: true });
    expect(parse(await fs.readFile(f.configPath, "utf8"))).toEqual({ features: { fast_mode: true } });
  });

  it.each([
    ['["features"]\n"fast_mode" = false\nother_feature = true\n', { fast_mode: true, other_feature: true }],
    ['features.fast_mode = false\nfeatures.other_feature = true\n', { fast_mode: true, other_feature: true }],
    ['features = { fast_mode = false, other_feature = true }\n', { fast_mode: true, other_feature: true }],
    ['features = { other_feature = true }\n', { fast_mode: true, other_feature: true }],
    ['[features.nested]\nenabled = true\n', { fast_mode: true, nested: { enabled: true } }],
  ])("updates valid alternative TOML feature syntax %# without discarding other features", async (config, features) => {
    const f = await fixture(config);
    const settings = await f.service.read();

    await f.service.update({ expectedRevision: settings.revision, serviceTier: "priority" });

    expect(parse(await fs.readFile(f.configPath, "utf8"))).toEqual({ service_tier: "priority", features });
  });

  it("preserves multiline strings containing text that looks like settings", async () => {
    const notes = 'instructions = """\nmodel = "inside-notes"\n[features]\nfast_mode = false\n"""\n';
    const f = await fixture(`${notes}model = "original-model"\n`);
    const settings = await f.service.read();

    await f.service.update({ expectedRevision: settings.revision, model: "chosen-model", serviceTier: "priority" });

    const config = await fs.readFile(f.configPath, "utf8");
    expect(config).toContain(notes);
    expect(parse(config)).toMatchObject({
      model: "chosen-model",
      service_tier: "priority",
      features: { fast_mode: true },
      instructions: 'model = "inside-notes"\n[features]\nfast_mode = false\n',
    });
  });

  it("rejects a stale edit after an external config change without overwriting it", async () => {
    const f = await fixture('model = "original-model"\n');
    const settings = await f.service.read();
    const external = 'model = "edited-elsewhere"\ncustom = "keep this"\n';
    await fs.writeFile(f.configPath, external);

    await expect(f.service.update({ expectedRevision: settings.revision, model: "stale-choice" })).rejects.toThrow(/changed|revision|reload|conflict/i);

    expect(await fs.readFile(f.configPath, "utf8")).toBe(external);
  });

  it("allows only one concurrent save from the same revision across CloudX instances", async () => {
    const f = await fixture('model = "original-model"\n');
    const second = f.instance("second");
    const settings = await f.service.read();

    const results = await Promise.allSettled([
      f.service.update({ expectedRevision: settings.revision, model: "first-choice" }),
      second.service.update({ expectedRevision: settings.revision, model: "second-choice" }),
    ]);

    const accepted = results.filter((result) => result.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(second.service.read()).resolves.toEqual(accepted[0]!.value);
    expect(parse(await fs.readFile(f.configPath, "utf8")).model).toBe(accepted[0]!.value.model);
  });

  it.each(["write", "sync", "rename"])("preserves the config and releases owned files after a %s failure", async (stage) => {
    const original = 'model = "original-model"\n';
    const f = await fixture(original);
    const failure = Object.assign(new Error(`Synthetic ${stage} failure`), { code: "ENOSPC" });
    const writer = f.instance("failing-writer", f.home, {
      fs: {
        ...fs,
        rename: async (...args: Parameters<typeof fs.rename>) => {
          if (stage === "rename") throw failure;
          await fs.rename(...args);
        },
        open: async (...args: Parameters<typeof fs.open>) => {
          const file = await fs.open(...args);
          if (String(args[0]).endsWith(".tmp")) {
            if (stage === "write") file.writeFile = async () => { throw failure; };
            if (stage === "sync") file.sync = async () => { throw failure; };
          }
          return file;
        },
      },
    });
    const settings = await writer.service.read();

    await expect(writer.service.update({ expectedRevision: settings.revision, model: "chosen-model" })).rejects.toMatchObject({ code: "ENOSPC" });

    expect(await fs.readFile(f.configPath, "utf8")).toBe(original);
    expect(await fs.readdir(f.home)).toEqual(["config.toml"]);
    await expect(f.service.update({ expectedRevision: settings.revision, model: "after-failure" })).resolves.toMatchObject({ model: "after-failure" });
  });

  it("rejects an external edit made while the replacement is being written", async () => {
    const f = await fixture('model = "original-model"\n');
    const external = 'model = "external-choice"\n';
    const writer = f.instance("racing-writer", f.home, {
      fs: {
        ...fs,
        open: async (...args: Parameters<typeof fs.open>) => {
          const file = await fs.open(...args);
          if (String(args[0]).endsWith(".tmp")) {
            const write = file.writeFile.bind(file);
            file.writeFile = async (...writeArgs: Parameters<typeof file.writeFile>) => {
              await write(...writeArgs);
              await fs.writeFile(f.configPath, external);
            };
          }
          return file;
        },
      },
    });
    const settings = await writer.service.read();

    await expect(writer.service.update({ expectedRevision: settings.revision, model: "chosen-model" })).rejects.toThrow(/changed|reload|conflict/i);

    expect(await fs.readFile(f.configPath, "utf8")).toBe(external);
    expect(await fs.readdir(f.home)).toEqual(["config.toml"]);
  });

  it("keeps an existing writer's lock intact when refusing another save", async () => {
    const original = 'model = "original-model"\n';
    const f = await fixture(original);
    const settings = await f.service.read();
    const lock = path.join(f.home, ".cloudx-config.lock");
    await fs.writeFile(lock, "another writer owns this lock\n");

    await expect(f.service.update({ expectedRevision: settings.revision, model: "chosen-model" })).rejects.toThrow(/edited|lock|save/i);

    expect(await fs.readFile(lock, "utf8")).toBe("another writer owns this lock\n");
    expect(await fs.readFile(f.configPath, "utf8")).toBe(original);
  });

  it("reads absent defaults and creates a missing config when saved", async () => {
    const f = await fixture();
    const settings = await f.service.read();
    expect(settings).toMatchObject({ model: null, serviceTier: null, fastModeEnabled: null });
    await expect(fs.stat(f.configPath)).rejects.toMatchObject({ code: "ENOENT" });

    const saved = await f.service.update({ expectedRevision: settings.revision, model: "chosen-model", serviceTier: "priority" });

    expect(saved).toMatchObject({ model: "chosen-model", serviceTier: "priority", fastModeEnabled: true });
    expect(parse(await fs.readFile(f.configPath, "utf8"))).toEqual({ model: "chosen-model", service_tier: "priority", features: { fast_mode: true } });
    expect((await fs.stat(f.configPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects malformed TOML without returning its contents or overwriting it", async () => {
    const f = await fixture('model = "original-model"\n');
    const settings = await f.service.read();
    const malformed = 'private_token = "synthetic-private-token"\nmodel = [unfinished\n';
    await fs.writeFile(f.configPath, malformed);

    for (const operation of [() => f.service.read(), () => f.service.update({ expectedRevision: settings.revision, model: "chosen-model" })]) {
      const result = await operation().then(() => "accepted", (error: Error) => error.message);
      expect(result).not.toBe("accepted");
      expect(result).not.toContain("synthetic-private-token");
      expect(result).not.toContain("unfinished");
    }
    expect(await fs.readFile(f.configPath, "utf8")).toBe(malformed);
  });

  it("rejects a symlink config without changing the file it targets", async () => {
    const f = await fixture('model = "original-model"\n');
    const settings = await f.service.read();
    const target = path.join(f.root, "private-config.toml");
    await fs.rename(f.configPath, target);
    await fs.symlink(target, f.configPath);

    await expect(f.service.read()).rejects.toThrow();
    await expect(f.service.update({ expectedRevision: settings.revision, model: "chosen-model" })).rejects.toThrow();

    expect((await fs.lstat(f.configPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe('model = "original-model"\n');
  });

  it("rejects a symlink Codex home", async () => {
    const f = await fixture('model = "original-model"\n');
    const settings = await f.service.read();
    const alias = path.join(f.root, "linked-home");
    await fs.symlink(f.home, alias);
    const linked = f.instance("linked-instance", alias);

    await expect(linked.service.read()).rejects.toThrow();
    await expect(linked.service.update({ expectedRevision: settings.revision, model: "chosen-model" })).rejects.toThrow();

    expect(await fs.readFile(f.configPath, "utf8")).toBe('model = "original-model"\n');
  });

  it("rejects configs larger than one MiB without overwriting them", async () => {
    const f = await fixture('model = "original-model"\n');
    const settings = await f.service.read();
    const oversized = `#${"x".repeat(1_048_576)}\n`;
    await fs.writeFile(f.configPath, oversized);

    await expect(f.service.read()).rejects.toThrow(/size|limit|large/i);
    await expect(f.service.update({ expectedRevision: settings.revision, model: "chosen-model" })).rejects.toThrow();

    expect(await fs.readFile(f.configPath, "utf8")).toBe(oversized);
  });

  it("uses saved defaults in new launches from another CloudX instance", async () => {
    const f = await fixture('model = "original-model"\n');
    const skill = path.join(f.home, "skills", ".system", "imagegen");
    await fs.mkdir(path.join(skill, "scripts"), { recursive: true });
    await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: imagegen\ndescription: Generate images.\n---\n\nImage generation instructions.\n");
    await fs.writeFile(path.join(skill, "scripts", "image_gen.py"), "# imagegen helper\n");
    const second = f.instance("second");
    const launch = (tabId: string) => materializeCodexTemplate(undefined, { CODEX_HOME: f.home, HOME: f.root }, { dataDir: second.dataDir, sources: second.sources, tabId });
    const firstLaunch = await launch("before-save");
    const settings = await f.service.read();

    await f.service.update({ expectedRevision: settings.revision, model: "chosen-model", serviceTier: "priority" });
    const secondLaunch = await launch("after-save");

    expect(parse(await fs.readFile(secondLaunch.overlay!.configPath, "utf8"))).toMatchObject({ model: "chosen-model", service_tier: "priority", features: { fast_mode: true } });
    expect(parse(await fs.readFile(firstLaunch.overlay!.configPath, "utf8")).model).toBe("original-model");
  });

  it("cancels a staged save and waits for its files to close during shutdown", async () => {
    const original = 'model = "original-model"\n';
    const f = await fixture(original);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const sources = new CodexStateSources(f.dataDir, { CODEX_HOME: f.home }, { fs: {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        if (String(args[0]).endsWith(".tmp")) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...writeArgs) => {
            enter();
            await released;
            return write(...writeArgs);
          };
        }
        return handle;
      },
    } });
    const service = new CodexSettingsService(sources);
    const settings = await service.read();
    const controller = new AbortController();
    const saving = service.update({ expectedRevision: settings.revision, model: "chosen-model" }, controller.signal);
    const rejected = expect(saving).rejects.toThrow(/cancelled/);
    await entered;
    controller.abort();
    await rejected;
    let disposed = false;
    const disposal = sources.dispose().then(() => { disposed = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(disposed).toBe(false);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(original);
    } finally {
      release();
      await disposal;
    }
    expect(await fs.readdir(f.home)).toEqual(["config.toml"]);
    expect(await fs.readFile(f.configPath, "utf8")).toBe(original);
  });
});

describe("Codex settings plugin boundary", () => {
  async function pluginFixture() {
    const f = await fixture('model = "original-model"\n');
    const plugin = new CodexSettingsPlugin(f.service, new CodexUpdateService(f.dataDir));
    const hooks = new HookRegistry();
    plugin.hooks.forEach((hook) => hooks.register(hook));
    return { ...f, plugin, hooks };
  }

  it.each(["ui", "http"] as const)("reads and updates shared defaults through the %s hook boundary", async (kind) => {
    const f = await pluginFixture();
    const settings = await f.service.read();

    await expect(f.hooks.call("codex-settings.read", {}, { caller: { kind } })).resolves.toEqual({ settings });
    await expect(f.hooks.call("codex-settings.update", { expectedRevision: settings.revision, model: "chosen-model" }, { caller: { kind } })).resolves.toMatchObject({ settings: { model: "chosen-model" } });
    expect(f.plugin.descriptor()).toMatchObject({ id: "codex-settings", creatable: false, requiresDirectory: false });
  });

  it("exposes settings hooks without offering a workspace tab", async () => {
    const { plugin } = await pluginFixture();
    expect(plugin.descriptor().uiContributions?.some(contribution => contribution.slot === "plugin.panel")).toBe(false);
    expect(() => plugin.createSession()).toThrow("Settings > Codex");
  });

  it.each([
    { expectedRevision: undefined },
    { expectedRevision: "" },
    { expectedRevision: 42 },
    { model: 42 },
    { model: "" },
    { model: " " },
    { model: "chosen-model\nother = true" },
    { model: "x".repeat(1_025) },
    { serviceTier: "turbo" },
    { serviceTier: true },
    { path: "/private/config.toml" },
    { codexHome: "/private" },
    { fastModeEnabled: true },
    { yoloMode: "true" },
    { autoTrustWorkspace: null },
    { reasoningEffort: "imaginary" },
    { webSearch: true },
    { personality: "funny" },
    { defaultSkills: [] },
    { defaultSkills: { "../private": true } },
    { defaultSkills: { imagegen: "yes" } },
  ])("rejects invalid settings input before the service can change files %#", async (invalid) => {
    const f = await pluginFixture();
    const settings = await f.service.read();
    const update = vi.spyOn(f.service, "update");

    await expect(f.hooks.call("codex-settings.update", { expectedRevision: settings.revision, model: "chosen-model", ...invalid }, { caller: { kind: "ui" } })).rejects.toThrow(/input/i);

    expect(update).not.toHaveBeenCalled();
    expect(await fs.readFile(f.configPath, "utf8")).toBe('model = "original-model"\n');
  });

  it("rejects caller-selected paths when reading shared defaults", async () => {
    const f = await pluginFixture();
    const read = vi.spyOn(f.service, "read");

    await expect(f.hooks.call("codex-settings.read", { path: "/private/config.toml" }, { caller: { kind: "ui" } })).rejects.toThrow(/input/i);

    expect(read).not.toHaveBeenCalled();
  });
});
