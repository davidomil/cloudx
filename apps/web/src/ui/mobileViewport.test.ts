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
});

function cssBlocksFor(selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(stylesCss.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g")), (match) => match[1]);
}
