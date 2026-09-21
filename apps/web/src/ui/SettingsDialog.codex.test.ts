// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxConfigResponse, CodexGlobalSettings } from "@cloudx/shared";

import { SettingsDialog } from "./SettingsDialog.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const initial: CodexGlobalSettings = { revision: "first", model: "initial-model", serviceTier: "priority", fastModeEnabled: true };
const config: CloudxConfigResponse = { globalFields: [], plugins: [], values: { global: {}, plugins: {} } };

async function mount(read: () => Promise<CodexGlobalSettings> = async () => initial, initialCategoryId?: string) {
  const calls: { hook: string; input: Record<string, unknown> }[] = [];
  const save = vi.fn(async () => {});
  const callHook: NonNullable<UiContributionRenderContext["callHook"]> = async <T extends Record<string, unknown>>(hook: string, input: Record<string, unknown> = {}) => {
    calls.push({ hook, input });
    return { settings: await read() } as unknown as T;
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const dialog = createElement(StrictMode, {}, createElement(SettingsDialog, {
    config, callHook, initialCategoryId, onSave: save, onCancel: () => root.render(null)
  }));
  const open = async () => { await act(async () => root.render(dialog)); };
  await open();
  return { container, calls, save, open };
}

async function click(container: Element, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => button!.click());
}

async function fill(container: Element, label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function model(container: Element) { return container.querySelector<HTMLInputElement>('[aria-label="Default model"]')!; }
const codexTab = '[role="tab"][aria-label="Codex"]';

describe("Codex settings in the Settings window", () => {
  it("opens the Codex category directly for a retired workspace panel without writing preferences", async () => {
    const { container, calls, save } = await mount(undefined, "codex");
    expect(container.querySelector(codexTab)?.getAttribute("aria-selected")).toBe("true");
    expect(model(container).value).toBe("initial-model");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.hook === "codex-settings.read")).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("loads only when opened and preserves edits across categories and search filtering", async () => {
    const { container, calls } = await mount();
    expect(calls).toEqual([]);
    await fill(container, "Search settings", "fast mode");
    expect(container.querySelector(codexTab)?.getAttribute("aria-selected")).toBe("true");
    expect(model(container).value).toBe("initial-model");
    await fill(container, "Default model", "draft-model");
    const readCount = calls.length;
    await click(container, '[role="tab"][aria-label="General"]');
    expect(model(container)).toBeNull();
    await click(container, codexTab);
    expect(model(container).value).toBe("draft-model");
    await fill(container, "Search settings", "no-matching-setting");
    expect(model(container)).toBeNull();
    await fill(container, "Search settings", "default model");
    expect(model(container).value).toBe("draft-model");
    expect(calls).toHaveLength(readCount);
  });

  it("saves Codex defaults independently of the CloudX footer Save", async () => {
    const { container, calls, save } = await mount();
    await click(container, codexTab);
    await fill(container, "Default model", "saved-model");
    expect(container.querySelector('.settings-footer')?.textContent).toContain("Save Codex settings in the Codex section.");
    const codexSave = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(codexSave.textContent).toContain("Save Codex settings");
    await act(async () => codexSave.click());
    expect(calls.at(-1)).toEqual({ hook: "codex-settings.update", input: { expectedRevision: "first", model: "saved-model" } });
    expect(save).not.toHaveBeenCalled();
    await click(container, '.settings-footer .primary-button');
    expect(save).toHaveBeenCalledWith(config.values);
    expect(calls.filter(call => call.hook === "codex-settings.update")).toHaveLength(1);
  });

  it("discards drafts on close and reads current defaults on reopening", async () => {
    let settings = initial;
    const { container, open } = await mount(async () => settings);
    await click(container, codexTab);
    await fill(container, "Default model", "discarded-model");
    await click(container, '[aria-label="Close settings"]');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    settings = { ...initial, revision: "second", model: "external-model" };
    await open();
    await click(container, codexTab);
    expect(model(container).value).toBe("external-model");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });

  it("ignores a read completing after the Settings window closes", async () => {
    let finishRead!: (settings: CodexGlobalSettings) => void;
    const pending = new Promise<CodexGlobalSettings>(resolve => { finishRead = resolve; });
    let reading = pending;
    const { container, open } = await mount(() => reading);
    await click(container, codexTab);
    expect(container.querySelector('.codex-settings-panel')?.getAttribute("aria-busy")).toBe("true");
    await click(container, '[aria-label="Close settings"]');
    reading = Promise.resolve({ ...initial, model: "current-model" });
    await open();
    await click(container, codexTab);
    await act(async () => finishRead({ ...initial, model: "obsolete-model" }));
    expect(model(container).value).toBe("current-model");
  });
});
