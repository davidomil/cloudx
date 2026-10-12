import { createHash } from "node:crypto";
import type { ForgeChangeRequest, ForgeCiDiagnostic } from "@cloudx/shared";
import { ForgeHttpClient, hasNextPage } from "./ForgeHttpClient.js";
import { ForgeProviderError } from "./ForgeProvider.js";
import { boolean, integer, invalid, list, record, string } from "./validation.js";
import { ciDiagnostic, ciEvidenceFailure, ciId, ciJobName, ciSha, ciUrl, classifyDiagnostic, finishCiDiagnostic, maxCiFailureJobs, type CiJob } from "./ciEvidence.js";

import { GitHubWorkflowDependencies } from "./GitHubWorkflowDependencies.js";

interface RequiredFailure {
  checkId: number;
  runId: number;
  runAttempt: number;
  name: string;
  conclusion: string;
}

export class GitHubCiDiagnostics {
  private readonly path: string;

  constructor(private readonly http: ForgeHttpClient) {
    this.path = `/repos/${http.repository.projectPath.split("/").map(encodeURIComponent).join("/")}`;
  }

  async collect(change: ForgeChangeRequest): Promise<ForgeCiDiagnostic> {
    const diagnostic = ciDiagnostic(this.http.repository, change);
    try {
      if (!change.targetHeadSha) throw new ForgeProviderError("CI repair requires a current target head.");
      if (change.checks?.reason === "superseded_merge_identity") {
        diagnostic.state = "obsolete"; diagnostic.reason = "CI tested a superseded merge identity.";
        return finishCiDiagnostic(diagnostic);
      }
      if (change.checks?.reason === "pending_merge_identity") {
        diagnostic.state = "pending"; diagnostic.reason = "CI is waiting for the current merge identity.";
        return finishCiDiagnostic(diagnostic);
      }
      const failures = await this.requiredFailures(change, diagnostic);
      if (!failures || !failures.length) return finishCiDiagnostic(diagnostic);
      if (failures.length > maxCiFailureJobs) throw new ForgeProviderError("Too many failed CI jobs to diagnose safely.");
      for (const failure of failures) {
        const run = record((await this.http.request(`${this.path}/actions/runs/${failure.runId}`)).body);
        if (!this.currentRun(run, failure, change)) {
          diagnostic.state = "obsolete"; diagnostic.reason = "CI run no longer matches the current source, base, or run attempt.";
          return finishCiDiagnostic(diagnostic);
        }
        if (run.status !== "completed") {
          diagnostic.state = "pending"; diagnostic.reason = "The required CI run is still running.";
          return finishCiDiagnostic(diagnostic);
        }
        if (!["failure", "timed_out"].includes(string(run.conclusion)))
          throw new ForgeProviderError("The CI run does not confirm a terminal failure.");
        const jobs = await this.jobs(failure);
        const job = jobs.find(job => this.checkId(job) === failure.checkId);
        if (!job || ciId(job.run_id) !== failure.runId || ciSha(job.head_sha) !== ciSha(run.head_sha) ||
            job.status !== "completed" || string(job.conclusion).toUpperCase() !== failure.conclusion)
          throw new ForgeProviderError("The failed check does not match a terminal workflow job.");
        if (job.name !== failure.name) throw new ForgeProviderError("The required check and workflow job names differ.");
        const identities = new Map<number, string>();
        const visited = new Set<number>();
        let workflow: GitHubWorkflowDependencies | undefined;
        let workflowSha: string | undefined;
        const inspect = async (producer: Record<string, unknown>, gate?: CiJob["requiredGate"]): Promise<boolean> => {
          const jobId = ciId(producer.id);
          if (visited.has(jobId)) throw new ForgeProviderError("Aggregate dependencies repeat or form a cycle.");
          visited.add(jobId);
          if (visited.size > maxCiFailureJobs * 2 || diagnostic.jobs.length >= maxCiFailureJobs)
            throw new ForgeProviderError("Too many failed CI dependencies to diagnose safely.");
          if (ciId(producer.run_id) !== failure.runId || ciSha(producer.head_sha) !== change.headSha ||
              producer.run_attempt !== undefined && ciId(producer.run_attempt) !== failure.runAttempt ||
              producer.status !== "completed" || !["failure", "timed_out"].includes(string(producer.conclusion)))
            throw new ForgeProviderError("A failed dependency does not match this terminal run attempt and source.");
          identities.set(jobId, this.jobIdentity(producer));
          const existing = diagnostic.jobs.find(job => job.runId === String(failure.runId) && job.runAttempt === failure.runAttempt && job.jobId === String(jobId));
          if (existing) {
            if (workflowSha && existing.testedSha !== workflowSha) throw new ForgeProviderError("The dependency checkout differs from the pinned aggregate workflow revision.");
            return existing.classification === "code" && Boolean(existing.testedSha);
          }
          const evidence: CiJob = {
            runId: String(failure.runId), runAttempt: failure.runAttempt, jobId: String(jobId),
            name: ciJobName(producer.name), url: ciUrl(producer.html_url), conclusion: string(producer.conclusion),
            classification: "unknown", ...(gate ? { requiredGate: gate } : {}),
          };
          diagnostic.jobs.push(evidence);
          const collected = await this.http.ciLogEvidence(`${this.path}/actions/jobs/${jobId}/logs`);
          Object.assign(evidence, { log: collected.log, classification: collected.classification });
          if (["credentials", "policy", "infrastructure"].includes(evidence.classification)) {
            classifyDiagnostic(diagnostic);
            return false;
          }
          if (collected.checkout.invalid || collected.checkout.shas.length > 1)
            throw new ForgeProviderError("The complete job log does not prove one tested checkout revision in the configured repository.");
          const testedSha = collected.checkout.shas[0];
          if (testedSha) {
            if (workflowSha && testedSha !== workflowSha) throw new ForgeProviderError("The dependency checkout differs from the pinned aggregate workflow revision.");
            if (!await this.testedCurrentCommit(testedSha, change, diagnostic)) return false;
            evidence.testedSha = testedSha;
            return true;
          }
          if (!workflow) {
            workflowSha = await this.workflowRevision(run, change, diagnostic);
            if (!workflowSha) return false;
            workflow = await this.pinnedWorkflow(run, workflowSha);
          }
          const dependencies = workflow.failedDependencies(producer, jobs);
          diagnostic.jobs.pop();
          const requiredGate = gate ?? { jobId: evidence.jobId, name: evidence.name, url: evidence.url, log: evidence.log! };
          for (const dependency of dependencies) if (!await inspect(dependency, requiredGate)) return false;
          return true;
        };
        const inspected = await inspect(job);
        const runTestedSha = diagnostic.jobs.at(-1)?.testedSha;
        if (inspected) {
          const testedShas = new Set(diagnostic.jobs.map(job => job.testedSha));
          diagnostic.testedSha = testedShas.size === 1 ? runTestedSha : undefined;
        }
        const current = record((await this.http.request(`${this.path}/actions/runs/${failure.runId}`)).body);
        const currentJobs = await this.jobs(failure);
        if (!this.currentRun(current, failure, change) || current.status !== "completed" || current.conclusion !== run.conclusion ||
            workflow && (current.path !== run.path || current.workflow_id !== run.workflow_id) ||
            [...identities].some(([id, identity]) => {
              const matches = currentJobs.filter(job => ciId(job.id) === id);
              return matches.length !== 1 || this.jobIdentity(matches[0]) !== identity;
            })) {
          diagnostic.state = "obsolete"; diagnostic.reason = "CI was rerun or its job or workflow identity changed while reading logs.";
          return finishCiDiagnostic(diagnostic);
        }
        // Re-resolve the pinned dependency graph too: a successful sibling becoming
        // a failed dependency must invalidate this evidence, even if selected IDs stayed fixed.
        if (workflow) {
          for (const id of identities.keys()) {
            const previous = jobs.find(job => ciId(job.id) === id)!;
            const selected = currentJobs.find(job => ciId(job.id) === id)!;
            if (diagnostic.jobs.some(job => job.jobId === String(id))) continue;
            const before = workflow.failedDependencies(previous, jobs).map(job => this.jobIdentity(job)).sort();
            const after = workflow.failedDependencies(selected, currentJobs).map(job => this.jobIdentity(job)).sort();
            if (JSON.stringify(before) !== JSON.stringify(after)) {
              diagnostic.state = "obsolete"; diagnostic.reason = "Aggregate dependencies changed while reading failure evidence.";
              return finishCiDiagnostic(diagnostic);
            }
          }
        }
        if (!inspected) return finishCiDiagnostic(diagnostic);
        if (!await this.testedCurrentCommit(runTestedSha!, change, diagnostic)) return finishCiDiagnostic(diagnostic);
      }
      const latest = await this.requiredFailures(change, diagnostic);
      if (!latest || JSON.stringify(latest) !== JSON.stringify(failures)) {
        diagnostic.state = "obsolete"; diagnostic.reason = "Required CI changed while reading failure evidence.";
      } else classifyDiagnostic(diagnostic);
    } catch (error) {
      diagnostic.state = "blocked"; diagnostic.reason = ciEvidenceFailure(error);
    }
    return finishCiDiagnostic(diagnostic);
  }

