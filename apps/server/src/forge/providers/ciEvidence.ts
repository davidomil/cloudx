import { createHash } from "node:crypto";
import type { ForgeChangeRequest, ForgeCiDiagnostic, ForgeRepository } from "@cloudx/shared";
import { ForgeProviderError, ForgeProviderUnavailableError } from "./ForgeProvider.js";
import { integer, string, invalid, webUrl } from "./validation.js";

export type CiJob = ForgeCiDiagnostic["jobs"][number];
export const maxCiFailureJobs = 8;
export const maxCiLogBytes = 128_000;
export const maxCiLogScanBytes = 16_000_000;
const maxCiLogCharacters = 31_900;
const operationalCiBlockers = {
  credentials: /bad credentials|invalid (?:access )?token|authentication failed|permission denied \(publickey\)|could not read username|token (?:has )?expired|\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?)\s*[:=]?\s*(?:401|403)\b|\b(?:401 unauthorized|403 forbidden|E401|E403|ERR_PNPM_FETCH_401|ERR_PNPM_FETCH_403)\b|\b(?:error|fatal):\s*(?:unauthorized|forbidden)\b/i,
  policy: /billing|spending limit|approval required|must approve|policy violation|workflow (?:is )?disabled|not permitted to run/i,
  infrastructure: /runner (?:lost|offline|unavailable)|lost communication with|failed to (?:start|prepare) (?:runner|environment)|system failure|no space left on device|network is unreachable|connection (?:refused|reset|timed out)|could not resolve host|temporary failure in name resolution|service unavailable|\b502 bad gateway\b|\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?)\s*[:=]?\s*(?:502|503)\b/i,
};

export interface CiLogEvidence {
  log: string;
  classification: CiJob["classification"];
  checkout: { shas: string[]; invalid: boolean };
}

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
    diagnostic.jobs.map(job => [job.runId, job.runAttempt, job.jobId, job.requiredGate?.jobId, job.testedSha, job.conclusion]).sort(),
  ])).digest("hex");
  return diagnostic;
}

export function classifyCiLog(log: string): CiJob["classification"] {
  const classifier = new CiLogClassifier();
  for (const line of log.split(/\r?\n/)) classifier.add(ciLogLine(line), line);
  classifier.finishRun();
  return classifier.classification;
}

function classifyCiLine(log: string): CiJob["classification"] {
  const assertion = /assertion(?:error| failed)|\bexpected\b.*\b(?:received|actual|equal)\b|\bFAIL(?:ED)?\b.*(?:test|spec)/i.test(log);
  if (!assertion)
    for (const classification of ["credentials", "policy", "infrastructure"] as const)
      if (operationalCiBlockers[classification].test(log)) return classification;
  if (/assertion(?:error| failed)|\bFAIL(?:ED)?\b.*(?:test|spec)|(?:test|spec).*(?:failed|failure|timed out)|\b(?:TypeError|SyntaxError|ReferenceError|CompileError)\b|\berror TS\d+\b|\berror\[E\d+\]|compilation failed|lint.*(?:error|failed)|eslint|prettier|\bexpected\b.*\b(?:received|actual|equal)\b|\blocator\.\w+:\s*(?:Timeout \d+ms exceeded|.*(?:failed|timed out))|\b(?:Error|TimeoutError):\s*expect\([^\r\n]*\)\.[^\r\n]*(?:failed|timed out|timeout)/i.test(log)) return "code";
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
    .replace(/((["'])[A-Za-z0-9_]{0,80}(?:password|passwd|secret|token|api[_-]?key|authorization|credential)[A-Za-z0-9_]{0,80}\2\s*[=:]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^,\r\n}\]]+)/gi, '$1"[REDACTED]"')
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

export async function readCiLog(response: Response, secrets: string[], projectPath: string): Promise<CiLogEvidence> {
  const reader = response.body?.getReader();
  const evidence: CiLogEvidence = { log: "", classification: "unknown", checkout: { shas: [], invalid: false } };
  if (!reader) return evidence;
  const excerpts = new CiLogExcerpts(secrets, projectPath, evidence);
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxCiLogScanBytes)
        throw new ForgeProviderError("The CI log exceeds the full-scan byte limit; complete checkout and blocker evidence cannot be verified.");
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline + 1);
        if (Buffer.byteLength(line) > maxCiLogBytes)
          throw new ForgeProviderError("The CI log contains a line beyond the safe evidence limit.");
        excerpts.add(line);
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending) > maxCiLogBytes)
        throw new ForgeProviderError("The CI log contains a line beyond the safe evidence limit.");
    }
    pending += decoder.decode();
    if (pending) excerpts.add(pending);
    excerpts.finish();
    return evidence;
  } finally { await reader.cancel(); }
}

