// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexConfigRepairPreview } from "@cloudx/shared";

import { HttpError } from "../api.js";
import { CodexConfigRepairControl } from "./CodexConfigRepairControl.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()); });
  document.body.replaceChildren();
});

const preview: CodexConfigRepairPreview = {
  revision: "a".repeat(64), sourceConfigPath: "/shared/codex/config.toml",
  selectedCommand: "/retained/codex/0.160.0/codex", selectedVersion: "0.160.0",
  changes: ["Remove features.ghost_commit.", "Remove features.streamable_shell.", "Move hide_full_access_warning to notice.hide_full_access_warning."],
  canApply: true, blockedReason: null
};
const repaired = { ...preview, revision: "b".repeat(64), changes: [], canApply: false };
type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function mount(read: () => Promise<unknown> = async () => preview, apply: (revision: string) => Promise<unknown> = async () => repaired, strict = false) {
  const reads = vi.fn(read);
  const applies = vi.fn(apply);
  const callHook: CallHook = async <T extends Record<string, unknown>>(hook: string, input: Record<string, unknown> = {}) => {
    if (hook === "codex-config-repair.read") {
      expect(input).toEqual({});
      return { repair: await reads() } as unknown as T;
    }
    expect(hook).toBe("codex-config-repair.apply");
    expect(Object.keys(input)).toEqual(["expectedRevision"]);
    return { repair: await applies(input.expectedRevision as string) } as unknown as T;
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const control = createElement(CodexConfigRepairControl, { callHook });
  await act(async () => { root.render(strict ? createElement(StrictMode, {}, control) : control); });
  const button = (label: string) => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === label)!;
  const click = async (label: string) => { await act(async () => button(label).click()); };
  return { container, root, reads, applies, button, click };
}

