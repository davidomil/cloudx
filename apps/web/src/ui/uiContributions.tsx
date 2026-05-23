import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { UI_RENDERER_PLUGIN_WEBVIEW, type ConfigValue, type PluginDescriptor, type UiContributionDescriptor, type UiContributionSlot, type WorkspaceTab } from "@cloudx/shared";

export interface UiContributionRenderContext {
  tab?: WorkspaceTab;
  plugin?: PluginDescriptor;
  plugins?: PluginDescriptor[];
  active?: boolean;
  attention?: boolean;
  config?: Record<string, ConfigValue>;
  uiScale?: number;
  callHook?<T extends Record<string, unknown> = Record<string, unknown>>(hookId: string, input?: Record<string, unknown>, targetTabId?: string): Promise<T>;
}

export type UiContributionRenderer = (contribution: UiContributionDescriptor, context: UiContributionRenderContext) => ReactElement | null;

export class UiContributionRegistry {
  constructor(private readonly renderers: Record<string, UiContributionRenderer>) {}

  render(contribution: UiContributionDescriptor, context: UiContributionRenderContext = {}): ReactElement | null {
    const renderer = this.renderers[contribution.renderer];
    if (!renderer) {
      return null;
    }
    const element = renderer(contribution, context);
    return element ? <Fragment key={contribution.id}>{element}</Fragment> : null;
  }
}

export function collectUiContributions(plugins: PluginDescriptor[], slot?: UiContributionSlot): UiContributionDescriptor[] {
  return plugins
    .flatMap((plugin) => plugin.uiContributions ?? [])
    .filter((contribution) => !slot || contribution.slot === slot)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));
}

export function selectTabIndicatorContribution(plugins: PluginDescriptor[], tab: WorkspaceTab): UiContributionDescriptor | undefined {
  const contributions = collectUiContributions(plugins, "tab.indicator").filter((contribution) => uiContributionTargetsTab(contribution, tab));
  return contributions.find((contribution) => contribution.targetTabId === tab.id) ?? contributions.find((contribution) => contribution.targetPluginId === tab.pluginId) ?? contributions[0];
}

export function selectPluginPanelContribution(plugins: PluginDescriptor[], plugin: PluginDescriptor | undefined): UiContributionDescriptor | undefined {
  if (!plugin) {
    return undefined;
  }
  return collectUiContributions(plugins, "plugin.panel").find((contribution) => !contribution.targetPluginId || contribution.targetPluginId === plugin.id);
}

export function selectTabSettingsContributions(plugins: PluginDescriptor[], tab: WorkspaceTab): UiContributionDescriptor[] {
  return collectUiContributions(plugins, "tab.settings.sections").filter((contribution) => uiContributionTargetsTab(contribution, tab));
}

export function buildUiContributionHookInput(contribution: UiContributionDescriptor, context: UiContributionRenderContext = {}): Record<string, unknown> {
  const input = { ...(contribution.input ?? {}) };
  if (context.tab && input.tabId === undefined) {
    input.tabId = context.tab.id;
  }
  return input;
}

export const PLUGIN_WEBVIEW_RENDERER = UI_RENDERER_PLUGIN_WEBVIEW;
export const PLUGIN_WEBVIEW_MESSAGE_SOURCE = "cloudx.pluginWebview";
export const DEFAULT_PLUGIN_WEBVIEW_SANDBOX = "allow-scripts allow-forms allow-popups";
const PLUGIN_WEBVIEW_BRIDGE_TOKEN_BYTES = 16;
const PLUGIN_WEBVIEW_MAX_REQUEST_ID_LENGTH = 128;
const PLUGIN_WEBVIEW_MAX_HOOK_ID_LENGTH = 256;

export interface PluginWebviewSource {
  html?: string;
  url?: string;
  title?: string;
  sandbox?: string;
  allow?: string;
}

interface PluginWebviewHookCallMessage {
  source: typeof PLUGIN_WEBVIEW_MESSAGE_SOURCE;
  type: "hook-call";
  bridgeToken: string;
  requestId: string;
  hookId: string;
  input?: Record<string, unknown>;
  targetTabId?: string;
}

type PluginWebviewLoadState =
  | { status: "loading" }
  | { status: "ready"; source: PluginWebviewSource }
  | { status: "error"; message: string };

