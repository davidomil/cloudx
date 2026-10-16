// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeDiagnosticSnapshotStatus } from "@cloudx/shared";
import { ForgeDiagnosticSnapshotsPanel } from "./ForgeDiagnosticSnapshotsPanel.js";
import { getForgeDiagnosticSnapshots, recoverForgeDiagnosticSnapshot } from "../forgeDiagnosticSnapshotsApi.js";

vi.mock("../forgeDiagnosticSnapshotsApi.js", async importOriginal => ({
  ...await importOriginal<typeof import("../forgeDiagnosticSnapshotsApi.js")>(),
  getForgeDiagnosticSnapshots: vi.fn(), recoverForgeDiagnosticSnapshot: vi.fn(),
}));

const held: ForgeDiagnosticSnapshotStatus = {
  workerId: "issue-worker", attemptId: "first-attempt", path: ".cloudx/forge-snapshots/first/source",
  kind: "repository", retentionPolicy: "recover", state: "ready", hold: "Diagnostic source changed; preserve the complete copy before cleanup.",
};
const recovered: ForgeDiagnosticSnapshotStatus = {
  ...held, workerId: "reviewer", attemptId: "second-attempt", path: ".cloudx/forge-snapshots/second/source", state: "removed", hold: undefined,
  recovery: { state: "verified", archivePath: "/private/data/verified-snapshot.tar" },
};
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getForgeDiagnosticSnapshots).mockResolvedValue({ snapshots: [], errors: [] });
  vi.mocked(recoverForgeDiagnosticSnapshot).mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  document.body.replaceChildren(); vi.resetAllMocks(); vi.unstubAllGlobals();
});
async function render(revision = 0) { await act(async () => root!.render(createElement(ForgeDiagnosticSnapshotsPanel, { revision }))); }

