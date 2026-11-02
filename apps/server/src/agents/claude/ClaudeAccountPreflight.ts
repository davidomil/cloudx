import { isRecord } from "@cloudx/shared";
import { CLAUDE_ACCOUNT_ENV_KEYS, CLAUDE_AUTH_HELPER_KEYS, type ClaudeAccountPolicy } from "./claudeAccountPolicy.js";
import { defaultManagedFiles, managedSettingsFiles, readPolicy } from "./ClaudeHookPolicy.js";

/** File-based managed policy stays authoritative; conflicting/unestablished combinations stop before spawn. */
export async function assertClaudeAccountCompatibility(policy: ClaudeAccountPolicy, managedFiles = defaultManagedFiles()): Promise<void> {
  const merged: Record<string, unknown> = {};
  const origins = new Map<string, string>();
  for (const file of await managedSettingsFiles(managedFiles)) {
    const settings = await readPolicy(file);
    for (const [key, value] of Object.entries(settings)) {
      if (key === "env" && isRecord(value)) {
        const env = isRecord(merged.env) ? merged.env : {};
        for (const [name, selection] of Object.entries(value)) { env[name] = selection; origins.set(`env.${name}`, file); }
        merged.env = env;
      } else {
        merged[key] = key === "allowedProviders" && Array.isArray(value) && Array.isArray(merged[key]) ? [...new Set([...merged[key], ...value])] : value;
        origins.set(key, file);
      }
    }
  }
  const fail = (key: string, reason: string): never => { throw new Error(`Claude managed ${key} in ${origins.get(key) ?? "file policy"} ${reason}. Ask the policy owner to align the selected CloudX account and service routing before launching; CloudX has not changed policy.`); };
  if (merged.policyHelper) fail("policyHelper", "computes authentication policy that CloudX cannot preflight");
  for (const key of CLAUDE_AUTH_HELPER_KEYS) if (merged[key]) fail(key, "selects a native credential helper outside the selected account contract");
  if (isRecord(merged.env)) for (const key of CLAUDE_ACCOUNT_ENV_KEYS) {
    const managed = merged.env[key];
    if (managed !== undefined && managed !== (policy.env[key] ?? "")) fail(`env.${key}`, "conflicts with the resolved account/service launch environment");
  }
  if (merged.forceLoginMethod !== undefined) {
    const expected = policy.env.ANTHROPIC_API_KEY ? "console" : "claudeai";
    if (merged.forceLoginMethod !== expected) fail("forceLoginMethod", "requires a different or unsupported login method");
  }
  if (merged.forceLoginOrgUUID) fail("forceLoginOrgUUID", "requires an organization that CloudX cannot establish from the selected account record");
  if (merged.forceLoginGatewayUrl) fail("forceLoginGatewayUrl", "requires native gateway authentication outside the selected account contract");
  if (merged.allowedProviders !== undefined) {
    const allowed = Array.isArray(merged.allowedProviders) ? merged.allowedProviders : [];
    const custom = policy.provider === "anthropic" && policy.env.ANTHROPIC_BASE_URL && new URL(policy.env.ANTHROPIC_BASE_URL).hostname !== "api.anthropic.com";
    if (!allowed.includes(custom ? "customEndpoint" : policy.provider)) fail("allowedProviders", "does not allow the resolved service provider");
    if (custom && (!isRecord(merged.env) || merged.env.ANTHROPIC_BASE_URL !== policy.env.ANTHROPIC_BASE_URL)) fail("allowedProviders", "requires the selected custom endpoint to be pinned by managed env");
  }
}
