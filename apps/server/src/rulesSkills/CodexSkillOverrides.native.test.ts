import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AppServerClient, StdioAppServerTransport } from "../appServer/AppServerClient.js";
import { CodexStateSources } from "../plugins/CodexStateSources.js";
import { materializeCodexHomeOverlay, readCodexSkillOverrides, type CodexHomeOverlay, type CodexSkillOverride } from "./CodexHomeOverlay.js";
import type { ResolvedPersonalityTemplate } from "./RulesSkillsCatalogService.js";

const codex = process.env.CLOUDX_NATIVE_CODEX;

it.skipIf(!codex)("preserves real native enabled and disabled skills across fork handoff and child process loss", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-fork-skills-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const projectSkill = path.join(cwd, ".agents/skills/project-choice/SKILL.md");
  const selectedSkill = path.join(dataDir, "rules-skills/skills/selected-choice/SKILL.md");
  const sources = new CodexStateSources(dataDir, { CODEX_HOME: home });
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home };
  const children: Array<{ client: AppServerClient; stopped: Promise<unknown> }> = [];
  const template: ResolvedPersonalityTemplate = {
    source: "tab", template: { id: "selected", name: "Selected", color: "green", ruleIds: [], skillIds: ["selected-choice"] }, rules: [],
    skills: [{ id: "selected-choice", name: "Selected choice", description: "Preserve native choices." }]
  };
  const launch = async (tabId: string, nativeSkillOverrides?: CodexSkillOverride[]) => {
    const overlay = await materializeCodexHomeOverlay({ dataDir, tabId, sources, source: await sources.resolve(), cwd, resolved: template, baseEnv: env, nativeSkillOverrides });
    const native = spawn(codex!, ["app-server", "--listen", "stdio://"], { cwd, env: { ...env, CODEX_HOME: overlay.codexHome }, stdio: ["pipe", "pipe", "ignore"] });
    const stopped = new Promise(resolve => native.once("close", resolve));
    const client = new AppServerClient(new StdioAppServerTransport({ process: native, stop: () => { native.kill("SIGKILL"); } }));
    children.push({ client, stopped });
    await client.initialize();
    return { client, stopped, overlay };
  };
  const selectedPath = (overlay: CodexHomeOverlay) => overlay.skillPaths.find(file => file.endsWith("/cloudx/selected-choice/SKILL.md"))!;
  const expectChoices = async (client: AppServerClient, overlay: CodexHomeOverlay, projectEnabled: boolean, selectedEnabled: boolean) => {
    const inventory = await client.request("skills/list", { cwds: [cwd], forceReload: true }) as { data: Array<{ skills: Array<{ path: string; enabled: boolean }>; errors: unknown[] }> };
    expect(inventory.data[0]!.errors).toEqual([]);
    expect(inventory.data[0]!.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: projectSkill, enabled: projectEnabled }),
      expect.objectContaining({ path: selectedPath(overlay), enabled: selectedEnabled })
    ]));
  };
  try {
    await fs.mkdir(home);
    for (const file of [projectSkill, selectedSkill]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `---\nname: ${path.basename(path.dirname(file))}\ndescription: Preserve native choices.\n---\nApply this skill.\n`);
    }
    const sharedConfig = [
      '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
      'model = "cloudx-native"', 'model_provider = "synthetic"',
      `[projects.${JSON.stringify(cwd)}]`, 'trust_level = "trusted"',
      '[model_providers.synthetic]', 'name = "No model calls"', 'base_url = "http://127.0.0.1:1/v1"', 'wire_api = "responses"', 'requires_openai_auth = false', ''
    ].join("\n");
    await fs.writeFile(path.join(home, "config.toml"), sharedConfig);
    const parent = await launch("parent");
    await expectChoices(parent.client, parent.overlay, false, true);
    const started = await parent.client.request("thread/start", { cwd, persistExtendedHistory: true }) as { thread: { id: string } };
    await parent.client.request("thread/inject_items", { threadId: started.thread.id, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Shared native fork history." }] }] });
    await parent.client.request("skills/config/write", { path: projectSkill, enabled: true });
    await parent.client.request("skills/config/write", { path: selectedPath(parent.overlay), enabled: false });
    await expectChoices(parent.client, parent.overlay, true, false);
    const fork = await parent.client.request("thread/fork", { threadId: started.thread.id, cwd, persistExtendedHistory: true }) as { thread: { id: string } };
    expect(fork.thread.id).not.toBe(started.thread.id);
    const inherited = await readCodexSkillOverrides(parent.overlay.codexHome, { cwd, homeDir: home });
    parent.client.close();
    await parent.stopped;
    const child = await launch("child", inherited);
    expect(await child.client.request("thread/resume", { threadId: fork.thread.id, cwd })).toMatchObject({ thread: { id: fork.thread.id } });
    await expectChoices(child.client, child.overlay, true, false);
    // Flip both choices in the child and recover after losing its native process.
    await child.client.request("skills/config/write", { path: projectSkill, enabled: false });
    await child.client.request("skills/config/write", { path: selectedPath(child.overlay), enabled: true });
    await expectChoices(child.client, child.overlay, false, true);
    const recoveredChoices = await readCodexSkillOverrides(child.overlay.codexHome, { cwd, homeDir: home });
    child.client.close();
    await child.stopped;
    const recovered = await launch("child", recoveredChoices);
    expect(await recovered.client.request("thread/resume", { threadId: fork.thread.id, cwd })).toMatchObject({ thread: { id: fork.thread.id } });
    await expectChoices(recovered.client, recovered.overlay, false, true);
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(sharedConfig);
  } finally {
    for (const child of children) child.client.close();
    await Promise.all(children.map(child => child.stopped));
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
