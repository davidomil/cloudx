import net from "node:net";

import type { CreatePluginSessionInput, PluginActionDefinition, PluginSession, PluginSessionSnapshot, PluginVoiceContext, WorkspacePlugin } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";

export const LOCAL_WEB_PLUGIN_ID = "local-web";

interface LocalWebState {
  url?: string;
  updatedAt?: string;
}

export class LocalWebPlugin implements WorkspacePlugin {
  readonly id = LOCAL_WEB_PLUGIN_ID;
  readonly acronym = "WEB";
  readonly displayName = "Local Web";
  readonly description = "Embeds a local HTTP(S) website or dashboard in a Cloudx tab.";
  readonly panelKind = "web-viewer" as const;
  readonly creatable = true;
  readonly requiresDirectory = false;

  readonly actions: PluginActionDefinition[] = [
    {
      name: "get_state",
      description: "Return the current local website URL for this viewer.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: "open_url",
      description: "Open a local website URL in this viewer. Supports query tokens in the URL.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute local http:// or https:// URL to open, including any token query string." }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      name: "clear_url",
      description: "Clear the current local website URL.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  ];

  descriptor() {
    return {
      id: this.id,
      acronym: this.acronym,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      requiresDirectory: this.requiresDirectory,
      configFields: [],
      actions: this.actions
    };
  }

  defaultTitleContext(input: { cwd: string; initialInput?: Record<string, unknown> }): string | undefined {
    const rawUrl = input.initialInput?.url;
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
      return "local";
    }
    return localWebTitleContext(rawUrl);
  }

  createSession(input: CreatePluginSessionInput): PluginSession {
    const initialUrl = typeof input.initialInput?.url === "string" && input.initialInput.url.trim() ? normalizeLocalWebUrl(input.initialInput.url) : undefined;
    return new LocalWebSession(input.tab, initialUrl);
  }
}

function localWebTitleContext(rawUrl: string): string {
  try {
    return new URL(normalizeLocalWebUrl(rawUrl)).host || "local";
  } catch {
    return "local";
  }
}

class LocalWebSession implements PluginSession {
  private state: LocalWebState;

  constructor(
    public readonly tab: WorkspaceTab,
    initialUrl?: string
  ) {
    this.state = initialUrl ? { url: initialUrl, updatedAt: new Date().toISOString() } : {};
  }

  snapshot(): PluginSessionSnapshot {
    return {
      tabId: this.tab.id,
      pluginId: this.tab.pluginId,
      title: this.tab.title,
      cwd: this.tab.cwd,
      status: this.tab.status,
      recentOutput: this.state.url,
      state: this.publicState()
    };
  }

  voiceContext(): PluginVoiceContext {
    return {
      kind: "local-web",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: this.state.url
        ? `Local web viewer showing ${this.state.url}. Use open_url to navigate to another local dashboard.`
        : "Local web viewer with no URL loaded. Use open_url with an absolute local URL.",
      visibleText: this.state.url ? `URL: ${this.state.url}` : undefined,
      currentPath: this.state.url,
      metadata: {
        url: this.state.url,
        updatedAt: this.state.updatedAt
      }
    };
  }

  handleAction(action: string, input: Record<string, unknown>): Record<string, unknown> {
    if (action === "get_state") {
      return this.publicState();
    }
    if (action === "open_url") {
      const url = normalizeLocalWebUrl(requireString(input.url, "url"));
      this.state = { url, updatedAt: new Date().toISOString() };
      return this.publicState();
    }
    if (action === "clear_url") {
      this.state = {};
      return this.publicState();
    }
    throw new Error(`Unsupported local web action: ${action}`);
  }

  private publicState(): Record<string, unknown> {
    return {
      url: this.state.url,
      updatedAt: this.state.updatedAt
    };
  }
}

export function normalizeLocalWebUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("Local web URL must be an absolute http:// or https:// URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Local web URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Local web URL must not include embedded credentials.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("Plain HTTP local web URLs are allowed only for localhost or loopback addresses. Use HTTPS for LAN or tailnet hosts.");
  }
  if (!isLocalWebHost(parsed.hostname)) {
    throw new Error("Local web URL host must be localhost, loopback, a private address, a local hostname, or a tailnet hostname.");
  }

  return parsed.href;
}

function isLocalWebHost(hostname: string): boolean {
  return isLoopbackHost(hostname) || isPrivateAddress(hostname) || isLocalHostname(hostname);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "localhost." || normalized.endsWith(".localhost") || normalized.endsWith(".localhost.")) {
    return true;
  }
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return normalized.startsWith("127.");
  }
  if (ipVersion === 6) {
    return normalized === "::1";
  }
  return false;
}

function isPrivateAddress(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname).replace(/\.$/, "");
  if (net.isIP(normalized) !== 0) {
    return false;
  }
  return (
    !normalized.includes(".") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home.arpa") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".localdomain") ||
    normalized.endsWith(".ts.net")
  );
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  const [first, second] = octets;
  if (!octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) || first === undefined || second === undefined) {
    return false;
  }
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}
