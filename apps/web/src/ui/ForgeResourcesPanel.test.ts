// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisposableResource, ForgeCheckoutEvidenceManifest, ForgeGitHistoryManifest } from "@cloudx/shared";
import { ForgeResourcesPanel } from "./ForgeResourcesPanel.js";
import { getForgeResources } from "../forgeResourcesApi.js";
import { getForgeCheckoutEvidence } from "../forgeCheckoutEvidenceApi.js";
import { getForgeGitHistory } from "../forgeGitHistoryApi.js";

vi.mock("../forgeResourcesApi.js", () => ({
  getForgeResources: vi.fn(),
  forgeEvidenceFileUrl: (id: string, path: string) => `/api/forge/resources/${id}/evidence-file?${new URLSearchParams({ path })}`,
}));
vi.mock("../forgeCheckoutEvidenceApi.js", () => ({
  getForgeCheckoutEvidence: vi.fn(),
  checkoutEvidenceManifestUrl: (id: string) => `/api/forge/checkout-evidence/${id}`,
  checkoutEvidenceFileUrl: (id: string, path: string) => `/api/forge/checkout-evidence/${id}/file?${new URLSearchParams({ path })}`,
}));
vi.mock("../forgeGitHistoryApi.js", () => ({
  getForgeGitHistory: vi.fn(),
  gitHistoryManifestUrl: (id: string) => `/api/forge/git-history/${id}`,
  gitHistoryBundleUrl: (id: string) => `/api/forge/git-history/${id}/file`,
}));
const resource: DisposableResource = {
  id: "resource-1", kind: "container", engineId: "engine", name: "regression-env",
  owner: { workerId: "worker-1", attemptId: "attempt-1" }, consumers: [], state: "deleted", reason: "Cleaned automatically", reclaimedBytes: 8192, updatedAt: "2026-10-06",
  evidence: { state: "verified", paths: ["/evidence"], commitSha: "a".repeat(40), bytes: 1024,
    files: [{ path: "evidence/test log.txt", bytes: 1024, sha256: "b".repeat(64) }] },
};
const archive: ForgeCheckoutEvidenceManifest = {
  archiveId: "archive-1", workerId: "retired-worker", attemptId: "attempt-2", commitSha: "c".repeat(40),
  checkoutIdentity: { dev: "1", ino: "2" }, paths: ["reports"], exportedAt: "2026-10-06T00:00:00.000Z", bytes: 34_048_143,
  files: [{ path: "reports/coverage.json", bytes: 34_048_143, sha256: "d".repeat(64) }],
};
const history: ForgeGitHistoryManifest = {
  archiveId: "history-1", workerId: "retired-worker", attemptId: "attempt-2", commitSha: "c".repeat(40),
  checkoutIdentity: { dev: "1", ino: "2" }, exportedAt: "2026-10-06T00:00:00.000Z", bytes: 2048,
  refs: [{ name: "refs/cloudx/before-rebase/snapshot-1", commitSha: "e".repeat(40) }],
  files: [{ path: "history.bundle", bytes: 2048, sha256: "f".repeat(64) }],
};
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getForgeResources).mockResolvedValue([]);
  vi.mocked(getForgeCheckoutEvidence).mockResolvedValue([]);
  vi.mocked(getForgeGitHistory).mockResolvedValue([]);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  document.body.replaceChildren(); vi.resetAllMocks(); vi.unstubAllGlobals();
});
async function render(revision = 0) { await act(async () => root!.render(createElement(ForgeResourcesPanel, { revision }))); }

