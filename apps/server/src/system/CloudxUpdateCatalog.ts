import type { CloudxUpdateChannel, CloudxUpdatePreview } from "@cloudx/shared";

const repository = "davidomil/cloudx";
const githubUrl = `https://github.com/${repository}`;
const apiUrl = `https://api.github.com/repos/${repository}`;
const pageSize = 100;
const maxPages = 5;
const maxResponseBytes = 2 * 1024 * 1024;
const lookupTimeoutMs = 20_000;
const partialChangelogMessage = "The merged pull request changelog is incomplete. Open the comparison on GitHub for the full changes.";

type Target = NonNullable<CloudxUpdatePreview["target"]>;
type Comparison = { status: "ahead" | "behind" | "identical" | "diverged"; total: number; commits: string[] };
type Page = { data: unknown; hasNext: boolean };

class CatalogError extends Error {}

export class CloudxUpdateCatalog {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async preview(channel: CloudxUpdateChannel, currentCommit: string): Promise<CloudxUpdatePreview> {
    const preview: CloudxUpdatePreview = {
      channel, currentCommit, checkedAt: new Date().toISOString(), state: "unavailable",
      changelog: [], changelogComplete: false
    };
    if (!isCommit(currentCommit)) return { ...preview, message: "The installed commit could not be verified." };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), lookupTimeoutMs);
    try {
      preview.target = await this.target(channel, controller.signal);
      if (preview.target.commit === currentCommit.toLowerCase()) {
        return { ...preview, state: "current", changelogComplete: true };
      }
      const range = `${currentCommit}...${preview.target.commit}`;
      preview.compareUrl = `${githubUrl}/compare/${range}`;
      const firstPage = await this.request(`/compare/${range}?per_page=${pageSize}&page=1`, controller.signal);
      const comparison = parseComparison(firstPage.data);
      if (comparison.status === "identical") throw new CatalogError("GitHub returned an inconsistent commit comparison.");
      preview.state = { ahead: "available", behind: "ahead", diverged: "diverged" }[comparison.status] as CloudxUpdatePreview["state"];
      if (preview.state !== "available") {
        return {
          ...preview, changelogComplete: true,
          ...(preview.state === "ahead" ? { message: "The installed commit is ahead of the selected version." } : {}),
          ...(preview.state === "diverged" ? { message: "The installed commit and selected version have diverged. Review the comparison before updating." } : {})
        };
      }

      const changelog = await this.changelog(range, comparison, controller.signal);
      return {
        ...preview, ...changelog,
        ...(!changelog.changelogComplete ? { message: partialChangelogMessage } : {})
      };
    } catch (error) {
      return {
        ...preview, state: "unavailable",
        message: controller.signal.aborted ? "The GitHub update check timed out. Check again when the connection is available."
          : error instanceof CatalogError ? error.message : "GitHub could not be reached to check for updates."
      };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  private async target(channel: CloudxUpdateChannel, signal: AbortSignal): Promise<Target> {
    if (channel === "main") {
      const { data } = await this.request("/commits/main", signal);
      const commit = parseCommit(data);
      return { commit, name: "main", url: `${githubUrl}/commit/${commit}` };
    }
    const { data } = await this.request("/releases/latest", signal);
    if (!isRecord(data) || data.draft !== false || data.prerelease !== false || !isText(data.tag_name, 256)) {
      throw new CatalogError("GitHub returned an invalid published release.");
    }
    const tag = encodeURIComponent(data.tag_name);
    const commit = await this.request(`/commits/${tag}`, signal);
    return { commit: parseCommit(commit.data), name: data.tag_name, url: `${githubUrl}/releases/tag/${tag}` };
  }

  private async changelog(range: string, comparison: Comparison, signal: AbortSignal): Promise<Pick<CloudxUpdatePreview, "changelog" | "changelogComplete">> {
    const commits = new Set(comparison.commits);
    let complete = true;
    try {
      for (let page = 2; commits.size < comparison.total && page <= maxPages; page++) {
        const response = await this.request(`/compare/${range}?per_page=${pageSize}&page=${page}`, signal);
        const next = parseComparison(response.data);
        if (next.status !== comparison.status || next.total !== comparison.total || next.commits.length === 0) {
          throw new CatalogError("GitHub returned an inconsistent comparison.");
        }
        for (const commit of next.commits) commits.add(commit);
      }
    } catch {
      complete = false;
    }
    if (commits.size !== comparison.total) complete = false;

    const pullRequests = new Map<number, CloudxUpdatePreview["changelog"][number]>();
    try {
      for (let page = 1; page <= maxPages; page++) {
        const response = await this.request(`/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`, signal);
        if (!Array.isArray(response.data) || response.data.length > pageSize) {
          throw new CatalogError("GitHub returned an invalid pull request list.");
        }
        for (const value of response.data) {
          const pull = parsePullRequest(value);
          if (pull.base === "main" && pull.merged && pull.commit && commits.has(pull.commit)) {
            pullRequests.set(pull.number, { number: pull.number, title: pull.title, url: `${githubUrl}/pull/${pull.number}` });
          }
        }
        if (!response.hasNext) break;
        if (page === maxPages) complete = false;
      }
    } catch {
      complete = false;
    }
    return { changelog: [...pullRequests.values()], changelogComplete: complete };
  }

  private async request(endpoint: string, signal: AbortSignal): Promise<Page> {
    signal.throwIfAborted();
    const response = await this.fetcher(`${apiUrl}${endpoint}`, {
      signal, redirect: "error", credentials: "omit",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" }
    });
    const reader = response.body?.getReader();
    try {
      if (!response.ok) {
        if (response.status === 404 && endpoint === "/releases/latest") throw new CatalogError("No published releases were found.");
        if (response.status === 403 || response.status === 429) throw new CatalogError("GitHub limited the update check. Check again later.");
        if (response.status === 404) throw new CatalogError("The selected version or installed commit could not be found on GitHub.");
        throw new CatalogError("GitHub could not provide update information.");
      }
      if (!reader || Number(response.headers.get("content-length")) > maxResponseBytes) {
        throw new CatalogError("GitHub returned an invalid or oversized update response.");
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) throw new CatalogError("GitHub returned an oversized update response.");
        chunks.push(value);
      }
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new CatalogError("GitHub returned invalid update data."); }
      return { data, hasNext: /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "") };
    } finally {
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
}

