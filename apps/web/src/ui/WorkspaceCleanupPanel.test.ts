// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisposableResource, WorkspaceCleanupCandidate, WorkspaceCleanupJob, WorkspaceCleanupPreview, WorkspaceCleanupRequest } from "@cloudx/shared";
import { ForgeResourcesPanel } from "./ForgeResourcesPanel.js";
import { CloudxUpdatePanel } from "./CloudxUpdatePanel.js";
import { useWorkspaceCleanup } from "./workspaceCleanupSession.js";

const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const candidate = (kind: WorkspaceCleanupCandidate["kind"], n: number, extra: Partial<WorkspaceCleanupCandidate> = {}): WorkspaceCleanupCandidate => ({
  id: id(n), path: `/work/${kind}-${n}`, repository: "team/project", kind, state: "completed", lastActivity: "2026-10-05", allocatedBytes: 4096,
  eligible: true, reason: "Completed and inactive", sourceChanges: [], unpublishedCommits: 0, requiresDiscard: false, ...extra,
});
const entries = [candidate("checkout", 1), candidate("worktree", 2), candidate("forge", 3), candidate("trash", 4), candidate("resource", 5),
  candidate("forge", 6, { requiresDiscard: true, sourceChanges: ["src/unpublished.ts"], unpublishedCommits: 1 }),
  candidate("forge", 7, { eligible: false, allocatedBytes: 0, sizeUnavailable: true, reason: "Relevant process activity is unresolved" })];
const preview: WorkspaceCleanupPreview = { id: id(10), createdAt: "2026-10-05", candidates: entries, availableBytes: 8192,
  reclaimableBytes: 9000, warnings: [], reclaimGroups: [{ bytes: 1000, candidateIds: [id(1), id(2)] }, { bytes: 4096, candidateIds: [id(3)] }, { bytes: 2000, candidateIds: [id(5)] }] };
const resource: DisposableResource = { id: "container-1", kind: "container", engineId: "engine", name: "validation", state: "blocked", reason: "Evidence review required",
  owner: { workerId: "worker-1", attemptId: "attempt-1" }, consumers: [{ workerId: "worker-1", attemptId: "attempt-1" }], retentionReason: "Useful reports", reclaimedBytes: 0,
  updatedAt: "2026-10-05", evidence: { state: "pending", paths: ["/evidence/test.log"] } };
let root: Root;
let container: HTMLDivElement;
let job: WorkspaceCleanupJob | null;
let requests: WorkspaceCleanupRequest[];
let scanFailure: boolean;
let removalFailure: boolean;
let evidenceFinish: (() => void) | undefined;
const completed = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  scanFailure = false; removalFailure = false;
  job = null; requests = []; evidenceFinish = undefined; completed.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/forge/checkout-evidence") return Response.json({ archives: [] });
    if (url === "/api/forge/resources") return Response.json({ resources: [resource] });
    if (url.endsWith("evidence-decision")) {
      await new Promise<void>(resolve => { evidenceFinish = resolve; });
      return Response.json(resource);
    }
    if (url === "/api/system/workspace-cleanup/preview") { if (scanFailure) throw new Error("Preview permission denied."); return Response.json(preview); }
    if (url === "/api/system/workspace-cleanup") {
      if (init?.method === "POST") {
        if (removalFailure) throw new Error("An active open file still protects this workspace.");
        const request = JSON.parse(init.body as string) as WorkspaceCleanupRequest;
        requests.push(request);
        job = { id: id(20), state: "running", startedAt: "2026-10-05", availableBytesBefore: 8192, results: request.candidateIds.map(candidateId => ({ id: candidateId, path: entries.find(item => item.id === candidateId)!.path, status: "waiting", reason: "Queued" })) };
      }
      return Response.json(job);
    }
    if (url === "/api/system/update/backups") return Response.json({ backups: [{ id: "retained-version", path: "/updates/recovery", state: "available", allocatedBytes: 4096, reason: "Recovery backup" }] });
    if (url === "/api/system/update/backups/cleanup") return Response.json(null);
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function mount() {
  function Harness() {
    const cleanup = useWorkspaceCleanup({ onComplete: completed });
    const [visible, setVisible] = useState(true);
    return createElement("div", null,
      createElement("button", { onClick: () => setVisible(value => !value) }, visible ? "Hide environments" : "Open environments"),
      createElement(CloudxUpdatePanel, { cleanupBusy: cleanup.busy, update: { status: { available: true, run: { id: id(30), targetCommit: "a".repeat(40), state: "failed", resumable: true, startedAt: "2026-10-05", message: "Capacity shortage" } }, channel: "main", previewLoading: false, starting: false, checking: false, reassessing: false, start: vi.fn(), resume: vi.fn(), check: vi.fn(), selectChannel: vi.fn(), reassessCapacity: vi.fn() } }),
      visible ? createElement(ForgeResourcesPanel, { cleanup }) : null);
  }
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
}
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === name)!;
async function click(name: string) { await act(async () => button(name).click()); }
async function check(path: string) { await act(async () => container.querySelector<HTMLInputElement>(`[aria-label="Select ${path}"]`)!.click()); }
async function filter(value: string) {
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Workspace filter"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value); select.dispatchEvent(new Event("change", { bubbles: true })); });
}