  private async requiredFailures(change: ForgeChangeRequest, diagnostic: ForgeCiDiagnostic): Promise<RequiredFailure[] | undefined> {
    const [owner, name] = this.http.repository.projectPath.split("/");
    const failures: RequiredFailure[] = [];
    let cursor: string | null = null;
    let pending = false;
    for (let page = 0; page < 20; page++) {
      const response = record((await this.http.request("/graphql", {
        method: "POST", graphql: true, body: {
          query: "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){number state headRefOid headRefName baseRefOid baseRefName headRef{target{... on Commit{oid statusCheckRollup{contexts(first:100,after:$cursor){nodes{__typename ... on CheckRun{databaseId name status conclusion isRequired(pullRequestNumber:$number) checkSuite{workflowRun{databaseId runAttempt}}} ... on StatusContext{context state isRequired(pullRequestNumber:$number)}} pageInfo{hasNextPage endCursor}}}}}}}}}",
          variables: { owner, name, number: change.number, cursor },
        },
      })).body);
      if (response.errors !== undefined) throw new ForgeProviderError("GitHub could not verify required CI evidence.");
      const request = record(record(record(response.data).repository).pullRequest);
      if (integer(request.number) !== change.number) return invalid();
      if (request.state !== "OPEN" || ciSha(request.headRefOid) !== change.headSha ||
          ciSha(request.baseRefOid) !== change.targetHeadSha || request.headRefName !== change.headBranch || request.baseRefName !== change.baseBranch) {
        diagnostic.state = "obsolete"; diagnostic.reason = "The request source, base, branches, or open state changed.";
        return;
      }
      const commit = record(record(request.headRef).target);
      if (ciSha(commit.oid) !== change.headSha) return invalid();
      if (commit.statusCheckRollup === null) break;
      const contexts = record(record(commit.statusCheckRollup).contexts);
      for (const value of list(contexts.nodes)) {
        const context = record(value);
        if (!boolean(context.isRequired)) continue;
        if (context.__typename === "StatusContext") {
          if (["FAILURE", "ERROR"].includes(string(context.state)))
            throw new ForgeProviderError("A required external CI status has no supported job-log identity.");
          pending ||= ["PENDING", "EXPECTED"].includes(string(context.state));
          continue;
        }
        if (context.__typename !== "CheckRun") return invalid();
        if (context.status !== "COMPLETED") { pending = true; continue; }
        if (["ACTION_REQUIRED", "STARTUP_FAILURE"].includes(String(context.conclusion)))
          throw new ForgeProviderError("Required CI needs policy or infrastructure intervention.");
        if (!["FAILURE", "TIMED_OUT"].includes(String(context.conclusion))) continue;
        const run = record(record(context.checkSuite).workflowRun);
        failures.push({ checkId: ciId(context.databaseId), runId: ciId(run.databaseId), runAttempt: ciId(run.runAttempt), name: string(context.name), conclusion: string(context.conclusion) });
      }
      const pageInfo = record(contexts.pageInfo);
      if (!boolean(pageInfo.hasNextPage)) break;
      const next = string(pageInfo.endCursor);
      if (!next || next === cursor || page === 19) throw new ForgeProviderError("Required CI context evidence exceeds the supported bound.");
      cursor = next;
    }
    if (!failures.length) {
      diagnostic.state = pending ? "pending" : "blocked";
      diagnostic.reason = pending ? "Required CI is pending." : "No current required failed or timed-out CI job was found; cancelled, skipped, and optional jobs do not trigger repair.";
    }
    if (new Set(failures.map(failure => failure.checkId)).size !== failures.length)
      throw new ForgeProviderError("GitHub returned duplicate failed check identities.");
    return failures.sort((a, b) => a.checkId - b.checkId);
  }

