// @vitest-environment jsdom
import { act, createElement, isValidElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { PluginDescriptor, UiContributionDescriptor, WorkspaceTab } from "@cloudx/shared";

import {
  PLUGIN_WEBVIEW_MESSAGE_SOURCE,
  buildPluginWebviewHtml,
  buildUiContributionHookInput,
  createPluginWebviewBridgeToken,
  isPluginWebviewHookCallMessage,
  PluginWebviewPanel,
  pluginWebviewLoadKey,
  pluginWebviewParentTargetOrigin,
  pluginWebviewReplyTargetOrigin,
  resolvePluginWebviewSource,
  selectPluginPanelContribution,
  selectTabSettingsContributions,
  type UiContributionRenderContext,
  UiContributionRegistry
} from "./uiContributions.js";

describe("UiContributionRegistry", () => {
  it("renders registered contribution renderers and ignores unknown renderers", () => {
    const registry = new UiContributionRegistry({
      "test.renderer": () => createElement("span", null, "Rendered")
    });

    expect(isValidElement(registry.render(contribution("test.renderer")))).toBe(true);
    expect(registry.render(contribution("missing.renderer"))).toBeNull();
  });
});

describe("selectPluginPanelContribution", () => {
  it("selects the matching plugin panel contribution by target plugin", () => {
    const plugins: PluginDescriptor[] = [
      pluginDescriptor("rules-skills", [
        { ...contribution("rules-skills.templates-panel"), slot: "plugin.panel", targetPluginId: "rules-skills" },
        { ...contribution("other.template-panel"), id: "other.panel", slot: "plugin.panel", targetPluginId: "other" }
      ])
    ];

    expect(selectPluginPanelContribution(plugins, plugins[0])?.renderer).toBe("rules-skills.templates-panel");
  });
});

describe("selectTabSettingsContributions", () => {
  it("returns tab settings sections that target the tab plugin or tab id", () => {
    const tab = workspaceTab("tab-1");
    const plugins: PluginDescriptor[] = [
      pluginDescriptor("rules-skills", [
        { ...contribution("custom.codex-settings"), id: "codex-settings", slot: "tab.settings.sections", targetPluginId: "codex-terminal" },
        { ...contribution("custom.tab-settings"), id: "tab-settings", slot: "tab.settings.sections", targetTabId: "tab-1" },
        { ...contribution("other.tab-settings"), id: "other-settings", slot: "tab.settings.sections", targetPluginId: "file-browser" }
      ])
    ];

    expect(selectTabSettingsContributions(plugins, tab).map((section) => section.id)).toEqual(["codex-settings", "tab-settings"]);
  });
});

describe("buildUiContributionHookInput", () => {
  it("adds the current tab id to hook input unless a contribution explicitly provides one", () => {
    expect(buildUiContributionHookInput({ ...contribution("test.renderer"), input: { value: "x" } }, { tab: workspaceTab("tab-1") })).toEqual({
      value: "x",
      tabId: "tab-1"
    });
    expect(buildUiContributionHookInput({ ...contribution("test.renderer"), input: { tabId: "explicit" } }, { tab: workspaceTab("tab-1") })).toEqual({
      tabId: "explicit"
    });
  });
});

describe("plugin webview contributions", () => {
  it("resolves direct and hook-returned webview sources with hook values overriding state", () => {
    expect(resolvePluginWebviewSource({ ...contribution("plugin.webview"), state: { html: "<h1>Direct</h1>", title: "Direct" } })).toEqual({
      html: "<h1>Direct</h1>",
      title: "Direct"
    });
    expect(
      resolvePluginWebviewSource(
        { ...contribution("plugin.webview"), state: { html: "<h1>Direct</h1>", title: "Direct" } },
        { url: "/plugin/view", title: "Hook" }
      )
    ).toEqual({
      url: "/plugin/view",
      title: "Hook"
    });
    expect(resolvePluginWebviewSource(contribution("plugin.webview"))).toBeUndefined();
  });

  it("builds a stable webview load key from relevant source and hook inputs", () => {
    const first = pluginWebviewLoadKey(
      { ...contribution("plugin.webview"), hookId: "webview.source", state: { url: "/view", sandbox: "allow-scripts" } },
      { b: 2, a: { z: 1, y: 0 } },
      "tab-1"
    );
    const second = pluginWebviewLoadKey(
      { ...contribution("plugin.webview"), hookId: "webview.source", state: { sandbox: "allow-scripts", url: "/view" } },
      { a: { y: 0, z: 1 }, b: 2 },
      "tab-1"
    );

    expect(first).toBe(second);
  });

  it("changes the webview load key when a required hook bridge becomes available", () => {
    const hookContribution = { ...contribution("plugin.webview"), hookId: "webview.source" };

    expect(pluginWebviewLoadKey(hookContribution, {}, "tab-1", false)).not.toBe(pluginWebviewLoadKey(hookContribution, {}, "tab-1", true));
    expect(pluginWebviewLoadKey(contribution("plugin.webview"), {}, "tab-1", false)).toBe(pluginWebviewLoadKey(contribution("plugin.webview"), {}, "tab-1", true));
  });

  it("does not refetch a hook-backed webview when only the callHook callback identity changes", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const hookContribution = { ...contribution("plugin.webview"), hookId: "webview.source" };
    const firstCallMock = vi.fn(async () => ({ html: "<p>First</p>" }));
    const secondCallMock = vi.fn(async () => ({ html: "<p>Second</p>" }));
    const firstCall = firstCallMock as UiContributionRenderContext["callHook"];
    const secondCall = secondCallMock as UiContributionRenderContext["callHook"];

    try {
      await act(async () => {
        root.render(createElement(PluginWebviewPanel, { contribution: hookContribution, context: { tab: workspaceTab("tab-1"), callHook: firstCall } }));
      });
      expect(firstCallMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(createElement(PluginWebviewPanel, { contribution: hookContribution, context: { tab: workspaceTab("tab-1"), callHook: secondCall } }));
      });

      expect(secondCallMock).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("injects the hook bridge into webview html", () => {
    const html = buildPluginWebviewHtml("<html><head><title>View</title></head><body></body></html>", "https://cloudx.example", "bridge-token");

    expect(html).toContain("<head>");
    expect(html).toContain("window.cloudx");
    expect(html).toContain(PLUGIN_WEBVIEW_MESSAGE_SOURCE);
    expect(html).toContain('const bridgeToken = "bridge-token";');
    expect(html).toContain("event.source !== window.parent");
    expect(html).not.toContain("message.bridgeToken !== bridgeToken");
    expect(html).toContain("parentTargetOrigin");
    expect(html.indexOf("window.cloudx")).toBeLessThan(html.indexOf("<title>View</title>"));
  });

  it("injects the parent origin as the hook-call postMessage target", () => {
    const html = buildPluginWebviewHtml("<body></body>", "https://cloudx.example:9443", "bridge-token");

    expect(html).toContain('const parentTargetOrigin = "https://cloudx.example:9443";');
    expect(html).toContain("window.parent.postMessage({ source, type: \"hook-call\", bridgeToken, requestId, hookId, input: input || {}, targetTabId }, parentTargetOrigin)");
    expect(html).toContain("expectedParentOrigin && event.origin !== expectedParentOrigin");
  });

  it("validates hook call postMessage payloads from webviews", () => {
    expect(isPluginWebviewHookCallMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-call", bridgeToken: "bridge-token", requestId: "1", hookId: "workspace.tabs.create", input: {} }, "bridge-token")).toBe(true);
    expect(isPluginWebviewHookCallMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-call", bridgeToken: "wrong-token", requestId: "1", hookId: "workspace.tabs.create", input: {} }, "bridge-token")).toBe(false);
    expect(isPluginWebviewHookCallMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-call", requestId: "1", hookId: "workspace.tabs.create", input: {} }, "bridge-token")).toBe(false);
    expect(isPluginWebviewHookCallMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-result", bridgeToken: "bridge-token", requestId: "1", hookId: "workspace.tabs.create" })).toBe(false);
    expect(isPluginWebviewHookCallMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-call", bridgeToken: "bridge-token", requestId: "1", hookId: "workspace.tabs.create", input: null })).toBe(false);
    expect(isPluginWebviewHookCallMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-call", bridgeToken: "bridge-token", requestId: "", hookId: "workspace.tabs.create" })).toBe(false);
    expect(isPluginWebviewHookCallMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-call", bridgeToken: "bridge-token", requestId: "1", hookId: "" })).toBe(false);
  });

  it("creates high-entropy bridge tokens for plugin webviews", () => {
    const token = createPluginWebviewBridgeToken();

    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("targets plugin webview replies to the sender origin when available", () => {
    expect(pluginWebviewReplyTargetOrigin("https://dashboard.example:8443")).toBe("https://dashboard.example:8443");
    expect(pluginWebviewReplyTargetOrigin("null")).toBe("*");
    expect(pluginWebviewReplyTargetOrigin("")).toBe("*");
    expect(pluginWebviewReplyTargetOrigin("file://")).toBe("*");
  });

  it("targets plugin webview hook calls to the app origin when available", () => {
    expect(pluginWebviewParentTargetOrigin("https://cloudx.example")).toBe("https://cloudx.example");
    expect(pluginWebviewParentTargetOrigin("null")).toBe("*");
    expect(pluginWebviewParentTargetOrigin("file://")).toBe("*");
  });
});

function contribution(renderer: string): UiContributionDescriptor {
  return {
    id: renderer,
    owner: { kind: "plugin", pluginId: "test" },
    slot: "app.topbar.actions",
    renderer,
    title: renderer
  };
}

function pluginDescriptor(id: string, uiContributions: PluginDescriptor["uiContributions"]): PluginDescriptor {
  return {
    id,
    acronym: id.slice(0, 3).toUpperCase(),
    displayName: id,
    description: id,
    panelKind: "placeholder",
    creatable: false,
    requiresDirectory: false,
    configFields: [],
    actions: [],
    uiContributions
  };
}

function workspaceTab(id: string): WorkspaceTab {
  return {
    id,
    pluginId: "codex-terminal",
    title: id,
    cwd: "/tmp",
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
