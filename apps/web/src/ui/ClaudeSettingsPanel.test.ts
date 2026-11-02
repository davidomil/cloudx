// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeGlobalSettings } from "@cloudx/shared";

import { ClaudeSettingsPanel } from "./ClaudeSettingsPanel.js";
import { ClaudeConfigurationCatalog } from "./ClaudeConfigurationCatalog.js";
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
  launchMode: null,
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
      expectedRevision: "a".repeat(64), model: "claude-sonnet-5-5", effortModel: "claude-sonnet-5-5", effortLevel: "high", fastMode: null, permissionMode: "acceptEdits"
    });
    expect(container.textContent).toContain("Claude settings saved.");
  });

  it("records bypass acceptance only after the warning is reviewed and confirmed", async () => {
    const callHook = hooks();
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));
    expect(container.textContent).toContain("Not accepted globally.");
    expect(container.textContent).not.toContain("will not ask for approval");
    await act(async () => button(container, "Review warning…").click());
    expect(container.textContent).toContain("Claude Code will not ask for approval.");
    expect(callHook).not.toHaveBeenCalledWith("claude-settings.accept-bypass", expect.anything());
    await act(async () => button(container, "I accept").click());
    expect(callHook).toHaveBeenCalledWith("claude-settings.accept-bypass", { accepted: true });
    expect(container.textContent).toContain("Accepted for future launches");
    expect(container.textContent).toContain("does not change an open managed tab's snapshot");
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

  it("discloses both modes before selection without resetting saved skill choices", async () => {
    const callHook = hooks();
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));
    expect((control(container, "Allow docx") as HTMLInputElement).checked).toBe(true);
    expect(control(container, "Claude launch mode").value).toBe("");
    expect(container.textContent).toContain("Saved choice: Unset");
    expect(container.textContent).toContain("Shared project settings, project CLAUDE.md and project rules are omitted");
    expect(container.textContent).toContain("CLAUDE.local.md");
    expect(container.textContent).toContain("additions, not an exclusive native allowlist");
    expect(container.textContent).toContain("Saved choices remain unchanged");
    const mode = control(container, "Claude launch mode");
    const disclosure = container.querySelector(`#${mode.getAttribute("aria-describedby")}`)!;
    expect(disclosure.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(callHook.mock.calls.some(([hookId]) => hookId === "claude-settings.update")).toBe(false);
  });

  it("saves an explicit managed choice for future launches and can return to the unset fresh default", async () => {
    const callHook = hooks();
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));
    await change(control(container, "Claude launch mode"), "cloudx-managed");
    expect(container.textContent).toContain("Selected for future launches: CloudX-managed");
    await act(async () => button(container, "Save Claude settings").click());
    expect(callHook).toHaveBeenLastCalledWith("claude-settings.update", { expectedRevision: "a".repeat(64), launchMode: "cloudx-managed" });
    expect(container.textContent).toContain("Saved choice: CloudX-managed");
    expect((control(container, "Allow docx") as HTMLInputElement).checked).toBe(true);
    await change(control(container, "Claude launch mode"), "");
    await act(async () => button(container, "Save Claude settings").click());
    expect(callHook).toHaveBeenLastCalledWith("claude-settings.update", { expectedRevision: "b".repeat(64), launchMode: null });
  });

  it("explains user values, model limits, permission rules and activation timing without promising effective runtime state", async () => {
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: hooks({ ...saved, legacyEffortLevel: "xhigh" }) as never }));
    expect(container.textContent).toContain("not observed values for an open tab");
    expect(container.textContent).toContain("always-thinking models");
    expect(container.textContent).toContain("Legacy user effortLevel: xhigh");
    expect(container.textContent).toContain("use native /model or /effort for a running session");
    expect(container.textContent).toContain("Saving never restarts a client");
    expect(container.textContent).toContain("Native project shares the user settings file and follows native reload where supported");
    expect(container.textContent).toContain("CloudX-managed copies user settings at launch; changes to that original file reach a managed session only at the next launch");
    await change(control(container, "Permission mode for CloudX tabs"), "manual");
    expect(container.textContent).toContain("Allows reads and pre-approved operations");
    await change(control(container, "Permission mode for CloudX tabs"), "plan");
    expect(container.textContent).toContain("permitted read-only shell commands");
    expect(container.textContent).not.toContain("Off disables thinking");
    expect(container.textContent).not.toContain("Asks before every tool use");
  });

  it("distinguishes native-project shared consent, managed-tab consent and global future-launch acknowledgement", async () => {
    const callHook = hooks({ ...saved, launchMode: "cloudx-managed" });
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));
    expect(container.textContent).toContain("Native project records native warning acceptance in the shared user settings");
    expect(container.textContent).toContain("CloudX-managed records it only in that tab's settings snapshot");
    expect(container.textContent).toContain("Accepting here updates the original user settings for future launches");
    expect(callHook.mock.calls.some(([id]) => id === "claude-settings.accept-bypass")).toBe(false);
  });

  it("shows unsupported saved channels and blocks updates until the user corrects the value", async () => {
    const callHook = hooks({ ...saved, autoUpdatesChannel: "rc" });
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));
    expect(container.textContent).toContain("Unsupported saved update channel: rc");
    expect(button(container, "Update Claude Code").disabled).toBe(true);
    const channels = control(container, "Update channel") as HTMLSelectElement;
    expect([...channels.options].map(option => option.value)).toEqual(["", "latest", "stable", "rc"]);
    await change(channels, "stable");
    await act(async () => button(container, "Save Claude settings").click());
    expect(callHook).toHaveBeenCalledWith("claude-settings.update", { expectedRevision: "a".repeat(64), autoUpdatesChannel: "stable" });
    expect(button(container, "Update Claude Code").disabled).toBe(false);
  });

  it("reads effort for each exact model and prevents saving an ambiguous account alias", async () => {
    const callHook = hooks({ ...saved, model: "claude-opus-5-5", effortLevel: "high", modelEffortLevels: { "claude-opus-5-5": "high", "claude-sonnet-5-5": "medium" } });
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));
    await change(control(container, "Default model"), "claude-sonnet-5-5");
    expect(control(container, "Effort").value).toBe("medium");
    await change(control(container, "Default model"), "opus");
    await change(control(container, "Effort"), "xhigh");
    expect(container.textContent).toContain("Choose a full Claude model ID before saving effort");
    expect(button(container, "Save Claude settings").disabled).toBe(true);
    await change(control(container, "Effort model"), "claude-opus-5-5");
    expect(control(container, "Effort").value).toBe("high");
  });

  it("searches the complete reference by family and exposes only reviewed typed persistent editors", async () => {
    const callHook = hooks({ ...saved, nativeOptions: { autoScrollEnabled: true } });
    const container = await render(createElement(ClaudeSettingsPanel, { callHook: callHook as never }));
    expect(container.textContent).toContain("247 settings rows, 384 environment rows, 121 CLI rows");
    expect(container.textContent).toContain("complete reference inventory is separate from native runtime certification");
    expect(container.textContent).toContain("Native 2.1.316 review");
    await change(control(container, "Search Claude configuration"), "autoScrollEnabled");
    expect(container.textContent).toContain("Native reference default: true");
    expect(container.textContent).toContain("Saved user value: true");
    expect(container.textContent).toContain("Effective session value: unresolved");
    await change(control(container, "Claude native autoScrollEnabled"), "");
    await act(async () => button(container, "Save Claude settings").click());
    expect(callHook).toHaveBeenCalledWith("claude-settings.update", { expectedRevision: "a".repeat(64), nativeOptions: { autoScrollEnabled: null } });
    await change(control(container, "Search Claude configuration"), "allowManagedHooksOnly");
    expect(container.textContent).toContain("Organization policy. Read-only in CloudX");
    expect(container.querySelector('[aria-label="Claude native allowManagedHooksOnly"]')).toBeNull();
    await change(control(container, "Claude configuration family"), "environment");
    await change(control(container, "Search Claude configuration"), "CLAUDE_CODE_USE_MANTLE");
    expect(container.textContent).toContain("Account, credential or provider configuration");
    await change(control(container, "Claude configuration family"), "cli");
    await change(control(container, "Search Claude configuration"), "--worktree");
    expect(container.textContent).toContain("Not supported as a managed CloudX session");
  });

  it("disables newer option values for an older executable while preserving the unset correction", async () => {
    const container = await render(createElement(ClaudeConfigurationCatalog, { settings: saved, version: "2.1.268 (Claude Code)", nativeOptions: { bashEditDiffEnabled: true }, onChange: vi.fn() }));
    await change(control(container, "Search Claude configuration"), "bashEditDiffEnabled");
    const options = [...(control(container, "Claude native bashEditDiffEnabled") as HTMLSelectElement).options];
    expect(options.map(option => [option.value, option.disabled])).toEqual([["", false], ["true", true], ["false", true]]);
    expect(container.textContent).toContain("selected 2.1.268 is older");
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
