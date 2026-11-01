import { isRecord } from "@cloudx/shared";

import { runAgentCli, type AgentCliOptions, type AgentCliResult } from "../agentCli.js";
import type { ClaudeAccountPolicy } from "./claudeAccountPolicy.js";

type Runner = (command: string, args: string[], options: AgentCliOptions) => Promise<AgentCliResult>;
export interface ClaudeNativeInspectionInput {
  command: string;
  settingsPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  configurationArgs?: string[];
  signal?: AbortSignal;
}

export interface ClaudeNativeSettings {
  version: string;
  account: Record<string, unknown>;
  effective: Record<string, unknown>;
  sources: Array<{ source: string; settings: Record<string, unknown> }>;
  hooks: Record<string, unknown>;
}

/** Isolated native fixtures only: print-mode startup executes configured SessionStart hooks.
 * The result contains private settings and must never be persisted or returned to a browser.
 */
export async function inspectClaudeNativeSettings(input: ClaudeNativeInspectionInput, run: Runner = runAgentCli): Promise<ClaudeNativeSettings> {
  const requests = ["initialize", "get_settings", "get_hooks_listing"];
  const result = await run(input.command, ["--settings", input.settingsPath, ...(input.configurationArgs ?? []),
    "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"], {
    env: input.env, cwd: input.cwd, signal: input.signal, timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024,
    stdin: requests.map(subtype => JSON.stringify({ type: "control_request", request_id: subtype, request: { subtype } })).join("\n") + "\n"
  });
  const replies = new Map<string, Record<string, unknown>>();
  try {
    if (result.code !== 0) throw new Error();
    for (const line of result.stdout.split(/\r?\n/u).filter(Boolean)) {
      const item: unknown = JSON.parse(line);
      if (!isRecord(item) || item.type !== "control_response" || !isRecord(item.response)) continue;
      const response = item.response;
      if (typeof response.request_id !== "string" || !requests.includes(response.request_id)) continue;
      if (response.subtype !== "success" || !isRecord(response.response) || replies.has(response.request_id)) throw new Error();
      replies.set(response.request_id, response.response);
    }
    const init = replies.get("initialize");
    const settings = replies.get("get_settings");
    const hooks = replies.get("get_hooks_listing");
    if (!init || typeof init.claude_code_version !== "string" || !/^\d+\.\d+\.\d+$/u.test(init.claude_code_version)
      || !isRecord(init.account) || !settings || !isRecord(settings.effective) || !Array.isArray(settings.sources)
      || settings.sources.some(source => !isRecord(source) || typeof source.source !== "string" || !isRecord(source.settings))
      || !hooks || !Array.isArray(hooks.hooks) || !isRecord(hooks.policy)) throw new Error();
    return { version: init.claude_code_version, account: init.account, effective: settings.effective,
      sources: settings.sources as ClaudeNativeSettings["sources"], hooks };
  } catch {
    throw new Error("Claude Code did not provide the supported native settings inspection contract. No native output or configuration values were included in this diagnostic.");
  }
}

/** Native auth status reads merged authentication policy without executing session hooks or a model turn. */
export async function verifyClaudeNativeAccount(input: ClaudeNativeInspectionInput, policy: ClaudeAccountPolicy, run: Runner = runAgentCli): Promise<void> {
  const result = await run(input.command, ["--settings", input.settingsPath, "auth", "status", "--json"], {
    env: input.env, cwd: input.cwd, signal: input.signal, timeoutMs: 15_000
  });
  parseClaudeNativeAccountStatus(result, policy);
}

export function parseClaudeNativeAccountStatus(result: AgentCliResult, policy: ClaudeAccountPolicy): { loggedIn: boolean; authMethod: string } {
  let status: unknown;
  try { status = JSON.parse(result.stdout); } catch { /* Native output can contain credentials: do not include it. */ }
  assertClaudeNativeAccountStatus(status, policy);
  const value = status as Record<string, unknown>;
  if (result.code !== 0 && !(result.code === 1 && value.loggedIn === false && value.authMethod === "none"))
    throw new Error("Claude native authentication inspection did not exit normally. Check the installed Claude Code version before launching. No native output was included in this diagnostic.");
  return { loggedIn: value.loggedIn as boolean, authMethod: value.authMethod as string };
}

export function assertClaudeNativeAccountStatus(status: unknown, policy: ClaudeAccountPolicy): void {
  const fail = (field: string): never => { throw new Error(`Claude native ${field} conflicts with the selected CloudX account or cannot be verified. Check managed authentication policy and the installed Claude Code version before launching. No credential values were included in this diagnostic.`); };
  if (!isRecord(status)) fail("authentication status");
  const value = status as Record<string, unknown>;
  if (value.configDirectory !== policy.env.CLAUDE_CONFIG_DIR) fail("configDirectory");
  if (value.apiProvider !== (policy.provider === "anthropic" ? "firstParty" : policy.provider)) fail("apiProvider");
  if (typeof value.loggedIn !== "boolean" || typeof value.authMethod !== "string"
    || !["none", "claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party"].includes(value.authMethod)) fail("authMethod");
  if (value.authMethod === "api_key_helper") fail("apiKeyHelper");
  if (policy.env.ANTHROPIC_API_KEY && (value.authMethod !== "api_key" || value.apiKeySource !== "ANTHROPIC_API_KEY")) fail("apiKeySource");
  if (policy.credentialSource === "selected-account" && !policy.env.ANTHROPIC_API_KEY
    && !["none", "claude.ai"].includes(value.authMethod as string)) fail("authMethod");
  if (policy.provider !== "anthropic" && value.authMethod !== "third_party") fail("authMethod");
}