describe("Diagnostic snapshot recovery", () => {
  it("adds no controls for an empty inventory or retired disposable source", async () => {
    await render();
    expect(container.textContent).toBe("");
    vi.mocked(getForgeDiagnosticSnapshots).mockResolvedValue({ snapshots: [{ ...held, kind: "source-only", retentionPolicy: "disposable", state: "removed", hold: undefined }], errors: [] });
    await render(1);
    expect(container.textContent).toBe("");
  });

  it("shows every attempt and hold alongside verified downloads without exposing archive locations", async () => {
    const anotherHold = { ...held, attemptId: "third-attempt", path: ".cloudx/forge-snapshots/third/source", hold: "Dependency link belongs to another checkout; preserve it." };
    vi.mocked(getForgeDiagnosticSnapshots).mockResolvedValue({ snapshots: [held, anotherHold, recovered], errors: ["Unavailable worker needs directory ownership review"] });
    await render();
    expect(container.querySelectorAll("article")).toHaveLength(3);
    expect(container.textContent).toContain(held.hold);
    expect(container.textContent).toContain(anotherHold.hold);
    for (const snapshot of [held, anotherHold, recovered]) {
      expect(container.textContent).toContain(snapshot.path);
      expect(container.textContent).toContain(snapshot.attemptId);
    }
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unavailable worker needs directory ownership review");
    const link = container.querySelector("a[download]")!;
    expect(link.getAttribute("href")).toBe(`/api/forge/workers/reviewer/snapshots/archive?${new URLSearchParams({ path: recovered.path })}`);
    expect(link.getAttribute("download")).toBe("diagnostic-snapshot.tar");
    expect(container.textContent).not.toContain(recovered.recovery!.archivePath);
  });

  it("recovers the selected owned snapshot once and refreshes its verified download", async () => {
    let finish!: () => void;
    vi.mocked(getForgeDiagnosticSnapshots).mockResolvedValueOnce({ snapshots: [held], errors: [] }).mockResolvedValueOnce({ snapshots: [{ ...held, state: "removed", hold: undefined, recovery: recovered.recovery }], errors: [] });
    vi.mocked(recoverForgeDiagnosticSnapshot).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render();
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("button")?.textContent).toBe("Recovering snapshot…");
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(recoverForgeDiagnosticSnapshot).toHaveBeenCalledWith(held.workerId, held.path, expect.any(AbortSignal));
    expect(recoverForgeDiagnosticSnapshot).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(getForgeDiagnosticSnapshots).toHaveBeenCalledTimes(2);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a[download]")?.textContent).toBe("Download recovered snapshot");
  });

  it("keeps a rejected recovery actionable and preserves other verified downloads", async () => {
    vi.mocked(getForgeDiagnosticSnapshots).mockResolvedValue({ snapshots: [held, recovered], errors: [] });
    vi.mocked(recoverForgeDiagnosticSnapshot).mockRejectedValue(new Error("Snapshot ownership changed; inspect ownership first."));
    await render();
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Snapshot ownership changed; inspect ownership first.");
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(container.querySelector("a[download]")).not.toBeNull();
    expect(getForgeDiagnosticSnapshots).toHaveBeenCalledOnce();
  });

  it("keeps existing archives downloadable when a later inventory refresh fails", async () => {
    vi.mocked(getForgeDiagnosticSnapshots).mockResolvedValueOnce({ snapshots: [recovered], errors: [] }).mockRejectedValueOnce(new Error("Snapshot inventory unavailable"));
    await render();
    await render(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Snapshot inventory unavailable");
    expect(container.querySelector("a[download]")?.textContent).toBe("Download recovered snapshot");
  });

  it("does not offer recovery from a retired source when its archive fails verification", async () => {
    vi.mocked(getForgeDiagnosticSnapshots).mockResolvedValue({ snapshots: [{ ...recovered, hold: "Saved snapshot archive checksum verification failed." }], errors: [] });
    await render();
    expect(container.textContent).toContain("Saved snapshot archive checksum verification failed.");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("recovery archive needs attention");
    expect(container.querySelector("button, a[download]")).toBeNull();
  });

  it("keeps a reappeared retired source visible for ownership review", async () => {
    vi.mocked(getForgeDiagnosticSnapshots).mockResolvedValue({ snapshots: [{ ...held, kind: "source-only", retentionPolicy: "disposable", state: "removed", hold: "Snapshot reappeared after retirement; its replacement was preserved." }], errors: [] });
    await render();
    expect(container.textContent).toContain("its replacement was preserved");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Review directory ownership");
    expect(container.querySelector("button, a[download]")).toBeNull();
  });

  it("ignores old inventory responses after a revision change and reports inventory failures", async () => {
    let finish!: (value: Awaited<ReturnType<typeof getForgeDiagnosticSnapshots>>) => void;
    vi.mocked(getForgeDiagnosticSnapshots).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render();
    const oldSignal = vi.mocked(getForgeDiagnosticSnapshots).mock.calls[0]![0]!;
    vi.mocked(getForgeDiagnosticSnapshots).mockRejectedValueOnce(new Error("Snapshot journal unavailable"));
    await render(1);
    await act(async () => finish({ snapshots: [held], errors: [] }));
    expect(oldSignal.aborted).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Snapshot journal unavailable");
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps a pending recovery bound to its original snapshot when the inventory changes", async () => {
    let finish!: () => void;
    vi.mocked(getForgeDiagnosticSnapshots).mockResolvedValueOnce({ snapshots: [held], errors: [] }).mockResolvedValue({ snapshots: [recovered], errors: [] });
    vi.mocked(recoverForgeDiagnosticSnapshot).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render();
    await act(async () => container.querySelector("button")!.click());
    await render(1);
    await act(async () => finish());
    expect(recoverForgeDiagnosticSnapshot).toHaveBeenCalledOnce();
    expect(recoverForgeDiagnosticSnapshot).toHaveBeenCalledWith(held.workerId, held.path, expect.any(AbortSignal));
    expect(container.textContent).toContain(recovered.path);
  });

  it("cancels inventory and recovery observers when the evidence panel closes", async () => {
    let finish!: () => void;
    vi.mocked(getForgeDiagnosticSnapshots).mockResolvedValue({ snapshots: [held], errors: [] });
    vi.mocked(recoverForgeDiagnosticSnapshot).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render();
    const inventorySignal = vi.mocked(getForgeDiagnosticSnapshots).mock.calls[0]![0]!;
    await act(async () => container.querySelector("button")!.click());
    const recoverySignal = vi.mocked(recoverForgeDiagnosticSnapshot).mock.calls[0]![2]!;
    await act(async () => root!.unmount()); root = undefined;
    await act(async () => finish());
    expect(inventorySignal.aborted).toBe(true);
    expect(recoverySignal.aborted).toBe(true);
    expect(getForgeDiagnosticSnapshots).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("");
  });
});