type OperationalClassification = keyof typeof operationalCiBlockers;
const ciClassifications: CiJob["classification"][] = ["unknown", "code", "infrastructure", "policy", "credentials"];
type BlockerEvidence = Map<OperationalClassification, string>;

class CiLogClassifier {
  classification: CiJob["classification"] = "unknown";
  readonly blockers: BlockerEvidence = new Map();
  private run?: { output: Map<string, BlockerEvidence>; failedTests: Set<string>; reporting: boolean; consoleTest?: string };

  add(line: string, clean: string): void {
    if (/^RUN\s+v\d+\./.test(line)) {
      this.finishRun();
      this.run = { output: new Map(), failedTests: new Set(), reporting: false };
    } else if (/^(?:##\[(?:end)?group\]|section_(?:start|end):)/.test(line)) this.finishRun();

    const consoleTest = /^(?:stdout|stderr) \| (.+)$/.exec(line);
    const failedTest = /^FAIL\s+(.+\.(?:test|spec)\.[^ >]+(?: > .+)?)$/.exec(line);
    if (this.run) {
      if (!line || /^##\[(?:error|warning)\]/.test(line)) delete this.run.consoleTest;
      if (consoleTest) this.run.consoleTest = consoleTest[1];
      if (failedTest) {
        this.run.reporting = true;
        this.run.failedTests.add(failedTest[1]);
        delete this.run.consoleTest;
      }
    }
    if (consoleTest && this.run) return;
    const classification = classifyCiLine(line);
    if (classification === "unknown") return;
    if (classification === "code") {
      this.record(classification);
      // Only a completed report can disassociate application output from the failure.
      const summary = /^Tests\s+(\d+) failed\b/.exec(line);
      if (summary) this.finishRun(Number(summary[1]) > 0 && Number(summary[1]) === this.run?.failedTests.size);
      return;
    }
    const match = operationalCiBlockers[classification].exec(clean);
    const context = match ? clean.slice(Math.max(0, match.index - 300), match.index + 700).trim() : "[REDACTED blocker text]";
    const evidence = `[${classification}] ${context}\n`;
    if (this.run && (this.run.consoleTest || !this.run.reporting && isApplicationError(line))) {
      const test = this.run.consoleTest ?? "";
      let output = this.run.output.get(test);
      if (!output) this.run.output.set(test, output = new Map());
      if (!output.has(classification)) output.set(classification, evidence);
    } else this.record(classification, evidence);
  }

  finishRun(complete = false): void {
    if (!this.run) return;
    for (const [test, output] of this.run.output) {
      const failed = test && [...this.run.failedTests].some(name => name === test || name.startsWith(`${test} > `));
      if (!complete || failed)
        for (const [classification, evidence] of output) this.record(classification, evidence);
    }
    this.run = undefined;
  }

  private record(classification: CiJob["classification"], evidence?: string): void {
    if (ciClassifications.indexOf(classification) > ciClassifications.indexOf(this.classification))
      this.classification = classification;
    if (evidence && classification !== "code" && classification !== "unknown" && !this.blockers.has(classification))
      this.blockers.set(classification, evidence);
  }
}

function ciLogLine(raw: string): string {
  return raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/^\d{4}-\d\d-\d\dT[^ ]+ /, "").trim().replace(/^[·✓×↓\s]+/, "");
}

function isApplicationError(line: string): boolean {
  if (!line.startsWith("{")) return false;
  try {
    const record: unknown = JSON.parse(line);
    return !!record && typeof record === "object" &&
      "level" in record && typeof record.level === "number" &&
      "msg" in record && typeof record.msg === "string" &&
      !["credentials", "policy"].includes(classifyCiLine(record.msg)) &&
      !/\brunner\b|lost communication with|system failure|no space left on device/i.test(record.msg) &&
      "err" in record && !!record.err && typeof record.err === "object" &&
      "type" in record.err && typeof record.err.type === "string" &&
      "message" in record.err && typeof record.err.message === "string" &&
      "stack" in record.err && typeof record.err.stack === "string";
  } catch { return false; }
}

class CiLogExcerpts {
  private complete = "";
  private shortened = false;
  private prefix = "";
  private tail = "";
  private checkoutLog = "";
  private readonly classifier = new CiLogClassifier();
  private repository = "";
  private awaitingSha = false;
  private privateKey = false;
  private secretValuePending = false;
  private secretQuote = "";

  constructor(private readonly secrets: string[], private readonly projectPath: string, private readonly evidence: CiLogEvidence) {}

  add(raw: string): void {
    const line = ciLogLine(raw);
    const clean = this.redact(raw);
    this.classifier.add(line, clean);
    this.checkout(line, clean);
    if (!this.shortened) {
      this.complete += clean;
      if (this.complete.length > maxCiLogCharacters) { this.complete = ""; this.shortened = true; }
    }
    if (this.prefix.length < 6_000) this.prefix = (this.prefix + clean).slice(0, 6_000);
    this.tail = (this.tail + clean).slice(-19_000);
  }

  finish(): void {
    this.classifier.finishRun();
    this.evidence.classification = this.classifier.classification;
    if (this.awaitingSha) this.evidence.checkout.invalid = true;
    this.evidence.log = this.shortened ? [
      this.prefix, "[CI log truncated; full stream scanned]",
      this.checkoutLog && `[Checkout evidence]\n${this.checkoutLog}`,
      this.classifier.blockers.size && `[Operational blocker evidence]\n${[...this.classifier.blockers.values()].join("")}`,
      `[Failure tail]\n${this.tail}`,
    ].filter(Boolean).join("\n").slice(0, maxCiLogCharacters) : this.complete;
  }

  private checkout(line: string, clean: string): void {
    if (this.awaitingSha) {
      const sha = line.replace(/^'(.*)'$/, "$1");
      if (/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(sha)) {
        if (!this.evidence.checkout.shas.includes(sha) && this.evidence.checkout.shas.length < 2)
          this.evidence.checkout.shas.push(sha);
      } else this.evidence.checkout.invalid = true;
      this.checkoutLog = (this.checkoutLog + clean).slice(0, 2_000);
      this.awaitingSha = false;
    }
    const syncing = /^Syncing repository: (\S+)$/.exec(line);
    if (syncing) this.repository = syncing[1];
    if (this.repository === this.projectPath && /^\[command\].*\bgit log -1 --format=(?:%H|'%H')$/.test(line)) {
      this.awaitingSha = true;
      this.checkoutLog = (this.checkoutLog + `Syncing repository: ${this.projectPath}\n` + clean).slice(0, 2_000);
    }
  }

  private redact(raw: string): string {
    if (this.privateKey) {
      const end = /-----END [A-Z ]*PRIVATE KEY-----/.exec(raw);
      if (!end) return "";
      this.privateKey = false;
      return this.redact(raw.slice(end.index + end[0].length));
    }
    if (this.secretQuote) {
      const end = closingQuote(raw, this.secretQuote);
      if (end === -1) return "";
      this.secretQuote = "";
      return this.redact(raw.slice(end + 1));
    }
    if (this.secretValuePending) {
      const value = raw.replace(/^\d{4}-\d\d-\d\dT[^ ]+ /, "").trimStart();
      if (!value) return raw;
      this.secretValuePending = false;
      if (value[0] === '"' || value[0] === "'") {
        const end = closingQuote(value.slice(1), value[0]);
        if (end === -1) { this.secretQuote = value[0]; return '"[REDACTED]"\n'; }
        return '"[REDACTED]"' + this.redact(value.slice(end + 2));
      }
      return "[REDACTED]\n";
    }
    const assignments = /((['"])[A-Za-z0-9_]{0,80}(?:password|passwd|secret|token|api[_-]?key|authorization|credential)[A-Za-z0-9_]{0,80}\2|\b[A-Za-z0-9_]{0,80}(?:password|passwd|secret|token|api[_-]?key|authorization|credential)[A-Za-z0-9_]{0,80})\s*[=:]\s*/gi;
    for (const assignment of raw.matchAll(assignments)) {
      const value = raw.slice(assignment.index + assignment[0].length);
      if (!value) this.secretValuePending = true;
      else if ((value[0] === '"' || value[0] === "'") && closingQuote(value.slice(1), value[0]) === -1)
        this.secretQuote = value[0];
    }
    const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(raw);
    if (begin && !/-----END [A-Z ]*PRIVATE KEY-----/.test(raw.slice(begin.index))) this.privateKey = true;
    return sanitizeCiLog(raw, this.secrets);
  }
}

function closingQuote(value: string, quote: string): number {
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    if (!escaped && value[index] === quote) return index;
    escaped = !escaped && value[index] === "\\";
  }
  return -1;
}
