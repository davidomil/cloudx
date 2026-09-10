// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxConfigResponse, CloudxConfigValues, RulesSkillsStore } from "@cloudx/shared";

import { SettingsDialog } from "./SettingsDialog.js";

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const templates: RulesSkillsStore = {
  defaultTemplateId: "focused",
  rules: [], skills: [], systemRules: [], systemSkills: [],
  templates: [
    { id: "focused", name: "Focused", color: "green", ruleIds: [], skillIds: [] },
    { id: "review", name: "Review changes", color: "yellow", ruleIds: [], skillIds: [] }
  ]
};

function config(): CloudxConfigResponse {
  return {
    globalFields: [
      { key: "workspaceTitle", label: "Workspace title", type: "string", description: "Name shown in the workbench.", defaultValue: "CloudX" },
      { key: "internalGlobal", label: "Diagnostic pipeline", type: "string", visibility: "internal", defaultValue: "private-tracking-value" }
    ],
    plugins: [
      {
        pluginId: "documentation", displayName: "Archive Search", fields: [
          {
            key: "searchEngine", label: "Search engine", type: "select", description: "Model used for retrieval quality.", defaultValue: "compact-v2",
            options: [
              { label: "Compact model", value: "compact-v2", description: "Smaller inference cost" },
              { label: "Detailed model", value: "detailed-v3", description: "Larger context window" }
            ]
          },
          { key: "accessToken", label: "Access token", type: "secret", secretConfigured: true, defaultValue: "secret-default-value" },
          { key: "internalPlugin", label: "Internal plugin field", type: "string", visibility: "internal", defaultValue: "hidden-plugin-default" }
        ]
      },
      {
        pluginId: "internal-only", displayName: "Internal Only", fields: [
          { key: "hiddenField", label: "Hidden field", type: "string", visibility: "internal", defaultValue: "hidden" }
        ]
      }
    ],
    values: {
      global: { workspaceTitle: "My workspace", internalGlobal: "private-tracking-value" },
      plugins: {
        documentation: { searchEngine: "compact-v2", accessToken: "secret-current-value", internalPlugin: "hidden-plugin-value" },
        "internal-only": { hiddenField: "hidden" }
      }
    }
  };
}

async function mount(overrides: Partial<ComponentProps<typeof SettingsDialog>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const response = config();
  const save = vi.fn(async (_values: CloudxConfigValues) => {});
  const cancel = vi.fn();
  const saveTemplate = vi.fn(async (_templateId: string | undefined) => {});
  const requestPermission = vi.fn(async () => {});
  await act(async () => root!.render(createElement(SettingsDialog, {
    config: response,
    rulesSkillsStore: templates,
    browserNotificationState: "default",
    onSave: save,
    onCancel: cancel,
    onSaveDefaultTemplate: saveTemplate,
    onRequestBrowserNotifications: requestPermission,
    ...overrides
  })));
  return { container, response, save, cancel, saveTemplate, requestPermission };
}

function tab(container: Element, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.getAttribute("aria-label") === name);
  expect(found, `Tab ${name}`).toBeDefined();
  return found!;
}

function activePanel(container: Element): HTMLElement {
  const panels = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter(panel => !panel.hidden);
  expect(panels).toHaveLength(1);
  return panels[0];
}

function field(container: Element, label: string): HTMLInputElement | HTMLSelectElement {
  const found = [...container.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))?.querySelector<HTMLInputElement | HTMLSelectElement>("input,select");
  expect(found, `Field ${label}`).toBeTruthy();
  return found!;
}

function visibleFields(container: Element): string[] {
  return [...activePanel(container).querySelectorAll("label")]
    .filter(label => !label.closest("[hidden]"))
    .map(label => label.querySelector("input,select")?.getAttribute("aria-label") ?? label.querySelector("span")?.textContent ?? "");
}

function button(container: Element, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === name || item.getAttribute("aria-label") === name);
  expect(found, `Button ${name}`).toBeDefined();
  return found!;
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
}

async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

async function search(container: Element, query: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search settings"]');
  expect(input).not.toBeNull();
  await change(input!, query);
}

async function pressKey(target: HTMLElement, key: string, shiftKey = false) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })));
}

