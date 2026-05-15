import { createElement, isValidElement } from "react";
import { describe, expect, it } from "vitest";

import type { PluginDescriptor, UiContributionDescriptor, WorkspaceTab } from "@cloudx/shared";

import {
  PLUGIN_WEBVIEW_MESSAGE_SOURCE,
  buildPluginWebviewHtml,
  buildUiContributionHookInput,
  isPluginWebviewHookCallMessage,
  resolvePluginWebviewSource,
  selectPluginPanelContribution,
  selectTabSettingsContributions,
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

  it("injects the hook bridge into webview html", () => {
    const html = buildPluginWebviewHtml("<html><head><title>View</title></head><body></body></html>");

    expect(html).toContain("<head>");
    expect(html).toContain("window.cloudx");
    expect(html).toContain(PLUGIN_WEBVIEW_MESSAGE_SOURCE);
    expect(html.indexOf("window.cloudx")).toBeLessThan(html.indexOf("<title>View</title>"));
  });

  it("validates hook call postMessage payloads from webviews", () => {
    expect(isPluginWebviewHookCallMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-call", requestId: "1", hookId: "workspace.tabs.create", input: {} })).toBe(true);
    expect(isPluginWebviewHookCallMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-result", requestId: "1", hookId: "workspace.tabs.create" })).toBe(false);
    expect(isPluginWebviewHookCallMessage({ source: PLUGIN_WEBVIEW_MESSAGE_SOURCE, type: "hook-call", requestId: "1", hookId: "workspace.tabs.create", input: null })).toBe(false);
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
