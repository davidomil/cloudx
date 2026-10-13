import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HookRegistry } from "../hooks/HookRegistry.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexSettingsService } from "./CodexSettingsService.js";
import { CodexSettingsPlugin } from "./CodexSettingsPlugin.js";
import { CodexUpdateService } from "./CodexUpdateService.js";
import { CodexConfigRepairService } from "./CodexConfigRepairService.js";
import { validateNativeCodexConfiguration } from "./CodexConfigurationProbe.js";

vi.mock("../../../../scripts/codex-updater.mjs", () => ({ readCodexVersion: vi.fn(async () => "0.162.1") }));
vi.mock("./CodexConfigurationProbe.js", () => ({ validateNativeCodexConfiguration: vi.fn(async () => undefined) }));
const fixtures: { root: string; sources: CodexStateSources }[] = [];
afterEach(async () => {
  vi.mocked(validateNativeCodexConfiguration).mockReset().mockResolvedValue(undefined);
  for (const fixture of fixtures.splice(0)) { await fixture.sources.dispose(); await fs.rm(fixture.root, { recursive: true, force: true }); }
});

async function fixture(text = 'model_verbosity="medium" # preserve preference\n', dependencies: ConstructorParameters<typeof CodexStateSources>[2] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-settings-service-"));
  const home = path.join(root, "home"); await fs.mkdir(home);
  const configPath = path.join(home, "config.toml"); await fs.writeFile(configPath, text);
  const sources = new CodexStateSources(path.join(root, "data"), { CODEX_HOME: home }, dependencies); fixtures.push({ root, sources });
  const service = new CodexSettingsService(sources, { CLOUDX_ASSISTANT_BIN: "/selected/codex" });
  const hooks = new HookRegistry();
  new CodexSettingsPlugin(service, new CodexUpdateService(root), new CodexConfigRepairService(sources)).hooks.forEach(hook => hooks.register(hook));
  const call = (id: string, input: Record<string, unknown> = {}) => hooks.call(id, input, { caller: { kind: "http" } });
  return { root, home, configPath, service, call };
}

