import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { AgentAccountStore } from "../agents/AgentAccountStore.js";
import type { TerminalProcess, TerminalProcessFactory } from "../terminal/TerminalProcess.js";
import type { TerminalExit } from "../terminal/TerminalSupervisor.js";
import { CodexTerminalPlugin, DEFAULT_TERMINAL_REPLAY_BYTES } from "./CodexTerminalPlugin.js";
import { ClaudeSettingsService } from "../agents/claude/ClaudeSettingsService.js";
import { AgentLaunchRecords } from "../agents/AgentLaunchRecords.js";
import { ClaudeConversationPolicies } from "../agents/claude/ClaudeConversationPolicies.js";
import { runAgentCli } from "../agents/agentCli.js";
import { PluginSessionNotStartedError } from "@cloudx/plugin-api";
import { hardwareLaunchEnv } from "../hardware/AgentHardwareContext.js";

vi.mock("../agents/claude/ClaudeNativeSettings.js", () => ({ verifyClaudeNativeAccount: vi.fn(async () => undefined) }));

const SESSION = "a5570c58-978a-4694-84f9-c67756be3acd";

class FakeTerminalProcess implements TerminalProcess {
  written = "";
  terminated = false;
  exitAtStartup = false;
  acknowledgePrompt = true;
  forgeBinding?: { workerId: string; attemptId: string; receiptPath: string };
  private exitListener: ((event: TerminalExit) => void) | undefined;
  onData(listener: (data: string) => void) { queueMicrotask(() => listener("Claude native composer ready\r\n")); return () => undefined; }
  onExit(listener: (event: TerminalExit) => void) { this.exitListener = listener; if (this.exitAtStartup) queueMicrotask(() => listener({ exitCode: 1 })); return () => { this.exitListener = undefined; }; }
  write(data: string) {
    this.written += data;
    if (data === "\r" && this.written.includes("/exit")) queueMicrotask(() => this.exitListener?.({ exitCode: 0 }));
    else if (data === "\r" && this.forgeBinding) {
      if (this.acknowledgePrompt) writeFileSync(this.forgeBinding.receiptPath, JSON.stringify({ workerId: this.forgeBinding.workerId, attemptId: this.forgeBinding.attemptId, threadId: SESSION, turnId: "initial", status: "running" }));
      else queueMicrotask(() => this.exitListener?.({ exitCode: 1 }));
    }
  }
  resize() { return undefined; }
  kill() { return undefined; }
  exit(exitCode: number) { this.exitListener?.({ exitCode }); }
  async terminate() { this.terminated = true; }
}