describe("Settings navigation and search", () => {
  it("opens General and exposes one associated panel for each visible category", async () => {
    const { container } = await mount();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-label") ?? document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Settings");
    expect([...container.querySelectorAll('[role="tab"]')].map(item => item.getAttribute("aria-label"))).toEqual(["General", "Archive Search", "Browser"]);
    expect(tab(container, "General").getAttribute("aria-selected")).toBe("true");
    expect(visibleFields(container)).toEqual(["Workspace title", "Default template"]);

    for (const name of ["Archive Search", "Browser", "General"]) {
      await click(tab(container, name));
      const selected = tab(container, name);
      expect(selected.getAttribute("aria-selected")).toBe("true");
      expect(activePanel(container).id).toBe(selected.getAttribute("aria-controls"));
      expect(activePanel(container).getAttribute("aria-labelledby")).toBe(selected.id);
    }
  });

  it("omits Browser without permission state and excludes internal settings from navigation", async () => {
    const { container } = await mount({ browserNotificationState: undefined });
    expect([...container.querySelectorAll('[role="tab"]')].map(item => item.getAttribute("aria-label"))).toEqual(["General", "Archive Search"]);
    expect(container.textContent).not.toMatch(/Diagnostic pipeline|Internal plugin field|Internal Only|Hidden field/);
  });

  it.each([
    { mobile: false, orientation: "vertical", next: "ArrowDown", previous: "ArrowUp", scrollingKey: "ArrowRight" },
    { mobile: true, orientation: "horizontal", next: "ArrowRight", previous: "ArrowLeft", scrollingKey: "ArrowDown" }
  ])("navigates $orientation tabs with the matching arrow keys, Home, and End", async ({ mobile, orientation, next, previous, scrollingKey }) => {
    vi.stubGlobal("matchMedia", () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }));
    const { container } = await mount();
    expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-orientation")).toBe(orientation);
    tab(container, "General").focus();
    await pressKey(tab(container, "General"), scrollingKey);
    expect(tab(container, "General").getAttribute("aria-selected")).toBe("true");
    for (const [key, name] of [[next, "Archive Search"], ["End", "Browser"], [next, "General"], [previous, "Browser"], ["Home", "General"]]) {
      await pressKey(document.activeElement as HTMLElement, key);
      const selected = tab(container, name);
      expect(selected.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(selected);
      expect([...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(item => item.tabIndex === 0)).toEqual([selected]);
    }
  });

  it.each(["Search engine", "searchEngine", "retrieval quality", "Compact model", "compact-v2", "smaller inference", "  MODEL  RETRIEVAL  "])("finds the matching setting from %j", async query => {
    const { container } = await mount();
    await search(container, query);
    expect(tab(container, "Archive Search").getAttribute("aria-selected")).toBe("true");
    expect(visibleFields(container)).toEqual(["Search engine"]);
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/1 matching settings? across all tabs/i);
  });

  it("counts results across categories while keeping a selected category with matches", async () => {
    const response = config();
    response.globalFields.push({ key: "voiceModel", label: "Voice model", type: "string", defaultValue: "voice-default" });
    const { container } = await mount({ config: response });
    await search(container, "model");
    expect(tab(container, "General").getAttribute("aria-selected")).toBe("true");
    expect(visibleFields(container)).toEqual(["Voice model"]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("2 matching settings across all tabs");
    await click(tab(container, "Archive Search"));
    expect(visibleFields(container)).toEqual(["Search engine"]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("2 matching settings across all tabs");
  });

  it.each(["Archive Search", "documentation"])("finds all visible settings in a plugin using %j", async query => {
    const { container } = await mount();
    await search(container, query);
    expect(visibleFields(container)).toEqual(["Search engine", "Access token"]);
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/2 matching settings\b/i);
  });

  it.each(["internalGlobal", "diagnostic pipeline", "private-tracking-value", "Internal Only", "hidden-plugin-default", "secret-current-value", "secret-default-value", "compact nonexistent"])("returns no matches for %j", async query => {
    const { container } = await mount();
    await search(container, query);
    expect(visibleFields(container)).toEqual([]);
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/0 matching settings\b/i);
  });

  it("clears an empty search result and returns focus to the search field", async () => {
    const { container } = await mount();
    await search(container, "no such setting");
    await click(button(container, "Clear search"));
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(visibleFields(container)).toEqual(["Workspace title", "Default template"]);
  });

  it("finds the default template and browser permission action", async () => {
    const { container, requestPermission } = await mount();
    await search(container, "default template");
    expect(visibleFields(container)).toEqual(["Default template"]);
    await search(container, "Review changes");
    expect(visibleFields(container)).toEqual(["Default template"]);
    await search(container, "permission");
    expect(tab(container, "Browser").getAttribute("aria-selected")).toBe("true");
    await click(button(activePanel(container), "Request permission"));
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("preserves drafts across navigation and filtering, then saves all categories together", async () => {
    const { container, response, save, saveTemplate } = await mount();
    const original = structuredClone(response.values);
    await change(field(container, "Workspace title"), "Project workbench");
    await change(field(container, "Default template"), "review");
    await click(tab(container, "Archive Search"));
    await change(field(container, "Search engine"), "detailed-v3");
    await change(field(container, "Access token"), "new-sensitive-token");
    await search(container, "workspace title");
    expect(field(activePanel(container), "Workspace title").value).toBe("Project workbench");
    await search(container, "new-sensitive-token");
    expect(visibleFields(container)).toEqual([]);
    await click(button(container, "Clear search"));
    await click(tab(container, "Archive Search"));
    expect(field(activePanel(container), "Search engine").value).toBe("detailed-v3");
    expect(field(activePanel(container), "Access token").value).toBe("new-sensitive-token");
    await click(button(container, "Save"));

    expect(saveTemplate).toHaveBeenCalledExactlyOnceWith("review");
    expect(save).toHaveBeenCalledExactlyOnceWith({
      global: { ...original.global, workspaceTitle: "Project workbench" },
      plugins: { ...original.plugins, documentation: { ...original.plugins.documentation, searchEngine: "detailed-v3", accessToken: "new-sensitive-token" } }
    });
    expect(response.values).toEqual(original);
  });

  it("cancels edits from multiple categories without saving configuration or templates", async () => {
    const { container, response, save, saveTemplate, cancel } = await mount();
    const original = structuredClone(response.values);
    await change(field(container, "Workspace title"), "Unsaved title");
    await change(field(container, "Default template"), "review");
    await search(container, "search engine");
    await change(field(activePanel(container), "Search engine"), "detailed-v3");
    await click(button(container, "Cancel"));
    expect(cancel).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(saveTemplate).not.toHaveBeenCalled();
    expect(response.values).toEqual(original);
  });

  it("keeps a secret clear action pending while its setting is hidden by search", async () => {
    let finishClear!: () => void;
    const clearing = new Promise<void>(resolve => { finishClear = resolve; });
    const clearSecret = vi.fn(() => clearing);
    const { container } = await mount({ onClearPluginSecret: clearSecret });
    await search(container, "access token");
    await click(button(activePanel(container), "Clear"));
    try {
      expect(clearSecret).toHaveBeenCalledExactlyOnceWith("documentation", "accessToken");
      expect(field(activePanel(container), "Access token").disabled).toBe(true);
      await search(container, "workspace title");
      await search(container, "access token");
      expect(field(activePanel(container), "Access token").disabled).toBe(true);
    } finally {
      await act(async () => finishClear());
    }
    expect(field(activePanel(container), "Access token").disabled).toBe(false);
    expect(field(activePanel(container), "Access token").value).toBe("");
  });

  it("keeps focus inside the dialog and restores the opener after cancellation", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { container, cancel } = await mount();
    expect(document.activeElement).toBe(container.querySelector('input[type="search"]'));
    const close = button(container, "Close settings");
    const save = button(container, "Save");
    close.focus();
    await pressKey(close, "Tab", true);
    expect(document.activeElement).toBe(save);
    await pressKey(save, "Tab");
    expect(document.activeElement).toBe(close);
    await pressKey(close, "Escape");
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => root!.unmount());
    root = undefined;
    expect(document.activeElement).toBe(opener);
  });
});
