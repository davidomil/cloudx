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
  const [loadState, setLoadState] = useState<PluginWebviewLoadState>(() => resolveInitialWebviewState(contribution));

  useEffect(() => {
    let cancelled = false;
    if (!contribution.hookId) {
      setLoadState(resolveInitialWebviewState(contribution));
      return undefined;
    }
    if (!context.callHook) {
      setLoadState({ status: "error", message: "Plugin webview hook bridge is not available." });
      return undefined;
    }
    setLoadState({ status: "loading" });
    context
      .callHook(contribution.hookId, buildUiContributionHookInput(contribution, context), context.tab?.id)
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
  }, [contribution, context]);

  useEffect(() => {
    const iframe = iframeRef.current;
    const callHook = context.callHook;
    if (!iframe || !callHook) {
      return undefined;
    }
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || !isPluginWebviewHookCallMessage(event.data)) {
        return;
      }
      const message = event.data;
      callHook(message.hookId, message.input ?? {}, message.targetTabId ?? context.tab?.id)
        .then((result) => {
          iframe.contentWindow?.postMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-result", requestId: message.requestId, ok: true, result }, "*");
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
            "*"
          );
        });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [context]);

  const iframeTitle = loadState.status === "ready" ? loadState.source.title ?? contribution.title : contribution.title;
  const srcDoc = useMemo(() => (loadState.status === "ready" && loadState.source.html ? buildPluginWebviewHtml(loadState.source.html) : undefined), [loadState]);

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

export function buildPluginWebviewHtml(html: string): string {
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${PLUGIN_WEBVIEW_BRIDGE_SCRIPT}`);
  }
  return `${PLUGIN_WEBVIEW_BRIDGE_SCRIPT}${html}`;
}

export function isPluginWebviewHookCallMessage(value: unknown): value is PluginWebviewHookCallMessage {
  return (
    isRecord(value) &&
    value.source === PLUGIN_WEBVIEW_MESSAGE_SOURCE &&
    value.type === "hook-call" &&
    typeof value.requestId === "string" &&
    typeof value.hookId === "string" &&
    (value.input === undefined || isRecord(value.input)) &&
    (value.targetTabId === undefined || typeof value.targetTabId === "string")
  );
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

function uiContributionTargetsTab(contribution: UiContributionDescriptor, tab: WorkspaceTab): boolean {
  return (!contribution.targetTabId || contribution.targetTabId === tab.id) && (!contribution.targetPluginId || contribution.targetPluginId === tab.pluginId);
}

const PLUGIN_WEBVIEW_BRIDGE_SCRIPT = `<script>
(() => {
  const source = "${PLUGIN_WEBVIEW_MESSAGE_SOURCE}";
  let nextId = 0;
  const pending = new Map();
  window.cloudx = {
    callHook(hookId, input, targetTabId) {
      return new Promise((resolve, reject) => {
        const requestId = String(++nextId);
        pending.set(requestId, { resolve, reject });
        window.parent.postMessage({ source, type: "hook-call", requestId, hookId, input: input || {}, targetTabId }, "*");
      });
    }
  };
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.source !== source || message.type !== "hook-result") {
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
