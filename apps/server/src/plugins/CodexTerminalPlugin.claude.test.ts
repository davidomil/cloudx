import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { AgentAccountStore } from "../agents/AgentAccountStore.js";
import type { TerminalProcess, TerminalProcessFactory } from "../terminal/TerminalProcess.js";
import type { TerminalExit } from "../terminal/TerminalSupervisor.js";
import { CodexTerminalPlugin, DEFAULT_TERMINAL_REPLAY_BYTES } from "./CodexTerminalPlugin.js";
import { ClaudeSettingsService } from "../agents/claude/ClaudeSettingsService.js";
import { PluginSessionNotStartedError } from "@cloudx/plugin-api";

const SESSION = "a5570c58-978a-4694-84f9-c67756be3acd";

class FakeTerminalProcess implements TerminalProcess {
  written = "";
  private exitListener: ((event: TerminalExit) => void) | undefined;
  onData() { return () => undefined; }
  onExit(listener: (event: TerminalExit) => void) { this.exitListener = listener; return () => { this.exitListener = undefined; }; }
  write(data: string) {
    this.written += data;
    if (data === "\r" && this.written.includes("/exit")) queueMicrotask(() => this.exitListener?.({ exitCode: 0 }));
  }
  resize() { return undefined; }
  kill() { return undefined; }
  exit(exitCode: number) { this.exitListener?.({ exitCode }); }
  async terminate() { return undefined; }
}

class CapturingFactory implements TerminalProcessFactory {
  launches: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; process: FakeTerminalProcess }> = [];
  async spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
    const process = new FakeTerminalProcess();
    this.launches.push({ command, args, env: options.env, process });
    return process;
  }
  get last() { return this.launches.at(-1)!; }
  // The login shell wraps the command: [-lc, "exec claude ..."].
  get lastCommandLine() { return this.last.args.at(-1)!; }
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-plugin-"));
  const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), SHELL: "/bin/bash", CLOUDX_CLAUDE_BIN: "claude", ANTHROPIC_API_KEY: "inherited" };
  await fs.mkdir(env.HOME, { recursive: true });
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);
  const accounts = new AgentAccountStore(dataDir, env);
  const account = await accounts.create({ providerId: "claude", label: "Work", kind: "subscription" });
  await fs.writeFile(path.join(accounts.home(account), ".credentials.json"), "{}");
  const factory = new CapturingFactory();
  const claudeSettings = new ClaudeSettingsService(dataDir, () => path.join(env.HOME, ".claude"), env);
  const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, dataDir, undefined, env, { accounts, claudeSettings });
  const cwd = path.join(root, "work");
  await fs.mkdir(cwd);
  const tab: WorkspaceTab = {
    id: "tab-1", pluginId: "codex-terminal", title: "Claude", cwd, status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  const restored: Record<string, unknown>[] = [];
  const controls = { setTabIndicator: () => undefined, closeTab: () => undefined, setRestoreInput: (input: Record<string, unknown>) => { restored.push(input); } };
  return { root, env, dataDir, accounts, account, factory, plugin, cwd, tab, controls, restored, claudeSettings };
}

