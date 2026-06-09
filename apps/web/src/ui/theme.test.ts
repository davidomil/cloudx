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

    expect(applyCloudxTheme("minimalist-dark", root)).toBe("minimalist-dark");

    expect(root.dataset.theme).toBe("minimalist-dark");
    expect(root.style.getPropertyValue("--color-background")).toBe("#0A0A0F");
    expect(root.style.getPropertyValue("--color-accent")).toBe("#F59E0B");
    expect(root.style.getPropertyValue("--automation-minimap-node")).toBe("#F59E0B");
    expect(root.style.getPropertyValue("--automation-minimap-border")).toBe("rgba(245, 158, 11, 0.24)");
    expect(root.style.getPropertyValue("--automation-controls-foreground")).toBe("#F59E0B");
    expect(root.style.getPropertyValue("--automation-controls-border")).toBe("rgba(245, 158, 11, 0.24)");
    expect(root.style.getPropertyValue("--automation-node-background")).toBe("rgba(26, 26, 36, 0.94)");
    expect(root.style.getPropertyValue("--automation-palette-button-hover-background")).toBe("rgba(245, 158, 11, 0.2)");
    expect(root.style.getPropertyValue("--automation-input-border")).toBe("rgba(245, 158, 11, 0.24)");
    expect(root.style.getPropertyValue("--surface-popover-background")).toBe("rgba(10, 10, 15, 0.98)");
    expect(root.style.getPropertyValue("--surface-popover-border")).toBe("rgba(245, 158, 11, 0.32)");
    expect(root.style.getPropertyValue("--surface-dock-button-shadow")).toContain("rgba(245, 158, 11");
    expect(root.style.getPropertyValue("--resize-handle-background")).toContain("rgba(245, 158, 11");
    expect(root.style.getPropertyValue("--plugin-panel-dock-button-size")).toBe("44px");
    expect(root.style.getPropertyValue("--plugin-panel-dock-panel-height")).toBe("580px");
    expect(root.style.getPropertyValue("--notification-count-size")).toBe("17px");
    expect(root.style.getPropertyValue("--notification-popover-width")).toBe("420px");
    expect(root.style.getPropertyValue("--font-body")).toContain("\"Inter\"");
    expect(root.style.getPropertyValue("--font-mono")).toContain("\"JetBrains Mono\"");
    expect(root.style.getPropertyValue("--font-size-sm")).toBe("0.6875rem");
    expect(root.style.getPropertyValue("--line-height-normal")).toBe("1.45");
    expect(root.style.getPropertyValue("--chamfer")).toBe("inset(0 round 12px)");
  });

  it("keeps typography scale and layout tokens shared without flattening theme fonts", () => {
    const neonRoot = document.createElement("div");
    const minimalistRoot = document.createElement("div");

    expect(applyCloudxTheme("cloudx-neon", neonRoot)).toBe("cloudx-neon");
    expect(applyCloudxTheme("minimalist-dark", minimalistRoot)).toBe("minimalist-dark");

    expect(neonRoot.style.getPropertyValue("--font-heading")).toContain("\"Orbitron\"");
    expect(minimalistRoot.style.getPropertyValue("--font-heading")).toContain("\"Space Grotesk\"");
    expect(neonRoot.style.getPropertyValue("--font-body")).not.toBe(minimalistRoot.style.getPropertyValue("--font-body"));
    for (const token of ["--font-size-xs", "--font-size-md", "--line-height-compact", "--plugin-panel-dock-button-size", "--plugin-panel-dock-menu-gap", "--notification-count-size", "--notification-popover-width"]) {
      expect(neonRoot.style.getPropertyValue(token)).toBe(minimalistRoot.style.getPropertyValue(token));
    }
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