describe("shared Codex config repair", () => {
  it("reviews the exact edits and selected executable before explicitly applying the reviewed revision", async () => {
    const control = await mount();
    expect(control.container.textContent).toContain(preview.sourceConfigPath);
    expect(control.container.textContent).toContain(preview.selectedCommand);
    expect(control.container.textContent).toContain("Selected CLI version: 0.160.0");
    expect([...control.container.querySelectorAll("li")].map(item => item.textContent)).toEqual(preview.changes);
    expect(control.container.textContent).toContain("new and restored tabs");
    expect(control.container.textContent).toContain("Running sessions keep their current configuration.");
    expect(control.applies).not.toHaveBeenCalled();
    expect(control.button("Repair shared config").disabled).toBe(false);
    await control.click("Repair shared config");
    expect(control.applies).toHaveBeenCalledExactlyOnceWith(preview.revision);
    expect(control.container.textContent).toContain("Shared Codex configuration repaired.");
    expect(control.container.querySelectorAll("li")).toHaveLength(0);
    expect(control.button("Repair shared config").disabled).toBe(true);
  });

  it("keeps a clean preview compact and allows an explicit reload after changing the selected CLI", async () => {
    const control = await mount(async () => repaired);
    expect(control.container.textContent).not.toContain(preview.sourceConfigPath);
    expect(control.container.textContent).not.toContain(preview.selectedCommand);
    expect(control.button("Repair shared config").disabled).toBe(true);
    control.reads.mockResolvedValue({ ...preview, selectedCommand: "/pinned/codex", selectedVersion: "0.160.1" });
    await control.click("Reload configuration");
    expect(control.reads).toHaveBeenCalledTimes(2);
    expect(control.container.textContent).toContain("/pinned/codex");
    expect(control.container.textContent).toContain("Selected CLI version: 0.160.1");
    expect(control.applies).not.toHaveBeenCalled();
  });

  it("shows a blocked repair without allowing an apply", async () => {
    const control = await mount(async () => ({ ...preview, canApply: false, blockedReason: "This selected CLI supports the legacy feature keys." }));
    expect(control.container.textContent).toContain("This selected CLI supports the legacy feature keys.");
    expect([...control.container.querySelectorAll("li")].map(item => item.textContent)).toEqual(preview.changes);
    expect(control.button("Repair shared config").disabled).toBe(true);
    await control.click("Repair shared config");
    expect(control.applies).not.toHaveBeenCalled();
  });

  it("identifies the selected source and executable when compatibility blocks the preview", async () => {
    const control = await mount(async () => ({ ...preview, changes: [], canApply: false, blockedReason: "The selected CLI schema could not be verified." }));
    expect(control.container.textContent).toContain(preview.sourceConfigPath);
    expect(control.container.textContent).toContain(preview.selectedCommand);
    expect(control.container.textContent).toContain("The selected CLI schema could not be verified.");
    expect(control.container.textContent).not.toContain("No supported configuration repairs are needed");
    expect(control.button("Repair shared config").disabled).toBe(true);
  });

  it("waits for the initial preview and prevents duplicate reloads", async () => {
    const pending = deferred<CodexConfigRepairPreview>();
    const control = await mount(() => pending.promise);
    expect(control.container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    expect(control.button("Repair shared config").disabled).toBe(true);
    expect(control.button("Reload configuration").disabled).toBe(true);
    await control.click("Reload configuration");
    expect(control.reads).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(preview); });
    expect(control.button("Repair shared config").disabled).toBe(false);
  });

  it("sends one apply while duplicate clicks arrive before the next render", async () => {
    const pending = deferred<CodexConfigRepairPreview>();
    const control = await mount(undefined, () => pending.promise);
    await act(async () => { control.button("Repair shared config").click(); control.button("Repair shared config").click(); });
    expect(control.applies).toHaveBeenCalledExactlyOnceWith(preview.revision);
    expect(control.button("Repair shared config").disabled).toBe(true);
    expect(control.button("Reload configuration").disabled).toBe(true);
    expect(control.container.textContent).toContain("Repairing shared Codex configuration…");
    await act(async () => { pending.resolve(repaired); });
    expect(control.button("Reload configuration").disabled).toBe(false);
  });

  it("requires a fresh review after a stale revision rather than retrying the old apply", async () => {
    const control = await mount(undefined, async () => { throw new HttpError(409, "secret config content"); });
    await control.click("Repair shared config");
    expect(control.container.querySelector('[role="alert"]')?.textContent).toContain("changed");
    expect(control.container.textContent).toContain("Reload configuration");
    expect(control.container.textContent).not.toContain("secret config content");
    expect(control.button("Repair shared config").disabled).toBe(true);
    await control.click("Repair shared config");
    expect(control.applies).toHaveBeenCalledTimes(1);
    control.reads.mockResolvedValue({ ...preview, revision: "c".repeat(64) });
    control.applies.mockResolvedValue(repaired);
    await control.click("Reload configuration");
    expect(control.container.querySelector('[role="alert"]')).toBeNull();
    await control.click("Repair shared config");
    expect(control.applies).toHaveBeenLastCalledWith("c".repeat(64));
  });

  it("blocks another apply after an unknown failure and keeps raw configuration out of the error", async () => {
    const control = await mount(undefined, async () => { throw new Error("token = private-value"); });
    await control.click("Repair shared config");
    expect(control.container.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm");
    expect(control.container.textContent).not.toContain("private-value");
    expect(control.button("Repair shared config").disabled).toBe(true);
    await control.click("Reload configuration");
    expect(control.button("Repair shared config").disabled).toBe(false);
  });

  it.each([async () => { throw new Error("private source TOML"); }, async () => ({ ...preview, changes: "private source TOML" })])("shows a safe preview error and recovers only on reload", async read => {
    const control = await mount(read);
    expect(control.container.querySelector('[role="alert"]')?.textContent).toContain("Cannot read shared Codex configuration");
    expect(control.container.textContent).not.toContain("private source TOML");
    expect(control.button("Repair shared config").disabled).toBe(true);
    control.reads.mockResolvedValue(preview);
    await control.click("Reload configuration");
    expect(control.button("Repair shared config").disabled).toBe(false);
  });

  it("ignores a stale initial preview after Strict Mode starts the current read", async () => {
    const first = deferred<CodexConfigRepairPreview>();
    let reads = 0;
    const control = await mount(() => ++reads === 1 ? first.promise : Promise.resolve({ ...preview, revision: "d".repeat(64), selectedVersion: "0.160.1" }), undefined, true);
    await act(async () => { first.resolve(preview); });
    expect(control.container.textContent).toContain("Selected CLI version: 0.160.1");
    expect(control.container.textContent).not.toContain("Selected CLI version: 0.160.0");
    await control.click("Repair shared config");
    expect(control.applies).toHaveBeenCalledExactlyOnceWith("d".repeat(64));
  });

  it("does not restore a late apply result after the control unmounts", async () => {
    const pending = deferred<CodexConfigRepairPreview>();
    const control = await mount(undefined, () => pending.promise);
    await control.click("Repair shared config");
    await act(async () => { control.root.unmount(); });
    roots.splice(roots.indexOf(control.root), 1);
    await act(async () => { pending.resolve(repaired); });
    expect(control.container.childElementCount).toBe(0);
  });
});