describe("CodexTerminalPlugin on Claude", () => {
  it("launches Claude Code in a per-tab config dir on the selected account", async () => {
    const { plugin, factory, tab, cwd, controls, account, dataDir, restored } = await setup();
    await plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" }, prompt: "Fix it" } });

    const configDir = path.join(dataDir, "claude-launches", "tab-1");
    // The login profile runs first; the selection is re-applied before exec.
    expect(factory.lastCommandLine).toMatch(/^unset ANTHROPIC_API_KEY .*; export CLAUDE_CONFIG_DIR="\$CLOUDX_ENFORCED_CLAUDE_CONFIG_DIR"; unset CLOUDX_ENFORCED_CLAUDE_CONFIG_DIR; exec claude --settings \S+\.cloudx-settings\.json --add-dir \S+ --dangerously-skip-permissions -- 'Fix it'$/u);
    expect(factory.last.env).toMatchObject({ CLAUDE_CONFIG_DIR: configDir, CLOUDX_ENFORCED_CLAUDE_CONFIG_DIR: configDir });
    expect(factory.last.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(restored.at(-1)).toMatchObject({ agent: { providerId: "claude", accountId: account.id } });
  });

  it("refuses Forge work on Claude until the bypass warning is accepted, then runs it in bypass mode", async () => {
    const { plugin, factory, tab, cwd, controls, env, dataDir, accounts, claudeSettings } = await setup();
    const configured = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, dataDir, undefined, env, {
      accounts, claudeSettings: { read: async () => ({ ...await claudeSettings.read(), permissionMode: "acceptEdits" as const, autoTrustWorkspace: false }) }
    });
    const launch = (target: CodexTerminalPlugin) => target.createSession({
      tab: { ...tab, ownerPluginId: "forge" }, cwd, controls,
      agentTurn: { workerId: "issue-1", attemptId: "attempt-1", receiptPath: path.join(dataDir, "attempt-1.json") },
      initialInput: { agent: { providerId: "claude" }, prompt: "Work" }
    });
    await expect(launch(configured)).rejects.toBeInstanceOf(PluginSessionNotStartedError);
    await expect(launch(configured)).rejects.toThrow("Accept Claude Code's bypass-permissions warning");
    expect(factory.launches).toHaveLength(0);

    await claudeSettings.acceptBypass();
    await launch(configured);
    expect(factory.lastCommandLine).toContain("--dangerously-skip-permissions");
    await plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" } } });
    expect(factory.lastCommandLine).toContain("--dangerously-skip-permissions");
    await configured.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" } } });
    expect(factory.lastCommandLine).toContain("--permission-mode acceptEdits");
    await fs.writeFile(path.join(env.HOME, ".claude", "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true, permissions: { disableBypassPermissionsMode: "disable" } }));
    const before = factory.launches.length;
    await expect(plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" } } })).rejects.toThrow("disable bypass permissions mode");
    await configured.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" } } });
    expect(factory.launches).toHaveLength(before + 1);
  });

  it("starts a Forge conversation under its fixed id, then resumes it once Claude saved it", async () => {
    const { plugin, factory, tab, cwd, controls, env, dataDir, claudeSettings } = await setup();
    await claudeSettings.acceptBypass();
    const agentTurn = { workerId: "issue-1", attemptId: "attempt-1", receiptPath: path.join(dataDir, "attempt-1.json") };
    const launch = () => plugin.createSession({
      tab: { ...tab, ownerPluginId: "forge" }, cwd, controls, agentTurn,
      prepareAgentSession: async () => SESSION,
      initialInput: { agent: { providerId: "claude" }, prompt: "Review", model: "claude-opus-5-5", reasoningEffort: "xhigh" }
    });

    const first = await launch();
    expect(factory.lastCommandLine).toContain(`--model claude-opus-5-5 --effort xhigh --session-id ${SESSION} -- Review`);
    expect(JSON.parse(await fs.readFile(path.join(dataDir, "claude-launches", "tab-1", ".cloudx-forge-turn.json"), "utf8")))
      .toEqual({ ...agentTurn, expectedThreadId: SESSION });

    // The finish action leaves the Claude TUI with /exit after a completed turn.
    await fs.writeFile(agentTurn.receiptPath, JSON.stringify({ workerId: "issue-1", attemptId: "attempt-1", threadId: SESSION, turnId: "p1", status: "completed" }));
    await first.handleAction("finish", { threadId: SESSION, turnId: "p1" });
    expect(factory.last.process.written).toContain("/exit");

    const transcript = path.join(env.HOME, ".claude", "projects", "-work", `${SESSION}.jsonl`);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(transcript, "");
    await launch();
    expect(factory.lastCommandLine).toContain(`--resume ${SESSION} -- Review`);
  });

  it("keeps the native session for a same-provider switch and writes a handoff for Codex", async () => {
    const { plugin, tab, cwd, controls, env, accounts, account } = await setup();
    const other = await accounts.create({ providerId: "claude", label: "Personal", kind: "subscription" });
    const codex = await accounts.create({ providerId: "codex", label: "Codex", kind: "subscription" });
    const transcript = path.join(env.HOME, ".claude", "projects", "-work", `${SESSION}.jsonl`);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "Add retries" } })}\n`);
    const current = { agent: { providerId: "claude", accountId: account.id }, resume: { mode: "session", sessionId: SESSION }, prompt: "old", codexExecutionId: "x" };

    expect(await plugin.prepareAgentSwitch({ tab, cwd, controls, initialInput: current }, { providerId: "claude", accountId: other.id }))
      .toEqual({ agent: { providerId: "claude", accountId: other.id }, resume: { mode: "session", sessionId: SESSION } });

    const next = await plugin.prepareAgentSwitch({ tab, cwd, controls, initialInput: current }, { providerId: "codex", accountId: codex.id });
    expect(next).toMatchObject({ agent: { providerId: "codex", accountId: codex.id } });
    expect(next.resume).toBeUndefined();
    expect(await fs.readFile(String(next.agentHandoff), "utf8")).toContain("Add retries");
    expect(next.prompt).toContain(String(next.agentHandoff));
  });

  it("records the confirmed conversation for usage and closes it when Claude exits", async () => {
    const { factory, tab, cwd, controls, env, dataDir, accounts, claudeSettings, restored } = await setup();
    const usage = { conversationStarted: vi.fn(), ended: vi.fn() };
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, dataDir, undefined, env, { accounts, claudeSettings, usage: usage as never });
    await plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" } } });
    await fs.writeFile(path.join(dataDir, "claude-launches", "tab-1", ".cloudx-conversation.json"), JSON.stringify({
      version: 2, authority: "selected", tabId: "tab-1", executionId: restored.at(-1)!.codexExecutionId, sessionId: SESSION, cwd
    }));
    await vi.waitFor(() => expect(usage.conversationStarted).toHaveBeenCalledWith(expect.objectContaining({ id: "tab-1" }), "claude", expect.any(String), SESSION), { timeout: 2_000 });
    factory.last.process.exit(0);
    expect(usage.ended).toHaveBeenCalledWith("tab-1");
  });
});
