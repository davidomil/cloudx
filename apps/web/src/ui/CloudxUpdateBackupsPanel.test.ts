// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxUpdateBackup, CloudxUpdateBackupCleanup, CloudxUpdateBackupPreview } from "@cloudx/shared";
import { CloudxUpdateBackupsPanel } from "./CloudxUpdateBackupsPanel.js";
import { CloudxUpdatePanel, type CloudxUpdateController as UpdateController } from "./CloudxUpdatePanel.js";

let root: Root | undefined;
const createdAt = "2026-10-04T03:02:05Z";
const runId = "11111111-1111-4111-8111-111111111111";
const secondRunId = "22222222-2222-4222-8222-222222222222";
const previewId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const first: CloudxUpdateBackup = { id: `${runId}:snapshot`, runId, kind: "snapshot", sourceCommit: "a".repeat(40), targetCommit: "b".repeat(40),
  createdAt, outcome: "succeeded", path: `/updates/${runId}/snapshot`, logicalBytes: 8 * 1024 ** 3, allocatedBytes: 7 * 1024 ** 3, reclaimableBytes: 6 * 1024 ** 3 };
const second: CloudxUpdateBackup = { ...first, id: `${secondRunId}:snapshot`, runId: secondRunId, path: `/updates/${secondRunId}/snapshot`, sourceCommit: "b".repeat(40), targetCommit: "c".repeat(40) };
const protectedRelease: CloudxUpdateBackup = { ...first, id: `${runId}:release`, kind: "release", path: `/updates/${runId}/release`,
  reclaimableBytes: 0, protectionReason: "A surviving terminal broker and Codex session still reference this exact release." };
const preview: CloudxUpdateBackupPreview = { id: previewId, createdAt, backups: [first, second, protectedRelease], reclaimableBytes: 10 * 1024 ** 3,
  estimateNote: "Shared allocation is counted once. Hard links outside the reviewed backups are excluded; actual free space may differ." };
let current: CloudxUpdateBackupCleanup | null;
let inventory: CloudxUpdateBackup[];
let post: (init: RequestInit) => Promise<Response>;
let fetch: ReturnType<typeof vi.fn>;

function cleanup(state: CloudxUpdateBackupCleanup["state"] = "running"): CloudxUpdateBackupCleanup {
  return { id: jobId, state, startedAt: createdAt, ...(state === "running" ? {} : { finishedAt: createdAt }),
    results: preview.backups.map(item => ({ id: item.id, runId: item.runId, path: item.path, status: state === "running" ? "pending" : item.protectionReason ? "protected" : "deleted", reason: item.protectionReason,
      deletedLogicalBytes: state !== "running" && !item.protectionReason ? item.logicalBytes! : 0 })),
    freeSpace: [{ path: "/updates", availableBytesBefore: 2 * 1024 ** 3, availableBytesAfter: state === "running" ? null : 5 * 1024 ** 3 }],
    ...(state === "interrupted" ? { recoveryAction: "Review a new preview; processed items are recorded and remaining items are preserved." } : {}) };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  current = null;
  inventory = [...preview.backups];
  post = async () => { current = cleanup(); return Response.json(current); };
  fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/preview")) return Response.json(preview);
    if (url.endsWith("/cleanup")) return init?.method === "POST" ? post(init) : Response.json(current);
    return Response.json({ backups: inventory });
  });
  vi.stubGlobal("fetch", fetch);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mount(props: Parameters<typeof CloudxUpdateBackupsPanel>[0] = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(CloudxUpdateBackupsPanel, props)));
  return container;
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(item => item.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function acknowledge() { await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); }
async function poll() { await act(async () => vi.advanceTimersByTimeAsync(750)); }
function deleteRequests() { return fetch.mock.calls.filter(([url, init]) => url.endsWith("/cleanup") && init?.method === "POST"); }

