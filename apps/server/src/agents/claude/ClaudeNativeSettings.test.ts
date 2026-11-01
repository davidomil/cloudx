import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { assertClaudeNativeAccountStatus, inspectClaudeNativeSettings, verifyClaudeNativeAccount } from "./ClaudeNativeSettings.js";
import { resolveClaudeAccountPolicy } from "./claudeAccountPolicy.js";
import type { AgentCliOptions } from "../agentCli.js";

const input = { command: "claude", settingsPath: "/selected/settings.json", cwd: "/workspace", env: {} };
const policy = resolveClaudeAccountPolicy({}, "/selected", { ANTHROPIC_API_KEY: "fake-selected" });
const status = { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", configDirectory: "/selected", apiKeySource: "ANTHROPIC_API_KEY" };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it("reads native authentication without starting a session or exposing private output", async () => {
  const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(status), stderr: "" }));
  await verifyClaudeNativeAccount(input, policy, run);
  expect(run).toHaveBeenCalledWith("claude", ["--settings", input.settingsPath, "auth", "status", "--json"], expect.objectContaining({ cwd: input.cwd, timeoutMs: 15_000 }));
});

it.each([
  { ...status, apiProvider: "mantle" }, { ...status, configDirectory: "/unrelated" },
  { ...status, apiKeySource: "apiKeyHelper" }, { ...status, authMethod: "api_key_helper" },
  { ...status, authMethod: "oauth_token" }, { ...status, loggedIn: "true" }, null,
])("refuses native account redirection and unsupported status contracts: %j", value => {
  expect(() => assertClaudeNativeAccountStatus(value, policy)).toThrow(/selected CloudX account|cannot be verified/);
});

it("never echoes native status output containing credential values", async () => {
  await expect(verifyClaudeNativeAccount(input, policy, async () => ({ code: 1, stdout: "never-print-key", stderr: "never-print-secret" }))).rejects.not.toThrow(/never-print/);
});

it.each([null, 1, 2, 137])("rejects a failed native auth-status process (%s) even if stdout resembles a successful status", async code => {
  await expect(verifyClaudeNativeAccount(input, policy, async () => ({ code, stdout: JSON.stringify(status), stderr: "never-print-crash-details" }))).rejects.toThrow("did not exit normally");
});

it("accepts the native unauthenticated exit without claiming the selected subscription is logged in", async () => {
  const selected = resolveClaudeAccountPolicy({}, "/selected", {});
  await expect(verifyClaudeNativeAccount(input, selected, async () => ({ code: 1, stdout: JSON.stringify({ ...status, loggedIn: false, authMethod: "none" }), stderr: "" }))).resolves.toBeUndefined();
});

it.each(["bedrock", "mantle", "anthropicAws", "vertex", "foundry"] as const)("accepts explicit native %s service authentication", provider => {
  const selectors = { bedrock: "CLAUDE_CODE_USE_BEDROCK", mantle: "CLAUDE_CODE_USE_MANTLE", anthropicAws: "CLAUDE_CODE_USE_ANTHROPIC_AWS", vertex: "CLAUDE_CODE_USE_VERTEX", foundry: "CLAUDE_CODE_USE_FOUNDRY" };
  const selected = resolveClaudeAccountPolicy({ [selectors[provider]]: "1" }, "/selected", {});
  expect(() => assertClaudeNativeAccountStatus({ ...status, apiProvider: provider, authMethod: "third_party" }, selected)).not.toThrow();
  expect(() => assertClaudeNativeAccountStatus(status, selected)).toThrow("apiProvider");
});

it("bounds and validates isolated settings readback and sends no model input", async () => {
  const responses = [
    ["initialize", { claude_code_version: "2.1.316", account: {} }],
    ["get_settings", { effective: { model: "sonnet" }, sources: [{ source: "userSettings", settings: {} }] }],
    ["get_hooks_listing", { hooks: [], policy: { allDisabled: false } }]
  ];
  const stdout = responses.map(([request_id, response]) => JSON.stringify({ type: "control_response", response: { subtype: "success", request_id, response } })).join("\n");
  const run = vi.fn(async (_command: string, _args: string[], _options: AgentCliOptions) => ({ code: 0, stdout, stderr: "" }));
  expect(await inspectClaudeNativeSettings(input, run)).toMatchObject({ version: "2.1.316", effective: { model: "sonnet" } });
  const options = run.mock.calls[0]![2];
  expect(options).toMatchObject({ maxOutputBytes: 2 * 1024 * 1024, timeoutMs: 30_000 });
  expect(options.stdin!.split("\n").filter(Boolean).map(line => JSON.parse(line).type)).toEqual(["control_request", "control_request", "control_request"]);
  await expect(inspectClaudeNativeSettings(input, async () => ({ code: 0, stdout: stdout + "\nprivate-malformed-output", stderr: "" }))).rejects.not.toThrow("private-malformed-output");
});

