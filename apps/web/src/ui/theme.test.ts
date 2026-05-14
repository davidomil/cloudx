// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { applyCloudxTheme, readTerminalColorTheme, resolveThemeId } from "./theme.js";

describe("theme", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to the default theme for unknown config values", () => {
    expect(resolveThemeId("missing")).toBe("cloudx-neon");
  });

  it("applies theme tokens to the root element", () => {
    const root = document.createElement("div");

    expect(applyCloudxTheme("graphite", root)).toBe("graphite");

    expect(root.dataset.theme).toBe("graphite");
    expect(root.style.getPropertyValue("--color-background")).toBe("#0c0f12");
  });

  it("reads terminal colors from CSS variables", () => {
    const root = document.createElement("div");
    root.style.setProperty("--color-background", "#111111");
    root.style.setProperty("--color-foreground", "#eeeeee");
    root.style.setProperty("--color-accent", "#99ff99");
    root.style.setProperty("--terminal-selection-background", "#223344");
    vi.spyOn(window, "getComputedStyle").mockReturnValue(root.style);

    expect(readTerminalColorTheme(root)).toEqual({
      background: "#111111",
      foreground: "#eeeeee",
      cursor: "#99ff99",
      selectionBackground: "#223344"
    });
  });
});
