import { describe, expect, it } from "vitest";
import { CLOUDX_THEME_OPTIONS, UI_RENDERER_ICON_BUTTON, UI_RENDERER_PLUGIN_WEBVIEW, UI_RENDERER_STATUS_DOT, isCloudxThemeId, parseVoiceActionPlan } from "./index.js";

describe("parseVoiceActionPlan", () => {
  it("accepts a valid structured plan", () => {
    const plan = parseVoiceActionPlan({
      transcript: "type hello",
      summary: "Enter text in the active tab.",
      actions: [{ action: "enter_text", input: { text: "hello" } }]
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.action).toBe("enter_text");
  });

  it("strips null optional input fields emitted by strict structured output schemas", () => {
    const plan = parseVoiceActionPlan({
      transcript: "list folder",
      summary: "List files.",
      actions: [
        {
          id: null,
          targetTabId: null,
          pluginId: null,
          hookId: null,
          action: "enter_text",
          input: { text: "ls", submit: true, key: null, tabId: null, title: null, relativePath: null, url: null },
          reason: null
        }
      ]
    });

    expect(plan.actions[0]).toEqual({
      action: "enter_text",
      input: { text: "ls", submit: true }
    });
  });

  it("preserves hook ids for hook-backed voice actions", () => {
    const plan = parseVoiceActionPlan({
      transcript: "open a web tab",
      summary: "Create a web tab.",
      actions: [
        {
          hookId: "workspace.tabs.create",
          action: "workspace.tabs.create",
          input: { pluginId: "local-web", url: "http://127.0.0.1:5173" }
        }
      ]
    });

    expect(plan.actions[0]).toMatchObject({ hookId: "workspace.tabs.create", action: "workspace.tabs.create" });
  });

  it("rejects malformed actions", () => {
    expect(() =>
      parseVoiceActionPlan({
        transcript: "switch",
        summary: "",
        actions: [{ input: {} }]
      })
    ).toThrow(/action name/);
  });
});

describe("CloudX themes", () => {
  it("exposes config-safe theme options", () => {
    expect(CLOUDX_THEME_OPTIONS.map((option) => option.value)).toEqual(["cloudx-neon", "minimalist-dark"]);
    expect(isCloudxThemeId("minimalist-dark")).toBe(true);
    expect(isCloudxThemeId("graphite")).toBe(false);
    expect(isCloudxThemeId("missing")).toBe(false);
  });
});

describe("UI contribution renderer ids", () => {
  it("exports stable renderer ids for plugin-authored contributions", () => {
    expect([UI_RENDERER_ICON_BUTTON, UI_RENDERER_STATUS_DOT, UI_RENDERER_PLUGIN_WEBVIEW]).toEqual(["icon-button", "status-dot", "plugin.webview"]);
  });
});
