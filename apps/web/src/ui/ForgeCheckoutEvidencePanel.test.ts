// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getForgeCheckoutEvidence } from "../forgeCheckoutEvidenceApi.js";
import { ForgeCheckoutEvidencePanel } from "./ForgeCheckoutEvidencePanel.js";

vi.mock("../forgeCheckoutEvidenceApi.js", () => ({
  getForgeCheckoutEvidence: vi.fn(),
  checkoutEvidenceManifestUrl: (id: string) => `/api/forge/checkout-evidence/${id}`,
  checkoutEvidenceFileUrl: (id: string, path: string) => `/api/forge/checkout-evidence/${id}/file?${new URLSearchParams({ path })}`,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.resetAllMocks(); });

it("keeps provenance and exact file downloads available independently of retired workers", async () => {
  vi.mocked(getForgeCheckoutEvidence).mockResolvedValue([{ archiveId: "archive-1", workerId: "worker-1", attemptId: "attempt-1",
    commitSha: "a".repeat(40), checkoutIdentity: { dev: "1", ino: "2" }, paths: ["reports"], exportedAt: "2026-10-05T00:00:00.000Z",
    files: [{ path: "reports/coverage.json", bytes: 34_048_143, sha256: "b".repeat(64) }], bytes: 34_048_143 }]);
  await act(async () => root.render(createElement(ForgeCheckoutEvidencePanel)));
  expect(container.textContent).toContain("worker-1"); expect(container.textContent).toContain("attempt-1");
  expect(container.textContent).toContain("a".repeat(40)); expect(container.textContent).toContain("34,048,143");
  expect(container.querySelector('a[href*="/file"]')?.getAttribute("href")).toBe("/api/forge/checkout-evidence/archive-1/file?path=reports%2Fcoverage.json");
  expect(container.querySelectorAll("a[download]")).toHaveLength(2);
  const signal = vi.mocked(getForgeCheckoutEvidence).mock.calls[0]![0]!;
  await act(async () => root.unmount()); expect(signal.aborted).toBe(true);
});

it("surfaces failed verification and refreshes explicitly", async () => {
  vi.mocked(getForgeCheckoutEvidence).mockRejectedValueOnce(new Error("Durable checksum verification failed.")).mockResolvedValue([]);
  await act(async () => root.render(createElement(ForgeCheckoutEvidencePanel)));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Durable checksum verification failed.");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.textContent).toContain("No exported checkout evidence."); expect(container.querySelector('[role="alert"]')).toBeNull();
});