describe("Canonical workspace and container cleanup", () => {
  it("exposes every workspace kind, preserves selection across remounts and filters, and counts selected hard links once", async () => {
    await mount(); await click("Scan workspaces and environments");
    expect(container.textContent).toContain("Writable-layer size unknown");
    const cleanup = container.querySelector('[aria-label="Workspace cleanup"]')!;
    for (const label of ["Ordinary checkout", "Ordinary worktree", "Retained Forge directory", "Workspace trash", "Owned container"]) expect(cleanup.textContent).toContain(label);
    expect(cleanup.textContent).toContain("6.93 KiB estimated reclaimable");
    const unknown = container.querySelector('[aria-label="Select /work/forge-7"]')!.closest("li")!;
    expect(unknown.textContent).toContain("Size unavailable"); expect(unknown.textContent).not.toContain("0 B");
    await check("/work/worktree-2"); expect(cleanup.textContent).toContain("5.95 KiB estimated reclaimable");
    await filter("forge"); expect(container.querySelector('[aria-label="Select /work/checkout-1"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Select /work/forge-6"]')!.disabled).toBe(true);
    await click("Hide environments"); await click("Open environments");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Workspace filter"]')!.value).toBe("forge");
    await filter("all");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Select /work/checkout-1"]')!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Select /work/worktree-2"]')!.checked).toBe(false);
  });

  it("deletes only the safe visible Forge selection when ordinary and source-bearing selections are retained behind the filter", async () => {
    await mount(); await click("Scan workspaces and environments");
    await check("/work/forge-6");
    const sourceDiscard = [...container.querySelectorAll("label")].find(item => item.textContent?.includes("Explicitly discard"))!.querySelector<HTMLInputElement>("input")!;
    await act(async () => sourceDiscard.click());
    await filter("forge");
    await click("Review deletion of 2 workspaces"); await click("Delete permanently");
    expect(requests[0]?.candidateIds).toEqual([id(3), id(5)]);
    expect(requests[0]?.discardCandidateIds).toEqual([]);
  });

  it("requires source and trash confirmations, preserves a running job while hidden, and gates updates until actual completion", async () => {
    await mount(); await click("Scan workspaces and environments");
    await check("/work/forge-6"); expect(button("Review deletion of 5 workspaces").disabled).toBe(true);
    const sourceDiscard = [...container.querySelectorAll("label")].find(item => item.textContent?.includes("Explicitly discard"))!.querySelector<HTMLInputElement>("input")!;
    await act(async () => sourceDiscard.click());
    await check("/work/trash-4"); expect(button("Review deletion of 6 workspaces").disabled).toBe(true);
    const trash = [...container.querySelectorAll("label")].find(item => item.textContent?.includes("Empty selected"))!.querySelector<HTMLInputElement>("input")!;
    await act(async () => trash.click());
    await click("Review deletion of 6 workspaces"); expect(button("Resume update").disabled).toBe(true);
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    await click("Cancel"); expect(requests).toEqual([]);
    await click("Review deletion of 6 workspaces"); await click("Delete permanently");
    expect(requests).toEqual([{ previewId: preview.id, candidateIds: [id(1), id(2), id(3), id(5), id(6), id(4)], discardCandidateIds: [id(6)], emptyTrash: true, confirmation: "Delete permanently" }]);
    await click("Hide environments"); expect(button("Resume update").disabled).toBe(true);
    job = { ...job!, state: "completed", availableBytesAfter: 16384, results: job!.results.map(item => ({ ...item, status: "deleted", reason: "Deleted" })) };
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(completed).toHaveBeenCalledOnce(); expect(button("Resume update").disabled).toBe(false);
    await click("Open environments"); expect(container.textContent).toContain("Cleanup results"); expect(container.textContent).toContain("16.00 KiB available after cleanup");
  });

  it("reports unknown reclaim when scanning fails and preserves the reviewed selection after a rejected deletion", async () => {
    await mount(); scanFailure = true;
    await click("Scan workspaces and environments");
    const cleanup = container.querySelector('[aria-label="Workspace cleanup"]')!;
    expect(cleanup.textContent).toContain("Preview permission denied. Reclaimable usage is unknown.");
    expect(cleanup.textContent).not.toContain("estimated reclaimable");
    scanFailure = false; await click("Scan workspaces and environments");
    await click("Review deletion of 4 workspaces"); removalFailure = true;
    await click("Delete permanently");
    expect(cleanup.textContent).toContain("An active open file still protects this workspace.");
    expect(container.querySelector('[aria-label="Confirm permanent deletion"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Select /work/checkout-1"]')!.checked).toBe(true);
    expect(requests).toEqual([]);
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/system/workspace-cleanup" && init?.method === "POST")).toHaveLength(1);
    await click("Cancel"); expect(button("Resume update").disabled).toBe(false);
  });

  it("shares evidence-decision busy state with cleanup and updater while preserving evidence confirmation", async () => {
    await mount(); await click("Export evidence and release");
    expect(button("Resume update").disabled).toBe(true); expect(button("Scan workspaces and environments").disabled).toBe(true);
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    await click("Hide environments"); expect(button("Resume update").disabled).toBe(true);
    await act(async () => evidenceFinish!()); expect(button("Resume update").disabled).toBe(false);
  });
});
