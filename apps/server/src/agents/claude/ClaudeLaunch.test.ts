import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { buildClaudeLaunchArgs, findClaudeTranscript } from "./ClaudeLaunch.js";
import { claudeLaunchEnv } from "../agentCli.js";
import { agentTurnReceiptPath, readClaudeTurnState } from "../agentTurn.js";
import { materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";
import { CodexConversationRecovery } from "../../plugins/CodexConversationRecovery.js";

const run = promisify(execFile);
const HELPER = fileURLToPath(new URL("../../../helpers/claude-hook-receipt.mjs", import.meta.url));
const SESSION = "a5570c58-978a-4694-84f9-c67756be3acd";
const EXECUTION = "0b8a3c1e-1111-4222-8333-944455556666";
const SETTINGS = { permissionMode: "bypassPermissions" as const, autoTrustWorkspace: true };

describe("buildClaudeLaunchArgs", () => {
  const options = { settings: SETTINGS, settingsPath: "/overlay/settings.json", addDirs: ["/rules"] };

  it("starts a new session with CloudX hooks and bypassed permissions", () => {
    expect(buildClaudeLaunchArgs(undefined, options)).toEqual(["--settings", "/overlay/settings.json", "--add-dir", "/rules", "--dangerously-skip-permissions"]);
  });

  it("resumes an exact session with a prompt and maps Codex effort names", () => {
    expect(buildClaudeLaunchArgs({ resume: { mode: "session", sessionId: SESSION }, prompt: "-continue", reasoningEffort: "ultra" }, options))
      .toEqual(["--settings", "/overlay/settings.json", "--add-dir", "/rules", "--dangerously-skip-permissions", "--effort", "max", "--resume", SESSION, "--", "-continue"]);
  });

  it("leaves model and effort to Claude settings unless the run chooses Claude values", () => {
    const configured = { permissionMode: "acceptEdits" as const, autoTrustWorkspace: false };
    const args = buildClaudeLaunchArgs({ model: "gpt-6.1-sol", reasoningEffort: "unknown", resume: { mode: "picker" } }, { ...options, settings: configured });
    expect(args).toEqual(["--settings", "/overlay/settings.json", "--add-dir", "/rules", "--permission-mode", "acceptEdits", "--resume"]);
    expect(buildClaudeLaunchArgs({ model: "claude-sonnet-5-5", reasoningEffort: "high" }, options)).toContain("claude-sonnet-5-5");
  });

  it("rejects malformed session ids", () => {
    expect(() => buildClaudeLaunchArgs({ resume: { mode: "session", sessionId: "../x" } }, options)).toThrow("exact session id");
  });
});

describe("claudeLaunchEnv", () => {
  it("removes inherited credentials and nested-session markers", () => {
    const env = claudeLaunchEnv({
      PATH: "/bin", ANTHROPIC_API_KEY: "inherited", CLAUDECODE: "1", CODEX_HOME: "/codex",
      CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CODE_MESSAGING_SOCKET: "/run/sock"
    }, "/overlay", {});
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/overlay" });
    expect(claudeLaunchEnv({}, "/overlay", { ANTHROPIC_API_KEY: "account" })).toMatchObject({ ANTHROPIC_API_KEY: "account" });
  });
});

describe("Claude overlay and hook receipts", () => {
  it("overrides every account variable with the launch environment's, whatever settings file sets it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-account-env-"));
    const providerHome = path.join(root, "home", ".claude");
    const accountHome = path.join(root, "account");
    await Promise.all([providerHome, accountHome, path.join(root, ".claude")].map(directory => fs.mkdir(directory, { recursive: true })));
    // The user's settings are empty; a trusted project sets a key of its own.
    await fs.writeFile(path.join(providerHome, "settings.json"), "{}");
    await fs.writeFile(path.join(root, ".claude", "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "project" } }));
    const options = { dataDir: path.join(root, "data"), tabId: "tab-1", accountHome, providerHome, executionId: EXECUTION, cwd: root };
    const env = async (launchEnv: NodeJS.ProcessEnv) => JSON.parse(await fs.readFile((await materializeClaudeHomeOverlay({ ...options, launchEnv })).settingsPath, "utf8")).env;

    const configDir = path.join(root, "data", "claude-launches", "tab-1");
    const cleared = { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "", CLAUDE_CONFIG_DIR: configDir };
    expect(await env({ PATH: "/bin" })).toEqual(cleared);
    // A selected API key, and an endpoint the CloudX process itself runs with, are kept.
    expect(await env({ ANTHROPIC_API_KEY: "selected", ANTHROPIC_BASE_URL: "https://gateway.example" })).toEqual({ ...cleared, ANTHROPIC_API_KEY: "selected", ANTHROPIC_BASE_URL: "https://gateway.example" });
    expect((await fs.stat(path.join(configDir, ".cloudx-settings.json"))).mode & 0o777).toBe(0o600);
  });

  it("links account credentials and the shared session store, and records hook receipts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-overlay-"));
    const dataDir = path.join(root, "data");
    const providerHome = path.join(root, "home", ".claude");
    const accountA = path.join(root, "account-a");
    const accountB = path.join(root, "account-b");
    await Promise.all([dataDir, providerHome, accountA, accountB].map(directory => fs.mkdir(directory, { recursive: true })));
    await fs.writeFile(path.join(accountA, ".credentials.json"), "{\"a\":true}");
    await fs.writeFile(path.join(accountB, ".credentials.json"), "{\"b\":true}");
    await fs.writeFile(path.join(providerHome, "settings.json"), "{}");
    await fs.writeFile(path.join(providerHome, "CLAUDE.md"), "Prefer small diffs.\n");
    const options = { dataDir, tabId: "tab-1", accountHome: accountA, providerHome, executionId: EXECUTION, cwd: root, trustProject: true };

    const overlay = await materializeClaudeHomeOverlay(options);
    expect(await fs.readlink(path.join(overlay.configDir, ".credentials.json"))).toBe(path.join(accountA, ".credentials.json"));
    expect(await fs.readlink(path.join(overlay.configDir, "projects"))).toBe(path.join(providerHome, "projects"));
    expect(await fs.readlink(path.join(overlay.configDir, "settings.json"))).toBe(path.join(providerHome, "settings.json"));
    expect(await fs.readFile(path.join(overlay.configDir, "CLAUDE.md"), "utf8")).toContain("Prefer small diffs.");
    expect(JSON.parse(await fs.readFile(path.join(overlay.configDir, ".claude.json"), "utf8"))).toMatchObject({
      hasCompletedOnboarding: true, projects: { [root]: { hasTrustDialogAccepted: true } }
    });

    // Switching accounts replaces only the credential link.
    await materializeClaudeHomeOverlay({ ...options, accountHome: accountB });
    expect(await fs.readlink(path.join(overlay.configDir, ".credentials.json"))).toBe(path.join(accountB, ".credentials.json"));

    const settings = JSON.parse(await fs.readFile(overlay.settingsPath, "utf8"));
    const command: string = settings.hooks.SessionStart[0].hooks[0].command;
    // CloudX never accepts Claude Code's bypass warning on the user's behalf.
    expect(settings.skipDangerousModePermissionPrompt).toBeUndefined();
    expect(command).toContain("claude-hook-receipt.mjs");

    const transcript = path.join(providerHome, "projects", "-work", `${SESSION}.jsonl`);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(transcript, "");
    const payload = JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: root, prompt_id: "p1" });
    await run("sh", ["-c", `printf '%s' '${payload}' | ${process.execPath} ${HELPER} ${overlay.configDir} tab-1 ${EXECUTION} SessionStart`]);
    expect(new CodexConversationRecovery(overlay.configDir).readForExecution("tab-1", EXECUTION)).toEqual({
      sessionId: SESSION, cwd: root, transcriptPath: transcript, selection: { tabId: "tab-1", executionId: EXECUTION }
    });
    await run("sh", ["-c", `printf '%s' '${payload}' | ${process.execPath} ${HELPER} ${overlay.configDir} tab-1 ${EXECUTION} UserPromptSubmit`]);
    expect(JSON.parse(await fs.readFile(agentTurnReceiptPath(overlay.configDir), "utf8"))).toMatchObject({ sessionId: SESSION, turnId: "p1", status: "running" });
    await run("sh", ["-c", `printf '%s' '${payload}' | ${process.execPath} ${HELPER} ${overlay.configDir} tab-1 ${EXECUTION} Stop`]);
    // The turn completes once the transcript shows the Stop hooks finished.
    expect(JSON.parse(await fs.readFile(agentTurnReceiptPath(overlay.configDir), "utf8"))).toMatchObject({ status: "running" });
    await fs.appendFile(transcript, `${JSON.stringify({ type: "system", subtype: "stop_hook_summary", hookCount: 1 })}\n`);
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(agentTurnReceiptPath(overlay.configDir), "utf8"))).toMatchObject({ status: "completed" }), { timeout: 5_000 });

    // Malformed payloads never fail the hook.
    await expect(run("sh", ["-c", `printf 'not json' | ${process.execPath} ${HELPER} ${overlay.configDir} tab-1 ${EXECUTION} Stop`])).resolves.toBeTruthy();

    expect(await findClaudeTranscript(path.join(providerHome, "projects"), SESSION)).toBe(transcript);
    await expect(findClaudeTranscript(path.join(providerHome, "projects"), "b5570c58-978a-4694-84f9-c67756be3acd")).rejects.toThrow("unavailable");
  });
});

