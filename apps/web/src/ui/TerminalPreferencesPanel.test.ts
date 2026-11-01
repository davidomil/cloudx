// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPreferencesPanel } from "./TerminalPreferencesPanel.js";
import { readTerminalPreferences, TERMINAL_PREFERENCES_KEY } from "./terminalPreferences.js";

const values = new Map<string, string>();
let cleanup: (() => void) | undefined;
beforeEach(() => {
  values.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => { act(() => cleanup?.()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => root.unmount();
  act(() => root.render(createElement(TerminalPreferencesPanel)));
  return container;
}

describe("terminal preference ownership and recovery", () => {
  it("explains damaged saved settings and resets them only after an explicit action", () => {
    values.set(TERMINAL_PREFERENCES_KEY, '{"scrollback":-1}');
    const panel = mount();
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("using bounded host defaults");
    expect(values.get(TERMINAL_PREFERENCES_KEY)).toBe('{"scrollback":-1}');
    act(() => panel.querySelector<HTMLButtonElement>("button")!.click());
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(readTerminalPreferences()).toEqual({});
    expect(panel.textContent).toContain("Unset inherits the CloudX default");
  });
  it("saves browser Option/Meta preferences immediately without native configuration writes", () => {
    const panel = mount();
    const option = panel.querySelector<HTMLSelectElement>("select")!;
    act(() => { option.value = "true"; option.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(readTerminalPreferences()).toEqual({ macOptionIsMeta: true });
    expect(panel.textContent).toContain("do not edit native settings or restart clients");
    act(() => { option.value = ""; option.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(readTerminalPreferences()).toEqual({});
    expect(panel.textContent).toContain("explicit Copy approval");
  });
});
