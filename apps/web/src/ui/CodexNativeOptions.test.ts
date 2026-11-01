// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { CodexGlobalSettings } from "@cloudx/shared";
import { CodexNativeOptions } from "./CodexNativeOptions.js";
import { CodexSettingsEditor } from "./CodexSettingsEditor.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

async function render(version = "0.160.0", blockedReason: string | null = null) {
  const values = { file_opener: "none", web_search: "live", tui: { keymap: { global: { submit: "ctrl-s" }, composer: { submit: [] } } } };
  const settings: CodexGlobalSettings = {
    revision: "saved", model: null, serviceTier: null, fastModeEnabled: null, yoloMode: true, autoTrustWorkspace: false,
    defaultSkills: [], reasoningEffort: null, webSearch: "live", personality: null,
    configuration: { selectedVersion: version, baselineVersion: "0.166.0", selectedCommand: "/bin/codex", sourcePath: "/codex/config.toml", blockedReason, values, effectiveValues: values, overrides: ["CloudX generated skills"], layers: ["Native defaults", "Administrator requirements"] }
  };
  const editor = new CodexSettingsEditor();
  editor.load(async () => ({ settings }) as never);
  await Promise.resolve();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(CodexNativeOptions, { editor })));
  return { container, editor };
}

it("renders fixed, model-dependent, unestablished, managed and inherited keymap values without claiming live-session observation", async () => {
  const { container, editor } = await render();
  expect(container.textContent).toContain('Native 0.160.0 default: "vscode"');
  expect(container.textContent).toContain('Native 0.160.0 default: "cached"');
  expect(container.textContent).toContain("selected model/provider");
  expect(container.textContent).toContain("has not been established by this source review");
  expect(container.textContent).toContain("CloudX selects its registered system skills");
  expect(container.textContent).toContain("Saved composer override (explicitly unbound): []");
  expect(container.textContent).toContain("not observed effective values for an open session");
  expect(container.textContent).toContain("An empty list explicitly unbinds an action");
  expect(container.textContent).toContain("composer handles plain Enter before the editor newline action");
  expect(container.querySelector<HTMLAnchorElement>('a[href*="rust-v0.160.0/codex-rs/core/src/config/mod.rs"]')).not.toBeNull();
  const unset = [...container.querySelectorAll("button")].find(button => button.textContent === "Unset file_opener")!;
  await act(async () => unset.click());
  expect(editor.getSnapshot().nativeDrafts.file_opener).toBe("");
  expect(editor.getSnapshot().settings!.configuration!.values.web_search).toBe("live");
});

it("shows only the selected release's options and labels a blocked baseline as reference data", async () => {
  const { container } = await render("0.162.1");
  expect(container.querySelector('[aria-label="Native include_environment_context_time"]')).toBeNull();
  await act(async () => root.unmount());
  const blocked = await render("0.167.0", "Native editor has no reviewed schema for selected Codex 0.167.0.");
  expect(blocked.container.textContent).toContain("baseline 0.166.0, not the selected executable");
  expect(blocked.container.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
  expect(blocked.container.textContent).not.toContain("Native inherited key bindings");
});