export function PluginWebviewPanel({ contribution, context }: { contribution: UiContributionDescriptor; context: UiContributionRenderContext }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeTokenRef = useRef<string | undefined>(undefined);
  if (!bridgeTokenRef.current) {
    bridgeTokenRef.current = createPluginWebviewBridgeToken();
  }
  const bridgeToken = bridgeTokenRef.current;
  const [loadState, setLoadState] = useState<PluginWebviewLoadState>(() => resolveInitialWebviewState(contribution));
  const callHook = context.callHook;
  const contextTabId = context.tab?.id;
  const callHookAvailable = Boolean(callHook);
  const callHookRef = useRef(callHook);
  const hookInput = useMemo(() => buildUiContributionHookInput(contribution, { tab: context.tab }), [contribution, contextTabId]);
  const loadKey = useMemo(() => pluginWebviewLoadKey(contribution, hookInput, contextTabId, callHookAvailable), [callHookAvailable, contribution, contextTabId, hookInput]);

  useEffect(() => {
    callHookRef.current = callHook;
  }, [callHook]);

  useEffect(() => {
    let cancelled = false;
    if (!contribution.hookId) {
      setLoadState(resolveInitialWebviewState(contribution));
      return undefined;
    }
    const currentCallHook = callHookRef.current;
    if (!currentCallHook) {
      setLoadState({ status: "error", message: "Plugin webview hook bridge is not available." });
      return undefined;
    }
    setLoadState({ status: "loading" });
    currentCallHook(contribution.hookId, hookInput, contextTabId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const source = resolvePluginWebviewSource(contribution, result);
        setLoadState(source ? { status: "ready", source } : { status: "error", message: "Plugin webview hook did not return html or url." });
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !callHook) {
      return undefined;
    }
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || !isPluginWebviewHookCallMessage(event.data, bridgeToken)) {
        return;
      }
      const message = event.data;
      callHook(message.hookId, message.input ?? {}, message.targetTabId ?? contextTabId)
        .then((result) => {
          iframe.contentWindow?.postMessage(
            {
              source: PLUGIN_WEBVIEW_MESSAGE_SOURCE,
              type: "hook-result",
              requestId: message.requestId,
              ok: true,
              result
            },
            pluginWebviewReplyTargetOrigin(event.origin)
          );
        })
        .catch((error) => {
          iframe.contentWindow?.postMessage(
            {
              source: PLUGIN_WEBVIEW_MESSAGE_SOURCE,
              type: "hook-result",
              requestId: message.requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            },
            pluginWebviewReplyTargetOrigin(event.origin)
          );
        });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [bridgeToken, callHook, contextTabId]);

  const iframeTitle = loadState.status === "ready" ? loadState.source.title ?? contribution.title : contribution.title;
  const srcDoc = useMemo(() => (loadState.status === "ready" && loadState.source.html ? buildPluginWebviewHtml(loadState.source.html, undefined, bridgeToken) : undefined), [bridgeToken, loadState]);

  if (loadState.status === "loading") {
    return <div className="plugin-webview-panel empty-pane">Loading {contribution.title}...</div>;
  }
  if (loadState.status === "error") {
    return <div className="plugin-webview-panel empty-pane">{loadState.message}</div>;
  }
  return (
    <div className="plugin-webview-panel">
      <iframe
        ref={iframeRef}
        className="plugin-webview-frame"
        title={iframeTitle}
        src={loadState.source.html ? undefined : loadState.source.url}
        srcDoc={srcDoc}
        sandbox={loadState.source.sandbox ?? DEFAULT_PLUGIN_WEBVIEW_SANDBOX}
        allow={loadState.source.allow}
      />
    </div>
  );
}

export function resolvePluginWebviewSource(contribution: UiContributionDescriptor, hookResult?: Record<string, unknown>): PluginWebviewSource | undefined {
  const declared = sourceFromRecord(contribution.state);
  const hookSource = sourceFromRecord(hookResult);
  const source =
    hookSource.html || hookSource.url
      ? {
          ...declared,
          ...hookSource,
          html: hookSource.html,
          url: hookSource.url
        }
      : declared;
  if (!source.html && !source.url) {
    return undefined;
  }
  return source;
}

