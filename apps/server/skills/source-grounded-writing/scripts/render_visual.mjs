#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const executablePath = process.env.SGW_BROWSER_EXECUTABLE || chromium.executablePath();
if (!existsSync(executablePath)) {
  throw new Error(`Installed Chromium is unavailable: ${executablePath}. Set SGW_BROWSER_EXECUTABLE to an installed browser; no download was attempted.`);
}

const [action, input, output] = process.argv.slice(2);
if (action === "browser-path") {
  process.stdout.write(`${executablePath}\n`);
} else if (action === "rasterize" && input && output) {
  const svg = readFileSync(resolve(input)).toString("base64");
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await page.route(/^https?:/, route => route.abort());
    await page.setContent(`<style>body{margin:0;background:white}img{display:block}</style><img src="data:image/svg+xml;base64,${svg}">`);
    const size = await page.locator("img").evaluate(async image => {
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    });
    if (!size.width || !size.height || size.width > 16000 || size.height > 16000) {
      throw new Error(`SVG has unsupported dimensions: ${size.width} x ${size.height}`);
    }
    await page.setViewportSize(size);
    await page.locator("img").screenshot({ path: resolve(output), type: "png" });
  } finally {
    await browser.close();
  }
} else {
  throw new Error("Usage: render_visual.mjs browser-path | rasterize INPUT.svg OUTPUT.png");
}
