// @vitest-environment jsdom

import { act, createElement, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexGlobalSettings } from "@cloudx/shared";

import { CodexSettingsPanel } from "./CodexSettingsPanel.js";
import { CodexSettingsEditor } from "./CodexSettingsEditor.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()); });
  document.body.replaceChildren();
});

const initial: CodexGlobalSettings = { revision: "first", model: "gpt-6-astra", serviceTier: "priority", fastModeEnabled: true };
type HookHandler = (hook: string, input: Record<string, unknown>) => CodexGlobalSettings | Promise<CodexGlobalSettings>;

async function mount(settings = initial, handler?: HookHandler, strict = false) {
  const calls: { hook: string; input: Record<string, unknown> }[] = [];
  const callHook: NonNullable<UiContributionRenderContext["callHook"]> = async <T extends Record<string, unknown>>(hook: string, input: Record<string, unknown> = {}) => {
    calls.push({ hook, input });
    const result = handler ? await handler(hook, input) : settings;
    return { settings: result } as unknown as T;
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const editor = new CodexSettingsEditor();
  const panel = createElement(CodexSettingsPanel, { editor, callHook });
  await act(async () => { root.render(strict ? createElement(StrictMode, {}, panel) : panel); });
  async function detach() { await act(async () => { root.render(null); }); }
  async function attach() { await act(async () => { root.render(panel); }); }
  async function remount() { await detach(); await attach(); }
  return { container, calls, root, callHook, editor, detach, attach, remount };
}

function model(container: Element) { return container.querySelector<HTMLInputElement>('input[aria-label="Default model"]')!; }
function mode(container: Element) { return container.querySelector<HTMLSelectElement>('select[aria-label="Fast mode"]')!; }
function button(container: Element, name: string) {
  const found = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === name);
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
async function click(container: Element, name: string) { await act(async () => { button(container, name).click(); }); }
async function fill(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe("global Codex settings editor", () => {
  it("loads the shared settings and explains their scope", async () => {
    const { container, calls } = await mount();
    expect(calls).toEqual([{ hook: "codex-settings.read", input: {} }]);
    expect(model(container).value).toBe(initial.model);
    expect(mode(container).value).toBe(initial.serviceTier);
    expect(button(container, "Save").disabled).toBe(true);
    expect(container.textContent).toContain("Shared by CloudX instances using the same Codex home.");
    expect(container.textContent).toContain("Running sessions keep their current settings.");
  });

  it("saves changed model and fast mode with the revision that was loaded", async () => {
    const updated = { ...initial, revision: "second", model: "provider/new-model", serviceTier: "default" };
    const { container, calls } = await mount(initial, hook => hook === "codex-settings.read" ? initial : updated);
    await fill(model(container), updated.model);
    await fill(mode(container), updated.serviceTier);
    await click(container, "Save");
    expect(calls.at(-1)).toEqual({ hook: "codex-settings.update", input: { expectedRevision: "first", model: "provider/new-model", serviceTier: "default" } });
    expect(container.textContent).toContain("Global Codex settings saved.");
    expect(button(container, "Save").disabled).toBe(true);
    await fill(model(container), "next-model");
    await click(container, "Save");
    expect(calls.at(-1)?.input.expectedRevision).toBe("second");
  });

  it.each(["fast", "custom-tier", "flex"])("preserves the saved %s tier when only the model changes", async serviceTier => {
    const settings = { ...initial, serviceTier };
    const { container, calls } = await mount(settings);
    expect(mode(container).value).toBe(serviceTier);
    await fill(model(container), "new-model");
    await click(container, "Save");
    expect(calls.at(-1)).toEqual({ hook: "codex-settings.update", input: { expectedRevision: "first", model: "new-model" } });
  });

  it("removes the model and service tier overrides when their defaults are selected", async () => {
    const { container, calls } = await mount();
    await fill(model(container), "");
    await fill(mode(container), "");
    await click(container, "Save");
    expect(calls.at(-1)?.input).toEqual({ expectedRevision: "first", model: null, serviceTier: null });
  });

  it("enables a disabled feature only after explicitly selecting a mode", async () => {
    const settings = { ...initial, fastModeEnabled: false };
    const { container, calls } = await mount(settings);
    expect(container.textContent).toContain("Fast mode support is disabled");
    await fill(model(container), "new-model");
    await click(container, "Save");
    expect(calls.at(-1)?.input).toEqual({ expectedRevision: "first", model: "new-model" });
    await fill(mode(container), "default");
    await click(container, "Save");
    expect(calls.at(-1)?.input).toEqual({ expectedRevision: "first", serviceTier: "default" });
  });

  it.each(["priority", "default", "flex"])("enables disabled support for the saved %s tier without changing the selection", async serviceTier => {
    const settings = { ...initial, serviceTier, fastModeEnabled: false };
    const { container, calls } = await mount(settings, hook => hook === "codex-settings.read" ? settings : { ...settings, fastModeEnabled: true });
    expect(mode(container).value).toBe(serviceTier);
    expect(button(container, "Save").disabled).toBe(true);
    await click(container, "Enable fast mode support");
    expect(mode(container).value).toBe(serviceTier);
    expect(button(container, "Save").disabled).toBe(false);
    expect(container.textContent).toContain("Fast mode support will be enabled when you save.");
    expect(calls).toHaveLength(1);
    await click(container, "Save");
    expect(calls.at(-1)?.input).toEqual({ expectedRevision: "first", serviceTier });
    expect(container.textContent).not.toContain("Enable fast mode support");
    expect(button(container, "Save").disabled).toBe(true);
  });

  it("discards a pending enable on Reload and preserves disabled support for model-only saves", async () => {
    const settings = { ...initial, fastModeEnabled: false };
    const { container, calls } = await mount(settings);
    await click(container, "Enable fast mode support");
    await click(container, "Reload");
    expect(button(container, "Save").disabled).toBe(true);
    expect(button(container, "Enable fast mode support").disabled).toBe(false);
    await fill(model(container), "new-model");
    await click(container, "Save");
    expect(calls.at(-1)?.input).toEqual({ expectedRevision: "first", model: "new-model" });
  });

  it.each([null, "custom-tier"])("requires a supported tier before enabling support for %s", async serviceTier => {
    const { container } = await mount({ ...initial, serviceTier, fastModeEnabled: false });
    expect(container.textContent).not.toContain("Enable fast mode support");
    expect(button(container, "Save").disabled).toBe(true);
  });

  it("disables the enable action while a model-only save is pending", async () => {
    const pending = deferred<CodexGlobalSettings>();
    const settings = { ...initial, fastModeEnabled: false };
    const { container } = await mount(settings, hook => hook === "codex-settings.read" ? settings : pending.promise);
    await fill(model(container), "new-model");
    await click(container, "Save");
    expect(button(container, "Enable fast mode support").disabled).toBe(true);
    await act(async () => { pending.resolve({ ...settings, model: "new-model" }); });
    expect(button(container, "Enable fast mode support").disabled).toBe(false);
  });

  it.each(["not a model", "-starts-with-hyphen", "x".repeat(129)])("rejects an invalid model identifier %s", async value => {
    const { container, calls } = await mount();
    await fill(model(container), value);
    expect(model(container).getAttribute("aria-invalid")).toBe("true");
    expect(button(container, "Save").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter a model identifier");
    expect(calls).toHaveLength(1);
  });

  it("keeps a failed save's draft and revision until Reload reads the shared file", async () => {
    let current = initial;
    const { container, calls } = await mount(initial, hook => {
      if (hook === "codex-settings.update") throw new Error("Settings changed in another instance. Reload before saving.");
      return current;
    });
    await fill(model(container), "my-draft");
    await click(container, "Save");
    expect(model(container).value).toBe("my-draft");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("another instance");
    expect(button(container, "Save").disabled).toBe(false);
    current = { ...initial, revision: "external", model: "external-model", serviceTier: "flex" };
    await click(container, "Reload");
    expect(model(container).value).toBe("external-model");
    expect(mode(container).value).toBe("flex");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(calls.at(-1)?.hook).toBe("codex-settings.read");
    expect(button(container, "Save").disabled).toBe(true);
  });

  it("shows a read error and lets Reload recover", async () => {
    let failed = true;
    const { container } = await mount(initial, () => {
      if (failed) throw new Error("Config TOML is invalid.");
      return initial;
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Config TOML is invalid.");
    expect(model(container)).toBeNull();
    failed = false;
    await click(container, "Reload");
    expect(model(container).value).toBe(initial.model);
  });

  it("disables edits during saving and ignores duplicate submits", async () => {
    const saved = deferred<CodexGlobalSettings>();
    const { container, calls } = await mount(initial, hook => hook === "codex-settings.read" ? initial : saved.promise);
    await fill(model(container), "new-model");
    await click(container, "Save");
    expect(model(container).disabled).toBe(true);
    expect(mode(container).disabled).toBe(true);
    expect(button(container, "Reload").disabled).toBe(true);
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(calls.filter(call => call.hook === "codex-settings.update")).toHaveLength(1);
    await act(async () => { saved.resolve({ ...initial, model: "new-model" }); });
    expect(model(container).disabled).toBe(false);
  });

  it("keeps one pending load when Strict Mode reconnects the panel", async () => {
    const pending = deferred<CodexGlobalSettings>();
    const { container, calls } = await mount(initial, () => pending.promise, true);
    expect(calls).toHaveLength(1);
    await act(async () => { pending.resolve(initial); });
    expect(model(container).value).toBe(initial.model);
  });

  it("does not reload when the App provides a new hook callback", async () => {
    const { container, root, calls, editor } = await mount();
    await fill(model(container), "unsaved-model");
    const nextCallHook = vi.fn();
    await act(async () => { root.render(createElement(CodexSettingsPanel, { editor, callHook: nextCallHook })); });
    expect(model(container).value).toBe("unsaved-model");
    expect(calls).toHaveLength(1);
    expect(nextCallHook).not.toHaveBeenCalled();
  });

  it("ignores a late load after the tab owner disposes the editor", async () => {
    const pending = deferred<CodexGlobalSettings>();
    const { container, root, editor } = await mount(initial, () => pending.promise);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading global Codex settings");
    await act(async () => { root.unmount(); editor.dispose(); });
    roots.splice(roots.indexOf(root), 1);
    await act(async () => { pending.resolve(initial); });
    expect(container.childElementCount).toBe(0);
    expect(editor.getSnapshot().settings).toBeUndefined();
  });

  it("retains an explicit enable action through a panel remount until Reload", async () => {
    const { container, calls, remount } = await mount({ ...initial, fastModeEnabled: false });
    await click(container, "Enable fast mode support");
    await remount();
    expect(calls).toHaveLength(1);
    expect(mode(container).value).toBe("priority");
    expect(button(container, "Save").disabled).toBe(false);
    expect(container.textContent).toContain("Fast mode support will be enabled when you save.");
    await click(container, "Reload");
    await remount();
    expect(button(container, "Save").disabled).toBe(true);
    expect(container.textContent).toContain("Enable fast mode support");
  });

  it("finishes a pending read while the panel is detached and reuses it on return", async () => {
    const pending = deferred<CodexGlobalSettings>();
    const { container, calls, detach, attach } = await mount(initial, () => pending.promise);
    await detach();
    await act(async () => { pending.resolve(initial); });
    await attach();
    expect(calls).toHaveLength(1);
    expect(model(container).value).toBe(initial.model);
    expect(model(container).disabled).toBe(false);
  });

  it.each(["success", "conflict"])("retains a pending save and its %s across panel remounts", async outcome => {
    const pending = deferred<CodexGlobalSettings>();
    const fixture = await mount(initial, async hook => {
      if (hook === "codex-settings.read") return initial;
      const result = await pending.promise;
      if (outcome === "conflict") throw new Error("Shared settings changed in another instance.");
      return result;
    });
    const { container, calls, detach, attach, remount } = fixture;
    await fill(model(container), "pending-model");
    await click(container, "Save");
    await remount();
    expect(model(container).value).toBe("pending-model");
    expect(model(container).disabled).toBe(true);
    expect(button(container, "Reload").disabled).toBe(true);
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(calls).toHaveLength(2);
    await detach();
    await act(async () => { pending.resolve({ ...initial, revision: "saved-revision", model: "pending-model" }); });
    await attach();
    expect(calls).toHaveLength(2);
    expect(model(container).value).toBe("pending-model");
    expect(model(container).disabled).toBe(false);
    if (outcome === "success") {
      expect(container.textContent).toContain("Global Codex settings saved.");
      expect(button(container, "Save").disabled).toBe(true);
      await fill(model(container), "next-model");
    } else {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("another instance");
    }
    await click(container, "Save");
    expect(calls.at(-1)?.input.expectedRevision).toBe(outcome === "success" ? "saved-revision" : "first");
  });

  it("retains a failed initial read on reattach until an explicit Reload", async () => {
    let fail = true;
    const { container, calls, remount } = await mount(initial, () => {
      if (fail) throw new Error("Invalid shared settings");
      return initial;
    });
    await remount();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Invalid shared settings");
    expect(calls).toHaveLength(1);
    fail = false;
    await click(container, "Reload");
    expect(model(container).value).toBe(initial.model);
  });

  it("discards a closed tab's pending save without resurrecting its draft", async () => {
    const pending = deferred<CodexGlobalSettings>();
    const { container, editor, detach, attach } = await mount(initial, hook => hook === "codex-settings.read" ? initial : pending.promise);
    await fill(model(container), "closed-tab-draft");
    await click(container, "Save");
    await detach();
    editor.dispose();
    await attach();
    expect(model(container).value).toBe(initial.model);
    await act(async () => { pending.resolve({ ...initial, model: "closed-tab-draft", revision: "late-save" }); });
    expect(model(container).value).toBe(initial.model);
    expect(editor.getSnapshot().settings?.revision).toBe("first");
    expect(container.textContent).not.toContain("Global Codex settings saved.");
  });

  it("keeps separate drafts and revisions for two open editors", async () => {
    const first = await mount();
    const second = await mount({ ...initial, revision: "second-tab-revision" });
    await fill(model(first.container), "first-tab-draft");
    await fill(model(second.container), "second-tab-draft");
    await first.remount();
    await second.remount();
    expect(model(first.container).value).toBe("first-tab-draft");
    expect(model(second.container).value).toBe("second-tab-draft");
    await click(first.container, "Save");
    await click(second.container, "Save");
    expect(first.calls.at(-1)?.input.expectedRevision).toBe("first");
    expect(second.calls.at(-1)?.input.expectedRevision).toBe("second-tab-revision");
  });

  it("ignores cancelled reads when Strict Mode cleans up and restarts the tab owner", async () => {
    const first = deferred<CodexGlobalSettings>();
    const editor = new CodexSettingsEditor();
    let reads = 0;
    const callHook: NonNullable<UiContributionRenderContext["callHook"]> = async <T extends Record<string, unknown>>() => {
      const settings = ++reads === 1 ? await first.promise : { ...initial, model: "current-model" };
      return { settings } as unknown as T;
    };
    function TabOwner() {
      useEffect(() => () => editor.dispose(), []);
      return createElement(CodexSettingsPanel, { editor, callHook });
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => { root.render(createElement(StrictMode, {}, createElement(TabOwner))); });
    expect(model(container).value).toBe("current-model");
    await act(async () => { first.resolve({ ...initial, model: "cancelled-model" }); });
    expect(model(container).value).toBe("current-model");
  });

});
