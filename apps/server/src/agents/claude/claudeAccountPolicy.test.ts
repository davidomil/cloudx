import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { claudeAccountLaunch } from "../agentCli.js";
import { assertClaudeAccountCompatibility } from "./ClaudeAccountPreflight.js";
import { CLAUDE_ACCOUNT_ENV_KEYS, CLAUDE_AUTH_HELPER_KEYS, assertClaudeAccountPolicyVersion, resolveClaudeAccountPolicy } from "./claudeAccountPolicy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it("uses the reviewed native registry only and never echoes an unsupported executable's output", () => {
  expect(() => assertClaudeAccountPolicyVersion("2.1.316 (Claude Code)\n")).not.toThrow();
  for (const version of ["2.1.315", "2.1.317", "9.9.9 (Claude Code)", "never-print-private-version"]) {
    expect(() => assertClaudeAccountPolicyVersion(version)).toThrow("reviewed for native 2.1.316");
    expect(() => assertClaudeAccountPolicyVersion(version)).not.toThrow("never-print");
  }
});

it("pins selected credentials, refresh/profile/federation selectors and the SDK config directory through every launch boundary", () => {
  const inherited = { PATH: "/bin", ANTHROPIC_API_KEY: "fake-parent", ANTHROPIC_AUTH_TOKEN: "fake-bearer", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "fake-refresh", CLAUDE_CODE_OAUTH_SCOPES: "fake-scopes", ANTHROPIC_PROFILE: "unrelated", ANTHROPIC_FEDERATION_RULE_ID: "fake-rule", ANTHROPIC_IDENTITY_TOKEN: "fake-identity", ANTHROPIC_CONFIG_DIR: "/other/profile" };
  const launch = claudeAccountLaunch(inherited, "/selected", { ANTHROPIC_API_KEY: "fake-selected" });
  expect(launch.env).toMatchObject({ ANTHROPIC_API_KEY: "fake-selected", CLAUDE_CONFIG_DIR: "/selected", ANTHROPIC_CONFIG_DIR: "/selected/anthropic-auth" });
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_IDENTITY_TOKEN"]) {
    expect(launch.env[key]).toBeUndefined(); expect(launch.enforced.unset).toContain(key); expect(launch.policy.settings.env[key]).toBe("");
  }
  expect(launch.enforced.set).toEqual(launch.policy.env);
  expect(Object.keys(launch.policy.settings.env)).toEqual([...CLAUDE_ACCOUNT_ENV_KEYS]);
  for (const key of CLAUDE_AUTH_HELPER_KEYS) expect(launch.policy.settings[key]).toBe("");
});

it.each(["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS"])("preserves intentional AWS service credentials for %s and prevents shell/settings replacement", key => {
  const service = { [key]: "1", AWS_ACCESS_KEY_ID: "fake-service-id", AWS_SECRET_ACCESS_KEY: "fake-service-secret", AWS_BEARER_TOKEN_BEDROCK: "fake-service-bearer", AWS_PROFILE: "service", AWS_WEB_IDENTITY_TOKEN_FILE: "/service/identity" };
  const launch = claudeAccountLaunch(service, "/selected", {});
  for (const [name, value] of Object.entries(service)) {
    expect(launch.env[name]).toBe(value); expect(launch.enforced.set[name]).toBe(value); expect(launch.policy.settings.env[name]).toBe(value);
  }
  expect(launch.policy.credentialSource).toBe("service-provider");
  expect(() => resolveClaudeAccountPolicy(service, "/selected", { ANTHROPIC_API_KEY: "fake-account" })).toThrow(/API-key account cannot authenticate/);
});

it("rejects conflicting provider selectors and auth headers without including credential values", () => {
  const attempts = [
    { CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_BEDROCK: "1" },
    { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer never-print-this" },
  ];
  for (const env of attempts) {
    try { resolveClaudeAccountPolicy(env, "/selected", { ANTHROPIC_API_KEY: "never-print-account" }); throw new Error("Expected refusal"); }
    catch (error) { expect((error as Error).message).not.toContain("never-print"); expect((error as Error).message).toMatch(/provider|headers/); }
  }
  expect(resolveClaudeAccountPolicy({ ANTHROPIC_CUSTOM_HEADERS: "X-Client-Version: local" }, "/selected", { ANTHROPIC_API_KEY: "fake" }).env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Client-Version: local");
});

it("keeps matching managed routing authoritative and rejects managed helper/identity conflicts before launch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-account-policy-")); roots.push(root);
  const base = path.join(root, "managed-settings.json");
  const fragments = path.join(root, "managed-settings.d"); await fs.mkdir(fragments);
  const policy = resolveClaudeAccountPolicy({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "service" }, "/selected", {});
  await fs.writeFile(base, JSON.stringify({ env: { AWS_PROFILE: "service" }, allowedProviders: ["vertex"] }));
  await fs.writeFile(path.join(fragments, "10-provider.json"), JSON.stringify({ allowedProviders: ["bedrock"] }));
  await expect(assertClaudeAccountCompatibility(policy, [base])).resolves.toBeUndefined();
  for (const value of [
    { env: { AWS_PROFILE: "unrelated-secret-profile" } }, { awsCredentialExport: "never-print-helper" },
    { forceLoginMethod: "gateway" }, { forceLoginOrgUUID: "never-print-org" }, { policyHelper: { path: "/unverified" } },
  ]) {
    await fs.writeFile(base, JSON.stringify(value));
    try { await assertClaudeAccountCompatibility(policy, [base]); throw new Error("Expected refusal"); }
    catch (error) { expect((error as Error).message).toContain("Claude managed"); expect((error as Error).message).not.toContain("never-print"); expect((error as Error).message).not.toContain("unrelated-secret-profile"); }
  }
});