  private currentRun(run: Record<string, unknown>, failure: RequiredFailure, change: ForgeChangeRequest): boolean {
    if (ciId(run.id) !== failure.runId || ciId(run.run_attempt) !== failure.runAttempt || !failure.runAttempt ||
        ciSha(run.head_sha) !== change.headSha || record(run.repository).full_name !== this.http.repository.projectPath) return false;
    const requests = list(run.pull_requests);
    if (!requests.length) {
      if (run.event === "push" && run.head_branch === change.headBranch) return true;
      throw new ForgeProviderError("GitHub supplied no request or source-branch binding for this CI run.");
    }
    return requests.some(value => {
      const request = record(value);
      return integer(request.number) === change.number && ciSha(record(request.head).sha) === change.headSha;
    });
  }

  private jobIdentity(job: Record<string, unknown>): string {
    return JSON.stringify([ciId(job.id), this.checkId(job), ciId(job.run_id), job.run_attempt,
      ciSha(job.head_sha), ciJobName(job.name), ciUrl(job.html_url), job.status, job.conclusion]);
  }

  private async workflowRevision(run: Record<string, unknown>, change: ForgeChangeRequest, diagnostic: ForgeCiDiagnostic): Promise<string | undefined> {
    let revision: string;
    if (run.event === "push") revision = change.headSha;
    else if (run.event === "pull_request") {
      const merge = record((await this.http.request(`${this.path}/git/ref/pull/${change.number}/merge`)).body);
      if (merge.ref !== `refs/pull/${change.number}/merge` || record(merge.object).type !== "commit") return invalid();
      revision = ciSha(record(merge.object).sha);
    } else throw new ForgeProviderError("The job has no checkout revision or supported immutable aggregate workflow event binding.");
    return await this.testedCurrentCommit(revision, change, diagnostic) ? revision : undefined;
  }

