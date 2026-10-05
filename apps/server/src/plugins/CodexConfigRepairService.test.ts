import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { parseCodexConfigRepairPreview } from "@cloudx/shared";

import { HookRegistry } from "../hooks/HookRegistry.js";
import { CodexConfigRepairService } from "./CodexConfigRepairService.js";
import { CodexSettingsService } from "./CodexSettingsService.js";
import { CodexSettingsPlugin } from "./CodexSettingsPlugin.js";
import { CodexUpdateService } from "./CodexUpdateService.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { materializeCodexTemplate } from "./CodexTerminalPlugin.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

const legacyConfig = 'hide_full_access_warning = true\n[features]\nghost_commit = true\nstreamable_shell = true\n';

async function fixture(config = legacyConfig, version = "0.160.0") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-repair-"));
  disposals.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "source");
  const dataDir = path.join(root, "data");
  await fs.mkdir(home);
  const configPath = path.join(home, "config.toml");
  await fs.writeFile(configPath, config);
  const imagegen = path.join(home, "skills", ".system", "imagegen");
  await fs.mkdir(imagegen, { recursive: true });
  await fs.writeFile(path.join(imagegen, "SKILL.md"), "---\nname: imagegen\ndescription: Isolated test skill.\n---\n");
  const command = path.join(root, "selected-codex");
  const setVersion = (version: string) => fs.writeFile(command, `#!/bin/sh\nprintf '%s\\n' 'codex-cli ${version}'\n`, { mode: 0o700 });
  await setVersion(version);
  const env = { HOME: root, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: command, PATH: process.env.PATH };
  const sources = new CodexStateSources(dataDir, env);
  disposals.push(() => sources.dispose());
  const service = new CodexConfigRepairService(sources, env);
  return { root, home, dataDir, configPath, command, setVersion, env, sources, service };
}

