// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentationRevisions } from "./DocumentationRevisions.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => document.body.replaceChildren());

async function renderPanel(pendingCleanup: Array<{ documentId: string; purgeId: number; error: string }> = []) {
  const call = vi.fn(async (hook: string, _input: unknown) => {
    if (hook.endsWith("revisions")) return { revisions: [
      { document_id: "current", title: "Board", content_sha256: "a".repeat(64), state: "active", created_at: "2026-09-11" },
      { document_id: "old", title: "Board", content_sha256: "b".repeat(64), state: "superseded", created_at: "2026-09-10" }
    ], pendingCleanup };
    if (hook.endsWith("checkRevision")) return { status: "new-revision" };
    if (hook.endsWith("refresh")) return { status: "refreshed", documentId: "new" };
    pendingCleanup.splice(0);
    return { purged: true, cleanupPending: false, retainedDocument: false };
  });
  const refresh = vi.fn(async (_id: string) => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(DocumentationRevisions, { documentId: "current", callHook: call as never, onRefresh: refresh })));
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error(`Missing ${label}`);
    await act(async () => button.click());
  };
  return { call, refresh, root, container, click };
}

it("shows retained revisions and requires an explicit permanent deletion action", async () => {
  const panel = await renderPanel();
  await panel.click("Source revisions");
  expect(panel.container.textContent).toContain("superseded");
  expect([...panel.container.querySelectorAll("button")].filter((button) => button.textContent?.includes("Delete old revision"))).toHaveLength(1);
  await panel.click("Delete old revision");
  expect(panel.call.mock.calls.some(([hook]) => hook.endsWith("purge"))).toBe(false);
  await panel.click("Delete permanently");
  expect(panel.call).toHaveBeenCalledWith("documentation.documents.purge", expect.objectContaining({ documentId: "old" }));
  await act(async () => panel.root.unmount());
});

it("checks the selected source before offering to import a changed revision", async () => {
  const panel = await renderPanel();
  await panel.click("Source revisions");
  expect(panel.container.textContent).not.toContain("Import latest revision");
  await panel.click("Check for a new revision");
  expect(panel.call).toHaveBeenCalledWith("documentation.documents.checkRevision", { documentId: "current" });
  await panel.click("Import latest revision");
  expect(panel.refresh).toHaveBeenCalledWith("new");
  await act(async () => panel.root.unmount());
});

it("does not refresh selection when an older source request completes after unmount", async () => {
  const panel = await renderPanel();
  await panel.click("Source revisions");
  await panel.click("Check for a new revision");
  let release!: (result: { status: string; documentId: string }) => void;
  panel.call.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }) as never);
  await panel.click("Import latest revision");
  await act(async () => panel.root.unmount());
  await act(async () => release({ status: "refreshed", documentId: "late-revision" }));
  expect(panel.refresh).not.toHaveBeenCalled();
});


it("exposes retained file cleanup after reloading a purged revision family", async () => {
  const panel = await renderPanel([{ documentId: "purged-old", purgeId: 1, error: "Read-only retained directory" }]);
  await panel.click("Source revisions");
  expect(panel.container.textContent).toContain("Read-only retained directory");
  expect(panel.container.textContent).toContain("Retry file cleanup");
  expect(panel.container.textContent).not.toContain("Old revision permanently deleted.");
  await panel.click("Retry file cleanup");
  expect(panel.call).toHaveBeenCalledWith("documentation.documents.purge", expect.objectContaining({ documentId: "purged-old" }));
  expect(panel.container.textContent).not.toContain("Retry file cleanup");
  expect(panel.container.textContent).toContain("Old revision permanently deleted.");
  await act(async () => panel.root.unmount());
});
