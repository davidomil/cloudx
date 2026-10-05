// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxUpdateCapacity, CloudxUpdatePreview, CloudxUpdateStatus, WorkspaceCleanupJob, WorkspaceCleanupPreview, WorkspaceCleanupRequest } from "@cloudx/shared";

import { WorkspaceCleanupPanel } from "./WorkspaceCleanupPanel.js";
import { useWorkspaceCleanup } from "./workspaceCleanupSession.js";
import { CloudxUpdatePanel, useCloudxUpdate } from "./CloudxUpdatePanel.js";

let root: Root | undefined;
const reload = vi.fn();
const mainPreview: CloudxUpdatePreview = {
  runtime: { verification: "verified", commit: "a".repeat(40), builtAt: "2026-09-15T00:00:00Z", sourceDirty: false },
  channel: "main", currentCommit: "a".repeat(40), checkedAt: "2026-09-15T04:00:00.000Z", state: "available",
  target: { commit: "b".repeat(40), name: "main", url: "https://github.com/davidomil/cloudx/commit/" + "b".repeat(40) },
  changelog: [{ number: 82, title: "Choose an update channel", url: "https://github.com/davidomil/cloudx/pull/82" }],
  changelogComplete: true, compareUrl: "https://github.com/davidomil/cloudx/compare/main"
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  sessionStorage.clear();
  reload.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function reply(status: CloudxUpdateStatus | CloudxUpdatePreview, code = 200) { return new Response(JSON.stringify(status), { status: code }); }

async function mount() {
  const statusFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => url.endsWith("/api/system/update/preview") ? Promise.resolve(reply(mainPreview))
    : url.endsWith("/api/system/update/backups") ? Response.json({ backups: [] })
    : url.endsWith("/api/system/update/backups/cleanup") ? Response.json(null)
    : statusFetch(url, init));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const saveWorkspace = async () => {};
  function Harness() {
    const update = useCloudxUpdate(true, saveWorkspace, reload);
    const [cleanupOpen, setCleanupOpen] = useState(false);
    const cleanup = useWorkspaceCleanup({ onComplete: () => { void update.reassessCapacity(); } });
    return createElement("div", null,
      createElement(CloudxUpdatePanel, { update, cleanupBusy: cleanup.busy, onOpenEnvironments: () => { cleanup.setFilter("forge"); setCleanupOpen(true); } }),
      cleanupOpen ? createElement(WorkspaceCleanupPanel, { cleanup }) : null);

  }
  await act(async () => root!.render(createElement(Harness)));
  return container;
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(item => item.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) { await act(async () => button(label).click()); }

describe("Update capacity recovery", () => {
  const capacity: CloudxUpdateCapacity = { stage: "build-staging", checkedAt: "2026-10-03T22:35:00Z", filesystems: [
    { device: "1", mount: "/recovery", destination: "/recovery/update", requiredBytes: 40859257735, availableBytes: 27225911296,
      shortfallBytes: 13633346439, headroomBytes: 3714477976, requiredInodes: 2048, availableInodes: 10000, shortfallInodes: 0,
      reservations: [{ destination: "/recovery/update", purpose: "snapshot and failed-start recovery", bytes: 1024 ** 3, inodes: 100 }] }
  ] };
  const failedCapacity: CloudxUpdateStatus = { available: true, run: { id: "11111111-1111-4111-8111-111111111111", state: "failed",
    resumable: true, targetCommit: "c".repeat(40), component: "capacity", message: "Update stopped", startedAt: capacity.checkedAt,
    cause: "required 40859257735 bytes and available 27225911296 bytes", capacity } };
  it("renders the recorded shortage and exposes exact bytes only in expandable diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(failedCapacity)));
    const container = await mount();
    expect(container.textContent).toContain("38.05 GiB required, 25.36 GiB available, 12.70 GiB more needed");
    expect(container.textContent).toContain("3.46 GiB safety margin");
    expect(container.textContent).toContain("snapshot and failed-start recovery: 1.00 GiB");
    expect(container.textContent).toContain("/recovery");
    expect(container.querySelector("details pre")?.textContent).toContain("40859257735");
    expect([...container.querySelectorAll("p")].find(item => item.textContent?.includes("required 40859257735 bytes"))?.closest("details")).not.toBeNull();
  });
  it("keeps inode-only quota failure on a separate filesystem distinct from disk shortage", async () => {
    const inode = { ...capacity.filesystems[0]!, device: "2", mount: "/profile", requiredBytes: 5, availableBytes: 10,
      shortfallBytes: 0, requiredInodes: 2048, availableInodes: 2000, shortfallInodes: 48, inodeLimit: "quota" as const };
    vi.stubGlobal("fetch", vi.fn(async () => reply({ ...failedCapacity, run: { ...failedCapacity.run!, capacity: { ...capacity, filesystems: [capacity.filesystems[0]!, inode] } } })));
    const container = await mount();
    expect(container.textContent).toContain("Inode quota shortage: 48 more inodes needed");
    expect(container.textContent).toContain("5 B required, 10 B available, 0 B more needed");
    expect(container.textContent).toContain("/profile");
  });
  it("does not present a blocked capacity probe as zero usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ ...failedCapacity, run: { ...failedCapacity.run!, capacity: { ...capacity, filesystems: [], error: "Quota permission denied" } } })));
    const container = await mount();
    expect(container.textContent).toContain("Capacity scan blocked: Quota permission denied");
    expect(container.textContent).toContain("Usage is unknown");
    expect(container.textContent).not.toContain("0 B more needed");
  });
  it.each([false, true])("reviews safe Forge trash, cancels without deletion, and reassesses after cleanup (partial failure: %s)", async partial => {
    const candidate = { id: "22222222-2222-4222-8222-222222222222", path: "/work/completed-forge", repository: "team/project",
      kind: "forge" as const, state: "completed", lastActivity: capacity.checkedAt, allocatedBytes: 16 * 1024 ** 3, eligible: true,
      reason: "Completed and inactive", sourceChanges: [], unpublishedCommits: 0, requiresDiscard: false };
    const cleanupPreview: WorkspaceCleanupPreview = { id: "33333333-3333-4333-8333-333333333333", createdAt: capacity.checkedAt,
      candidates: [candidate, { ...candidate, id: "44444444-4444-4444-8444-444444444444", path: "/work/unpublished", requiresDiscard: true,
        sourceChanges: ["source.ts"], unpublishedCommits: 1, reason: "Source changes are preserved" },
        { ...candidate, id: "66666666-6666-4666-8666-666666666666", path: "/work/shared", eligible: false, reason: "Shared by an unfinished worker" }],
      reclaimableBytes: candidate.allocatedBytes, reclaimGroups: [{ bytes: candidate.allocatedBytes, candidateIds: [candidate.id] }],
      availableBytes: 27225911296, warnings: [], resourceOutcomes: [
        { id: "retired", path: "docker:retired", state: "deleted", reason: "Issue closed", reclaimedBytes: 1024 ** 3, remainingBytes: 0 },
        { id: "pending", path: "docker:pending", state: "failed", reason: "Ownership needs review", reclaimedBytes: 0, sizeUnavailable: true }
      ] };
    let job: WorkspaceCleanupJob | null = null;
    let requested: WorkspaceCleanupRequest | undefined;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("workspace-cleanup/preview")) return Response.json(cleanupPreview);
      if (url.endsWith("workspace-cleanup")) {
        if (init?.method === "POST") {
          requested = JSON.parse(init.body as string);
          job = { id: "55555555-5555-4555-8555-555555555555", state: "completed", startedAt: capacity.checkedAt,
            availableBytesBefore: cleanupPreview.availableBytes, availableBytesAfter: partial ? cleanupPreview.availableBytes : 50 * 1024 ** 3,
            results: [{ id: candidate.id, path: candidate.path, status: partial ? "failed" : "deleted", reason: partial ? "Resource could not be removed" : "Deleted" }] };
        }
        return Response.json(job);
      }
      if (url.endsWith("update/capacity")) return reply({ ...failedCapacity, run: { ...failedCapacity.run!, capacity: { ...capacity,
        filesystems: capacity.filesystems.map(item => ({ ...item, availableBytes: job!.availableBytesAfter!, shortfallBytes: Math.max(0, item.requiredBytes - job!.availableBytesAfter!) })) } } });
      return reply(init?.method === "POST" ? { available: true, run: { ...failedCapacity.run!, capacity: undefined, state: "running", resumable: false } } : failedCapacity);
    });
    vi.stubGlobal("fetch", fetch);
    const container = await mount();
    await click("Manage Forge environments");
    await click("Scan workspaces and environments");
    expect(container.textContent).toContain("16.00 GiB");
    expect(container.textContent).toContain("1.00 GiB Docker writable-layer bytes removed · 0 B remaining");
    expect(container.textContent).toContain("Ownership needs review");
    expect(container.textContent).toContain("Remaining size unknown");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Select /work/unpublished"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Select /work/shared"]')?.disabled).toBe(true);
    await click("Review deletion of 1 workspace");
    expect(button("Resume update").disabled).toBe(true);
    await click("Cancel");
    expect(requested).toBeUndefined();
    await click("Review deletion of 1 workspace");
    await click("Delete permanently");
    expect(requested?.candidateIds).toEqual([candidate.id]);
    expect(requested?.discardCandidateIds).toEqual([]);
    const recheck = fetch.mock.calls.find(([url]) => url.endsWith("update/capacity"));
    expect(JSON.parse(recheck![1]!.body as string)).toEqual({ channel: "main", targetCommit: failedCapacity.run!.targetCommit, resumeRunId: failedCapacity.run!.id });
    expect(container.textContent).toContain(partial ? "12.70 GiB more needed" : "0 B more needed");
    await click("Resume update");
    const resume = fetch.mock.calls.find(([url, init]) => url.endsWith("/update") && init?.method === "POST");
    expect(JSON.parse(resume![1]!.body as string)).toEqual({ channel: "main", targetCommit: failedCapacity.run!.targetCommit, resumeRunId: failedCapacity.run!.id });
    expect(reload).not.toHaveBeenCalled();
  });
});
