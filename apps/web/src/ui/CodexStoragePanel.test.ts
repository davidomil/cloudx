// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexStorageInventory } from "@cloudx/shared";
import { CodexStoragePanel } from "./CodexStoragePanel.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const size = (value: number) => ({ logicalBytes: value, allocatedBytes: value, files: 1 });
const inventory: CodexStorageInventory = {
  measuredAt: "2026-11-23T00:00:00.000Z", sourceHomes: ["/native"], sqliteHomes: ["/native"],
  native: { sessionHistory: size(56 * 1024 ** 3), nativeDatabases: size(4 * 1024 ** 3), userData: size(1024), rebuildableCaches: size(1024) },
  launches: { sessionHistory: size(0), nativeDatabases: size(0), userData: size(1024), rebuildableCaches: size(7 * 1024 ** 3) },
  total: size(67 * 1024 ** 3), warnings: ["A source configuration could not be read."], measurementNote: "Linked history is counted once.",
  maintenance: { selectedVersion: "0.156.1", ownedHistoryDeletion: "unavailable", reason: "The native version has not been verified. Interactive history is retained.", projectionReclamation: "No supported foreground database compaction is available.", retainedHistory: [{ ownerId: "worker", threadId: "11111111-1111-4111-8111-111111111111", state: "retained", reason: "The selected executable does not match the recorded version." }] },
};
async function mount(call: () => Promise<{ storage: CodexStorageInventory }>) {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const hook = vi.fn(call) as unknown as NonNullable<UiContributionRenderContext["callHook"]>;
  const render = async (callHook = hook) => { await act(async () => { root.render(createElement(CodexStoragePanel, { callHook })); }); };
  await render();
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
  const click = async () => { await act(async () => (container.querySelector("button") as HTMLButtonElement).click()); };
  return { container, hook, click, render };
}

describe("Codex storage status", () => {
  it("measures on request and separates shared native history from launch caches and maintenance limits", async () => {
    const f = await mount(async () => ({ storage: inventory }));
    expect(f.hook).not.toHaveBeenCalled();
    await f.click();
    expect(f.hook).toHaveBeenCalledWith("codex-storage.read", {});
    expect(f.container.textContent).toContain("57,344 MiB");
    expect(f.container.textContent).toContain("7,168 MiB");
    expect(f.container.textContent).toContain("Native maintenance (0.156.1): unavailable");
    expect(f.container.textContent).toContain("Interactive history is retained");
    expect(f.container.textContent).toContain(inventory.warnings[0]);
    expect(f.container.querySelector('[aria-label="Retained native conversations"]')?.textContent).toContain(inventory.maintenance.retainedHistory[0].reason);
    expect(f.container.querySelectorAll("tbody tr")).toHaveLength(4);
  });

  it("shows errors and discards an old response after the source hook changes", async () => {
    let resolve!: (value: { storage: CodexStorageInventory }) => void;
    const f = await mount(() => new Promise(done => { resolve = done; }));
    await f.click();
    expect((f.container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    const failed = vi.fn(async () => { throw new Error("Storage unavailable"); }) as unknown as NonNullable<UiContributionRenderContext["callHook"]>;
    await f.render(failed);
    await act(async () => resolve({ storage: inventory }));
    expect(f.container.querySelector("table")).toBeNull();
    await f.click();
    expect(f.container.querySelector('[role="alert"]')?.textContent).toBe("Storage unavailable");
    expect((f.container.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
  });
});