  private async pinnedWorkflow(run: Record<string, unknown>, revision: string): Promise<GitHubWorkflowDependencies> {
    ciId(run.workflow_id);
    const path = string(run.path);
    if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(path))
      throw new ForgeProviderError("The CI run does not identify a supported workflow path.");
    const file = record((await this.http.request(`${this.path}/contents/${path}?ref=${revision}`)).body);
    if (file.type !== "file" || file.path !== path || file.encoding !== "base64" ||
        !Number.isSafeInteger(file.size) || Number(file.size) > 1_000_000) return invalid();
    const content = Buffer.from(string(file.content), "base64");
    const sha = ciSha(file.sha);
    const identity = createHash(sha.length === 40 ? "sha1" : "sha256").update(`blob ${content.length}\0`).update(content).digest("hex");
    if (content.length !== file.size || identity !== sha) throw new ForgeProviderError("The pinned workflow content does not match its Git blob identity.");
    return new GitHubWorkflowDependencies(content.toString("utf8"));
  }

  private async testedCurrentCommit(testedSha: string, change: ForgeChangeRequest, diagnostic: ForgeCiDiagnostic): Promise<boolean> {
    if (testedSha === change.headSha) {
      const comparison = record((await this.http.request(`${this.path}/compare/${change.targetHeadSha}...${testedSha}`)).body);
      if (ciSha(record(comparison.base_commit).sha) !== change.targetHeadSha || ciSha(record(comparison.merge_base_commit).sha) !== change.targetHeadSha) {
        diagnostic.state = "obsolete"; diagnostic.reason = "The tested source checkout does not include the current target commit.";
        return false;
      }
      return true;
    }
    const request = record((await this.http.request(`${this.path}/pulls/${change.number}`)).body);
    if (integer(request.number) !== change.number || record(record(request.base).repo).full_name !== this.http.repository.projectPath)
      throw new ForgeProviderError("GitHub did not confirm the tested request repository.");
    if (request.state !== "open" || request.merged !== false || ciSha(record(request.head).sha) !== change.headSha ||
        ciSha(record(request.base).sha) !== change.targetHeadSha) {
      diagnostic.state = "obsolete"; diagnostic.reason = "The source or target changed before confirming the tested merge.";
      return false;
    }
    if (request.mergeable === null) {
      diagnostic.state = "pending"; diagnostic.reason = "GitHub is still computing the current test merge.";
      return false;
    }
    if (request.mergeable !== true) throw new ForgeProviderError("GitHub has not confirmed a mergeable test identity.");
    const mergeRef = record((await this.http.request(`${this.path}/git/ref/pull/${change.number}/merge`)).body);
    const object = record(mergeRef.object);
    if (mergeRef.ref !== `refs/pull/${change.number}/merge` || object.type !== "commit")
      throw new ForgeProviderError("GitHub did not confirm the exact pull-request merge ref.");
    if (ciSha(object.sha) !== testedSha) {
      diagnostic.state = "obsolete"; diagnostic.reason = "The failing job checked out a superseded test merge.";
      return false;
    }
    const commit = record((await this.http.request(`${this.path}/git/commits/${testedSha}`)).body);
    const parents = list(commit.parents).map(value => ciSha(record(value).sha));
    if (ciSha(commit.sha) !== testedSha || parents.length !== 2 || parents[0] !== change.targetHeadSha || parents[1] !== change.headSha) {
      diagnostic.state = "obsolete"; diagnostic.reason = "The tested merge parents do not match the exact current target and source in order.";
      return false;
    }
    return true;
  }

  private async jobs(failure: RequiredFailure): Promise<Record<string, unknown>[]> {
    const jobs: Record<string, unknown>[] = [];
    for (let page = 1; page <= 20; page++) {
      const response = await this.http.request(`${this.path}/actions/runs/${failure.runId}/attempts/${failure.runAttempt}/jobs?per_page=100&page=${page}`);
      jobs.push(...list(record(response.body).jobs).map(record));
      if (!hasNextPage(response.headers)) {
        if (new Set(jobs.map(job => ciId(job.id))).size !== jobs.length) throw new ForgeProviderError("GitHub returned duplicate workflow job identities.");
        return jobs;
      }
    }
    throw new ForgeProviderError("The CI run exceeds 2,000 jobs.");
  }

  private checkId(job: Record<string, unknown>): number {
    const url = new URL(ciUrl(job.check_run_url));
    const expected = new URL(`${this.http.repository.apiUrl}${this.path}/check-runs/`);
    if (url.origin !== expected.origin || !url.pathname.startsWith(expected.pathname)) return invalid();
    const id = url.pathname.slice(expected.pathname.length);
    if (!/^\d+$/.test(id)) return invalid();
    return ciId(Number(id));
  }
}