const claude = process.env.CLOUDX_NATIVE_CLAUDE;
it.skipIf(!claude)("native 2.1.316 auth readback preserves selected routing against user/project sources without executing hooks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-account-readback-")); roots.push(root);
  const configDir = path.join(root, "config"); await fs.mkdir(configDir);
  const marker = path.join(root, "hook-ran");
  const user = { apiKeyHelper: "printf fake-unrelated", env: { CLAUDE_CODE_USE_MANTLE: "1", ANTHROPIC_AWS_API_KEY: "fake-unrelated" }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] } };
  await fs.writeFile(path.join(configDir, "settings.json"), JSON.stringify(user));
  await fs.mkdir(path.join(root, ".claude"));
  await fs.writeFile(path.join(root, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_ANTHROPIC_AWS: "1" } }));
  const selected = resolveClaudeAccountPolicy({}, configDir, { ANTHROPIC_API_KEY: "fake-selected-no-model" });
  const settingsPath = path.join(root, "launch.json"); await fs.writeFile(settingsPath, JSON.stringify(selected.settings));
  await verifyClaudeNativeAccount({ command: claude!, settingsPath, cwd: root, env: { PATH: process.env.PATH, HOME: root, ...selected.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" } }, selected);
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"))).toEqual(user);
});

it.skipIf(!claude)("native 2.1.316 settings readback observes disabled hooks and source identity without a model request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-hook-readback-")); roots.push(root);
  const settingsPath = path.join(root, "launch.json");
  const marker = path.join(root, "hook-ran");
  const hooks = { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] };
  const env = { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: path.join(root, "config"), ANTHROPIC_API_KEY: "fake-no-model", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
  await fs.writeFile(settingsPath, JSON.stringify({ disableAllHooks: true, hooks }));
  const disabled = await inspectClaudeNativeSettings({ command: claude!, settingsPath, cwd: root, env });
  expect(disabled.version).toBe("2.1.316");
  expect(disabled.effective.disableAllHooks).toBe(true);
  expect(disabled.hooks.policy).toMatchObject({ allDisabled: true });
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await fs.writeFile(settingsPath, JSON.stringify({ hooks }));
  const enabled = await inspectClaudeNativeSettings({ command: claude!, settingsPath, cwd: root, env });
  expect(enabled.hooks.policy).toMatchObject({ allDisabled: false });
  expect(enabled.sources.map(source => source.source)).toContain("flagSettings");
  await expect(fs.stat(marker)).resolves.toBeTruthy();
}, 40_000);

it.skipIf(!claude).each([
  ["CLAUDE_CODE_USE_BEDROCK", "bedrock"], ["CLAUDE_CODE_USE_MANTLE", "mantle"],
  ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "anthropicAws"], ["CLAUDE_CODE_USE_VERTEX", "vertex"], ["CLAUDE_CODE_USE_FOUNDRY", "foundry"]
])("native 2.1.316 reports the explicit %s route without a model request", async selector => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-service-readback-")); roots.push(root);
  const selected = resolveClaudeAccountPolicy({ [selector]: "1" }, path.join(root, "config"), {});
  const settingsPath = path.join(root, "launch.json"); await fs.writeFile(settingsPath, JSON.stringify(selected.settings));
  await verifyClaudeNativeAccount({ command: claude!, settingsPath, cwd: root, env: { PATH: process.env.PATH, HOME: root, ...selected.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" } }, selected);
});

it.skipIf(!claude).each([
  [{ allowManagedHooksOnly: true }, { managedOnly: true }],
])("native 2.1.316 honors host-managed hook policy %j without running non-managed receipt commands", async (managed, expected) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-managed-hook-readback-")); roots.push(root);
  const marker = path.join(root, "hook-ran");
  const settingsPath = path.join(root, "launch.json");
  await fs.writeFile(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] } }));
  // Exact @anthropic-ai/claude-agent-sdk 0.3.316 transport passes managedSettings with this native flag.
  const result = await inspectClaudeNativeSettings({ command: claude!, settingsPath, cwd: root,
    configurationArgs: ["--managed-settings", JSON.stringify(managed)],
    env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: path.join(root, "config"), ANTHROPIC_API_KEY: "fake-no-model", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" }
  });
  expect(result.hooks.policy).toMatchObject(expected);
  expect(result.sources.map(source => source.source)).toContain("policySettings");
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);
