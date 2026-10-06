// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeGlobalSettings } from "@cloudx/shared";

import { ClaudeSettingsPanel } from "./ClaudeSettingsPanel.js";
import { SettingsDialog } from "./SettingsDialog.js";

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const saved: ClaudeGlobalSettings = {
  revision: "a".repeat(64), settingsPath: "/home/user/.claude/settings.json",
  model: "opus", effortLevel: null, alwaysThinkingEnabled: null, fastMode: true, outputStyle: null, language: null, autoUpdatesChannel: null,
  permissionMode: "bypassPermissions", autoTrustWorkspace: true, bypassAccepted: false, bypassDisabled: false,
  skills: [
    { name: "release-notes", origin: "personal", allowed: false, available: true },
    { name: "docx", origin: "synced", allowed: true, available: true },
    { name: "pdf", origin: "synced", allowed: false, available: true }
  ]
};

function hooks(settings = saved) {
  let current = settings;
  return vi.fn(async (hookId: string, input?: Record<string, unknown>) => {
    if (hookId === "claude-settings.read") return { settings: current, cli: { installed: true, command: "/usr/bin/claude", version: "2.1.289 (Claude Code)" }, bypassWarning: "Claude Code will not ask for approval." };
    if (hookId === "claude-settings.update") {
      current = { ...current, ...Object.fromEntries(Object.entries(input!).filter(([key]) => key !== "expectedRevision")), revision: "b".repeat(64) } as ClaudeGlobalSettings;
      return { settings: current };
    }
    if (hookId === "claude-settings.accept-bypass") { current = { ...current, bypassAccepted: true }; return { settings: current }; }
    if (hookId === "claude-settings.update-cli") return { cli: { installed: true, command: "/usr/bin/claude", version: "2.1.300 (Claude Code)", output: "Updated" } };
    return {};
  });
}

async function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
}

function control(container: Element, label: string) {
  return container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
}

async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const button = (container: Element, text: string) => [...container.querySelectorAll("button")].find(item => item.textContent?.includes(text))!;

describe("ClaudeSettingsPanel", () => {
  it("shows saved values and the CLI, and saves only changed settings", async () => {
    const callHook = hooks();
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));

    expect(container.textContent).toContain("2.1.289 (Claude Code)");
    expect(container.textContent).toContain("/home/user/.claude/settings.json");
    expect(control(container, "Default model").value).toBe("opus");
    expect(control(container, "Fast mode").value).toBe("true");
    expect(button(container, "Save Claude settings").disabled).toBe(true);

    await change(control(container, "Default model"), "gpt-6.1-sol");
    expect(container.textContent).toContain("Enter a Claude model alias");
    expect(button(container, "Save Claude settings").disabled).toBe(true);

    await change(control(container, "Default model"), "claude-sonnet-5-5");
    await change(control(container, "Effort"), "high");
    await change(control(container, "Fast mode"), "");
    await change(control(container, "Permission mode for CloudX tabs"), "acceptEdits");
    await act(async () => button(container, "Save Claude settings").click());

    expect(callHook).toHaveBeenCalledWith("claude-settings.update", {
      expectedRevision: "a".repeat(64), model: "claude-sonnet-5-5", effortLevel: "high", fastMode: null, permissionMode: "acceptEdits"
    });
    expect(container.textContent).toContain("Claude settings saved.");
  });

  it("records bypass acceptance only after the warning is reviewed and confirmed", async () => {
    const callHook = hooks();
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));
    expect(container.textContent).toContain("Not accepted.");
    expect(container.textContent).not.toContain("will not ask for approval");
    await act(async () => button(container, "Review warning…").click());
    expect(container.textContent).toContain("Claude Code will not ask for approval.");
    expect(callHook).not.toHaveBeenCalledWith("claude-settings.accept-bypass", expect.anything());
    await act(async () => button(container, "I accept").click());
    expect(callHook).toHaveBeenCalledWith("claude-settings.accept-bypass", { accepted: true });
    expect(container.textContent).toContain("Accepted. Claude tabs in bypass mode start without the warning");
  });

  it("warns when policy disables bypass mode and runs the Claude updater", async () => {
    const callHook = hooks({ ...saved, bypassDisabled: true });
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));
    expect(container.textContent).toContain("disable bypass permissions mode");
    await act(async () => button(container, "Update Claude Code").click());
    expect(callHook).toHaveBeenCalledWith("claude-settings.update-cli", {});
    expect(container.textContent).toContain("2.1.300 (Claude Code)");
  });

  it("saves the personal and synced skills CloudX tabs may use", async () => {
    const callHook = hooks();
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));
    expect((control(container, "Allow docx") as HTMLInputElement).checked).toBe(true);
    expect(container.textContent).toContain("Synced from claude.ai.");
    await act(async () => (control(container, "Allow release-notes") as HTMLInputElement).click());
    await act(async () => (control(container, "Allow docx") as HTMLInputElement).click());
    await act(async () => button(container, "Save Claude settings").click());
    expect(callHook).toHaveBeenCalledWith("claude-settings.update", { expectedRevision: "a".repeat(64), allowedSkills: ["release-notes"] });
  });
});

describe("Settings categories for agents", () => {
  it("shows Agents & accounts and Claude when those plugins are available", async () => {
    const config = { globalFields: [], plugins: [], values: { global: {}, plugins: {} } };
    const container = await render(createElement(SettingsDialog, {
      config, onSave: vi.fn(), onCancel: vi.fn(), callHook: hooks() as never, availablePluginIds: ["agent-accounts", "claude-settings", "codex-settings"]
    }));
    const tabs = [...container.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute("aria-label"));
    expect(tabs).toEqual(expect.arrayContaining(["Codex", "Agents & accounts", "Claude"]));
    expect(tabs.indexOf("Claude")).toBe(tabs.indexOf("Agents & accounts") + 1);
  });
});
