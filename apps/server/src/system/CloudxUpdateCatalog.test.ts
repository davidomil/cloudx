import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudxUpdateCatalog } from "./CloudxUpdateCatalog.js";

const sha = (number: number) => number.toString(16).padStart(40, "0");
const installed = sha(1);
const target = sha(2);
const merge = sha(3);
const squash = sha(4);
const rebase = sha(5);
const api = "https://api.github.com/repos/davidomil/cloudx";
const website = "https://github.com/davidomil/cloudx";
const range = `${installed}...${target}`;
const nextPage = { link: '<https://untrusted.example/next>; rel="next"' };

function response(data: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { headers });
}

function comparison(commits = [merge], status = "ahead", total = commits.length): Response {
  return response({ status, total_commits: total, commits: commits.map(sha => ({ sha })) });
}

function pull(number: number, commit: string | null = merge, changes: Record<string, unknown> = {}) {
  return { number, title: `Change ${number}`, base: { ref: "main" }, merged_at: "2026-09-15T12:00:00Z", merge_commit_sha: commit, ...changes };
}

function catalog(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const result of responses) fetcher.mockResolvedValueOnce(result);
  return { catalog: new CloudxUpdateCatalog(fetcher), fetcher };
}

afterEach(() => vi.useRealTimers());

