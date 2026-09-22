// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexGlobalSettings, CodexUpdateStatus } from "@cloudx/shared";

import { HttpError } from "../api.js";
import { CodexSettingsPanel } from "./CodexSettingsPanel.js";
import { CodexSettingsEditor } from "./CodexSettingsEditor.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

const installed: CodexUpdateStatus = {
  jobId: null, phase: "idle", installedVersion: "1.0.0", outcome: null,
  message: "Ready to update Codex.", startedAt: null, finishedAt: null
};
const updating: CodexUpdateStatus = {
  ...installed, jobId: "update-job", phase: "updating", message: "Installing the latest Codex release…", startedAt: "2026-09-22T00:00:00.000Z"
};
const succeeded: CodexUpdateStatus = {
  ...updating, phase: "succeeded", installedVersion: "1.1.0", outcome: "updated", message: "Codex updated to 1.1.0.", finishedAt: "2026-09-22T00:00:01.000Z"
};
const settings: CodexGlobalSettings = {
  revision: "first", model: "saved-model", serviceTier: null, fastModeEnabled: true,
  yoloMode: true, autoTrustWorkspace: false, defaultSkills: [], reasoningEffort: null, webSearch: null, personality: null
};
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function mount(read: () => Promise<CodexUpdateStatus> = async () => installed, start: () => Promise<CodexUpdateStatus> = async () => updating, strict = false) {
  const reads = vi.fn(read);
  const starts = vi.fn(start);
  const callHook: NonNullable<UiContributionRenderContext["callHook"]> = async <T extends Record<string, unknown>>(hook: string, input: Record<string, unknown> = {}) => {
    expect(input).toEqual({});
    if (hook === "codex-settings.read") return { settings } as unknown as T;
    if (hook === "codex-update.read") return { update: await reads() } as unknown as T;
    if (hook === "codex-update.start") return { update: await starts() } as unknown as T;
    throw new Error(`Unexpected hook ${hook}`);
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const editor = new CodexSettingsEditor();
  const panel = createElement(CodexSettingsPanel, { editor, callHook });
  const render = () => root.render(strict ? createElement(StrictMode, {}, panel) : panel);
  await act(async () => render());
  return {
    container, editor, reads, starts,
    updateButton: () => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Update Codex")!,
    model: () => container.querySelector<HTMLInputElement>('[aria-label="Default model"]')!,
    close: async () => { await act(async () => root.render(null)); },
    open: async () => { await act(async () => render()); }
  };
}
async function poll() { await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); }

