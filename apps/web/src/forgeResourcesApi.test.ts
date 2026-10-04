import { afterEach, expect, it, vi } from "vitest";
import { decideForgeEvidence, forgeEvidenceFileUrl, getForgeResources } from "./forgeResourcesApi.js";
afterEach(() => vi.unstubAllGlobals());
it("loads resources with cancellation and submits the exact evidence decision", async () => {
  const resource = { id: "resource-1", state: "deleted" };
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ resources: [resource] }))).mockResolvedValueOnce(new Response(JSON.stringify(resource)));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(getForgeResources(signal)).resolves.toEqual([resource]);
  expect(fetch).toHaveBeenNthCalledWith(1, "/api/forge/resources", { cache: "no-store", signal, headers: undefined });
  await expect(decideForgeEvidence("resource-1", { action: "discard", confirmation: "Discard evidence" })).resolves.toEqual(resource);
  expect(fetch).toHaveBeenNthCalledWith(2, "/api/forge/resources/resource-1/evidence-decision", { method: "POST", body: JSON.stringify({ action: "discard", confirmation: "Discard evidence" }), headers: { "content-type": "application/json" } });
  expect(forgeEvidenceFileUrl("resource-1", "work/log with spaces.txt")).toBe("/api/forge/resources/resource-1/evidence-file?path=work%2Flog+with+spaces.txt");
});
