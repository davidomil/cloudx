import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { expect, it, vi } from "vitest";
import type { PluginSession, PluginTabControls } from "@cloudx/plugin-api";
import type { WorkspaceRuntimeContext, WorkspaceTab } from "@cloudx/shared";
import type { TerminalProcess, TerminalProcessFactory, TerminalSpawnOptions } from "../terminal/TerminalProcess.js";
import type { TerminalExit } from "../terminal/TerminalSupervisor.js";
import { CodexConversationForks } from "./CodexConversationForks.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";

it("hands native skill choices to the child and preserves its later choices on recovery and reconnect", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-fork-skills-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const selectedPath = (tabId: string) => path.join(sources.viewPath(tabId), "skills/cloudx/selected/SKILL.md");
  const projectSkill = path.join(root, ".agents/skills/project/SKILL.md");
  const nativeChildId = "01a08470-d118-7b72-b1df-439e72e5c745";
  const env = { HOME: home, CODEX_HOME: home, SHELL: "/bin/bash", CLOUDX_ASSISTANT_BIN: "/usr/bin/codex" };
  const sources = new CodexStateSources(data, env);
  const factory = new SkillTerminalFactory();
  const plugin = new CodexTerminalPlugin(factory, undefined, data, sources, env);
  const controls: PluginTabControls = { setTabIndicator() {}, closeTab() {} };
  const sessions: PluginSession[] = [];
  const runtimeContext: WorkspaceRuntimeContext = { pluginRuntime: { "rules-skills": { personalityTemplate: {
    source: "tab", template: { id: "selected", name: "Selected", color: "green", ruleIds: [], skillIds: ["selected"] }, rules: [],
    skills: [{ id: "selected", name: "Selected", description: "Selected native skill." }]
  } } } };
  const tab = (id: string): WorkspaceTab => ({ id, pluginId: "codex-terminal", title: id, cwd: root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "OK", updatedAt: "" } });
  const setNativeChoices = async (tabId: string, projectEnabled: boolean, selectedEnabled: boolean) => {
    const configPath = path.join(sources.viewPath(tabId), "config.toml");
    const config = parse(await fs.readFile(configPath, "utf8"));
    const skills = config.skills as TomlTable;
    // The real native test verifies this writer contract: enabled removes, disabled sets false.
    skills.config = (skills.config as TomlTable[]).filter(entry => entry.path !== projectSkill && entry.path !== selectedPath(tabId));
    if (!projectEnabled) (skills.config as TomlTable[]).push({ path: projectSkill, enabled: false });
    if (!selectedEnabled) (skills.config as TomlTable[]).push({ path: selectedPath(tabId), enabled: false });
    await fs.writeFile(configPath, stringify(config));
  };
  const expectChoices = async (tabId: string, projectEnabled: boolean, selectedEnabled: boolean) => {
    const config = parse(await fs.readFile(path.join(sources.viewPath(tabId), "config.toml"), "utf8"));
    expect((config.skills as TomlTable).config).toEqual(expect.arrayContaining([
      { path: projectSkill, enabled: projectEnabled }, { path: selectedPath(tabId), enabled: selectedEnabled }
    ]));
  };
  try {
    for (const skill of [projectSkill, path.join(data, "rules-skills/skills/selected/SKILL.md")]) {
      await fs.mkdir(path.dirname(skill), { recursive: true });
      await fs.writeFile(skill, `---\nname: ${path.basename(path.dirname(skill))}\ndescription: Preserve skill choices.\n---\nUse this skill.\n`);
    }
    await fs.mkdir(path.join(home, "sessions"), { recursive: true });
    const sharedConfig = '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}\n';
    await fs.writeFile(path.join(home, "config.toml"), sharedConfig);
    await fs.writeFile(path.join(home, "sessions", `rollout-${nativeChildId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: nativeChildId, cwd: root } })}\n`);
    const child = tab("child");
    let childSession: PluginSession | undefined;
    const parent = await plugin.createSession({ tab: tab("parent"), cwd: root, runtimeContext, controls: {
      ...controls, async openSiblingTab(fork) {
        childSession = await plugin.createSession({ tab: child, cwd: fork.cwd, initialInput: fork.initialInput, controls });
        sessions.push(childSession);
      }
    } });
    sessions.push(parent);
    await setNativeChoices("parent", true, false);
    const forks = new CodexConversationForks(sources.viewPath("parent"));
    await fs.writeFile(forks.receiptPath, JSON.stringify({ version: 1, tabId: "parent", executionId: parent.restoreInput!()!.codexExecutionId, forks: [{ sessionId: nativeChildId, cwd: root }] }));
    await vi.waitFor(() => expect(childSession).toBeDefined());
    await expectChoices("child", true, false);
    expect(childSession!.restoreInput!()!.codexNativeSkillOverrides).toEqual(expect.arrayContaining([
      { path: projectSkill, enabled: true }, { generatedPath: "skills/cloudx/selected/SKILL.md", enabled: false }
    ]));
    expect(JSON.stringify(childSession!.restoreInput!()!.codexNativeSkillOverrides)).not.toContain(sources.viewPath("parent"));

    await setNativeChoices("child", false, true);
    const savedInput = childSession!.restoreInput!();
    factory.processes.get("child")!.kill();
    const recovered = await plugin.recoverSession({ tab: child, cwd: root, initialInput: savedInput, controls });
    sessions.push(recovered);
    await expectChoices("child", false, true);

    // Reconnect also rematerializes an existing view and must retain the latest native choices.
    await setNativeChoices("child", true, false);
    const reconnectedInput = recovered.restoreInput!();
    recovered.detach!();
    const reconnected = await plugin.restoreSession({ tab: child, cwd: root, initialInput: reconnectedInput, controls });
    sessions.push(reconnected);
    await expectChoices("child", true, false);
    expect(reconnected.restoreInput!()).toMatchObject({ resume: { mode: "session", sessionId: nativeChildId } });
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(sharedConfig);
  } finally {
    for (const session of sessions) await session.terminate?.();
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

class SkillTerminalFactory implements TerminalProcessFactory {
  readonly processes = new Map<string, SkillTerminal>();
  async spawn(_command: string, _args: string[], options: TerminalSpawnOptions) {
    const terminal = new SkillTerminal();
    this.processes.set(options.sessionId!, terminal);
    return terminal;
  }
  async attach(tabId: string) { return this.processes.get(tabId)!; }
}

class SkillTerminal implements TerminalProcess {
  private readonly exits = new Set<(exit: TerminalExit) => void>();
  onData() { return () => {}; }
  onExit(listener: (exit: TerminalExit) => void) { this.exits.add(listener); return () => { this.exits.delete(listener); }; }
  write() {}
  resize() {}
  detach() {}
  kill() { for (const listener of this.exits) listener({ exitCode: 130 }); }
  async terminate() { this.kill(); }
}