export function buildPluginWebviewHtml(html: string, parentTargetOrigin = pluginWebviewCurrentParentTargetOrigin(), bridgeToken = createPluginWebviewBridgeToken()): string {
  const bridgeScript = pluginWebviewBridgeScript(parentTargetOrigin, bridgeToken);
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${bridgeScript}`);
  }
  return `${bridgeScript}${html}`;
}

export function pluginWebviewLoadKey(contribution: UiContributionDescriptor, hookInput: Record<string, unknown>, targetTabId?: string, hookBridgeAvailable = true): string {
  return stableStringify({
    hookId: contribution.hookId,
    hookBridgeAvailable: contribution.hookId ? hookBridgeAvailable : undefined,
    input: hookInput,
    state: sourceFromRecord(contribution.state),
    targetTabId
  });
}

export function isPluginWebviewHookCallMessage(value: unknown, expectedBridgeToken?: string): value is PluginWebviewHookCallMessage {
  return (
    isRecord(value) &&
    value.source === PLUGIN_WEBVIEW_MESSAGE_SOURCE &&
    value.type === "hook-call" &&
    isBoundedNonEmptyString(value.bridgeToken, PLUGIN_WEBVIEW_MAX_REQUEST_ID_LENGTH) &&
    (!expectedBridgeToken || value.bridgeToken === expectedBridgeToken) &&
    isBoundedNonEmptyString(value.requestId, PLUGIN_WEBVIEW_MAX_REQUEST_ID_LENGTH) &&
    isBoundedNonEmptyString(value.hookId, PLUGIN_WEBVIEW_MAX_HOOK_ID_LENGTH) &&
    (value.input === undefined || isRecord(value.input)) &&
    (value.targetTabId === undefined || typeof value.targetTabId === "string")
  );
}

export function pluginWebviewReplyTargetOrigin(origin: string): string {
  if (!origin || origin === "null" || origin.startsWith("file:")) {
    return "*";
  }
  return origin;
}

export function pluginWebviewParentTargetOrigin(origin: string): string {
  return pluginWebviewReplyTargetOrigin(origin);
}

export function createPluginWebviewBridgeToken(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error("Secure random values are required for plugin webview bridge tokens.");
  }
  const bytes = new Uint8Array(PLUGIN_WEBVIEW_BRIDGE_TOKEN_BYTES);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resolveInitialWebviewState(contribution: UiContributionDescriptor): PluginWebviewLoadState {
  if (contribution.hookId) {
    return { status: "loading" };
  }
  const source = resolvePluginWebviewSource(contribution);
  return source ? { status: "ready", source } : { status: "error", message: "Plugin webview contribution must provide html, url, or hookId." };
}

function sourceFromRecord(value: unknown): PluginWebviewSource {
  if (!isRecord(value)) {
    return {};
  }
  const source: PluginWebviewSource = {};
  if (typeof value.html === "string") {
    source.html = value.html;
  }
  if (typeof value.url === "string") {
    source.url = value.url;
  }
  if (typeof value.title === "string") {
    source.title = value.title;
  }
  if (typeof value.sandbox === "string") {
    source.sandbox = value.sandbox;
  }
  if (typeof value.allow === "string") {
    source.allow = value.allow;
  }
  return source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function uiContributionTargetsTab(contribution: UiContributionDescriptor, tab: WorkspaceTab): boolean {
  return (!contribution.targetTabId || contribution.targetTabId === tab.id) && (!contribution.targetPluginId || contribution.targetPluginId === tab.pluginId);
}

function pluginWebviewCurrentParentTargetOrigin(): string {
  if (typeof window === "undefined") {
    return "*";
  }
  return pluginWebviewParentTargetOrigin(window.location.origin);
}

function pluginWebviewBridgeScript(parentTargetOrigin: string, bridgeToken: string): string {
  return `<script>
(() => {
  const source = "${PLUGIN_WEBVIEW_MESSAGE_SOURCE}";
  const parentTargetOrigin = ${JSON.stringify(parentTargetOrigin)};
  const expectedParentOrigin = parentTargetOrigin === "*" ? "" : parentTargetOrigin;
  const bridgeToken = ${JSON.stringify(bridgeToken)};
  let nextId = 0;
  const pending = new Map();
  window.cloudx = {
    callHook(hookId, input, targetTabId) {
      return new Promise((resolve, reject) => {
        const requestId = String(++nextId);
        pending.set(requestId, { resolve, reject });
        window.parent.postMessage({ source, type: "hook-call", bridgeToken, requestId, hookId, input: input || {}, targetTabId }, parentTargetOrigin);
      });
    }
  };
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window.parent || (expectedParentOrigin && event.origin !== expectedParentOrigin) || !message || message.source !== source || message.type !== "hook-result") {
      return;
    }
    const callbacks = pending.get(message.requestId);
    if (!callbacks) {
      return;
    }
    pending.delete(message.requestId);
    if (message.ok) {
      callbacks.resolve(message.result || {});
    } else {
      callbacks.reject(new Error(message.error || "Hook call failed."));
    }
  });
})();
</script>`;
}
