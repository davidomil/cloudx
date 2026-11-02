// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onTerminalPreferencesChanged, readTerminalPreferences, saveTerminalPreferences, TERMINAL_PREFERENCES_KEY, terminalPreferenceState, validateTerminalPreferences } from "./terminalPreferences.js";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});

describe("browser terminal preferences", () => {
  it("distinguishes inherited defaults from saved settings and notifies live views", () => {
    const listener = vi.fn();
    const release = onTerminalPreferencesChanged(listener);
    expect(readTerminalPreferences()).toEqual({});
    const settings = { macOptionIsMeta: true, fontFamily: "monospace", scrollback: 2000, links: "disabled", attachments: "review", shiftEnter: "ctrl-j" } as const;
    saveTerminalPreferences(settings);
    expect(readTerminalPreferences()).toEqual(settings);
    expect(listener).toHaveBeenCalledOnce();
    window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_PREFERENCES_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
    release();
    saveTerminalPreferences({});
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readTerminalPreferences()).toEqual({});
  });
  it.each([{ scrollback: -1 }, { scrollback: 1.5 }, { scrollback: 100001 }, { fontFamily: "" }, { fontFamily: "font\nfamily" }, { macOptionIsMeta: "true" }, { links: "silent" }, { attachments: "automatic" }, { shiftEnter: "submit" }, null])("rejects invalid host settings %j", value => {
    expect(() => validateTerminalPreferences(value)).toThrow();
  });
  it("ignores damaged persisted data and bounds resource use", () => {
    window.localStorage.setItem(TERMINAL_PREFERENCES_KEY, "invalid");
    expect(readTerminalPreferences()).toEqual({});
    expect(terminalPreferenceState().error).toContain("Reset the saved preferences");
    expect(validateTerminalPreferences({ scrollback: 0, fontFamily: " Mono " })).toEqual({ scrollback: 0, fontFamily: "Mono" });
  });
});
