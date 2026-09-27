import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { pasteConversationPrompt } from "./profile.mjs";

const require = createRequire(import.meta.url);

it("pastes the lifecycle prompt through xterm before sending exactly one submit key", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="workspace-pane active"></div>');
    await page.addScriptTag({ path: require.resolve("@xterm/xterm") });
    await page.addStyleTag({
      path: require.resolve("@xterm/xterm/css/xterm.css"),
    });
    await page.evaluate(async () => {
      const terminal = new window.Terminal();
      terminal.open(document.querySelector(".workspace-pane.active"));
      window.terminalInput = [];
      terminal.onData((data) => window.terminalInput.push(data));
      // The real Codex TUI enables bracketed paste on startup.
      await new Promise((resolve) => terminal.write("\u001b[?2004h", resolve));
    });

    const prompt =
      "Save this synthetic CloudX lifecycle conversation. Do not call tools.";
    await pasteConversationPrompt(page, prompt);

    expect(await page.evaluate(() => window.terminalInput)).toEqual([
      `\u001b[200~${prompt}\u001b[201~`,
      "\r",
    ]);
  } finally {
    await browser.close();
  }
});