function parseCommit(value: unknown): string {
  if (!isRecord(value) || !isCommit(value.sha)) throw new CatalogError("GitHub returned an invalid commit.");
  return value.sha.toLowerCase();
}

function parseComparison(value: unknown): Comparison {
  if (!isRecord(value) || typeof value.status !== "string" || !["ahead", "behind", "identical", "diverged"].includes(value.status)
    || !Number.isSafeInteger(value.total_commits) || (value.total_commits as number) < 0
    || !Array.isArray(value.commits) || value.commits.length > pageSize) {
    throw new CatalogError("GitHub returned an invalid commit comparison.");
  }
  const commits = value.commits.map(parseCommit);
  if (commits.length > (value.total_commits as number) || (value.status === "ahead" && value.total_commits === 0)) {
    throw new CatalogError("GitHub returned an inconsistent commit comparison.");
  }
  return { status: value.status as Comparison["status"], total: value.total_commits as number, commits };
}

function parsePullRequest(value: unknown): { number: number; title: string; base: string; merged: boolean; commit: string | null } {
  if (!isRecord(value) || !Number.isSafeInteger(value.number) || (value.number as number) <= 0 || !isText(value.title, 512)
    || !isRecord(value.base) || !isText(value.base.ref, 256)
    || (value.merged_at !== null && (typeof value.merged_at !== "string" || value.merged_at.length > 32 || !Number.isFinite(Date.parse(value.merged_at))))
    || (value.merge_commit_sha !== null && !isCommit(value.merge_commit_sha))
    || (value.merged_at !== null && value.merge_commit_sha === null)) {
    throw new CatalogError("GitHub returned invalid pull request metadata.");
  }
  return {
    number: value.number as number, title: value.title, base: value.base.ref,
    merged: value.merged_at !== null, commit: typeof value.merge_commit_sha === "string" ? value.merge_commit_sha.toLowerCase() : null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function isText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}
