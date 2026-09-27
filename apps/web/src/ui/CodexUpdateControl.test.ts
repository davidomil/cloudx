// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexGlobalSettings, CodexReleases, CodexUpdateRequest, CodexUpdateStatus } from "@cloudx/shared";

import { HttpError } from "../api.js";
import { CodexSettingsPanel } from "./CodexSettingsPanel.js";
import { CodexSettingsEditor } from "./CodexSettingsEditor.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

const installed: CodexUpdateStatus = {
  jobId: null, phase: "idle", installedVersion: "1.0.0", activeVersion: "1.0.0", requestedVersion: null, previousVerifiedVersion: "0.9.0", outcome: null,
  message: "Ready to update Codex.", startedAt: null, finishedAt: null
};
const updating: CodexUpdateStatus = {
  ...installed, jobId: "update-job", phase: "updating", installedVersion: null, requestedVersion: "1.1.0", message: "Installing the latest Codex release…", startedAt: "2026-09-22T00:00:00.000Z"
};
const succeeded: CodexUpdateStatus = {
  ...updating, phase: "succeeded", installedVersion: "1.1.0", activeVersion: "1.1.0", previousVerifiedVersion: "1.0.0", outcome: "updated", message: "Codex updated to 1.1.0.", finishedAt: "2026-09-22T00:00:01.000Z"
};
const releases: CodexReleases = { latestStable: "1.1.0", versions: ["1.2.0-beta.1", "1.1.0", "1.0.0", "0.9.0"] };
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

