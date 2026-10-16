import { afterEach, expect, it, vi } from "vitest";
import { diagnosticSnapshotArchiveUrl, getForgeDiagnosticSnapshots, recoverForgeDiagnosticSnapshot } from "./forgeDiagnosticSnapshotsApi.js";

afterEach(() => vi.unstubAllGlobals());

it("loads every snapshot and hold without caching and preserves exact archive and recovery paths", async () => {
  const inventory = { snapshots: [{ workerId: "worker/1", path: ".cloudx/source with spaces", hold: "Preserve changed source" }], errors: ["Another worker requires ownership review"] };
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(inventory))).mockResolvedValueOnce(new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(getForgeDiagnosticSnapshots(signal)).resolves.toEqual(inventory);
  expect(fetch).toHaveBeenNthCalledWith(1, "/api/forge/diagnostic-snapshots", { cache: "no-store", signal, headers: undefined });
  await recoverForgeDiagnosticSnapshot("worker/1", ".cloudx/source with spaces", signal);
  expect(fetch).toHaveBeenNthCalledWith(2, "/api/forge/workers/worker%2F1/snapshots/recover", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: ".cloudx/source with spaces" }), signal,
  });
  expect(diagnosticSnapshotArchiveUrl("worker/1", ".cloudx/source with spaces")).toBe("/api/forge/workers/worker%2F1/snapshots/archive?path=.cloudx%2Fsource+with+spaces");
});

it("exposes server recovery failures without issuing another recovery request", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Diagnostic snapshot ownership changed" }), { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  await expect(recoverForgeDiagnosticSnapshot("worker", "source")).rejects.toThrow("Diagnostic snapshot ownership changed");
  expect(fetch).toHaveBeenCalledOnce();
});
