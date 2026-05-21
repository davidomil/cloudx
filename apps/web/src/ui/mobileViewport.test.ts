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
});

function cssBlocksFor(selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(stylesCss.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g")), (match) => match[1]);
}