describe("native settings persistence through the hook boundary", () => {
  it.each([
    ["model", "model", "gpt-6-sol", "gpt-6-astra"],
    ["serviceTier", "service_tier", "priority", "flex"],
    ["reasoningEffort", "model_reasoning_effort", "low", "xhigh"],
    ["webSearch", "web_search", "cached", "live"],
    ["personality", "personality", "none", "friendly"],
  ])("rejects conflicting quick and structured %s values and unsets before saving", async (field, key, quick, native) => {
    const f = await fixture();
    const current = await f.service.read();
    const original = await fs.readFile(f.configPath, "utf8");
    for (const [left, right] of [[quick, native], [null, native], [quick, null]]) {
      await expect(f.call("codex-settings.update", { expectedRevision: current.revision, [field]: left, nativeOptions: { [key]: right } })).rejects.toThrow(/Conflicting Codex/);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(original);
      expect((await f.service.read()).revision).toBe(current.revision);
    }
    expect(validateNativeCodexConfiguration).not.toHaveBeenCalled();
  });

  it("accepts agreeing quick and structured values without discarding either choice", async () => {
    const f = await fixture();
    const current = await f.service.read();
    const saved = await f.call("codex-settings.update", { expectedRevision: current.revision, model: "gpt-6-sol", nativeOptions: { model: "gpt-6-sol" } });
    expect(saved).toMatchObject({ settings: { model: "gpt-6-sol", configuration: { values: { model: "gpt-6-sol" } } } });
    expect(parse(await fs.readFile(f.configPath, "utf8"))).toMatchObject({ model: "gpt-6-sol" });
  });

  it("saves nested options and resets a family without rewriting unrelated comments", async () => {
    const f = await fixture('model_verbosity="medium" # preserve preference\n[tui]\nanimations=true # preserve animation note\n[unknown]\nkeep="private value"\n');
    const current = await f.service.read();
    const result = await f.call("codex-settings.update", { expectedRevision: current.revision, nativeOptions: { tui: { animations: false, notifications: false } } });
    expect(result).toMatchObject({ settings: { configuration: { values: { tui: { animations: false, notifications: false } } } } });
    const saved = await f.service.read();
    expect(JSON.stringify(saved)).not.toContain("private value");
    const changed = await fs.readFile(f.configPath, "utf8");
    expect(changed).toContain('# preserve animation note');
    expect(changed).toContain('[unknown]\nkeep="private value"');
    await f.call("codex-settings.update", { expectedRevision: saved.revision, nativeOptions: { tui: null } });
    expect(parse(await fs.readFile(f.configPath, "utf8"))).not.toHaveProperty("tui");
    expect(validateNativeCodexConfiguration).toHaveBeenCalledTimes(2);
  });

  it("keeps hidden credentials on entry edits and deletes them only with an explicit entry removal", async () => {
    const f = await fixture('[model_providers.private]\nname="Before"\nexperimental_bearer_token="synthetic-secret" # retain secret comment\n[model_providers.other]\nname="Other"\nexperimental_bearer_token="other-secret"\n');
    const current = await f.service.read();
    expect(JSON.stringify(current)).not.toContain("secret");
    const saved = await f.service.update({ expectedRevision: current.revision, nativeOptions: { model_providers: { private: { name: "After" }, other: { name: "Other" } } } });
    expect(parse(await fs.readFile(f.configPath, "utf8")).model_providers).toMatchObject({ private: { name: "After", experimental_bearer_token: "synthetic-secret" } });
    await f.service.update({ expectedRevision: saved.revision, nativeOptions: { model_providers: { other: { name: "Other" } } } });
    expect(parse(await fs.readFile(f.configPath, "utf8")).model_providers).toEqual({ other: { name: "Other", experimental_bearer_token: "other-secret" } });
  });

  it("edits separate profile files and rejects stale edits after the selected profile changes externally", async () => {
    const f = await fixture();
    const draft = await f.service.read(undefined, "writing");
    const savedProfile = await f.service.update({ expectedRevision: draft.revision, targetProfile: "writing", nativeOptions: { model_verbosity: "low" } });
    expect(savedProfile.configuration).toMatchObject({ targetProfile: "writing", profileFiles: ["writing"], values: { model_verbosity: "low" } });
    expect(await fs.readFile(f.configPath, "utf8")).toBe('model_verbosity="medium" # preserve preference\n');
    const root = await f.service.read();
    const selected = await f.service.update({ expectedRevision: root.revision, configProfile: "writing" });
    expect(selected.configuration?.effectiveValues.model_verbosity).toBe("low");
    expect(parse(await fs.readFile(f.configPath, "utf8"))).not.toHaveProperty("profile");
    await fs.writeFile(path.join(f.home, "writing.config.toml"), 'model_verbosity="high"\n');
    await expect(f.service.update({ expectedRevision: selected.revision, nativeOptions: { tui: { animations: false } } })).rejects.toThrow(/changed.*Reload/);
    const inherited = await f.service.read(undefined, "writing");
    const reset = await f.service.update({ expectedRevision: inherited.revision, targetProfile: "writing", nativeOptions: { model_verbosity: null } });
    expect(reset.configuration?.effectiveValues.model_verbosity).toBe("medium");
  });

  it("refuses native rejection, malformed values, managed fields and unsafe target names without changing files", async () => {
    const f = await fixture(); const current = await f.service.read();
    for (const input of [
      { nativeOptions: { tui: { animations: "no" } } }, { nativeOptions: { skills: { bundled: { enabled: true } } } },
      { nativeOptions: { mcp_servers: { remote: { http_headers: { Authorization: "secret" } } } } },
      { nativeOptions: { model_providers: { private: { api_key: "secret" } } } },
      { targetProfile: "../outside", nativeOptions: { tui: {} } }, { configProfile: "missing" },
    ]) await expect(f.call("codex-settings.update", { expectedRevision: current.revision, ...input })).rejects.toThrow();
    vi.mocked(validateNativeCodexConfiguration).mockRejectedValueOnce(new Error("Native rejected settings."));
    await expect(f.service.update({ expectedRevision: current.revision, nativeOptions: { tui: { animations: false } } })).rejects.toThrow(/Native rejected/);
    expect(await fs.readFile(f.configPath, "utf8")).toBe('model_verbosity="medium" # preserve preference\n');
    await fs.symlink(f.configPath, path.join(f.home, "linked.config.toml"));
    await expect(f.service.read(undefined, "linked")).rejects.toThrow();
  });

  it.each(["base", "selected profile"])("rejects an external edit of the %s while the target replacement is staged", async changedLayer => {
    let armed = false;
    let changedPath = "";
    const f = await fixture(undefined, { fs: { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const write = file.writeFile.bind(file);
        file.writeFile = async (...input) => {
          await write(...input);
          if (armed) { armed = false; await fs.writeFile(changedPath, 'model_verbosity="high" # external edit\n'); }
        };
      }
      return file;
    } } });
    await fs.writeFile(path.join(f.home, "writing.config.toml"), 'model_verbosity="low"\n');
    const root = await f.service.read();
    await f.service.update({ expectedRevision: root.revision, configProfile: "writing" });
    const targetProfile = changedLayer === "base" ? "writing" : undefined;
    const settings = await f.service.read(undefined, targetProfile);
    const target = targetProfile ? path.join(f.home, "writing.config.toml") : f.configPath;
    const original = await fs.readFile(target, "utf8");
    changedPath = changedLayer === "base" ? f.configPath : path.join(f.home, "writing.config.toml");
    armed = true;
    await expect(f.service.update({ expectedRevision: settings.revision, targetProfile, nativeOptions: { tui: { animations: false } } })).rejects.toThrow(/layers changed/);
    expect(await fs.readFile(target, "utf8")).toBe(original);
    expect(await fs.readFile(changedPath, "utf8")).toContain("# external edit");
    expect(await fs.readdir(f.home)).not.toContain(".cloudx-config.lock");
    expect((await fs.readdir(f.home)).some(name => name.endsWith(".tmp"))).toBe(false);
  });
});
