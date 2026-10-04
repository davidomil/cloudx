// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisposableResource } from "@cloudx/shared";
import { ForgeResourcesPanel } from "./ForgeResourcesPanel.js";
import { getForgeResources, decideForgeEvidence } from "../forgeResourcesApi.js";

vi.mock("../forgeResourcesApi.js", () => ({
  getForgeResources: vi.fn(), decideForgeEvidence: vi.fn(),
  forgeEvidenceFileUrl: (id: string, path: string) => `/api/forge/resources/${id}/evidence-file?${new URLSearchParams({ path })}`,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const held: DisposableResource = { id: "resource-1", kind: "container", engineId: "engine", name: "regression-env", owner: { workerId: "worker-1", attemptId: "attempt-1" }, consumers: [{ workerId: "worker-1", attemptId: "attempt-1" }], retentionReason: "Preserve the navigation reproduction log", state: "blocked", reason: "Select specific evidence before release.", allocatedBytes: 8192, reclaimedBytes: 0, updatedAt: "2026-10-04" };
let root: Root;
let container: HTMLDivElement;
async function render() {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(createElement(ForgeResourcesPanel)); });
  return container;
}
function button(label: string) { return [...container.querySelectorAll("button")].find(item => item.textContent === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }
async function paths(value: string) {
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => { vi.mocked(getForgeResources).mockResolvedValue([structuredClone(held)]); vi.mocked(decideForgeEvidence).mockResolvedValue(held); });
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.replaceChildren(); vi.resetAllMocks(); });

describe("Forge evidence decisions", () => {
  it("shows the specific protection and provenance, then exports only the entered paths", async () => {
    await render();
    expect(container.textContent).toContain(held.retentionReason);
    expect(container.textContent).toContain("worker-1");
    expect(button("Export evidence and release").disabled).toBe(true);
    await paths(" /work/evidence/test.log\n/work/reproduction.json ");
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Evidence commit for regression-env"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "b".repeat(40));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Export evidence and release");
    expect(decideForgeEvidence).toHaveBeenCalledExactlyOnceWith(held.id, { action: "export", evidencePaths: ["/work/evidence/test.log", "/work/reproduction.json"], commitSha: "b".repeat(40) });
    expect(getForgeResources).toHaveBeenCalledTimes(2);
  });
  it("requires a deliberate discard checkbox and disables duplicate decisions while pending", async () => {
    let finish!: (value: DisposableResource) => void;
    vi.mocked(decideForgeEvidence).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render();
    expect(button("Discard evidence and release").disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click("Discard evidence and release");
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(container.textContent).toContain("Applying evidence decision");
    expect(decideForgeEvidence).toHaveBeenCalledExactlyOnceWith(held.id, { action: "discard", confirmation: "Discard evidence" });
    await act(async () => finish(held));
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  });
  it("keeps an explicit hold and surfaces failures with a manual retry", async () => {
    vi.mocked(decideForgeEvidence).mockRejectedValueOnce(new Error("An active shared consumer protects this environment."));
    await render(); await click("Keep evidence hold");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("active shared consumer");
    expect(decideForgeEvidence).toHaveBeenCalledExactlyOnceWith(held.id, { action: "keep" });
    expect(container.querySelector("fieldset")?.disabled).toBe(false);
  });
  it("offers verified downloads after removal and retries removal without re-exporting evidence", async () => {
    const evidence = { state: "verified" as const, paths: ["/work/evidence/test.log"], commitSha: "a".repeat(40), files: [{ path: "work/evidence/test.log", bytes: 18, sha256: "b".repeat(64) }] };
    vi.mocked(getForgeResources).mockResolvedValue([{ ...held, evidence, state: "failed" }]);
    await render();
    const link = container.querySelector<HTMLAnchorElement>('a[href*="evidence-file"]')!;
    expect(link.getAttribute("href")).toContain("path=work%2Fevidence%2Ftest.log");
    expect(container.textContent).toContain(evidence.commitSha);
    await click("Retry environment cleanup");
    expect(decideForgeEvidence).toHaveBeenCalledExactlyOnceWith(held.id, { action: "export" });
    vi.mocked(getForgeResources).mockResolvedValue([{ ...held, evidence, state: "deleted", reclaimedBytes: 8192 }]);
    await click("Refresh environments");
    expect(container.textContent).toContain("8,192 writable bytes reclaimed");
    expect(container.querySelector("fieldset")).toBeNull();
    expect(container.querySelector('a[href*="evidence-file"]')).not.toBeNull();
  });
  it("shows loading errors, refreshes explicitly, and aborts requests when closed", async () => {
    vi.mocked(getForgeResources).mockRejectedValueOnce(new Error("Resource journal unavailable."));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Resource journal unavailable.");
    await click("Refresh environments");
    expect(container.textContent).toContain(held.name);
    const signal = vi.mocked(getForgeResources).mock.calls.at(-1)![0]!;
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);
  });
});
