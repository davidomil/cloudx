/// <reference types="node" />

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import indexHtml from "../../index.html?raw";

const stylesCss = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("mobile viewport stability", () => {
  it("keeps browser keyboard changes from resizing the layout viewport", () => {
    expect(indexHtml).toContain("interactive-widget=resizes-visual");
  });

  it("uses a stable mobile app shell height instead of dynamic viewport height", () => {
    const mobileShellBlock = cssBlocksFor(".app-shell").find((block) => block.includes("100svh"));

    expect(mobileShellBlock).toContain("height: 100vh;");
    expect(mobileShellBlock).toContain("height: 100svh;");
    expect(mobileShellBlock).not.toContain("100dvh");
  });

  it("keeps terminal spacing on the xterm element that FitAddon measures", () => {
    expect(cssBlocksFor(".terminal-panel").some((block) => block.includes("padding:"))).toBe(false);
    expect(cssBlocksFor(".terminal-panel .xterm").some((block) => block.includes("padding: 17px 8px 8px;"))).toBe(true);
  });

  it("keeps terminal glyph selection aligned to xterm's measured cell grid", () => {
    expect(cssBlocksFor(".terminal-panel .xterm").some((block) => block.includes("letter-spacing: 0;"))).toBe(true);
  });

  it("keeps automation toolbar controls reachable before status text in compact panes", () => {
    expect(cssBlocksFor(".automation-toolbar").some((block) => block.includes("overflow-x: auto;"))).toBe(true);
    expect(stylesCss).toContain(".automation-toolbar > .cx-button,\n.automation-toolbar > .automation-save-state");
    expect(cssBlocksFor(".automation-status").some((block) => block.includes("max-width: 220px;"))).toBe(true);
    expect(cssBlocksFor(".automation-status").some((block) => block.includes("display: none;"))).toBe(true);
  });

  it("keeps plugin panel docks layout-neutral until pane-local compact breakpoints", () => {
    const rootTokens = cssBlocksFor(":root")[0] ?? "";
    expect(rootTokens).toContain("--plugin-panel-dock-button-size: 44px;");
    expect(rootTokens).toContain("--plugin-panel-dock-menu-gap: 4px;");
    expect(rootTokens).toContain("--plugin-panel-dock-hover-bridge: 12px;");
    expect(rootTokens).toContain("--plugin-panel-dock-panel-width: 360px;");
    expect(rootTokens).toContain("--plugin-panel-dock-panel-height: 580px;");
    expect(rootTokens).toContain("--notification-count-size: 17px;");
    expect(rootTokens).toContain("--notification-popover-width: 420px;");
    expect(stylesCss).toContain(".plugin-panel-dock,\n.plugin-panel-dock-item,\n.plugin-panel-dock-panel {\n  display: contents;");
    expect(stylesCss).toContain("@container plugin-pane (width <= 1180px)");
    expect(stylesCss).toContain("@container plugin-pane (width <= 960px)");
    expect(stylesCss).toContain("@container plugin-pane (width <= 760px)");
    expect(cssBlocksFor(".plugin-panel-dock .plugin-panel-dock-button").some((block) => block.includes("display: none;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.controls-always .plugin-panel-dock-button").some((block) => block.includes("position: absolute;") && block.includes("right: calc(") && block.includes("left: auto;") && block.includes("display: inline-flex;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.controls-compact-or-hidden .plugin-panel-dock-item.hidden .plugin-panel-dock-button").some((block) => block.includes("position: absolute;") && block.includes("display: inline-flex;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.compact-narrow").some((block) => block.includes("right: var(--plugin-panel-dock-right, 8px);") && block.includes("left: auto;") && block.includes("justify-content: flex-end;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.compact-narrow .plugin-panel-dock-item::before").some((block) => block.includes("height: var(--plugin-panel-dock-hover-bridge);") && block.includes("pointer-events: auto;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.compact-medium .plugin-panel-dock-item::before").some((block) => block.includes("height: var(--plugin-panel-dock-hover-bridge);") && block.includes("pointer-events: auto;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.compact-wide .plugin-panel-dock-item::before").some((block) => block.includes("height: var(--plugin-panel-dock-hover-bridge);") && block.includes("pointer-events: auto;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.compact-narrow .plugin-panel-dock-button").some((block) => block.includes("display: inline-flex;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.compact-narrow.controls-compact-or-hidden .plugin-panel-dock-item.hidden .plugin-panel-dock-button").some((block) => block.includes("position: static;") && block.includes("opacity: 1;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.compact-medium .plugin-panel-dock-panel").some((block) => block.includes("position: absolute;") && block.includes("top: calc(100% + var(--plugin-panel-dock-menu-gap));") && block.includes("display: none;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.compact-wide .plugin-panel-dock-panel").some((block) => block.includes("position: absolute;") && block.includes("top: calc(100% + var(--plugin-panel-dock-menu-gap));") && block.includes("display: none;"))).toBe(true);
    expect(["compact-wide", "compact-medium", "compact-narrow"].every((mode) =>
      cssBlocksFor(`.plugin-panel-dock.${mode} .plugin-panel-dock-panel`).some((block) =>
        block.includes("background: var(--surface-popover-background);") &&
        block.includes("border: 1px solid var(--surface-popover-border);") &&
        block.includes("box-shadow: var(--surface-popover-shadow);")
      )
    )).toBe(true);
    expect(["compact-wide", "compact-medium", "compact-narrow"].every((mode) =>
      cssBlocksFor(`.plugin-panel-dock.${mode} .plugin-panel-dock-button`).some((block) => block.includes("box-shadow: var(--surface-dock-button-shadow);"))
    )).toBe(true);
    expect(cssBlocksFor(".notification-center-popover").some((block) =>
      block.includes("background: var(--surface-popover-background);") &&
      block.includes("border: 1px solid var(--surface-popover-border);") &&
      block.includes("box-shadow: var(--surface-popover-shadow);") &&
      block.includes("width: min(var(--notification-popover-width), calc(100vw - var(--notification-popover-viewport-margin)));") &&
      block.includes("max-height: min(var(--notification-popover-max-height), calc(100dvh - var(--notification-popover-viewport-reserve)));")
    )).toBe(true);
    expect(cssBlocksFor(".file-tree-resize-handle").some((block) =>
      block.includes("background: var(--resize-handle-background);") &&
      block.includes("border-bottom: 1px solid var(--resize-handle-border);")
    )).toBe(true);
    expect(cssBlocksFor(".file-secondary-dock").some((block) => block.includes("--plugin-panel-dock-top: 61px;"))).toBe(true);
    expect(cssBlocksFor(".git-diff-files-dock").some((block) => block.includes("--plugin-panel-dock-top: calc(0px - var(--plugin-panel-dock-button-size));") && block.includes("--plugin-panel-dock-right: 36px;"))).toBe(true);
    expect(cssBlocksFor(".file-preview").some((block) => block.includes("--file-preview-padding: 14px;") && block.includes("padding: var(--file-preview-padding);"))).toBe(true);
    expect(cssBlocksFor(".worktree-controls-dock").some((block) => block.includes("--plugin-panel-dock-right: 60px;"))).toBe(true);
    expect(cssBlocksFor(".worktree-ref-dock").some((block) => block.includes("--plugin-panel-dock-top: -2px;") && block.includes("--plugin-panel-dock-right: 8px;"))).toBe(true);
    expect(cssBlocksFor(".jira-issues-dock").some((block) => block.includes("--plugin-panel-dock-panel-width: 360px;"))).toBe(true);
    expect(cssBlocksFor(".jira-panel-header-actions > .plugin-panel-dock.compact-narrow.jira-issues-dock").some((block) => block.includes("position: relative;") && block.includes("display: flex;"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.compact-narrow.file-secondary-dock,\n  .plugin-panel-dock.compact-narrow.file-tree-dock,\n  .plugin-panel-dock.compact-narrow.git-diff-files-dock").some((block) => block.includes("width: var(--plugin-panel-dock-button-size);"))).toBe(true);
    expect(cssBlocksFor(".plugin-panel-dock.compact-narrow.git-diff-files-dock").some((block) => block.includes("right: calc(0px - var(--file-preview-padding, 14px));"))).toBe(true);
    expect(cssBlocksFor(".git-diff-workspace:has(.git-diff-files-dock.compact-narrow)").some((block) => block.includes("overflow: visible;"))).toBe(true);
    expect(stylesCss).toContain("flex-direction: column;");
    expect(stylesCss).toContain("pointer-events: auto;");
    expect(stylesCss).toContain(".plugin-panel-dock.compact-narrow.file-secondary-dock::before");
    expect(stylesCss).toContain(".file-browser-panel:has(.file-secondary-dock:hover)");
    expect(stylesCss).toContain("transform: translateX(var(--plugin-panel-dock-button-size));");
    expect(stylesCss).toContain("transform: translateX(0);");
  });

  it("gives compact plugin panes to their main surfaces instead of stacking secondary panels", () => {
    expect(cssBlocksFor(".automation-panel").some((block) => block.includes("grid-template-columns: minmax(0, 1fr);") && block.includes("grid-template-rows: minmax(0, 1fr);"))).toBe(true);
    expect(cssBlocksFor(".documentation-grid").some((block) => block.includes("grid-template-columns: minmax(0, 1fr);") && block.includes("grid-template-rows: minmax(0, 1fr);"))).toBe(true);
    expect(stylesCss).toContain(".jira-panel-body,\n  .file-browser-body,\n  .git-diff-workspace,\n  .worktree-manager-body,\n  .worktree-content-grid,\n  .rules-skills-panel");
    expect(stylesCss).toContain(".jira-detail,\n  .file-preview,\n  .git-diff-preview,\n  .worktree-content-grid,\n  .worktree-list,\n  .rules-skills-editor");
    expect(stylesCss).toContain(".plugin-panel-dock-panel > .file-search-bar");
    expect(stylesCss).toContain(".plugin-panel-dock-panel > .git-bar");
  });
});

function cssBlocksFor(selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(stylesCss.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g")), (match) => match[1]);
}