async function mount(read: () => Promise<CodexUpdateStatus> = async () => installed, start: (request: CodexUpdateRequest) => Promise<CodexUpdateStatus> = async () => updating, strict = false, discover: () => Promise<CodexReleases> = async () => releases, selectLatest = true) {
  const reads = vi.fn(read);
  const starts = vi.fn(start);
  const discoveries = vi.fn(discover);
  const callHook: NonNullable<UiContributionRenderContext["callHook"]> = async <T extends Record<string, unknown>>(hook: string, input: Record<string, unknown> = {}) => {
    if (hook !== "codex-update.start") expect(input).toEqual({});
    if (hook === "codex-update.releases") return { releases: await discoveries() } as unknown as T;
    if (hook === "codex-settings.read") return { settings } as unknown as T;
    if (hook === "codex-update.read") return { update: await reads() } as unknown as T;
    if (hook === "codex-update.start") return { update: await starts(input as unknown as CodexUpdateRequest) } as unknown as T;
    throw new Error(`Unexpected hook ${hook}`);
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const editor = new CodexSettingsEditor();
  const panel = createElement(CodexSettingsPanel, { editor, callHook });
  const render = () => root.render(strict ? createElement(StrictMode, {}, panel) : panel);
  await act(async () => render());
  const button = (name: string) => [...container.querySelectorAll("button")].find(button => button.textContent?.trim().startsWith(name))!;
  if (selectLatest) await act(async () => button("Select latest stable").click());
  return {
    container, editor, reads, starts, discoveries, button,
    version: () => container.querySelector<HTMLInputElement>('[aria-label="Search releases or enter an exact version"]')!,
    published: () => container.querySelector<HTMLSelectElement>('[aria-label="Published releases"]')!,
    updateButton: () => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Apply selected version")!,
    model: () => container.querySelector<HTMLInputElement>('[aria-label="Default model"]')!,
    close: async () => { await act(async () => root.render(null)); },
    open: async () => { await act(async () => render()); }
  };
}
async function enterVersion(panel: Awaited<ReturnType<typeof mount>>, version: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(panel.version(), version);
    panel.version().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function chooseRelease(panel: Awaited<ReturnType<typeof mount>>, version: string) {
  await act(async () => {
    panel.published().value = version;
    panel.published().dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function poll() { await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); }

describe("Codex CLI update in Settings", () => {
  it("discovers releases without selecting a prerelease or starting an update", async () => {
    const panel = await mount(undefined, undefined, false, undefined, false);
    expect(panel.version().value).toBe("");
    expect(panel.published().textContent).toContain("1.2.0-beta.1 — Prerelease");
    expect(panel.updateButton().disabled).toBe(true);
    await act(async () => panel.button("Select latest stable").click());
    expect(panel.version().value).toBe("1.1.0");
    expect(panel.container.textContent).toContain("Confirm selection: 1.0.0 → 1.1.0");
    expect(panel.starts).not.toHaveBeenCalled();
    await act(async () => panel.updateButton().click());
    expect(panel.starts).toHaveBeenCalledExactlyOnceWith({ targetVersion: "1.1.0" });
  });

  it("searches published releases and requires explicit prerelease selection", async () => {
    const panel = await mount(undefined, undefined, false, undefined, false);
    await enterVersion(panel, "beta");
    expect([...panel.published().options].map(option => option.value)).toEqual(["", "1.2.0-beta.1"]);
    expect(panel.updateButton().disabled).toBe(true);
    await chooseRelease(panel, "1.2.0-beta.1");
    expect(panel.container.textContent).toContain("Confirm selection: 1.0.0 → 1.2.0-beta.1 (Prerelease)");
    expect(panel.container.textContent).toContain("You selected a prerelease");
    expect(panel.starts).not.toHaveBeenCalled();
    await act(async () => panel.updateButton().click());
    expect(panel.starts).toHaveBeenCalledExactlyOnceWith({ targetVersion: "1.2.0-beta.1" });
  });

  it.each(["^1.0.0", "latest", "@openai/codex@1.1.0", "https://example.com/codex", "1.1.0; echo bad", "9.9.9"])("does not apply invalid or unpublished exact input %s", async version => {
    const panel = await mount();
    await enterVersion(panel, version);
    expect(panel.updateButton().disabled).toBe(true);
    await act(async () => panel.updateButton().click());
    expect(panel.starts).not.toHaveBeenCalled();
  });

  it("requires acknowledgement before returning to the previous verified version", async () => {
    const panel = await mount();
    await act(async () => panel.button("Return to previous verified").click());
    expect(panel.version().value).toBe("0.9.0");
    expect(panel.container.textContent).toContain("Confirm downgrade: 1.0.0 → 0.9.0");
    expect(panel.container.textContent).toContain("Saved conversations and shared Codex state may use a newer format");
    expect(panel.updateButton().disabled).toBe(true);
    const acknowledge = panel.container.querySelector<HTMLInputElement>('[aria-label="Acknowledge shared state downgrade risk"]')!;
    await act(async () => acknowledge.click());
    expect(panel.updateButton().disabled).toBe(false);
    await act(async () => panel.updateButton().click());
    expect(panel.starts).toHaveBeenCalledExactlyOnceWith({ targetVersion: "0.9.0", acknowledgeDowngrade: true });
  });

  it("requires explicit recovery and downgrade acknowledgement for the exact retained version", async () => {
    const panel = await mount();
    await act(async () => panel.button("Return to previous verified").click());
    const recovery = () => panel.container.querySelector<HTMLInputElement>('[aria-label="Recovery mode"]')!;
    expect(recovery().checked).toBe(false);
    await act(async () => recovery().click());
    expect(panel.container.textContent).toContain("Cross-version compatibility of saved conversations and shared state will not be checked");
    expect(panel.updateButton().disabled).toBe(true);
    await act(async () => panel.container.querySelector<HTMLInputElement>('[aria-label="Acknowledge shared state downgrade risk"]')!.click());
    expect(panel.updateButton().disabled).toBe(false);
    await act(async () => panel.updateButton().click());
    expect(panel.starts).toHaveBeenCalledExactlyOnceWith({ targetVersion: "0.9.0", acknowledgeDowngrade: true, recoveryMode: true });
  });

  it("resets recovery consent when the target or active version changes", async () => {
    let status = installed;
    const panel = await mount(async () => status);
    const recovery = () => panel.container.querySelector<HTMLInputElement>('[aria-label="Recovery mode"]')!;
    await act(async () => recovery().click());
    await enterVersion(panel, "1.2.0-beta.1");
    expect(recovery().checked).toBe(false);
    await act(async () => recovery().click());
    status = { ...installed, activeVersion: "1.1.0" };
    await poll();
    expect(recovery().checked).toBe(false);
    await act(async () => panel.updateButton().click());
    expect(panel.starts).toHaveBeenCalledExactlyOnceWith({ targetVersion: "1.2.0-beta.1" });
  });

  it("renews downgrade acknowledgement when the active version changes during confirmation", async () => {
    let status = installed;
    const panel = await mount(async () => status);
    await enterVersion(panel, "0.9.0");
    const acknowledge = () => panel.container.querySelector<HTMLInputElement>('[aria-label="Acknowledge shared state downgrade risk"]')!;
    await act(async () => acknowledge().click());
    expect(panel.updateButton().disabled).toBe(false);
    status = { ...installed, activeVersion: "1.1.0" };
    await poll();
    expect(acknowledge().checked).toBe(false);
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.container.textContent).toContain("Confirm downgrade: 1.1.0 → 0.9.0");
  });

  it("shows a current selection and submits the exact version for verification", async () => {
    const panel = await mount();
    await enterVersion(panel, "1.0.0");
    expect(panel.container.textContent).toContain("Codex 1.0.0 is already selected for new launches");
    await act(async () => panel.updateButton().click());
    expect(panel.starts).toHaveBeenCalledExactlyOnceWith({ targetVersion: "1.0.0" });
  });

  it("reports an already active verified selection without claiming another switch", async () => {
    const panel = await mount(async () => succeeded);
    expect(panel.container.textContent).toContain("Codex 1.1.0 is already selected and verified.");
    expect(panel.starts).not.toHaveBeenCalled();
  });

  it("keeps the failed candidate distinct from the active binary after remount", async () => {
    const failed: CodexUpdateStatus = { ...updating, phase: "failed", installedVersion: "1.1.0", message: "Candidate verification failed; active Codex preserved.", finishedAt: "2026-09-22T00:00:01.000Z" };
    const panel = await mount(async () => failed);
    await panel.close();
    await panel.open();
    expect(panel.container.textContent).toContain("Active for new tabs and Forge workers: 1.0.0");
    expect(panel.container.textContent).toContain("Requested version: 1.1.0");
    expect(panel.container.textContent).toContain("Installed candidate: 1.1.0");
    expect(panel.container.textContent).toContain(failed.message);
    expect(panel.starts).not.toHaveBeenCalled();
  });

  it("surfaces registry failure and reloads only on request without replacing the selected target", async () => {
    let published = false;
    const panel = await mount(undefined, undefined, false, async () => {
      if (!published) throw new Error("secret registry credentials");
      return releases;
    });
    await enterVersion(panel, "1.0.0");
    expect(panel.container.textContent).toContain("Cannot load published Codex releases");
    expect(panel.container.textContent).not.toContain("secret registry credentials");
    expect(panel.updateButton().disabled).toBe(true);
    await poll();
    expect(panel.discoveries).toHaveBeenCalledTimes(1);
    published = true;
    await act(async () => panel.button("Reload releases").click());
    expect(panel.discoveries).toHaveBeenCalledTimes(2);
    expect(panel.version().value).toBe("1.0.0");
    expect(panel.updateButton().disabled).toBe(false);
    expect(panel.starts).not.toHaveBeenCalled();
  });

  it("preserves an explicit target when a refreshed latest release changes", async () => {
    let published = releases;
    const panel = await mount(undefined, undefined, false, async () => published);
    published = { latestStable: "1.2.0", versions: ["1.2.0", ...releases.versions] };
    await act(async () => panel.button("Reload releases").click());
    expect(panel.version().value).toBe("1.1.0");
    await act(async () => panel.updateButton().click());
    expect(panel.starts).toHaveBeenCalledExactlyOnceWith({ targetVersion: "1.1.0" });
  });

  it("ignores a late release response after remount", async () => {
    const stale = deferred<CodexReleases>();
    let calls = 0;
    const panel = await mount(undefined, undefined, false, () => ++calls === 1 ? stale.promise : Promise.resolve(releases), false);
    await panel.close();
    await panel.open();
    await act(async () => stale.resolve({ latestStable: "9.0.0", versions: ["9.0.0"] }));
    expect(panel.button("Select latest stable").textContent).toContain("1.1.0");
    expect(panel.published().textContent).not.toContain("9.0.0");
  });

  it("waits for the active version before allowing a selected version to be applied", async () => {
    const read = deferred<CodexUpdateStatus>();
    const panel = await mount(() => read.promise);
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.container.textContent).toContain("Active for new tabs and Forge workers: Checking…");
    expect(panel.starts).not.toHaveBeenCalled();
    await act(async () => read.resolve(installed));
    expect(panel.container.textContent).toContain("Active for new tabs and Forge workers: 1.0.0");
    expect(panel.updateButton().disabled).toBe(false);
    expect(panel.container.textContent).toContain("New tabs and Forge workers use the selected version");
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
    expect(panel.container.textContent).toContain("Active for new tabs and Forge workers: 1.1.0");
    expect(panel.updateButton().disabled).toBe(false);
    expect(panel.model().value).toBe("unsaved-model");
    expect(panel.editor.canSave).toBe(true);
  });

  it("shows already-current and failed results with the usable version", async () => {
    let status: CodexUpdateStatus = { ...succeeded, installedVersion: "1.0.0", activeVersion: "1.0.0", outcome: "current", message: "Codex 1.0.0 is already current." };
    const panel = await mount(async () => status);
    expect(panel.container.textContent).toContain("already current");
    status = { ...succeeded, phase: "failed", installedVersion: "1.0.0", activeVersion: "1.0.0", outcome: null, message: "Codex installation failed. Check npm network access and try again." };
    await poll();
    expect(panel.container.textContent).toContain("Check npm network access");
    expect(panel.container.textContent).toContain("Active for new tabs and Forge workers: 1.0.0");
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

  it("explains a concurrent version change and reconciles to its actual target", async () => {
    let status = installed;
    const panel = await mount(async () => status, async () => {
      status = { ...updating, requestedVersion: "1.2.0-beta.1" };
      throw new HttpError(409, "Another operation is running");
    });
    await act(async () => panel.updateButton().click());
    expect(panel.container.textContent).toContain("Another Codex version change is already running");
    await poll();
    expect(panel.container.textContent).toContain("Requested version: 1.2.0-beta.1");
    expect(panel.container.textContent).toContain("Active for new tabs and Forge workers: 1.0.0");
    expect(panel.updateButton().disabled).toBe(true);
    expect(panel.starts).toHaveBeenCalledExactlyOnceWith({ targetVersion: "1.1.0" });
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
    expect(panel.container.textContent).toContain("Active for new tabs and Forge workers: 1.0.0");
    expect(panel.container.textContent).not.toContain(message);
    expect(panel.updateButton().disabled).toBe(false);
    expect(panel.starts).not.toHaveBeenCalled();
    connected = false;
    await poll();
    expect(panel.container.textContent).toContain("Cannot read Codex update status");
    expect(panel.container.textContent).not.toContain(message);
  });

  it.each([
    "Saved Codex update status could not be read. Check the local codex-update/status.json file before updating.",
    "Saved Codex selection is invalid or unreadable. Repair .cloudx-codex-selection.json in the configured npm prefix before selecting or launching Codex.",
  ])("disables updates after a safe read refusal while retaining the last known active version: %s", async message => {
    const panel = await mount();
    panel.reads.mockRejectedValue(new HttpError(500, message));
    await poll();
    expect(panel.container.textContent).toContain(message);
    expect(panel.container.textContent).toContain("Active for new tabs and Forge workers: 1.0.0");
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