describe("CloudxUpdateCatalog", () => {
  it("resolves a published release tag to its actual commit and includes merged changes", async () => {
    const { catalog: updates, fetcher } = catalog(
      response({ tag_name: "v1.2.3", draft: false, prerelease: false, target_commitish: "wrong-branch", html_url: "https://untrusted.example" }),
      response({ sha: target }), comparison(), response([pull(82)])
    );
    expect(await updates.preview("releases", installed)).toEqual({
      channel: "releases", currentCommit: installed, checkedAt: expect.any(String), state: "available",
      target: { commit: target, name: "v1.2.3", url: `${website}/releases/tag/v1.2.3` },
      compareUrl: `${website}/compare/${range}`,
      changelog: [{ number: 82, title: "Change 82", url: `${website}/pull/82` }], changelogComplete: true
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${api}/releases/latest`, `${api}/commits/v1.2.3`, `${api}/compare/${range}?per_page=100&page=1`,
      `${api}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=1`
    ]);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({
        redirect: "error", credentials: "omit", signal: expect.any(AbortSignal),
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" }
      });
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
  });

  it("compares main and includes merge, squash, and rebase PRs by their merged commit", async () => {
    const { catalog: updates, fetcher } = catalog(response({ sha: target }), comparison([merge, squash, rebase]), response([
      pull(1, merge, { title: "Merge method" }), pull(2, squash, { title: "Squash method" }), pull(3, rebase, { title: "Rebase method" }),
      pull(4, sha(100)), pull(5, merge, { merged_at: null }), pull(6, merge, { base: { ref: "feature" } })
    ]));
    const preview = await updates.preview("main", installed);
    expect(preview).toMatchObject({ state: "available", target: { commit: target, name: "main", url: `${website}/commit/${target}` }, changelogComplete: true });
    expect(preview.changelog.map(pull => pull.number)).toEqual([1, 2, 3]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${api}/commits/main`);
  });

  it("reports the installed target as current without requesting a comparison", async () => {
    const { catalog: updates, fetcher } = catalog(response({ sha: installed }));
    expect(await updates.preview("main", installed)).toMatchObject({ state: "current", changelog: [], changelogComplete: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["behind", "ahead"], ["diverged", "diverged"]
  ])("maps comparison %s to update state %s", async (status, state) => {
    const { catalog: updates, fetcher } = catalog(response({ sha: target }), comparison([], status));
    expect(await updates.preview("main", installed)).toMatchObject({ state, changelog: [], changelogComplete: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an identical comparison when the installed and target commits differ", async () => {
    const { catalog: updates, fetcher } = catalog(response({ sha: target }), comparison([], "identical"));
    expect(await updates.preview("main", installed)).toMatchObject({
      state: "unavailable", target: { commit: target }, message: "GitHub returned an inconsistent commit comparison."
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not guess a current version when the installed commit is unknown", async () => {
    const { catalog: updates, fetcher } = catalog();
    expect(await updates.preview("main", "unknown")).toMatchObject({ state: "unavailable", message: expect.stringContaining("installed commit") });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports that no published releases exist", async () => {
    const { catalog: updates } = catalog(new Response(null, { status: 404 }));
    expect(await updates.preview("releases", installed)).toMatchObject({ state: "unavailable", message: "No published releases were found." });
  });

  it.each([
    { tag_name: "v1", draft: true, prerelease: false },
    { tag_name: "v1", draft: false, prerelease: true },
    { tag_name: "v1", draft: false },
    { tag_name: "", draft: false, prerelease: false },
    { tag_name: "x".repeat(257), draft: false, prerelease: false }
  ])("rejects invalid published release metadata: %j", async release => {
    const { catalog: updates, fetcher } = catalog(response(release));
    expect(await updates.preview("releases", installed)).toMatchObject({ state: "unavailable", message: expect.stringContaining("invalid published release") });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("encodes a release tag as a single API and website path component", async () => {
    const { catalog: updates, fetcher } = catalog(
      response({ tag_name: "release/1", draft: false, prerelease: false }), response({ sha: installed })
    );
    expect(await updates.preview("releases", installed)).toMatchObject({ target: { url: `${website}/releases/tag/release%2F1` } });
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${api}/commits/release%2F1`);
  });

  it.each([null, [], { sha: "short" }, { sha: "z".repeat(40) }])("rejects an invalid target commit: %j", async payload => {
    const { catalog: updates } = catalog(response(payload));
    expect(await updates.preview("main", installed)).toMatchObject({ state: "unavailable", message: expect.stringContaining("invalid commit") });
  });

  it("keeps a known target but reports unavailable when the installed commit is not on GitHub", async () => {
    const { catalog: updates } = catalog(response({ sha: target }), new Response(null, { status: 404 }));
    expect(await updates.preview("main", installed)).toMatchObject({
      state: "unavailable", target: { commit: target }, compareUrl: `${website}/compare/${range}`,
      message: expect.stringContaining("could not be found on GitHub")
    });
  });

  it.each([403, 429])("reports rate limiting without retrying HTTP %s", async status => {
    const { catalog: updates, fetcher } = catalog(new Response("private response", { status }));
    expect(await updates.preview("main", installed)).toMatchObject({ state: "unavailable", message: "GitHub limited the update check. Check again later." });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds an unreachable GitHub check to twenty seconds", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("private transport error")), { once: true });
    }));
    const result = new CloudxUpdateCatalog(fetcher).preview("main", installed);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ state: "unavailable", message: expect.stringContaining("timed out") });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves a verified available target when the changelog exhausts the shared timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: target }))
      .mockResolvedValueOnce(comparison())
      .mockImplementationOnce(async (_url, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const result = new CloudxUpdateCatalog(fetcher).preview("main", installed);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({
      state: "available", target: { commit: target }, changelogComplete: false,
      message: expect.stringContaining("incomplete"), compareUrl: `${website}/compare/${range}`
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reports transport errors without disclosing their contents", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private credential detail"));
    expect(await new CloudxUpdateCatalog(fetcher).preview("main", installed)).toMatchObject({ state: "unavailable", message: "GitHub could not be reached to check for updates." });
  });

  it.each([
    () => new Response("invalid JSON"),
    () => new Response("{}", { headers: { "content-length": String(3 * 1024 * 1024) } }),
    () => new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "content-length": "1" } }),
    () => new Response(null),
    () => new Response(null, { status: 502 })
  ])("rejects invalid, oversized, and failed responses", async makeResponse => {
    const { catalog: updates } = catalog(makeResponse());
    expect(await updates.preview("main", installed)).toMatchObject({ state: "unavailable", changelogComplete: false });
  });

  it.each([
    { status: 502, bytes: 1, declaredBytes: "1" },
    { status: 200, bytes: 1, declaredBytes: String(3 * 1024 * 1024) },
    { status: 200, bytes: 2 * 1024 * 1024 + 1, declaredBytes: "1" }
  ])("cancels unread response bytes after an early failure: %j", async ({ status, bytes, declaredBytes }) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); }, cancel });
    const { catalog: updates } = catalog(new Response(body, { status, headers: { "content-length": declaredBytes } }));
    expect(await updates.preview("main", installed)).toMatchObject({ state: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("cancels a failed comparison body before continuing to the partial changelog", async () => {
    const cancel = vi.fn(async () => { throw new Error("cleanup failed"); });
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1)); }, cancel });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ sha: target }))
      .mockResolvedValueOnce(comparison([merge], "ahead", 101))
      .mockResolvedValueOnce(new Response(body, { status: 502 }))
      .mockImplementationOnce(async () => {
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
        return response([pull(1)]);
      });
    expect(await new CloudxUpdateCatalog(fetcher).preview("main", installed)).toMatchObject({
      state: "available", changelogComplete: false, changelog: [{ number: 1 }]
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    { status: "unknown", total_commits: 0, commits: [] },
    { status: "ahead", total_commits: 0, commits: [] },
    { status: "ahead", total_commits: -1, commits: [] },
    { status: "ahead", total_commits: 1, commits: [{ sha: "invalid" }] },
    { status: "ahead", total_commits: 1, commits: {} }
  ])("rejects invalid comparisons without claiming a version is current", async payload => {
    const { catalog: updates } = catalog(response({ sha: target }), response(payload));
    expect(await updates.preview("main", installed)).toMatchObject({ state: "unavailable", target: { commit: target }, changelogComplete: false });
  });

  it("paginates the commit range and PR list without following remote pagination URLs", async () => {
    const firstCommits = Array.from({ length: 100 }, (_, i) => sha(i + 10));
    const lastCommit = sha(110);
    const firstPulls = [pull(1, firstCommits[0]), ...Array.from({ length: 99 }, (_, i) => pull(i + 2, sha(900)))];
    const { catalog: updates, fetcher } = catalog(
      response({ sha: target }), comparison(firstCommits, "ahead", 101), comparison([lastCommit], "ahead", 101),
      response(firstPulls, nextPage), response([pull(101, lastCommit), pull(1, firstCommits[0])])
    );
    const preview = await updates.preview("main", installed);
    expect(preview.changelog.map(pull => pull.number)).toEqual([1, 101]);
    expect(preview.changelogComplete).toBe(true);
    expect(fetcher.mock.calls[2]?.[0]).toBe(`${api}/compare/${range}?per_page=100&page=2`);
    expect(fetcher.mock.calls[4]?.[0]).toBe(`${api}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=2`);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(api))).toBe(true);
  });

  it("marks the changelog partial when a comparison exceeds five pages", async () => {
    const pages = Array.from({ length: 5 }, (_, page) => comparison(Array.from({ length: 100 }, (_, i) => sha(page * 100 + i + 10)), "ahead", 501));
    const { catalog: updates, fetcher } = catalog(response({ sha: target }), ...pages, response([pull(1, sha(10))]));
    expect(await updates.preview("main", installed)).toMatchObject({
      state: "available", changelogComplete: false, changelog: [{ number: 1 }],
      compareUrl: `${website}/compare/${range}`, message: expect.stringContaining("incomplete")
    });
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it("marks the changelog partial when more than five PR pages remain", async () => {
    const pages = Array.from({ length: 5 }, () => response([pull(1)], nextPage));
    const { catalog: updates, fetcher } = catalog(response({ sha: target }), comparison(), ...pages);
    expect(await updates.preview("main", installed)).toMatchObject({ state: "available", changelogComplete: false, changelog: [{ number: 1 }] });
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it("preserves known PRs when a later PR page fails", async () => {
    const { catalog: updates } = catalog(response({ sha: target }), comparison(), response([pull(1)], nextPage), new Response(null, { status: 429 }));
    expect(await updates.preview("main", installed)).toMatchObject({ state: "available", changelogComplete: false, changelog: [{ number: 1 }], message: expect.stringContaining("incomplete") });
  });

  it("uses known range commits when a later comparison page fails", async () => {
    const { catalog: updates } = catalog(response({ sha: target }), comparison([merge], "ahead", 101), new Response(null, { status: 502 }), response([pull(1)]));
    expect(await updates.preview("main", installed)).toMatchObject({ state: "available", changelogComplete: false, changelog: [{ number: 1 }] });
  });

  it("marks inconsistent comparison pages partial", async () => {
    const { catalog: updates } = catalog(response({ sha: target }), comparison([merge], "ahead", 101), comparison([], "ahead", 101), response([pull(1)]));
    expect(await updates.preview("main", installed)).toMatchObject({ state: "available", changelogComplete: false, changelog: [{ number: 1 }] });
  });

  it.each([
    {}, [pull(-1)], [pull(1, null)], [pull(1, "wrong")], [pull(1, merge, { title: "x".repeat(513) })],
    [pull(1, merge, { merged_at: "invalid" })], [pull(1, merge, { base: null })]
  ])("keeps update availability explicit when PR metadata is malformed", async payload => {
    const { catalog: updates } = catalog(response({ sha: target }), comparison(), response(payload));
    expect(await updates.preview("main", installed)).toMatchObject({ state: "available", changelogComplete: false, message: expect.stringContaining("incomplete") });
  });

  it("shows an empty complete changelog when range commits came from no merged PRs", async () => {
    const { catalog: updates } = catalog(response({ sha: target }), comparison(), response([pull(1, sha(900)), pull(2, null, { merged_at: null })]));
    expect(await updates.preview("main", installed)).toMatchObject({ state: "available", changelog: [], changelogComplete: true });
  });
});