describe("Codex CLI update in Settings", () => {
  it("waits for the installed version before allowing a one-click update", async () => {
    const read = deferred<CodexUpdateStatus>();
    const panel = await mount(() => read.promise);
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.container.textContent).toContain("Installed version: Checking…");
    expect(panel.starts).not.toHaveBeenCalled();
    await act(async () => read.resolve(installed));
    expect(panel.container.textContent).toContain("Installed version: 1.0.0");
    expect(panel.updateButton().disabled).toBe(false);
    expect(panel.container.textContent).toContain("Newly launched Codex processes use the updated version");
  });

  it("shows update progress and the verified version while preserving unsaved edits", async () => {
    let status = installed;
    const start = deferred<CodexUpdateStatus>();
    const panel = await mount(async () => status, () => start.promise, true);
    await act(async () => panel.editor.setModel("unsaved-model"));
    await act(async () => { panel.updateButton().click(); panel.updateButton().click(); });
    expect(panel.starts).toHaveBeenCalledTimes(1);
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.model().disabled).toBe(false);
    await act(async () => start.resolve(status = { ...updating, phase: "checking", message: "Checking the installed Codex version…" }));
    expect(panel.container.textContent).toContain("Checking the installed Codex version");
    status = updating;
    await poll();
    expect(panel.container.textContent).toContain("Installing the latest Codex release");
    status = { ...updating, phase: "verifying", message: "Verifying the updated Codex executable…" };
    await poll();
    expect(panel.container.textContent).toContain("Verifying the updated Codex executable");
    expect(panel.updateButton().disabled).toBe(true);
    status = succeeded;
    await poll();
    expect(panel.container.textContent).toContain("Codex updated to 1.1.0.");
    expect(panel.container.textContent).toContain("Installed version: 1.1.0");
    expect(panel.updateButton().disabled).toBe(false);
    expect(panel.model().value).toBe("unsaved-model");
    expect(panel.editor.canSave).toBe(true);
  });

  it("shows already-current and failed results with the usable version", async () => {
    let status: CodexUpdateStatus = { ...succeeded, installedVersion: "1.0.0", outcome: "current", message: "Codex 1.0.0 is already current." };
    const panel = await mount(async () => status);
    expect(panel.container.textContent).toContain("already current");
    status = { ...succeeded, phase: "failed", installedVersion: "1.0.0", outcome: null, message: "Codex installation failed. Check npm network access and try again." };
    await poll();
    expect(panel.container.textContent).toContain("Check npm network access");
    expect(panel.container.textContent).toContain("Installed version: 1.0.0");
    expect(panel.container.textContent).not.toContain("Codex updated to");
    expect(panel.updateButton().disabled).toBe(false);
  });

  it.each([new Error("secret private npm log"), new HttpError(500, "secret private npm log")])("reconciles an indeterminate start without retrying the update or exposing private errors (%s)", async error => {
    let status = installed;
    const panel = await mount(async () => status, async () => { status = updating; throw error; });
    await act(async () => panel.updateButton().click());
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.container.textContent).toContain("Could not confirm the update request");
    expect(panel.container.textContent).not.toContain("secret private npm log");
    await poll();
    expect(panel.container.textContent).toContain(updating.message);
    expect(panel.updateButton().disabled).toBe(true);
    status = succeeded;
    await poll();
    expect(panel.container.textContent).toContain(succeeded.message);
    expect(panel.starts).toHaveBeenCalledTimes(1);
  });

  it("keeps a safe start rejection visible through unchanged idle reads and reconnect until an explicit retry", async () => {
    const message = "Codex update status could not be saved. Check CloudX data directory permissions.";
    let connected = true;
    const panel = await mount(async () => {
      if (!connected) throw new Error("offline");
      return installed;
    }, async () => { throw new HttpError(500, message); });
    await act(async () => panel.editor.setModel("unsaved-model"));
    await act(async () => panel.updateButton().click());
    expect(panel.container.textContent).toContain(message);
    expect(panel.updateButton().disabled).toBe(true);
    await poll();
    await poll();
    expect(panel.container.textContent).toContain(message);
    expect(panel.container.textContent).not.toContain(installed.message);
    expect(panel.updateButton().disabled).toBe(false);
    expect(panel.model().value).toBe("unsaved-model");
    expect(panel.starts).toHaveBeenCalledTimes(1);
    connected = false;
    await poll();
    expect(panel.container.textContent).toContain("Cannot read Codex update status");
    connected = true;
    await poll();
    expect(panel.container.textContent).toContain(message);
    panel.starts.mockResolvedValueOnce(updating);
    await act(async () => panel.updateButton().click());
    expect(panel.container.textContent).toContain(updating.message);
    expect(panel.container.textContent).not.toContain(message);
    expect(panel.starts).toHaveBeenCalledTimes(2);
  });

  it("replaces a retained start rejection when a new server job appears", async () => {
    const message = "Codex update status could not be saved. Check CloudX data directory permissions.";
    let status = installed;
    const panel = await mount(async () => status, async () => { throw new HttpError(500, message); });
    await act(async () => panel.updateButton().click());
    await poll();
    expect(panel.container.textContent).toContain(message);
    status = updating;
    await poll();
    expect(panel.container.textContent).toContain(updating.message);
    expect(panel.container.textContent).not.toContain(message);
    expect(panel.updateButton().disabled).toBe(true);
    status = succeeded;
    await poll();
    expect(panel.container.textContent).toContain(succeeded.message);
    expect(panel.starts).toHaveBeenCalledTimes(1);
  });

  it("recovers status after reconnect without losing the draft or starting another update", async () => {
    let connected = true;
    let status = updating;
    const panel = await mount(async () => {
      if (!connected) throw new Error("offline");
      return status;
    });
    await act(async () => panel.editor.setModel("unsaved-model"));
    connected = false;
    await poll();
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.container.textContent).toContain("Cannot read Codex update status");
    connected = true;
    status = succeeded;
    await poll();
    expect(panel.container.textContent).toContain(succeeded.message);
    expect(panel.model().value).toBe("unsaved-model");
    expect(panel.starts).not.toHaveBeenCalled();
  });

  it.each([
    "Saved Codex update status could not be read. Check the local codex-update/status.json file before updating.",
    "Codex update status could not be saved. Check CloudX data directory permissions.",
  ])("keeps a safe initial read refusal visible through polling and reconnect until status is readable (%s)", async message => {
    let connected = true;
    let readable = false;
    const panel = await mount(async () => {
      if (!connected) throw new Error("offline");
      if (!readable) throw new HttpError(500, message);
      return installed;
    });
    await act(async () => panel.editor.setModel("unsaved-model"));
    expect(panel.container.textContent).toContain(message);
    expect(panel.updateButton().disabled).toBe(true);
    await poll();
    await poll();
    expect(panel.reads).toHaveBeenCalledTimes(3);
    expect(panel.container.textContent).toContain(message);
    connected = false;
    await poll();
    expect(panel.container.textContent).toContain(message);
    expect(panel.container.textContent).not.toContain("offline");
    expect(panel.updateButton().disabled).toBe(true);
    connected = true;
    await poll();
    expect(panel.container.textContent).toContain(message);
    await act(async () => panel.updateButton().click());
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.starts).not.toHaveBeenCalled();
    expect(panel.model().value).toBe("unsaved-model");
    readable = true;
    await poll();
    expect(panel.container.textContent).toContain("Installed version: 1.0.0");
    expect(panel.container.textContent).not.toContain(message);
    expect(panel.updateButton().disabled).toBe(false);
    expect(panel.starts).not.toHaveBeenCalled();
    connected = false;
    await poll();
    expect(panel.container.textContent).toContain("Cannot read Codex update status");
    expect(panel.container.textContent).not.toContain(message);
  });

  it("disables updates after a safe read refusal while retaining the last known installed version", async () => {
    const message = "Saved Codex update status could not be read. Check the local codex-update/status.json file before updating.";
    const panel = await mount();
    panel.reads.mockRejectedValue(new HttpError(500, message));
    await poll();
    expect(panel.container.textContent).toContain(message);
    expect(panel.container.textContent).toContain("Installed version: 1.0.0");
    expect(panel.updateButton().disabled).toBe(true);
    await act(async () => panel.updateButton().click());
    await poll();
    expect(panel.container.textContent).toContain(message);
    expect(panel.starts).not.toHaveBeenCalled();
  });

  it.each([new Error("secret private status path"), new HttpError(500, "secret private status path")])("keeps unknown read failures generic and updates disabled (%s)", async error => {
    const panel = await mount(async () => { throw error; });
    await poll();
    expect(panel.container.textContent).toContain("Cannot read Codex update status");
    expect(panel.container.textContent).not.toContain("secret private status path");
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.starts).not.toHaveBeenCalled();
  });

  it("reads the server job after remount and ignores a late start response from the old panel", async () => {
    let status = installed;
    const response = deferred<CodexUpdateStatus>();
    const panel = await mount(async () => status, () => { status = updating; return response.promise; });
    await act(async () => panel.editor.setModel("unsaved-model"));
    await act(async () => panel.updateButton().click());
    await panel.close();
    const reads = panel.reads.mock.calls.length;
    await poll();
    expect(panel.reads).toHaveBeenCalledTimes(reads);
    await panel.open();
    expect(panel.container.textContent).toContain(updating.message);
    expect(panel.updateButton().disabled).toBe(true);
    status = succeeded;
    await poll();
    await act(async () => response.resolve(updating));
    expect(panel.container.textContent).toContain(succeeded.message);
    expect(panel.model().value).toBe("unsaved-model");
    expect(panel.starts).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale read that arrives after the start response", async () => {
    const stale = deferred<CodexUpdateStatus>();
    let reads = 0;
    const panel = await mount(() => ++reads === 1 ? Promise.resolve(installed) : stale.promise);
    await poll();
    await act(async () => panel.updateButton().click());
    await act(async () => stale.resolve(installed));
    expect(panel.container.textContent).toContain(updating.message);
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.starts).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed server status and keeps update disabled until status is known", async () => {
    const panel = await mount(async () => ({ phase: "succeeded" }) as CodexUpdateStatus);
    expect(panel.container.textContent).toContain("Cannot read Codex update status");
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.starts).not.toHaveBeenCalled();
  });
});