describe("Retained update backups", () => {
  it("shows all retained versions, measured storage and live dependency protection beside the bulk action", async () => {
    const container = await mount();
    expect(container.textContent).toContain("Previous commit: aaaaaaaaaaaa");
    expect(container.textContent).toContain("Target commit: cccccccccccc");
    expect(container.textContent).toContain("Update succeeded");
    expect(container.querySelector("time")?.dateTime).toBe(createdAt);
    expect(container.textContent).toContain("8.00 GiB logical · 7.00 GiB allocated · 6.00 GiB estimated reclaimable");
    expect(container.textContent).toContain(`Protected: ${protectedRelease.protectionReason}`);
    expect(button("Clean all update backups").closest(".cloudx-update-backups-heading")?.querySelector("h4")?.textContent).toBe("Retained update backups");
    expect(container.querySelectorAll(".workspace-cleanup-list li")).toHaveLength(3);
  });

  it("requires reviewed bulk acknowledgement and cancels without deleting either completed snapshot", async () => {
    const busy = vi.fn();
    const container = await mount({ onBusyChange: busy });
    await click("Clean all update backups");
    expect(container.textContent).toContain("2 eligible backups · 10.00 GiB estimated reclaimable");
    expect(container.textContent).toContain(preview.estimateNote);
    expect(container.textContent).toContain("Recovery or downgrade using these saved data snapshots will become unavailable");
    expect(container.querySelectorAll('[aria-label="Review permanent update backup deletion"] li')).toHaveLength(3);
    expect(button("Delete all eligible backups permanently").disabled).toBe(true);
    expect(busy).toHaveBeenLastCalledWith(true);
    await acknowledge();
    expect(button("Delete all eligible backups permanently").disabled).toBe(false);
    await click("Cancel");
    expect(deleteRequests()).toHaveLength(0);
    expect(container.querySelector('[aria-label="Review permanent update backup deletion"]')).toBeNull();
    expect(container.querySelectorAll(".workspace-cleanup-list li")).toHaveLength(3);
    expect(busy).toHaveBeenLastCalledWith(false);
    await click("Clean all update backups");
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });

  it("sends one explicit bulk confirmation, monitors progress and refreshes the reconciled list", async () => {
    const onComplete = vi.fn();
    const container = await mount({ onComplete });
    await click("Clean all update backups");
    await acknowledge();
    await click("Delete all eligible backups permanently");
    expect(JSON.parse(deleteRequests()[0]![1]!.body as string)).toEqual({ previewId, confirmPermanentDeletion: true });
    expect(deleteRequests()).toHaveLength(1);
    expect(container.textContent).toContain("Update backup cleanup in progress");
    expect(container.textContent).toContain("0 of 3 items processed");
    expect(container.textContent).toContain("free space after cleanup is not measured yet");
    expect(button("Clean all update backups").disabled).toBe(true);
    current = cleanup("completed");
    inventory = [protectedRelease];
    await poll();
    expect(container.textContent).toContain("2 deleted; 1 protected; 0 skipped; 0 failed");
    expect(container.textContent).toContain("5.00 GiB measured available afterward (3.00 GiB measured increase)");
    expect(container.querySelectorAll(".workspace-cleanup-list li")).toHaveLength(1);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(button("Clean all update backups").disabled).toBe(false);
  });

  it("reports partial failure and a measured decrease without claiming retained bytes were reclaimed", async () => {
    current = cleanup("completed");
    current.results[1] = { ...current.results[1]!, status: "failed", reason: "Permission denied after a partial removal.", deletedLogicalBytes: 1024 };
    current.results.push({ ...current.results[1]!, id: "changed", status: "skipped", path: "/updates/changed", reason: "Reviewed directory was replaced.", deletedLogicalBytes: 0 });
    current.freeSpace[0]!.availableBytesAfter = 1024 ** 3;
    const container = await mount();
    expect(container.textContent).toContain("1 deleted; 1 protected; 1 skipped; 1 failed");
    expect(container.textContent).toContain("Permission denied after a partial removal");
    expect(container.textContent).toContain("Reviewed directory was replaced");
    expect(container.textContent).toContain("1.00 GiB measured available afterward (1.00 GiB measured decrease)");
    expect(container.textContent).not.toContain("10.00 GiB reclaimed");
  });

  it("restores durable interrupted outcomes with the explicit recovery action after reopening Settings", async () => {
    current = cleanup("interrupted");
    current.results[0]!.status = "deleting";
    const container = await mount();
    expect(container.textContent).toContain("Update backup cleanup interrupted");
    expect(container.textContent).toContain(current.recoveryAction);
    expect(container.textContent).toContain("deleting");
    expect(button("Clean all update backups").disabled).toBe(false);
  });

  it("discards stale previews and requires a newly reviewed confirmation", async () => {
    post = async () => Response.json({ message: "The reviewed backup identities changed." }, { status: 409 });
    const container = await mount();
    await click("Clean all update backups");
    await acknowledge();
    await click("Delete all eligible backups permanently");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The reviewed backup identities changed. Review a new cleanup preview");
    expect(container.querySelector('[aria-label="Review permanent update backup deletion"]')).toBeNull();
    expect(deleteRequests()).toHaveLength(1);
    await click("Clean all update backups");
    expect(button("Delete all eligible backups permanently").disabled).toBe(true);
  });

  it("checks durable status after uncertain acceptance and never resubmits automatically", async () => {
    post = async () => { current = cleanup(); throw new TypeError("Connection interrupted"); };
    const busy = vi.fn();
    const container = await mount({ onBusyChange: busy });
    await click("Clean all update backups"); await acknowledge(); await click("Delete all eligible backups permanently");
    expect(container.textContent).toContain("Cleanup acceptance is unknown. Check cleanup status");
    expect(button("Clean all update backups").disabled).toBe(true);
    expect(busy).toHaveBeenLastCalledWith(true);
    await click("Check cleanup status");
    expect(container.textContent).toContain("Update backup cleanup in progress");
    expect(deleteRequests()).toHaveLength(1);
    current = cleanup("completed");
    await poll();
    expect(busy).toHaveBeenLastCalledWith(false);
  });

  it("keeps unknown cleanup status from permitting an update or deletion", async () => {
    fetch.mockImplementation(async (url: string) => url.endsWith("/cleanup") ? Response.json({ message: "Permission denied reading cleanup journal." }, { status: 500 }) : Response.json({ backups: inventory }));
    const busy = vi.fn();
    const container = await mount({ onBusyChange: busy });
    expect(container.textContent).toContain("Permission denied reading cleanup journal");
    expect(button("Clean all update backups").disabled).toBe(true);
    expect(button("Check cleanup status").disabled).toBe(false);
    expect(busy).toHaveBeenLastCalledWith(true);
  });

  it("invalidates previously known idle status when a fresh status check fails", async () => {
    const busy = vi.fn();
    await mount({ onBusyChange: busy });
    expect(button("Clean all update backups").disabled).toBe(false);
    fetch.mockImplementation(async (url: string) => url.endsWith("/cleanup") ? Response.json({ message: "Cleanup state is unavailable." }, { status: 500 }) : Response.json({ backups: inventory }));
    await click("Check cleanup status");
    expect(button("Clean all update backups").disabled).toBe(true);
    expect(busy).toHaveBeenLastCalledWith(true);
  });

  it.each(["active installation", "selected resumable failed update", "prepared update awaiting activation"])("lists the protected %s and keeps an empty bulk preview cancellable", async reason => {
    inventory = [{ ...first, outcome: "failed", logicalBytes: null, allocatedBytes: null, reclaimableBytes: null, protectionReason: reason }];
    fetch.mockImplementation(async (url: string) => Response.json(url.endsWith("/cleanup") ? null : url.endsWith("/preview") ? { ...preview, backups: inventory, reclaimableBytes: 0 } : { backups: inventory }));
    const container = await mount();
    await click("Clean all update backups");
    expect(container.textContent).toContain(`Protected: ${reason}`);
    expect(container.textContent).toContain("Unknown storage logical");
    expect(container.textContent).toContain("No update backups can be safely removed");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await click("Cancel");
    expect(deleteRequests()).toHaveLength(0);
  });

  it("blocks cleanup during installation mutation and exposes the server's exclusion reason", async () => {
    fetch.mockImplementation(async (url: string) => Response.json(url.endsWith("/cleanup") ? null : { backups: inventory, blockedReason: "Update activation currently holds the installation lock." }));
    const container = await mount({ updateActive: true });
    expect(container.textContent).toContain("Cleanup blocked: Update activation currently holds the installation lock.");
    expect(container.textContent).toContain("Cleanup is blocked while an update");
    expect(button("Clean all update backups").disabled).toBe(true);
  });

  it("aborts an obsolete preview after Settings closes and ignores its late result", async () => {
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/preview")) { signal = init?.signal as AbortSignal; return new Promise<Response>(finish => { resolve = finish; }); }
      return Response.json(url.endsWith("/cleanup") ? null : { backups: inventory });
    });
    await mount();
    await click("Clean all update backups");
    await act(async () => root?.unmount()); root = undefined;
    expect(signal?.aborted).toBe(true);
    const container = await mount();
    await act(async () => resolve(Response.json(preview)));
    expect(container.querySelector('[aria-label="Review permanent update backup deletion"]')).toBeNull();
  });

  it("allows a large backup inventory scan to finish after the shorter mutation-request timeout", async () => {
    let finish!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/cleanup")) return Response.json(null);
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    const container = await mount();
    await act(async () => vi.advanceTimersByTimeAsync(45_000));
    expect(signal?.aborted).toBe(false);
    expect(button("Clean all update backups").disabled).toBe(true);
    await act(async () => finish(Response.json({ backups: inventory })));
    expect(container.querySelectorAll(".workspace-cleanup-list li")).toHaveLength(3);
    expect(button("Clean all update backups").disabled).toBe(false);
  });

  it("gives backup previews two minutes to scan before aborting with an actionable error", async () => {
    let signal: AbortSignal | undefined;
    fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/preview")) {
        signal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("Backup scan timed out.")), { once: true }));
      }
      return Response.json(url.endsWith("/cleanup") ? null : { backups: inventory });
    });
    const container = await mount();
    await click("Clean all update backups");
    await act(async () => vi.advanceTimersByTimeAsync(119_999));
    expect(signal?.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(signal?.aborted).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not preview cleanup: Backup scan timed out.");
    expect(button("Clean all update backups").disabled).toBe(false);
    expect(deleteRequests()).toHaveLength(0);
  });

  it("keeps running cleanup evidence visible after a polling failure and reconnects explicitly", async () => {
    current = cleanup();
    const container = await mount();
    fetch.mockRejectedValueOnce(new Error("Cleanup connection lost"));
    await poll();
    expect(container.textContent).toContain("Check cleanup status to reconnect; deletion may still be running");
    expect(button("Clean all update backups").disabled).toBe(true);
    current = cleanup("completed");
    await click("Check cleanup status");
    expect(container.textContent).toContain("Update backup cleanup results");
  });

  it("disables update, channel and capacity controls throughout backup review and running cleanup", async () => {
    const update: UpdateController = { status: { available: true, run: { id: runId, state: "failed", startedAt: createdAt, message: "Saved failed update.", resumable: true, targetCommit: "d".repeat(40) } },
      preview: { channel: "main", currentCommit: "a".repeat(40), checkedAt: createdAt, state: "available", target: { commit: "b".repeat(40), name: "main", url: "https://github.com/davidomil/cloudx" },
        runtime: { verification: "verified", commit: "a".repeat(40), builtAt: createdAt, sourceDirty: false }, changelog: [], changelogComplete: true },
      channel: "main", previewLoading: false, starting: false, checking: false, reassessing: false, start: vi.fn(), resume: vi.fn(), check: vi.fn(), reassessCapacity: vi.fn(), selectChannel: vi.fn() };
    const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(createElement(CloudxUpdatePanel, { update })));
    expect(button("Start selected target").disabled).toBe(false);
    await click("Clean all update backups");
    for (const name of ["Start selected target", "Resume update", "Recheck update capacity", "Check update status"]) expect(button(name).disabled).toBe(true);
    expect(container.querySelector("select")?.disabled).toBe(true);
    await click("Cancel");
    expect(button("Start selected target").disabled).toBe(false);
    await click("Clean all update backups"); await acknowledge(); await click("Delete all eligible backups permanently");
    expect(button("Start selected target").disabled).toBe(true);
    current = cleanup("completed"); await poll();
    expect(button("Start selected target").disabled).toBe(false);
    expect(update.check).toHaveBeenCalledOnce();
  });
});
