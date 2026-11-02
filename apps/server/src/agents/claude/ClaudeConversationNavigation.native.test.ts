import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ClaudeLaunchMode } from "@cloudx/shared";
import { materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";
import { ClaudeConversationPolicies } from "./ClaudeConversationPolicies.js";
import { claudeAccountLaunch, runAgentCli } from "../agentCli.js";

const claude = process.env.CLOUDX_NATIVE_CLAUDE;
const native = it.skipIf(!claude);
const SESSION = "a5570c58-978a-4694-84f9-c67756be3acd";
const EXECUTION = "c5570c58-978a-4694-84f9-c67756be3acd";

native("native 2.1.316 blocks conflicting resumed conversations before model work and keeps historical Native project history unverified", async () => {
  expect((await runAgentCli(claude!, ["--version"])).stdout.trim()).toBe("2.1.316 (Claude Code)");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-navigation-native-"));
  const dataDir = path.join(root, "data"), providerHome = path.join(root, "personal"), accountHome = path.join(root, "account"), cwd = path.join(root, "project");
  let modelRequests = 0;
  const server = http.createServer(async (request, response) => {
    let input = ""; for await (const chunk of request) input += chunk;
    if (request.url?.includes("count_tokens")) { response.setHeader("content-type", "application/json"); response.end('{"input_tokens":1}'); return; }
    if (!request.url?.includes("messages")) { response.writeHead(404); response.end(); return; }
    modelRequests++;
    const message = { id: "msg_navigation", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Local navigation fixture complete." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(message));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Local TCP endpoint required.");
  const baseEnv = { PATH: process.env.PATH, HOME: path.join(root, "home"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  try {
    await Promise.all([dataDir, providerHome, accountHome, cwd, baseEnv.HOME].map(directory => fs.mkdir(directory, { recursive: true })));
    const execute = async (tabId: string, mode: ClaudeLaunchMode, accountId: string, resume: boolean) => {
      const configDir = path.join(dataDir, "claude-launches", tabId);
      const account = claudeAccountLaunch(baseEnv, configDir, { ANTHROPIC_API_KEY: "fake-local-navigation-key" });
      const overlay = await materializeClaudeHomeOverlay({ dataDir, tabId, executionId: EXECUTION, accountHome, providerHome, cwd,
        nativeVersion: "2.1.316", launchMode: mode, launchEnv: account.env, accountPolicy: account.policy, trustProject: true,
        conversationPolicy: { accountId, ...(resume ? { sessionId: SESSION } : {}) } });
      const before = modelRequests;
      const result = await runAgentCli(claude!, ["--settings", overlay.settingsPath, ...overlay.configurationArgs, "--append-system-prompt-file", overlay.instructionsPath,
        resume ? "--resume" : "--session-id", SESSION, "--print", "--output-format", "json", "--model", "claude-sonnet-4-6", "--permission-mode", "dontAsk", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--", "Only run the local navigation fixture."],
      { cwd, env: account.env, timeoutMs: 20_000 });
      const navigation = JSON.parse(await fs.readFile(path.join(configDir, ".cloudx-conversation-navigation.json"), "utf8"));
      return { result, navigation, calls: modelRequests - before, configDir };
    };
    const store = new ClaudeConversationPolicies(dataDir);
    const first = await execute("new-native", "native-project", "account-a", false);
    expect(first.result.code).toBe(0); expect(first.calls).toBeGreaterThan(0); expect(first.navigation).toMatchObject({ source: "startup", historical: false });
    expect(await store.read(SESSION)).toMatchObject({ accountId: "account-a", policy: { mode: "native-project" } });
    for (const [tab, mode, accountId] of [["mode-conflict", "cloudx-managed", "account-a"], ["account-conflict", "native-project", "account-b"]] as const) {
      const blocked = await execute(tab, mode, accountId, true);
      expect(blocked.calls).toBe(0); expect(blocked.navigation.source).toBe("resume");
      expect(blocked.result.stdout + blocked.result.stderr).toContain("CloudX blocked this prompt");
    }
    await fs.unlink(path.join(dataDir, "claude-conversation-policies", `${SESSION}.json`));
    const managedHistory = await execute("unknown-managed", "cloudx-managed", "account-a", true);
    expect(managedHistory.calls).toBe(0); expect(await store.read(SESSION)).toBeUndefined();
    const nativeHistory = await execute("unknown-native", "native-project", "account-a", true);
    expect(nativeHistory.calls).toBeGreaterThan(0); expect(nativeHistory.navigation).toMatchObject({ source: "resume", historical: true });
    expect(await store.read(SESSION)).toBeUndefined();
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