class CapturingFactory implements TerminalProcessFactory {
  deliverReceipt = true;
  acknowledgePrompt = true;
  exitWithoutReceipt = true;
  launches: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; process: FakeTerminalProcess }> = [];
  async spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
    const process = new FakeTerminalProcess();
    process.exitAtStartup = !this.deliverReceipt && this.exitWithoutReceipt;
    process.acknowledgePrompt = this.acknowledgePrompt;
    this.launches.push({ command, args, env: options.env, process });
    const configDir = options.env.CLOUDX_ENFORCED_CLAUDE_CONFIG_DIR!;
    try { process.forgeBinding = JSON.parse(await fs.readFile(path.join(configDir, ".cloudx-forge-turn.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const settings = JSON.parse(await fs.readFile(path.join(configDir, ".cloudx-settings.json"), "utf8"));
    const hook = settings.hooks.SessionStart[0].hooks[0].command as string;
    const executionId = [...hook.matchAll(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gu)].at(-1)![0];
    const cwd = path.join(path.dirname(path.dirname(path.dirname(configDir))), "work");
    if (this.deliverReceipt) await fs.writeFile(path.join(configDir, ".cloudx-conversation.json"), JSON.stringify({ version: 2, authority: "selected", tabId: "tab-1", executionId, sessionId: SESSION, cwd }));
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
  const binary = path.join(env.HOME, "claude-fixture");
  await fs.writeFile(binary, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.316 (Claude Code)"; fi\n', { mode: 0o755 });
  env.CLOUDX_CLAUDE_BIN = binary;
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
  const controls = { setTabIndicator: vi.fn(), closeTab: () => undefined, setRestoreInput: (input: Record<string, unknown>) => { restored.push(input); } };
  return { root, env, dataDir, accounts, account, factory, plugin, cwd, tab, controls, restored, claudeSettings };
}

describe("CodexTerminalPlugin on Claude", () => {
  it("launches Claude with an exact execution Hardware context enforced after account and shell setup", async () => {
    const { plugin, factory, tab, cwd, controls, root } = await setup();
    const runtimeContext = { pluginRuntime: { hardware: { directory: path.join(root, "hardware-agent"), helperPath: path.join(root, "hardware-helper.mjs") } } };
    const session = await plugin.createSession({ tab, cwd, controls, runtimeContext, initialInput: { agent: { providerId: "claude" } } });
    try {
      const executionId = session.restoreInput?.()?.codexExecutionId as string;
      const env = hardwareLaunchEnv(runtimeContext, executionId);
      expect(factory.last.env).toMatchObject(env);
      expect(factory.last.env.CLOUDX_ENFORCED_CLOUDX_HARDWARE_CONTEXT).toBe(env.CLOUDX_HARDWARE_CONTEXT);
      expect(factory.last.env.CLOUDX_ENFORCED_CLOUDX_HARDWARE_HELPER).toBe(env.CLOUDX_HARDWARE_HELPER);
    } finally { session.stop?.(); }
  });

  it("stops an unacknowledged Forge prompt without admitting the worker or replaying the prompt", async () => {
    const { plugin, factory, tab, cwd, controls, dataDir, claudeSettings } = await setup();
    await claudeSettings.acceptBypass();
    factory.acknowledgePrompt = false;
    await expect(plugin.createSession({ tab: { ...tab, ownerPluginId: "forge" }, cwd, controls,
      agentTurn: { workerId: "issue-1", attemptId: "attempt-1", receiptPath: path.join(dataDir, "attempt-1.json") },
      initialInput: { agent: { providerId: "claude" }, prompt: "Submit this exactly once" }
    })).rejects.toThrow("did not replay the prompt");
    expect(factory.last.process.written.match(/Submit this exactly once/gu)).toHaveLength(1);
    expect(factory.last.process.terminated).toBe(true);
  });

  it("surfaces unavailable interactive tracking and restores the activity indicator after a late valid receipt", async () => {
    const { plugin, factory, tab, cwd, controls, restored } = await setup();
    factory.deliverReceipt = false;
    factory.exitWithoutReceipt = false;
    vi.useFakeTimers();
    let session;
    try {
      session = await plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" } } });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(controls.setTabIndicator).toHaveBeenCalledWith(expect.objectContaining({ label: "Tracking unavailable", color: "yellow" }));
      expect(restored.at(-1)?.codexIdentityError).toMatch(/Tracking and automatic recovery are unavailable/);
      vi.useRealTimers();
      const configDir = factory.last.env.CLOUDX_ENFORCED_CLAUDE_CONFIG_DIR!;
      const settings = JSON.parse(await fs.readFile(path.join(configDir, ".cloudx-settings.json"), "utf8"));
      const executionId = [...settings.hooks.SessionStart[0].hooks[0].command.matchAll(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gu)].at(-1)![0];
      await fs.writeFile(path.join(configDir, ".cloudx-conversation.json"), JSON.stringify({ version: 2, authority: "selected", tabId: tab.id, executionId, sessionId: SESSION, cwd }));
      await vi.waitFor(() => expect(restored.at(-1)?.codexIdentityError).toBeUndefined());
      expect(controls.setTabIndicator).toHaveBeenLastCalledWith(tab.indicator);
    } finally { session?.stop?.(); vi.useRealTimers(); }
  });
  it("does not submit Forge work when the actual native execution cannot deliver its startup receipt", async () => {
    const { plugin, factory, tab, cwd, controls, dataDir, claudeSettings } = await setup();
    await claudeSettings.acceptBypass();
    factory.deliverReceipt = false;
    await expect(plugin.createSession({ tab: { ...tab, ownerPluginId: "forge" }, cwd, controls,
      agentTurn: { workerId: "issue-1", attemptId: "attempt-1", receiptPath: path.join(dataDir, "attempt-1.json") },
      initialInput: { agent: { providerId: "claude" }, prompt: "Never submit this work" }
    })).rejects.toThrow("No worker prompt was submitted");
    expect(factory.lastCommandLine).not.toContain("Never submit this work");
    expect(factory.last.process.written).toBe("");
    expect(factory.last.process.terminated).toBe(true);
  });
  it("launches Claude Code in a per-tab config dir on the selected account", async () => {
    const { plugin, factory, tab, cwd, controls, account, dataDir, restored } = await setup();
    await plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" }, prompt: "Fix it" } });

    const configDir = path.join(dataDir, "claude-launches", "tab-1");
    // The login profile runs first; the selection is re-applied before exec.
    expect(factory.lastCommandLine).toMatch(/^unset ANTHROPIC_API_KEY /u);
    expect(factory.lastCommandLine).toContain('CLAUDE_CONFIG_DIR="$CLOUDX_ENFORCED_CLAUDE_CONFIG_DIR"');
    expect(factory.lastCommandLine).toContain('ANTHROPIC_CONFIG_DIR="$CLOUDX_ENFORCED_ANTHROPIC_CONFIG_DIR"');
    expect(factory.lastCommandLine).toMatch(/; exec \S+claude-fixture --settings \S+\.cloudx-settings\.json --append-system-prompt-file \S+\.cloudx-instructions\.md --add-dir \S+ --dangerously-skip-permissions -- 'Fix it'$/u);
    expect(factory.last.env).toMatchObject({ CLAUDE_CONFIG_DIR: configDir, CLOUDX_ENFORCED_CLAUDE_CONFIG_DIR: configDir });
    expect(factory.last.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(configDir, ".cloudx-settings.json"), "utf8"))).toMatchObject({
      apiKeyHelper: "", env: { ANTHROPIC_API_KEY: "", CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_CONFIG_DIR: path.join(configDir, "anthropic-auth") }
    });
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
    expect(factory.lastCommandLine).toContain(`--model claude-opus-5-5 --effort xhigh --session-id ${SESSION}`);
    expect(factory.lastCommandLine).not.toContain("Review");
    expect(factory.last.process.written).toContain("Review");
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
    expect(factory.lastCommandLine).toContain(`--resume ${SESSION}`);
    expect(factory.last.process.written).toContain("Review");
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

  it("starts the target fresh when the conversation has no transcript yet", async () => {
    const { plugin, tab, cwd, controls, accounts, account } = await setup();
    const other = await accounts.create({ providerId: "claude", label: "Personal", kind: "subscription" });
    const codex = await accounts.create({ providerId: "codex", label: "Codex", kind: "subscription" });
    // Claude Code writes the transcript only once the first prompt arrives.
    const current = { agent: { providerId: "claude", accountId: account.id }, resume: { mode: "session", sessionId: SESSION } };

    expect(await plugin.prepareAgentSwitch({ tab, cwd, controls, initialInput: current }, { providerId: "claude", accountId: other.id }))
      .toEqual({ agent: { providerId: "claude", accountId: other.id } });
    const next = await plugin.prepareAgentSwitch({ tab, cwd, controls, initialInput: current }, { providerId: "codex", accountId: codex.id });
    expect(next).toEqual({ agent: { providerId: "codex", accountId: codex.id } });
    await expect(fs.readdir(path.join(cwd, ".cloudx", "handoffs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records the confirmed conversation for usage and closes it when Claude exits", async () => {
    const { factory, tab, cwd, controls, env, dataDir, accounts, claudeSettings, restored } = await setup();
    const usage = { conversationStarted: vi.fn(), ended: vi.fn() };
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, dataDir, undefined, env, { accounts, claudeSettings, usage: usage as never });
    await plugin.createSession({ tab, cwd, workspaceId: "window-1", controls, initialInput: { agent: { providerId: "claude" } } });
    await fs.writeFile(path.join(dataDir, "claude-launches", "tab-1", ".cloudx-conversation.json"), JSON.stringify({
      version: 2, authority: "selected", tabId: "tab-1", executionId: restored.at(-1)!.codexExecutionId, sessionId: SESSION, cwd
    }));
    await vi.waitFor(() => expect(usage.conversationStarted).toHaveBeenCalledWith(expect.objectContaining({ id: "tab-1" }), "claude", expect.any(String), SESSION, "window-1"), { timeout: 2_000 });
    factory.last.process.exit(0);
    expect(usage.ended).toHaveBeenCalledWith("tab-1");
  });
});


it("records an explicit managed execution and preserves its mode through recovery despite changed defaults", async () => {
  const { plugin, factory, tab, cwd, controls, env, dataDir, restored, claudeSettings, account } = await setup();
  const binary = path.join(env.HOME, "reviewed-claude");
  await fs.writeFile(binary, '#!/bin/sh\necho "2.1.316 (Claude Code)"\n', { mode: 0o755 }); env.CLOUDX_CLAUDE_BIN = binary;
  const first = await plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" }, claudeLaunchMode: "cloudx-managed" } });
  await vi.waitFor(async () => expect(await new ClaudeConversationPolicies(dataDir).read(SESSION)).toMatchObject({ accountId: account.id, policy: { mode: "cloudx-managed" } }));
  const original = first.restoreInput!()!;
  expect(factory.lastCommandLine).toContain("--setting-sources user");
  expect(factory.lastCommandLine).toContain("CLAUDE_CODE_HOST_SKILL_CATALOG");
  expect(factory.lastCommandLine).toContain("CLAUDE_CODE_PLUGIN_DIRS");
  expect(original).toMatchObject({ claudeLaunchMode: "cloudx-managed", claudeLaunchPolicy: { mode: "cloudx-managed", exclusiveSkills: true } });
  const snapshot = await fs.readFile(path.join(dataDir, "claude-launches", tab.id, ".cloudx-launch-policy.json"), "utf8");
  await expect(first.applyRuntimeContext?.({})).rejects.toThrow("next launch");
  expect(await fs.readFile(path.join(dataDir, "claude-launches", tab.id, ".cloudx-launch-policy.json"), "utf8")).toBe(snapshot);
  await claudeSettings.update({ expectedRevision: (await claudeSettings.read()).revision, launchMode: "native-project" });
  const transcript = path.join(env.HOME, ".claude", "projects", "-work", `${SESSION}.jsonl`);
  await fs.mkdir(path.dirname(transcript), { recursive: true }); await fs.writeFile(transcript, "");
  first.stop?.();
  const recovered = await plugin.recoverSession({ tab, cwd, controls, initialInput: original });
  expect(factory.lastCommandLine).toContain("--setting-sources user");
  expect(await new AgentLaunchRecords(dataDir).read(tab.id, "claude")).toMatchObject({ claudeLaunchModeSource: "conversation", claudeLaunchPolicy: { mode: "cloudx-managed" } });
  expect(restored.at(-1)).toMatchObject({ claudeLaunchMode: "cloudx-managed" });
  recovered.stop?.();
});

it("rejects mode/account changes for a bound conversation before spawning or changing its overlay", async () => {
  const { plugin, factory, tab, cwd, controls, env, dataDir, accounts, account } = await setup();
  const binary = path.join(env.HOME, "reviewed-claude");
  await fs.writeFile(binary, '#!/bin/sh\necho "2.1.316 (Claude Code)"\n', { mode: 0o755 }); env.CLOUDX_CLAUDE_BIN = binary;
  const first = await plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" }, claudeLaunchMode: "cloudx-managed" } });
  await vi.waitFor(async () => expect(await new ClaudeConversationPolicies(dataDir).read(SESSION)).toBeDefined());
  const original = first.restoreInput!()!; const launches = factory.launches.length;
  const settingsPath = path.join(dataDir, "claude-launches", tab.id, ".cloudx-settings.json"); const before = await fs.readFile(settingsPath, "utf8");
  await expect(plugin.createSession({ tab, cwd, controls, initialInput: { ...original, claudeLaunchMode: "native-project" } })).rejects.toThrow("different launch mode");
  const other = await accounts.create({ providerId: "claude", label: "Other", kind: "subscription" });
  const transcript = path.join(env.HOME, ".claude", "projects", "-work", `${SESSION}.jsonl`);
  await fs.mkdir(path.dirname(transcript), { recursive: true }); await fs.writeFile(transcript, "");
  await expect(plugin.prepareAgentSwitch({ tab, cwd, controls, initialInput: original }, { providerId: "claude", accountId: other.id })).rejects.toThrow("recorded account");
  await expect(plugin.createSession({ tab, cwd, controls, initialInput: { ...original, agent: { providerId: "claude", accountId: other.id } } })).rejects.toThrow("different account");
  expect(factory.launches).toHaveLength(launches); expect(await fs.readFile(settingsPath, "utf8")).toBe(before);
  expect(original.agent).toEqual({ providerId: "claude", accountId: account.id }); first.stop?.();
});

it.each(["native-project", "cloudx-managed"] as const)("keeps the verified %s executable when a login profile changes PATH", async mode => {
  const { plugin, factory, tab, cwd, controls, env, dataDir } = await setup();
  const reviewed = path.join(env.HOME, "reviewed-bin"); const other = path.join(env.HOME, "profile-bin");
  await fs.mkdir(reviewed); await fs.mkdir(other);
  const binary = path.join(reviewed, "claude");
  await fs.writeFile(binary, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.316 (Claude Code)"; else echo verified-executable; fi\n', { mode: 0o755 });
  await fs.writeFile(path.join(other, "claude"), '#!/bin/sh\necho unreviewed-executable\n', { mode: 0o755 });
  env.CLOUDX_CLAUDE_BIN = "claude";
  env.PATH = `${reviewed}:${env.PATH}`;
  const profile = path.join(env.HOME, "profile.sh"); await fs.writeFile(profile, `export PATH=${other}:$PATH\n`);
  Object.assign(env, { BASH_ENV: profile });
  const session = await plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" }, claudeLaunchMode: mode } });
  try {
    const result = await runAgentCli(factory.last.command, factory.last.args, { cwd, env: factory.last.env });
    expect(result.code).toBe(0); expect(result.stdout.trim()).toBe("verified-executable");
    expect(await new AgentLaunchRecords(dataDir).read(tab.id, "claude")).toMatchObject({ command: await fs.realpath(binary), claudeLaunchPolicy: { nativeVersion: "2.1.316" } });
  } finally { session.stop?.(); }
});

it("keeps historical resume unverified and rejects strict mode, ambiguous resume and malformed launch input before spawn", async () => {
  const { plugin, factory, tab, cwd, controls, env, claudeSettings, dataDir } = await setup();
  const transcript = path.join(env.HOME, ".claude", "projects", "-work", `${SESSION}.jsonl`);
  await fs.mkdir(path.dirname(transcript), { recursive: true }); await fs.writeFile(transcript, "");
  await claudeSettings.update({ expectedRevision: (await claudeSettings.read()).revision, launchMode: "cloudx-managed" });
  const initialInput = { agent: { providerId: "claude" }, resume: { mode: "session", sessionId: SESSION } };
  await expect(plugin.createSession({ tab, cwd, controls, initialInput })).rejects.toThrow("historical");
  await expect(plugin.createSession({ tab, cwd, controls, initialInput: { ...initialInput, claudeLaunchMode: "invalid" } })).rejects.toThrow("launch mode must");
  await expect(plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" }, resume: { mode: "last" } } })).rejects.toThrow("exact saved Claude");
  expect(factory.launches).toHaveLength(0);
  const native = await plugin.createSession({ tab, cwd, controls, initialInput: { ...initialInput, claudeLaunchMode: "native-project" } });
  expect(await new AgentLaunchRecords(dataDir).read(tab.id, "claude")).toMatchObject({ historicalClaudeConversation: true, claudeLaunchPolicy: { exclusiveSkills: false } }); native.stop?.();
});


it("rejects a managed terminal before spawning or submitting when excluded project settings would clear disabled personal hooks", async () => {
  const { plugin, factory, tab, cwd, controls, env } = await setup();
  const personal = path.join(env.HOME, ".claude", "settings.json");
  const project = path.join(cwd, ".claude", "settings.json");
  await Promise.all([personal, project].map(file => fs.mkdir(path.dirname(file), { recursive: true })));
  await fs.writeFile(personal, '{"disableAllHooks":true}');
  await fs.writeFile(project, '{"disableAllHooks":false}');
  await expect(plugin.createSession({ tab, cwd, controls, initialInput: { agent: { providerId: "claude" }, claudeLaunchMode: "cloudx-managed", prompt: "Never submit work" } })).rejects.toThrow("disableAllHooks");
  expect(factory.launches).toHaveLength(0);
  expect(await fs.readFile(personal, "utf8")).toBe('{"disableAllHooks":true}');
  expect(await fs.readFile(project, "utf8")).toBe('{"disableAllHooks":false}');
});
