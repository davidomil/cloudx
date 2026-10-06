import { afterEach, expect, it, vi } from "vitest";
import { forgeEvidenceFileUrl, getForgeResources } from "./forgeResourcesApi.js";
afterEach(() => vi.unstubAllGlobals());
it("loads saved resource evidence with cancellation and exact download paths", async () => {
  const resource = { id: "resource-1", state: "deleted" };
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ resources: [resource] })));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(getForgeResources(signal)).resolves.toEqual([resource]);
  expect(fetch).toHaveBeenNthCalledWith(1, "/api/forge/resources", { cache: "no-store", signal, headers: undefined });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(forgeEvidenceFileUrl("resource-1", "work/log with spaces.txt")).toBe("/api/forge/resources/resource-1/evidence-file?path=work%2Flog+with+spaces.txt");
});