describe("Claude Forge turn receipts", () => {
  async function hook(configDir: string, event: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
    const input = JSON.stringify(payload).replaceAll("'", "'\\''");
    await run("sh", ["-c", `printf '%s' '${input}' | ${process.execPath} ${HELPER} ${configDir} tab-1 ${EXECUTION} ${event}`], { env: { ...process.env, ...env } });
  }
  async function forgeAttempt() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-forge-"));
    const receiptPath = path.join(root, "attempt-1.json");
    const transcript = path.join(root, "t.jsonl");
    await fs.writeFile(path.join(root, ".cloudx-forge-turn.json"), JSON.stringify({ workerId: "issue-1", attemptId: "attempt-1", receiptPath, expectedThreadId: SESSION }));
    return {
      root, receiptPath, transcript,
      base: { session_id: SESSION, cwd: root, transcript_path: transcript, prompt_id: "p1" },
      record: (value: unknown) => `${JSON.stringify(value)}\n`,
      receipt: async () => JSON.parse(await fs.readFile(receiptPath, "utf8")),
      final: async () => JSON.parse(await fs.readFile(`${receiptPath}.final.json`, "utf8"))
    };
  }
  const feedback = { type: "user", message: { role: "user", content: "Stop hook feedback:\n[check] Run the tests first." } };
  const summary = (context: string[] = []) => ({ type: "system", subtype: "stop_hook_summary", hookCount: 2, hookAdditionalContext: context });
  const response = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

  it("records the first turn of an attempt and its final response", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-forge-"));
    const receiptPath = path.join(root, "attempt-1.json");
    await fs.writeFile(path.join(root, ".cloudx-forge-turn.json"), JSON.stringify({ workerId: "issue-1", attemptId: "attempt-1", receiptPath, expectedThreadId: SESSION }));
    const base = { session_id: SESSION, cwd: root, transcript_path: path.join(root, "t.jsonl") };

    await hook(root, "UserPromptSubmit", { ...base, prompt_id: "p1" });
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toEqual({ workerId: "issue-1", attemptId: "attempt-1", threadId: SESSION, turnId: "p1", status: "running" });
    // A second prompt typed into the tab does not replace the attempt's turn.
    await hook(root, "UserPromptSubmit", { ...base, prompt_id: "p2" });
    await hook(root, "Stop", { ...base, prompt_id: "p2", last_assistant_message: "other" });
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toMatchObject({ turnId: "p1", status: "running" });

    await hook(root, "Stop", { ...base, prompt_id: "p1", last_assistant_message: "Done. Report written." });
    // The transcript did not exist at the Stop; its summary still settles the turn.
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toMatchObject({ turnId: "p1", status: "running" });
    await fs.writeFile(base.transcript_path, `${JSON.stringify({ type: "system", subtype: "stop_hook_summary", hookCount: 1, hookAdditionalContext: [] })}\n`);
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toMatchObject({ turnId: "p1", status: "completed" }), { timeout: 5_000 });
    expect(JSON.parse(await fs.readFile(`${receiptPath}.final.json`, "utf8"))).toMatchObject({ turnId: "p1", status: "completed", text: "Done. Report written." });
  });

  it("completes after a Stop hook continues the turn, with the later final response", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-forge-"));
    const receiptPath = path.join(root, "attempt-1.json");
    const transcript = path.join(root, "t.jsonl");
    await fs.writeFile(transcript, "");
    await fs.writeFile(path.join(root, ".cloudx-forge-turn.json"), JSON.stringify({ workerId: "issue-1", attemptId: "attempt-1", receiptPath, expectedThreadId: SESSION }));
    const base = { session_id: SESSION, cwd: root, transcript_path: transcript, prompt_id: "p1" };
    const append = (record: unknown) => fs.appendFile(transcript, `${JSON.stringify(record)}\n`);
    const receipt = async () => JSON.parse(await fs.readFile(receiptPath, "utf8"));

    await hook(root, "UserPromptSubmit", base);
    await hook(root, "Stop", { ...base, last_assistant_message: "I will run the tests next." });
    // Another Stop hook blocks: Claude records its feedback and continues.
    await append({ type: "user", message: { role: "user", content: "Stop hook feedback:\n[check] Run the tests first." } });
    await append({ type: "system", subtype: "stop_hook_summary", hookCount: 2 });
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(await receipt()).toMatchObject({ status: "running" });

    await append({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Tests pass." }] } });
    await hook(root, "Stop", { ...base, last_assistant_message: "Tests pass. Done." });
    await append({ type: "system", subtype: "stop_hook_summary", hookCount: 2 });
    await vi.waitFor(async () => expect(await receipt()).toMatchObject({ status: "completed" }), { timeout: 5_000 });
    expect(JSON.parse(await fs.readFile(`${receiptPath}.final.json`, "utf8"))).toMatchObject({ text: "Tests pass. Done." });
  });

  it("keeps the turn running when a Stop hook adds context and the turn continues", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-forge-"));
    const receiptPath = path.join(root, "attempt-1.json");
    const transcript = path.join(root, "t.jsonl");
    await fs.writeFile(transcript, "");
    await fs.writeFile(path.join(root, ".cloudx-forge-turn.json"), JSON.stringify({ workerId: "issue-1", attemptId: "attempt-1", receiptPath, expectedThreadId: SESSION }));
    const base = { session_id: SESSION, cwd: root, transcript_path: transcript, prompt_id: "p1" };
    const append = (record: unknown) => fs.appendFile(transcript, `${JSON.stringify(record)}\n`);
    await hook(root, "UserPromptSubmit", base);
    await hook(root, "Stop", { ...base, last_assistant_message: "Interim response." });
    // As Claude Code 2.1.289 records hookSpecificOutput.additionalContext from a Stop hook.
    await append({ type: "attachment", attachment: { type: "hook_additional_context" } });
    await append({ type: "system", subtype: "stop_hook_summary", hookCount: 1, hookAdditionalContext: ["Also run the tests."] });
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toMatchObject({ status: "running" });

    await hook(root, "Stop", { ...base, last_assistant_message: "Final response." });
    await append({ type: "system", subtype: "stop_hook_summary", hookCount: 1, hookAdditionalContext: [] });
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toMatchObject({ status: "completed" }), { timeout: 5_000 });
    expect(JSON.parse(await fs.readFile(`${receiptPath}.final.json`, "utf8"))).toMatchObject({ text: "Final response." });
  });

  it("matches each Stop to its own summary when the transcript appears only after both", async () => {
    const { root, transcript, base, record, receipt, final } = await forgeAttempt();
    await hook(root, "UserPromptSubmit", base);
    // Two quick responses; Claude flushes the transcript only afterwards.
    await hook(root, "Stop", { ...base, last_assistant_message: "Interim." });
    await hook(root, "Stop", { ...base, last_assistant_message: "Final." });
    await fs.writeFile(transcript, record(response("Interim.")) + record(feedback) + record(summary()) + record(response("Final.")) + record(summary()));
    await vi.waitFor(async () => expect(await receipt()).toMatchObject({ status: "completed" }), { timeout: 5_000 });
    expect(await final()).toMatchObject({ text: "Final." });
  });

  it("completes when Claude ends the turn at its Stop continuation cap", async () => {
    const { root, transcript, base, record, receipt, final } = await forgeAttempt();
    const cap = { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "1" };
    await fs.writeFile(transcript, "");
    await hook(root, "UserPromptSubmit", base);
    await hook(root, "Stop", { ...base, last_assistant_message: "First." }, cap);
    await fs.appendFile(transcript, record(feedback) + record(summary()) + record(response("Second.")));
    // The second block exceeds the cap of one, so Claude ends the turn.
    await hook(root, "Stop", { ...base, last_assistant_message: "Second." }, cap);
    await fs.appendFile(transcript, record(feedback) + record(summary()));
    await vi.waitFor(async () => expect(await receipt()).toMatchObject({ status: "completed" }), { timeout: 5_000 });
    expect(await final()).toMatchObject({ text: "Second." });
  });

  it("applies the continuation cap only to consecutive continuations without a tool call", async () => {
    const { root, transcript, base, record, receipt, final } = await forgeAttempt();
    const cap = { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "1" };
    const toolCall = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } };
    await fs.writeFile(transcript, "");
    await hook(root, "UserPromptSubmit", base);
    await hook(root, "Stop", { ...base, last_assistant_message: "First." }, cap);
    await fs.appendFile(transcript, record(feedback) + record(summary()) + record(toolCall) + record(response("Interim after tool.")));
    // A tool call reset Claude's count, so this continuation is within the cap.
    await hook(root, "Stop", { ...base, last_assistant_message: "Interim after tool." }, cap);
    await fs.appendFile(transcript, record(feedback) + record(summary()));
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(await receipt()).toMatchObject({ status: "running" });
    await fs.appendFile(transcript, record(response("Actual final response.")));
    await hook(root, "Stop", { ...base, last_assistant_message: "Actual final response." }, cap);
    await fs.appendFile(transcript, record(summary()));
    await vi.waitFor(async () => expect(await receipt()).toMatchObject({ status: "completed" }), { timeout: 5_000 });
    expect(await final()).toMatchObject({ text: "Actual final response." });
  });

  it("finds the final summary of a turn longer than one read", async () => {
    const { root, transcript, base, record, receipt, final } = await forgeAttempt();
    await fs.writeFile(transcript, "");
    await hook(root, "UserPromptSubmit", base);
    const output = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(1024 * 1024) }] } };
    await fs.appendFile(transcript, record(output).repeat(18) + record(response("Done.")));
    await hook(root, "Stop", { ...base, last_assistant_message: "Done." });
    await fs.appendFile(transcript, record(summary()));
    await vi.waitFor(async () => expect(await receipt()).toMatchObject({ status: "completed" }), { timeout: 10_000 });
    expect(await final()).toMatchObject({ text: "Done." });
  });

  it("ignores another conversation and records API failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-forge-"));
    const receiptPath = path.join(root, "attempt-1.json");
    await fs.writeFile(path.join(root, ".cloudx-forge-turn.json"), JSON.stringify({ workerId: "issue-1", attemptId: "attempt-1", receiptPath, expectedThreadId: SESSION }));
    await hook(root, "UserPromptSubmit", { session_id: "b5570c58-978a-4694-84f9-c67756be3acd", cwd: root, prompt_id: "p1" });
    await expect(fs.stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });

    await hook(root, "UserPromptSubmit", { session_id: SESSION, cwd: root, prompt_id: "p1" });
    await hook(root, "StopFailure", { session_id: SESSION, cwd: root, prompt_id: "p1", error: "rate_limit" });
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toMatchObject({ status: "failed", error: "rate_limit" });
  });
});

describe("Claude turn state", () => {
  it("treats a running turn the user interrupted as idle until the next prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-interrupt-"));
    const receipt = agentTurnReceiptPath(root);
    const transcript = path.join(root, "t.jsonl");
    const line = (record: unknown) => `${JSON.stringify(record)}\n`;
    await fs.writeFile(receipt, JSON.stringify({ version: 1, sessionId: SESSION, turnId: "p1", status: "running" }));
    await fs.writeFile(transcript, line({ type: "user", message: { role: "user", content: "Refactor the parser." } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }) +
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }));
    expect(readClaudeTurnState(receipt, transcript)).toBe("running");

    // Esc writes the marker and no Stop hook runs.
    await fs.appendFile(transcript, line({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
    expect(readClaudeTurnState(receipt, transcript)).toBe("idle");

    await fs.appendFile(transcript, line({ type: "user", message: { role: "user", content: "Try again, smaller." } }));
    expect(readClaudeTurnState(receipt, transcript)).toBe("running");
    expect(readClaudeTurnState(receipt, undefined)).toBe("running");
  });
});
