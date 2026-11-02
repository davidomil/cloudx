import path from "node:path";

// Official environment/settings/WIF references reviewed 2026-11-01.
// Empty helper overrides were verified with native 2.1.316 auth status (no model).
export const CLAUDE_ACCOUNT_POLICY_REVIEW = {
  nativeVersion: "2.1.316", reviewedAt: "2026-11-01",
  sources: ["https://code.claude.com/docs/en/env-vars", "https://code.claude.com/docs/en/settings-reference", "https://platform.claude.com/docs/en/manage-claude/wif-reference"],
} as const;

// A version bump requires review of the native provider/env/settings registry
// and the no-model plus synthetic-provider boundary fixtures.
export const CLAUDE_ACCOUNT_POLICY_VERSIONS = [CLAUDE_ACCOUNT_POLICY_REVIEW.nativeVersion] as const;

export function assertClaudeAccountPolicyVersion(version: string): void {
  const selected = version.trim().match(/^(\d+\.\d+\.\d+)(?: \(Claude Code\))?$/u)?.[1];
  if (!CLAUDE_ACCOUNT_POLICY_VERSIONS.some(supported => supported === selected))
    throw new Error(`Claude account/provider isolation is reviewed for native ${CLAUDE_ACCOUNT_POLICY_VERSIONS.join(", ")}. The selected executable has an unsupported or unrecognized version. Select a reviewed native version or update the CloudX account policy review before login or model work; CloudX has not changed accounts, settings or the native installation.`);
}

export const CLAUDE_ACCOUNT_CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES",
  "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_PROFILE", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_WORKSPACE_ID", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE",
] as const;

export const CLAUDE_SERVICE_ROUTING_KEYS = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AWS_BASE_URL", "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
] as const;

const AWS_KEYS = [
  "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
  "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_SDK_LOAD_CONFIG",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
] as const;
const GOOGLE_KEYS = ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "CLOUDSDK_CONFIG", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "CLOUD_ML_REGION"] as const;
const AZURE_KEYS = ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET", "AZURE_CLIENT_CERTIFICATE_PATH", "AZURE_CLIENT_CERTIFICATE_PASSWORD", "AZURE_FEDERATED_TOKEN_FILE", "AZURE_AUTHORITY_HOST", "AZURE_CONFIG_DIR", "AZURE_TOKEN_CREDENTIALS"] as const;
export const CLAUDE_AUTH_HELPER_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh"] as const;
export const CLAUDE_ACCOUNT_ENV_KEYS = [...CLAUDE_ACCOUNT_CREDENTIAL_KEYS, ...CLAUDE_SERVICE_ROUTING_KEYS, ...AWS_KEYS, ...GOOGLE_KEYS, ...AZURE_KEYS, "ANTHROPIC_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const;

export interface ClaudeAccountPolicy {
  provider: "anthropic" | "bedrock" | "mantle" | "anthropicAws" | "vertex" | "foundry";
  credentialSource: "selected-account" | "service-provider";
  env: Record<string, string>;
  settings: Record<string, unknown> & { env: Record<string, string> };
}

const enabled = (value: string | undefined) => /^(?:1|true|yes|on)$/iu.test(value ?? "");
const providerSelectors = {
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "anthropicAws", CLAUDE_CODE_USE_MANTLE: "mantle",
  CLAUDE_CODE_USE_BEDROCK: "bedrock", CLAUDE_CODE_USE_VERTEX: "vertex", CLAUDE_CODE_USE_FOUNDRY: "foundry",
} as const;

/** The service chooses routing; the selected account chooses direct Anthropic credentials. */
export function resolveClaudeAccountPolicy(serviceEnv: NodeJS.ProcessEnv, configDir: string, accountEnv: Record<string, string>): ClaudeAccountPolicy {
  if (!path.isAbsolute(configDir)) throw new Error("Claude account configuration directory must be absolute.");
  if (Object.keys(accountEnv).some(key => key !== "ANTHROPIC_API_KEY")) throw new Error("Unsupported selected Claude account credential source. Use a CloudX API key or native subscription login.");
  for (const key of Object.keys(providerSelectors)) if (serviceEnv[key] && !/^(?:1|true|yes|on|0|false|no|off)$/iu.test(serviceEnv[key]!)) throw new Error(`Claude service provider selector ${key} has an unsupported value. Configure one documented provider selection before launching.`);
  for (const key of CLAUDE_SERVICE_ROUTING_KEYS.filter(key => key.endsWith("BASE_URL"))) if (serviceEnv[key]) {
    try { const endpoint = new URL(serviceEnv[key]!); if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error(); }
    catch { throw new Error(`Claude service endpoint ${key} must be an absolute HTTP(S) URL. No credential values were included in this diagnostic.`); }
  }
  const routes = Object.entries(providerSelectors).filter(([key]) => enabled(serviceEnv[key]));
  // Bedrock+Mantle is a native dual route, but CloudX cannot account for its two identities yet.
  if (routes.length > 1) throw new Error(`Claude service routing selects multiple providers (${routes.map(([key]) => key).join(", ")}). Configure one provider before launching a selected account.`);
  const provider: ClaudeAccountPolicy["provider"] = routes.length ? routes[0]![1] : "anthropic";
  if (accountEnv.ANTHROPIC_API_KEY && provider !== "anthropic")
    throw new Error(`Selected Claude API-key account cannot authenticate ${routes[0]![0]} service routing. Use an Anthropic-compatible endpoint or configure a service-provider account before launching.`);
  const headerAuth = serviceEnv.ANTHROPIC_CUSTOM_HEADERS?.split(/\r?\n/u).some(line => /^(?:authorization|x-api-key|api-key|host|anthropic-(?:organization|workspace)-id)\s*:/iu.test(line.trim()));
  if (accountEnv.ANTHROPIC_API_KEY && headerAuth)
    throw new Error("ANTHROPIC_CUSTOM_HEADERS in the CloudX service contains authentication or routing headers that conflict with the selected API-key account. Remove those headers or choose the intended service authentication.");
  const env: Record<string, string> = {};
  const retain = (keys: readonly string[]) => { for (const key of keys) if (serviceEnv[key] !== undefined) env[key] = serviceEnv[key]!; };
  retain(CLAUDE_SERVICE_ROUTING_KEYS);
  // Keep intentional service credentials and pin the entire chain after login-shell initialization.
  // Non-provider tools still inherit ambient cloud credentials on direct Anthropic launches.
  retain([...AWS_KEYS, ...GOOGLE_KEYS, ...AZURE_KEYS]);
  if (provider === "anthropicAws") retain(["ANTHROPIC_AWS_API_KEY"]);
  if (provider === "foundry") retain(["ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN"]);
  Object.assign(env, accountEnv, { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_CONFIG_DIR: path.join(configDir, "anthropic-auth") });
  return {
    provider, credentialSource: provider === "anthropic" && !headerAuth ? "selected-account" : "service-provider", env,
    settings: { ...Object.fromEntries(CLAUDE_AUTH_HELPER_KEYS.map(key => [key, ""])), env: Object.fromEntries(CLAUDE_ACCOUNT_ENV_KEYS.map(key => [key, env[key] ?? ""])) },
  };
}