describe("reviewed shared Codex configuration repair", () => {
  it("identifies the selected executable and source without editing or exposing values", async () => {
    const f = await fixture(`private_token = "synthetic-secret"\n${legacyConfig}`);
    const before = await fs.readFile(f.configPath, "utf8");
    const preview = await f.service.read();
    expect(preview).toMatchObject({ sourceConfigPath: f.configPath, selectedCommand: f.command, selectedVersion: "0.160.0", canApply: true, blockedReason: null });
    expect(preview.changes).toHaveLength(3);
    expect(JSON.stringify(preview)).not.toContain("synthetic-secret");
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
    expect(parseCodexConfigRepairPreview(preview)).toEqual(preview);
  });

  it("uses the selected executable even when PATH offers a different release", async () => {
    const f = await fixture();
    const bin = path.join(f.root, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "codex"), "#!/bin/sh\nprintf 'codex-cli 0.157.1\\n'\n", { mode: 0o700 });
    const service = new CodexConfigRepairService(f.sources, { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    expect(await service.read()).toMatchObject({ selectedVersion: "0.160.0", selectedCommand: f.command });
  });

  it.each(["0.156.1", "0.157.1", "0.160.0"])("repairs the reviewed %s source and regenerates new and restored overlays", async version => {
    const unrelated = '# Personal defaults\nmodel = "chosen-model"\nmodel_reasoning_effort = "high"\nweb_search = "live"\n';
    const preservedTables = '\n[projects."/trusted"]\ntrust_level = "trusted"\n[profiles.custom]\nmodel = "profile-model"\n[model_providers.personal]\nname = "Private provider"\n';
    const f = await fixture(`${unrelated}${legacyConfig}fast_mode = false\nfuture_feature = true # keep unknown settings\n${preservedTables}`, version);
    await fs.mkdir(path.join(f.home, "sessions"));
    await fs.writeFile(path.join(f.home, "sessions", "retained.jsonl"), "session retained");
    await fs.writeFile(path.join(f.home, "auth.json"), "credential retained");
    const launch = (tabId: string, resetOverlay = true) => materializeCodexTemplate(undefined, f.env, { dataDir: f.dataDir, tabId, sources: f.sources, cwd: f.root, resetOverlay });
    const old = await launch("restored");
    expect(old.configurationNotice).toContain(f.configPath);
    expect(old.configurationNotice).toContain(`Codex ${version}`);
    expect(old.configurationNotice).toContain(f.command);
    const preview = await f.service.read();
    const applied = await f.service.apply(preview.revision);
    expect(applied).toMatchObject({ changes: [], canApply: false });
    const saved = await fs.readFile(f.configPath, "utf8");
    expect(saved).toContain(unrelated);
    expect(saved).toContain(preservedTables);
    expect(saved).toContain('future_feature = true # keep unknown settings');
    expect(parse(saved)).toMatchObject({ model: "chosen-model", model_reasoning_effort: "high", features: { fast_mode: false, future_feature: true }, notice: { hide_full_access_warning: true } });
    for (const overlay of [await launch("new"), await launch("restored", false)]) {
      const generated = parse(await fs.readFile(overlay.overlay!.configPath, "utf8"));
      expect(generated.features).not.toHaveProperty("ghost_commit");
      expect(generated.features).not.toHaveProperty("streamable_shell");
      expect(generated).not.toHaveProperty("hide_full_access_warning");
      expect(generated.notice).toMatchObject({ hide_full_access_warning: true });
      expect(overlay.configurationNotice).toBeUndefined();
    }
    expect(await fs.readFile(path.join(f.home, "auth.json"), "utf8")).toBe("credential retained");
    expect(await fs.readFile(path.join(f.home, "sessions", "retained.jsonl"), "utf8")).toBe("session retained");
  });

  it.each([
    'hide_full_access_warning = false\nfeatures.ghost_commit = true\nfeatures.streamable_shell = false\nnotice.hide_world_writable_warning = true\n',
    '"hide_full_access_warning" = true\nfeatures = { ghost_commit = true, fast_mode = false, streamable_shell = true }\nnotice = { hide_world_writable_warning = true }\n',
    'hide_full_access_warning = true\nfeatures = { streamable_shell = true, ghost_commit = true }\n[notice]\nhide_world_writable_warning = true\n',
    'hide_full_access_warning = false\n[features]\n"ghost_commit" = true\n"streamable_shell" = false\n[notice.model_migrations]\nold = "new"\n',
    'hide_full_access_warning = true\n[features]\nghost_commit = true\nstreamable_shell = true\n[notice]\nhide_full_access_warning = true\n',
  ])("preserves the acknowledgement and siblings across valid TOML shapes %#", async original => {
    const f = await fixture(original);
    const preview = await f.service.read();
    await f.service.apply(preview.revision);
    const result = parse(await fs.readFile(f.configPath, "utf8"));
    const before = parse(original);
    const expected = { ...before, features: { ...(before.features as object) }, notice: { ...(before.notice as object), hide_full_access_warning: before.hide_full_access_warning } };
    delete (expected as Record<string, unknown>).hide_full_access_warning;
    delete (expected.features as Record<string, unknown>).ghost_commit;
    delete (expected.features as Record<string, unknown>).streamable_shell;
    if (result.features === undefined && !Object.keys(expected.features).length) delete (expected as Record<string, unknown>).features;
    expect(result).toEqual(expected);
  });

  it.each([
    'features = {\n ghost_commit = true, # obsolete entry\n # Keep fast mode, with comma in comment\n fast_mode = false,\n streamable_shell = false, # obsolete entry\n}\n',
    'features = {\n # Keep table comment\n ghost_commit = true,\n streamable_shell = false,\n}\n',
  ])("preserves comments and valid trailing commas in multiline inline tables %#", async original => {
    const f = await fixture(original);
    await f.service.apply((await f.service.read()).revision);
    const saved = await fs.readFile(f.configPath, "utf8");
    for (const line of original.split("\n").filter(line => line.trim().startsWith("# Keep"))) expect(saved).toContain(line);
    const features = parse(saved).features;
    expect(features).not.toHaveProperty("ghost_commit");
    expect(features).not.toHaveProperty("streamable_shell");
    if (original.includes("fast_mode")) expect(features).toMatchObject({ fast_mode: false });
  });

  it.each(["0.155.1", "0.159.0", "0.160.0-alpha.1", "0.161.0"])("leaves the pinned unreviewed %s source untouched", async version => {
    const f = await fixture(legacyConfig, version);
    const preview = await f.service.read();
    expect(preview.canApply).toBe(false);
    expect(preview.blockedReason).toContain(version);
    await expect(f.service.apply(preview.revision)).rejects.toThrow(/reviewed/);
    expect(await fs.readFile(f.configPath, "utf8")).toBe(legacyConfig);
  });

  it.each([
    `${legacyConfig}[notice]\nhide_full_access_warning = false\n`,
    'hide_full_access_warning = "not-a-boolean"\n',
    'hide_full_access_warning = true\nnotice = false\n',
  ])("rejects conflicting or malformed acknowledgements without a partial write %#", async original => {
    const f = await fixture(original);
    const preview = await f.service.read();
    expect(preview.canApply).toBe(false);
    await expect(f.service.apply(preview.revision)).rejects.toThrow(/acknowledgement/);
    expect(await fs.readFile(f.configPath, "utf8")).toBe(original);
  });

  it.each(["source", "version"])("rejects a changed %s after review", async changed => {
    const f = await fixture();
    const preview = await f.service.read();
    if (changed === "source") await fs.appendFile(f.configPath, '# externally edited\n');
    else await f.setVersion("0.157.1");
    const before = await fs.readFile(f.configPath, "utf8");
    await expect(f.service.apply(preview.revision)).rejects.toThrow(/changed/);
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
  });

  it("fails closed on malformed TOML and missing executable without exposing config", async () => {
    const f = await fixture('private_token = "synthetic-secret"\n[bad');
    await expect(f.service.read()).rejects.toThrow(/invalid TOML/);
    await fs.writeFile(f.configPath, legacyConfig);
    await fs.unlink(f.command);
    await expect(f.service.read()).rejects.toThrow(/Codex/);
    expect(await fs.readFile(f.configPath, "utf8")).toBe(legacyConfig);
  });

  it.each(["ui", "http"] as const)("reviews and applies through the production %s hook boundary", async kind => {
    const f = await fixture();
    const updates = new CodexUpdateService(f.dataDir, f.env);
    disposals.push(() => updates.dispose());
    const plugin = new CodexSettingsPlugin(new CodexSettingsService(f.sources), updates, f.service);
    const hooks = new HookRegistry();
    plugin.hooks.forEach(hook => hooks.register(hook));
    const caller = { caller: { kind } };
    const response = await hooks.call("codex-config-repair.read", {}, caller) as { repair: { revision: string } };
    await expect(hooks.call("codex-config-repair.apply", { expectedRevision: response.repair.revision, path: "/other" }, caller)).rejects.toThrow();
    await expect(hooks.call("codex-config-repair.apply", { expectedRevision: response.repair.revision }, caller)).resolves.toMatchObject({ repair: { changes: [], canApply: false } });
  });

  it("rejects malformed repair payloads", () => {
    for (const value of [null, [], {}, { revision: "x", canApply: true }, { revision: "a".repeat(64), sourceConfigPath: "source", selectedCommand: "codex", selectedVersion: "0.160.0", changes: [], canApply: true, blockedReason: null }])
      expect(() => parseCodexConfigRepairPreview(value)).toThrow(/Invalid/);
  });
});
