import { createHash } from "node:crypto";
import type { ForgeChangeRequest, ForgeCiDiagnostic, ForgeRepository } from "@cloudx/shared";
import { ForgeProviderError, ForgeProviderUnavailableError } from "./ForgeProvider.js";
import { integer, string, invalid, webUrl } from "./validation.js";

export type CiJob = ForgeCiDiagnostic["jobs"][number];
export const maxCiFailureJobs = 8;
export const maxCiLogBytes = 128_000;

export function ciDiagnostic(repository: ForgeRepository, change: ForgeChangeRequest): ForgeCiDiagnostic {
  return {
    repository: { ...repository }, changeNumber: change.number,
    sourceHeadSha: change.headSha, targetHeadSha: change.targetHeadSha ?? "",
    failureKey: "", state: "blocked", jobs: [],
  };
}

export function finishCiDiagnostic(diagnostic: ForgeCiDiagnostic): ForgeCiDiagnostic {
  diagnostic.failureKey = createHash("sha256").update(JSON.stringify([
    diagnostic.repository, diagnostic.changeNumber, diagnostic.sourceHeadSha,
    diagnostic.targetHeadSha, diagnostic.testedSha,
    diagnostic.jobs.map(job => [job.runId, job.runAttempt, job.jobId, job.testedSha, job.conclusion]).sort(),
  ])).digest("hex");
  return diagnostic;
}

export function classifyCiLog(log: string): CiJob["classification"] {
  if (/bad credentials|invalid (?:access )?token|authentication failed|permission denied \(publickey\)|could not read username|unauthorized|\b401\b|\b403\b|token (?:has )?expired/i.test(log)) return "credentials";
  if (/billing|spending limit|approval required|must approve|policy violation|workflow (?:is )?disabled|not permitted to run/i.test(log)) return "policy";
  if (/runner (?:lost|offline|unavailable)|lost communication with|failed to (?:start|prepare) (?:runner|environment)|system failure|no space left on device|network is unreachable|connection (?:refused|reset|timed out)|could not resolve host|temporary failure in name resolution|service unavailable|\b502 bad gateway\b|\b503\b/i.test(log)) return "infrastructure";
  if (/assertion(?:error| failed)|\bFAIL(?:ED)?\b.*(?:test|spec)|(?:test|spec).*(?:failed|failure|timed out)|\b(?:TypeError|SyntaxError|ReferenceError|CompileError)\b|\berror TS\d+\b|\berror\[E\d+\]|compilation failed|lint.*(?:error|failed)|eslint|prettier|\bexpected\b.*\b(?:received|actual|equal)\b/i.test(log)) return "code";
  return "unknown";
}

export function ciEvidenceFailure(error: unknown): string {
  if (error instanceof ForgeProviderUnavailableError) return `CI evidence unavailable: ${error.message}`;
  if (error instanceof ForgeProviderError && [401, 403].includes(error.statusCode)) return "CI logs are unavailable: grant the worker permission to read Actions jobs/logs or GitLab job traces.";
  if (error instanceof ForgeProviderError) return `CI evidence blocked: ${sanitizeCiLog(error.message, []).slice(0, 2000)}`;
  return "CI evidence is unavailable, incomplete, or unsafe. Inspect the failing job and provider permissions before resuming.";
}

export function classifyDiagnostic(diagnostic: ForgeCiDiagnostic): void {
  if (!diagnostic.jobs.length) {
    diagnostic.state = "blocked";
    diagnostic.reason = "No current failed job evidence is available.";
    return;
  }
  const blocked = diagnostic.jobs.find(job => job.classification !== "code" || !job.log?.trim() || !job.testedSha);
  if (blocked) {
    diagnostic.state = "blocked";
    diagnostic.reason = `CI job ${blocked.name} has ${blocked.classification} failure evidence. Inspect ${blocked.url} before changing application code.`;
  } else {
    diagnostic.state = "actionable";
    delete diagnostic.reason;
  }
}

export function ciSha(value: unknown): string {
  const sha = string(value);
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(sha)) return invalid();
  return sha;
}

export function ciId(value: unknown): number {
  const id = integer(value);
  if (!id) return invalid();
  return id;
}

export function ciJobName(value: unknown): string {
  const name = sanitizeCiLog(string(value), []).slice(0, 500);
  if (!name.trim()) return invalid();
  return name;
}

export function ciUrl(value: unknown): string {
  const url = new URL(webUrl(value));
  if (url.protocol !== "https:") return invalid();
  url.search = "";
  url.hash = "";
  if (url.href.length > 2048) return invalid();
  return url.href;
}

export function sanitizeCiLog(text: string, secrets: string[]): string {
  let clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) clean = clean.split(secret).join("[REDACTED]");
  return clean
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]+/gi, "[REDACTED AUTHORIZATION]")
    .replace(/(\b[A-Za-z0-9_]{0,80}(?:password|passwd|secret|token|api[_-]?key|authorization|credential)[A-Za-z0-9_]{0,80}\s*[=:]\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try {
        const url = new URL(value);
        if (url.username || url.password) { url.username = "REDACTED"; url.password = ""; }
        if (url.search) url.search = "?REDACTED";
        return url.href;
      } catch { return "[REDACTED URL]"; }
    });
}

export async function readCiLog(response: Response, secrets: string[]): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxCiLogBytes - bytes;
      chunks.push(value.subarray(0, remaining));
      bytes += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining || bytes === maxCiLogBytes) { truncated = true; break; }
    }
  } finally { await reader.cancel(); }
  let text = Buffer.concat(chunks).toString("utf8");
  if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  const clean = sanitizeCiLog(text, secrets);
  const excerpt = clean.slice(0, 31_900);
  return truncated || excerpt.length < clean.length ? `${excerpt}\n[CI log truncated]` : clean;
}
