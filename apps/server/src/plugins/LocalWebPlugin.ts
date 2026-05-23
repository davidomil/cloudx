import net from "node:net";

import type { CreatePluginSessionInput, PluginActionDefinition, PluginSession, PluginSessionSnapshot, PluginVoiceContext, WorkspacePlugin } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";

export const LOCAL_WEB_PLUGIN_ID = "local-web";

interface LocalWebState {
  url?: string;
  updatedAt?: string;
}

const LOCAL_WEB_STATE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "The normalized local website URL currently loaded in this viewer." },
    updatedAt: { type: "string", description: "ISO timestamp for the most recent local web viewer state change." }
  },
  additionalProperties: false
} satisfies PluginActionDefinition["outputSchema"];

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
      },
      outputSchema: LOCAL_WEB_STATE_OUTPUT_SCHEMA
    },
    {
      name: "open_url",
      description: "Open a local website URL in this viewer. Supports query tokens in the URL.",
      voiceExposed: true,
      updatesTabState: true,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute local http:// or https:// URL to open, including any token query string." }
        },
        required: ["url"],
        additionalProperties: false
      },
      outputSchema: LOCAL_WEB_STATE_OUTPUT_SCHEMA
    },
    {
      name: "clear_url",
      description: "Clear the current local website URL.",
      voiceExposed: true,
      updatesTabState: true,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      outputSchema: LOCAL_WEB_STATE_OUTPUT_SCHEMA
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
    const voiceUrl = this.state.url ? redactLocalWebUrlForVoice(this.state.url) : undefined;
    return {
      kind: "local-web",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: voiceUrl
        ? `Local web viewer showing ${voiceUrl}. Use open_url to navigate to another local dashboard.`
        : "Local web viewer with no URL loaded. Use open_url with an absolute local URL.",
      visibleText: voiceUrl ? `URL: ${voiceUrl}` : undefined,
      currentPath: voiceUrl,
      metadata: {
        url: voiceUrl,
        urlRedacted: this.state.url ? this.state.url !== voiceUrl : undefined,
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
    const state: Record<string, unknown> = {};
    if (this.state.url) {
      state.url = this.state.url;
    }
    if (this.state.updatedAt) {
      state.updatedAt = this.state.updatedAt;
    }
    return state;
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
  if (isDisallowedLocalWebAddress(parsed.hostname)) {
    throw new Error("Local web URL host must not be a link-local or cloud metadata address.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("Plain HTTP local web URLs are allowed only for localhost or loopback addresses. Use HTTPS for LAN or tailnet hosts.");
  }
  if (!isLocalWebHost(parsed.hostname)) {
    throw new Error("Local web URL host must be localhost, loopback, a private address, a local hostname, or a tailnet hostname.");
  }

  return parsed.href;
}

export function redactLocalWebUrlForVoice(input: string): string {
  try {
    const parsed = new URL(input);
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "[invalid local web URL]";
  }
}

function isLocalWebHost(hostname: string): boolean {
  return isLoopbackHost(hostname) || isPrivateAddress(hostname) || isLocalHostname(hostname);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = classifyableAddressHost(hostname);
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
  const normalized = classifyableAddressHost(hostname);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    return normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return false;
}

function isDisallowedLocalWebAddress(hostname: string): boolean {
  const normalized = classifyableAddressHost(hostname);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return isLinkLocalIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isLinkLocalIpv6(normalized);
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

function classifyableAddressHost(hostname: string): string {
  const normalized = normalizeHostname(hostname);
  return ipv4FromMappedIpv6(normalized) ?? normalized;
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
    (first === 100 && second >= 64 && second <= 127)
  );
}

function isLinkLocalIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  const [first, second] = octets;
  return first === 169 && second === 254;
}

function isLinkLocalIpv6(address: string): boolean {
  const firstHextet = Number.parseInt(address.split(":")[0] ?? "", 16);
  return Number.isInteger(firstHextet) && (firstHextet & 0xffc0) === 0xfe80;
}

function ipv4FromMappedIpv6(address: string): string | undefined {
  const hextets = ipv6Hextets(address);
  if (!hextets) {
    return undefined;
  }
  if (!hextets.slice(0, 5).every((hextet) => hextet === 0) || hextets[5] !== 0xffff) {
    return undefined;
  }
  return [
    hextets[6]! >> 8,
    hextets[6]! & 0xff,
    hextets[7]! >> 8,
    hextets[7]! & 0xff
  ].join(".");
}

function ipv6Hextets(address: string): number[] | undefined {
  const compressedParts = address.split("::");
  if (compressedParts.length > 2) {
    return undefined;
  }
  const head = parseIpv6HextetList(compressedParts[0] ?? "");
  const tail = parseIpv6HextetList(compressedParts[1] ?? "");
  if (!head || !tail) {
    return undefined;
  }
  if (compressedParts.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const missingCount = 8 - head.length - tail.length;
  if (missingCount < 1) {
    return undefined;
  }
  return [...head, ...Array.from({ length: missingCount }, () => 0), ...tail];
}

function parseIpv6HextetList(input: string): number[] | undefined {
  if (!input) {
    return [];
  }
  const hextets = input.split(":");
  const parsed = hextets.map((part) => (/^[\da-f]{1,4}$/iu.test(part) ? Number.parseInt(part, 16) : Number.NaN));
  return parsed.every((hextet) => Number.isInteger(hextet) && hextet >= 0 && hextet <= 0xffff) ? parsed : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}
