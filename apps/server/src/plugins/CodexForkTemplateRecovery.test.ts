import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PluginSession, PluginTabControls } from "@cloudx/plugin-api";
import type { WorkspaceRuntimeContext, WorkspaceTab } from "@cloudx/shared";
import { expect, it, vi } from "vitest";

import type { TerminalProcess, TerminalProcessFactory, TerminalSpawnOptions } from "../terminal/TerminalProcess.js";
import type { TerminalExit } from "../terminal/TerminalSupervisor.js";
import { CodexConversationForks } from "./CodexConversationForks.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";

const childId = "01a08470-d118-7b72-b1df-439e72e5c745";
const runtimeContext: WorkspaceRuntimeContext = {
  pluginRuntime: {
    "rules-skills": {
      personalityTemplate: {
        source: "tab",
        template: { id: "careful-review", name: "Careful review", color: "yellow", ruleIds: ["review-carefully"], skillIds: ["reviewer"] },
        rules: [{ id: "review-carefully", description: "Review carefully.", text: "Always verify the fork's custom review rule." }],
        skills: [{ id: "reviewer", name: "Reviewer", description: "Review changes.", instructions: "Review selected changes carefully." }]
      }
    }
  }
};

it("preserves a fork child's custom template rules and selected skills through process loss and reconnect", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-fork-template-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const env = { HOME: root, CODEX_HOME: home, SHELL: "/bin/bash", CLOUDX_ASSISTANT_BIN: "/usr/bin/codex" };
  const sources = new CodexStateSources(data, env);
  const factory = new CapturingTerminalFactory();
  const plugin = new CodexTerminalPlugin(factory, undefined, data, sources, env);
  const sessions: PluginSession[] = [];
  try {
    await writeSkill(path.join(home, "skills", ".system", "imagegen"), "imagegen", "Generate images.");
    await writeSkill(path.join(data, "rules-skills", "skills", "reviewer"), "reviewer", "Review selected changes carefully.");
    await fs.mkdir(path.join(home, "sessions"), { recursive: true });
    await fs.writeFile(path.join(home, "sessions", `rollout-${childId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: childId, cwd: root } })}\n`);

    const parent = createTab("parent", root);
    const child = createTab("child", root);
    let childSession: PluginSession | undefined;
    const childControls: PluginTabControls = { setTabIndicator() {}, closeTab() {} };
    const parentSession = await plugin.createSession({
      tab: parent, cwd: root, runtimeContext,
      controls: {
        setTabIndicator() {}, closeTab() {},
        async openSiblingTab(fork) {
          childSession = await plugin.createSession({
            tab: child, cwd: fork.cwd, initialInput: fork.initialInput,
            runtimeContext: { pluginRuntime: {} }, controls: childControls
          });
          sessions.push(childSession);
        }
      }
    });
    sessions.push(parentSession);
    const journal = new CodexConversationForks(sources.viewPath(parent.id));
    await fs.writeFile(journal.receiptPath, JSON.stringify({
      version: 1, tabId: parent.id, executionId: parentSession.restoreInput!()!.codexExecutionId,
      forks: [{ sessionId: childId, cwd: root }]
    }));
    await vi.waitFor(() => expect(childSession).toBeDefined());
    await expectTemplateOverlay(factory.launch(child.id).env);
    expect(childSession!.restoreInput!()).toMatchObject({
      codexForkSourceTabId: parent.id, codexRuntimeContext: runtimeContext,
      resume: { mode: "session", sessionId: childId }
    });

    const savedInput = childSession!.restoreInput!();
    factory.launch(child.id).terminal.kill();
    expect(childSession!.hasExited!()).toBe(true);
    const recovered = await plugin.recoverSession({
      tab: child, cwd: root, initialInput: savedInput,
      runtimeContext: { pluginRuntime: {} }, controls: childControls
    });
    sessions.push(recovered);
    await expectTemplateOverlay(factory.launch(child.id).env);
    expect(recovered.restoreInput!()).toMatchObject({
      codexRuntimeContext: runtimeContext, codexRecovered: true,
      resume: { mode: "session", sessionId: childId }
    });

    const recoveredInput = recovered.restoreInput!();
    recovered.detach!();
    const reconnected = await plugin.restoreSession({
      tab: child, cwd: root, initialInput: recoveredInput,
      runtimeContext: { pluginRuntime: {} }, controls: childControls
    });
    sessions.push(reconnected);
    await expectTemplateOverlay(factory.launch(child.id).env);
    expect(reconnected.restoreInput!()).toMatchObject({ codexRuntimeContext: runtimeContext });
    expect(factory.spawns).toBe(3);
  } finally {
    for (const session of sessions) await session.terminate?.();
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function expectTemplateOverlay(env: NodeJS.ProcessEnv): Promise<void> {
  expect(env).toMatchObject({
    CLOUDX_PERSONALITY_TEMPLATE_ID: "careful-review",
    CLOUDX_ENABLED_RULE_IDS: "review-carefully",
    CLOUDX_ENABLED_SKILL_IDS: "reviewer"
  });
  await expect(fs.readFile(path.join(env.CODEX_HOME!, "AGENTS.override.md"), "utf8")).resolves.toContain("Always verify the fork's custom review rule.");
  await expect(fs.readFile(path.join(env.CODEX_HOME!, "skills", "cloudx", "reviewer", "SKILL.md"), "utf8")).resolves.toContain("rules-skills/skills/reviewer/SKILL.md");
  await expect(fs.readFile(path.join(env.CODEX_HOME!, "config.toml"), "utf8")).resolves.toContain("skills/cloudx/reviewer/SKILL.md");
}

async function writeSkill(directory: string, name: string, instructions: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test ${name} skill.\n---\n\n${instructions}\n`);
}

function createTab(id: string, cwd: string): WorkspaceTab {
  return {
    id, pluginId: "codex-terminal", title: id, cwd, status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
}

class CapturingTerminalFactory implements TerminalProcessFactory {
  spawns = 0;
  private readonly launches = new Map<string, { env: NodeJS.ProcessEnv; terminal: TestTerminal }>();

  async spawn(_command: string, _args: string[], options: TerminalSpawnOptions): Promise<TerminalProcess> {
    this.spawns++;
    const terminal = new TestTerminal();
    this.launches.set(options.sessionId!, { env: options.env, terminal });
    return terminal;
  }

  async attach(tabId: string): Promise<TerminalProcess> { return this.launch(tabId).terminal; }

  launch(tabId: string) { return this.launches.get(tabId)!; }
}

class TestTerminal implements TerminalProcess {
  private readonly exitListeners = new Set<(exit: TerminalExit) => void>();

  onData() { return () => {}; }
  onExit(listener: (exit: TerminalExit) => void) {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }
  write() {}
  resize() {}
  detach() {}
  kill() { for (const listener of this.exitListeners) listener({ exitCode: 130 }); }
  async terminate() { this.kill(); }
}