describe("Saved Forge evidence", () => {
  it("replaces an empty resource history with one automatic-cleanup message and no controls", async () => {
    vi.mocked(getForgeResources).mockResolvedValue([{ ...resource, evidence: undefined }, { ...resource, id: "discarded", evidence: { state: "discarded", paths: [] } }]);
    await render();
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.textContent).toContain("Finished Forge workspaces clean automatically.");
    expect(container.querySelector("article, button, input, textarea, select, fieldset")).toBeNull();
  });
  it("keeps verified reports and generated Git snapshots downloadable after workers retire", async () => {
    vi.mocked(getForgeResources).mockResolvedValue([resource]);
    vi.mocked(getForgeCheckoutEvidence).mockResolvedValue([archive]);
    vi.mocked(getForgeGitHistory).mockResolvedValue([history]);
    await render();
    expect(container.querySelectorAll("article")).toHaveLength(3);
    expect(container.textContent).toContain("worker-1"); expect(container.textContent).toContain("attempt-1");
    expect(container.textContent).toContain("retired-worker"); expect(container.textContent).toContain("attempt-2");
    expect(container.textContent).toContain(resource.evidence!.commitSha); expect(container.textContent).toContain(archive.commitSha);
    expect(container.textContent).toContain("1.00 KiB saved"); expect(container.textContent).toContain("32.47 MiB saved");
    expect([...container.querySelectorAll<HTMLAnchorElement>("a[download]")].map(link => link.getAttribute("href"))).toEqual([
      "/api/forge/resources/resource-1/evidence", "/api/forge/resources/resource-1/evidence-file?path=evidence%2Ftest+log.txt",
      "/api/forge/checkout-evidence/archive-1", "/api/forge/checkout-evidence/archive-1/file?path=reports%2Fcoverage.json",
      "/api/forge/git-history/history-1", "/api/forge/git-history/history-1/file",
    ]);
    expect(container.querySelector('a[href$="history-1/file"]')?.getAttribute("download")).toBe("history.bundle");
    expect(container.textContent).toContain("Preserved snapshots (1)");
    expect(container.textContent).toContain(history.refs[0]!.name); expect(container.textContent).toContain(history.refs[0]!.commitSha);
    expect(container.querySelector("button, input, textarea, select, fieldset")).toBeNull();
  });
  it("shows automatic archival and protected failures without offering evidence decisions", async () => {
    vi.mocked(getForgeResources).mockResolvedValue([
      { ...resource, state: "owned", evidence: { ...resource.evidence!, state: "exporting" } },
      { ...resource, id: "blocked", state: "blocked", reason: "Select specific paths to export, keep the hold or confirm discard.", evidence: undefined, retentionReason: "Preserve validation reports" },
      { ...resource, id: "failed", state: "failed", reason: "Archive verification failed.", evidence: { ...resource.evidence!, state: "missing" } },
    ]);
    await render();
    expect(container.textContent).toContain("Saving evidence before automatic cleanup…");
    expect([...container.querySelectorAll('[role="status"]')].filter(item => item.textContent === "Automatic cleanup is blocked to protect evidence. See the worker error.")).toHaveLength(2);
    expect(container.textContent).not.toContain("Select specific paths");
    expect(container.textContent).not.toContain("Archive verification failed.");
    expect(container.querySelector("a, button, input, textarea, select, fieldset")).toBeNull();
  });
  it.each(["container", "checkout", "Git history"])("preserves available downloads when %s evidence cannot load", async source => {
    vi.mocked(getForgeResources).mockResolvedValue([resource]);
    vi.mocked(getForgeCheckoutEvidence).mockResolvedValue([archive]);
    if (source === "container") vi.mocked(getForgeResources).mockRejectedValue(new Error("Resource journal unavailable."));
    else if (source === "checkout") vi.mocked(getForgeCheckoutEvidence).mockRejectedValue(new Error("Checkout checksum verification failed."));
    else vi.mocked(getForgeGitHistory).mockRejectedValue(new Error("Git history checksum verification failed."));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(source === "container" ? "Resource journal unavailable" : source === "checkout" ? "Checkout checksum verification failed" : "Git history checksum verification failed");
    expect(container.querySelectorAll("a[download]")).toHaveLength(source === "Git history" ? 4 : 2);
    expect(container.querySelector("button")).toBeNull();
  });
  it("loads and refreshes evidence through Forge revision changes without retry controls", async () => {
    let finish!: (value: DisposableResource[]) => void;
    vi.mocked(getForgeResources).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading saved evidence…");
    await act(async () => finish([resource]));
    expect(container.textContent).toContain("regression-env");
    const previous = vi.mocked(getForgeResources).mock.calls[0]![0]!;
    await render(1);
    expect(previous.aborted).toBe(true);
    expect(container.querySelector("article")).toBeNull();
    expect(getForgeResources).toHaveBeenCalledTimes(2);
    expect(getForgeCheckoutEvidence).toHaveBeenCalledTimes(2);
    expect(getForgeGitHistory).toHaveBeenCalledTimes(2);
  });
  it("aborts all requests and ignores an old response after closing the evidence view", async () => {
    let finish!: (value: DisposableResource[]) => void;
    vi.mocked(getForgeResources).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render();
    const resourcesSignal = vi.mocked(getForgeResources).mock.calls[0]![0]!;
    const archivesSignal = vi.mocked(getForgeCheckoutEvidence).mock.calls[0]![0]!;
    const historySignal = vi.mocked(getForgeGitHistory).mock.calls[0]![0]!;
    await act(async () => root!.unmount()); root = undefined;
    await act(async () => finish([resource]));
    expect(resourcesSignal.aborted).toBe(true); expect(archivesSignal.aborted).toBe(true);
    expect(historySignal.aborted).toBe(true);
    expect(container.textContent).toBe("");
  });
});
