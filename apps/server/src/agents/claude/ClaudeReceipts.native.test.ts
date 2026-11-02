import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { CodexConversationRecovery } from "../../plugins/CodexConversationRecovery.js";
import { buildEnforcedLoginShellLaunch, shellQuote } from "../../terminal/ShellLaunch.js";
import { claudeAccountLaunch, runAgentCli } from "../agentCli.js";
import { agentTurnReceiptPath } from "../agentTurn.js";
import { CLAUDE_FORGE_TURN_BINDING, claudeOverlayPath, materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";
import { verifyClaudeNativeAccount } from "./ClaudeNativeSettings.js";

const claude = process.env.CLOUDX_NATIVE_CLAUDE;
const native = it.skipIf(!claude);
const SESSION = "e3120393-7cc9-48da-9a34-dde342cfd13a";
const EXECUTION = "a9a10b24-0b8c-44fb-ad66-b9155346559f";
const TAB = "native-receipts";

type Scenario = "success" | "continued" | "failure";
type Settings = Record<string, unknown>;

native.each([
  ["success", {}],
  ["continued", { allowManagedHooksOnly: false }],
  ["failure", { disableAllHooks: false }]
] as const)("native 2.1.316 delivers %s Forge receipts with compatible managed policy %j", async (scenario, managed) => {
  const fixture = await receiptFixture(scenario, managed);
  try {
    await fixture.execute();
    if (scenario === "failure") expect(fixture.requestObservations.length).toBeGreaterThan(0);
    else expect(fixture.requestObservations.length).toBe(scenario === "continued" ? 2 : 1);
    for (const observation of fixture.requestObservations) expect(observation).toEqual({
      selectedKey: true, serviceHeader: true, endpoint: true, turnRunning: true, boundConversation: true,
      forgeRunning: true, profileRan: true
    });
    await vi.waitFor(async () => {
      expect(await fixture.turn()).toMatchObject({ sessionId: SESSION, status: scenario === "failure" ? "failed" : "completed" });
      expect(await fixture.receipt()).toMatchObject({
        workerId: "fixture-worker", attemptId: "fixture-attempt", threadId: SESSION,
        status: scenario === "failure" ? "failed" : "completed"
      });
    }, { timeout: 10_000 });
    if (scenario !== "failure") expect(await fixture.final()).toMatchObject({ text: "Local receipt fixture complete.", status: "completed" });
    expect(await fs.readFile(fixture.userSettings, "utf8")).toBe(fixture.originalSettings);
    expect(fixture.conversation()).toMatchObject({ sessionId: SESSION, cwd: fixture.cwd, selection: { executionId: EXECUTION, tabId: TAB } });
  } finally { await fixture.close(); }
}, 60_000);

async function receiptFixture(scenario: Scenario, managed: Settings) {
  expect((await runAgentCli(claude!, ["--version"])).stdout.trim()).toBe("2.1.316 (Claude Code)");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-receipts-"));
  const dataDir = path.join(root, "data");
  const providerHome = path.join(root, "personal");
  const accountHome = path.join(root, "account");
  const cwd = path.join(root, "project");
  const configDir = claudeOverlayPath(dataDir, TAB);
  const receiptPath = path.join(root, "forge.json");
  const userSettings = path.join(providerHome, "settings.json");
  const profileMarker = path.join(root, "profile-ran");
  const requestObservations: Array<Record<string, boolean>> = [];
  await Promise.all([providerHome, accountHome, cwd, path.join(root, "home"), path.join(cwd, ".claude")].map(directory => fs.mkdir(directory, { recursive: true })));
  const userHooks: Settings = {};
  if (scenario === "continued") {
    const continuation = path.join(root, "continue-once.mjs");
    await fs.writeFile(continuation, `import fs from "node:fs"; const marker = ${JSON.stringify(path.join(root, "continued"))}; if (!fs.existsSync(marker)) { fs.writeFileSync(marker, "continued"); console.log(JSON.stringify({decision:"block",reason:"Continue once for the isolated receipt fixture."})); }`);
    userHooks.Stop = [{ hooks: [{ type: "command", command: [process.execPath, continuation].map(shellQuote).join(" ") }] }];
  }
  const conflictingEnv = {
    CLAUDE_CODE_USE_ANTHROPIC_AWS: "1", CLAUDE_CODE_USE_MANTLE: "1", CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_AWS_API_KEY: "fake-unrelated-aws",
    ANTHROPIC_API_KEY: "fake-unrelated-key", ANTHROPIC_AUTH_TOKEN: "fake-unrelated-bearer",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1/unrelated", CLAUDE_CONFIG_DIR: path.join(root, "unrelated"),
    ANTHROPIC_CONFIG_DIR: path.join(root, "unrelated-auth")
  };
  const originalSettings = JSON.stringify({ hooks: userHooks, apiKeyHelper: "printf fake-unrelated-helper", env: conflictingEnv });
  await fs.writeFile(userSettings, originalSettings);
  await fs.writeFile(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ env: conflictingEnv }));
  await fs.writeFile(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ env: conflictingEnv }));
  const profile = path.join(root, "profile.sh");
  await fs.writeFile(profile, [...Object.entries(conflictingEnv).map(([key, value]) => `export ${key}=${shellQuote(value)}`), `touch ${shellQuote(profileMarker)}`].join("\n"));
  const json = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
  const conversation = () => new CodexConversationRecovery(configDir).readForExecution(TAB, EXECUTION);
  const server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (request.url?.includes("count_tokens")) { response.setHeader("content-type", "application/json"); response.end('{"input_tokens":1}'); return; }
    if (!request.url?.includes("messages")) { response.writeHead(404); response.end(); return; }
    requestObservations.push({
      selectedKey: request.headers["x-api-key"] === "fake-selected-local-key",
      serviceHeader: request.headers["x-cloudx-fixture"] === "intentional-service-header",
      endpoint: request.url.startsWith("/selected/v1/messages"),
      turnRunning: (await json(agentTurnReceiptPath(configDir))).status === "running",
      boundConversation: conversation()?.sessionId === SESSION,
      forgeRunning: (await json(receiptPath)).status === "running",
      profileRan: await fs.stat(profileMarker).then(() => true, () => false)
    });
    if (scenario === "failure") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Isolated synthetic failure." } }));
      return;
    }
    const message = {
      id: `msg_fixture_${requestObservations.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Local receipt fixture complete." }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    };
    if (!JSON.parse(text).stream) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(message)); return; }
    response.setHeader("content-type", "text/event-stream");
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Local receipt fixture complete." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" }
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fixture needs a TCP endpoint.");
  const baseEnv = {
    PATH: process.env.PATH, HOME: path.join(root, "home"), SHELL: "/bin/bash", BASH_ENV: profile,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/selected`, ANTHROPIC_CUSTOM_HEADERS: "X-CloudX-Fixture: intentional-service-header",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1"
  };
  return {
    cwd, originalSettings, userSettings, requestObservations, conversation,
    receipt: () => json(receiptPath), turn: () => json(agentTurnReceiptPath(configDir)), final: () => json(`${receiptPath}.final.json`),
    execute: async () => {
      const account = claudeAccountLaunch(baseEnv, configDir, { ANTHROPIC_API_KEY: "fake-selected-local-key" });
      const overlay = await materializeClaudeHomeOverlay({ dataDir, tabId: TAB, accountHome, providerHome, executionId: EXECUTION,
        cwd, trustProject: true, launchEnv: account.env, accountPolicy: account.policy });
      await verifyClaudeNativeAccount({ command: claude!, settingsPath: overlay.settingsPath, cwd, env: account.env }, account.policy);
      expect(requestObservations).toEqual([]);
      expect(conversation()).toBeUndefined();
      await fs.writeFile(path.join(configDir, CLAUDE_FORGE_TURN_BINDING), JSON.stringify({
        workerId: "fixture-worker", attemptId: "fixture-attempt", expectedThreadId: SESSION, receiptPath
      }));
      const args = ["--settings", overlay.settingsPath, "--managed-settings", JSON.stringify(managed),
        "--append-system-prompt-file", overlay.instructionsPath, "--session-id", SESSION, "--print", "--output-format", "json",
        "--model", "claude-sonnet-4-6", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
      if (scenario === "failure") {
        args[args.indexOf("json")] = "stream-json";
        args.push("--input-format", "stream-json", "--verbose");
        const launch = buildEnforcedLoginShellLaunch(claude!, args, account.env, account.enforced);
        const child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
        let startupError: Error | undefined;
        const closed = new Promise<void>(resolve => {
          child.once("error", error => { startupError = error; });
          child.once("close", () => resolve());
        });
        child.stdout.resume(); child.stderr.resume();
        child.stdin.on("error", () => undefined);
        child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Run only the local receipt fixture." } }) + "\n");
        try {
          await vi.waitFor(async () => {
            if (startupError) throw startupError;
            expect(await json(receiptPath)).toMatchObject({ status: "failed" });
          }, { timeout: 10_000 });
        } finally {
          child.stdin.end(); child.kill("SIGKILL");
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([closed, new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("The isolated native failure fixture did not exit during cleanup.")), 5_000);
              timer.unref();
            })]);
          } finally { clearTimeout(timer); }
        }
        return;
      }
      args.push("--", "Run only the local receipt fixture.");
      const launch = buildEnforcedLoginShellLaunch(claude!, args, account.env, account.enforced);
      const result = await runAgentCli(launch.command, launch.args, { cwd, env: launch.env, timeoutMs: 40_000 });
      expect(result.code).toBe(0);
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}
