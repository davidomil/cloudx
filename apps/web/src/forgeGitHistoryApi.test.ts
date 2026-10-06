import { afterEach, expect, it, vi } from "vitest";
import { getForgeGitHistory, gitHistoryBundleUrl, gitHistoryManifestUrl } from "./forgeGitHistoryApi.js";

afterEach(() => vi.unstubAllGlobals());

it("reads archived Git history with cancellation and exact read-only download URLs", async () => {
  const archive = { archiveId: "archive-1", refs: [{ name: "refs/cloudx/before-rebase/snapshot-1", commitSha: "a".repeat(40) }] };
  const fetch = vi.fn().mockResolvedValue(Response.json({ archives: [archive] }));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(getForgeGitHistory(signal)).resolves.toEqual([archive]);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/forge/git-history", { cache: "no-store", signal, headers: undefined });
  expect(gitHistoryManifestUrl("archive 1")).toBe("/api/forge/git-history/archive%201");
  expect(gitHistoryBundleUrl("archive 1")).toBe("/api/forge/git-history/archive%201/file");
});
