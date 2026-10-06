import type { ForgeChangeRequest, ForgeCiDiagnostic } from "@cloudx/shared";
import { ForgeHttpClient, hasNextPage } from "./ForgeHttpClient.js";
import { ForgeProviderError } from "./ForgeProvider.js";
import { boolean, integer, invalid, list, record, string } from "./validation.js";
import { ciDiagnostic, ciEvidenceFailure, ciId, ciJobName, ciSha, ciUrl, classifyCiLog, classifyDiagnostic, finishCiDiagnostic, maxCiFailureJobs, type CiJob } from "./ciEvidence.js";

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
        const jobId = ciId(job.id);
        const evidence: CiJob = {
          runId: String(failure.runId), runAttempt: failure.runAttempt, jobId: String(jobId),
          name: ciJobName(job.name), url: ciUrl(job.html_url),
          conclusion: string(job.conclusion), classification: "unknown",
        };
        diagnostic.jobs.push(evidence);
        const log = await this.http.ciLog(`${this.path}/actions/jobs/${jobId}/logs`);
        Object.assign(evidence, { log, classification: classifyCiLog(log) });
        const testedSha = this.checkoutSha(log);
        if (!await this.testedCurrentCommit(testedSha, change, diagnostic)) return finishCiDiagnostic(diagnostic);
        Object.assign(evidence, { testedSha });
        diagnostic.testedSha = diagnostic.jobs.every(job => job.testedSha === testedSha) ? testedSha : undefined;
        const current = record((await this.http.request(`${this.path}/actions/runs/${failure.runId}`)).body);
        const currentJobs = await this.jobs(failure);
        const currentJob = currentJobs.find(job => ciId(job.id) === jobId);
        if (!this.currentRun(current, failure, change) || current.status !== "completed" ||
            !currentJob || this.checkId(currentJob) !== failure.checkId ||
            integer(currentJob.run_id) !== failure.runId || ciSha(currentJob.head_sha) !== change.headSha ||
            currentJob.status !== "completed" || currentJob.conclusion !== evidence.conclusion) {
          diagnostic.state = "obsolete"; diagnostic.reason = "CI was rerun or its job identity changed while reading logs.";
          return finishCiDiagnostic(diagnostic);
        }
        if (!await this.testedCurrentCommit(testedSha, change, diagnostic)) return finishCiDiagnostic(diagnostic);
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

  private checkoutSha(log: string): string {
    const lines = log.split("\n").map(line => line.replace(/^\d{4}-\d\d-\d\dT[^ ]+ /, "").trim());
    const revisions: string[] = [];
    let repository = "";
    for (let index = 0; index < lines.length; index++) {
      const syncing = /^Syncing repository: (\S+)$/.exec(lines[index]);
      if (syncing) repository = syncing[1];
      if (repository === this.http.repository.projectPath && /^\[command\].*\bgit log -1 --format=(?:%H|'%H')$/.test(lines[index])) {
        const sha = lines[index + 1]?.replace(/^'(.*)'$/, "$1");
        revisions.push(ciSha(sha));
      }
    }
    if (new Set(revisions).size !== 1) throw new ForgeProviderError("The bounded job log does not prove one tested checkout revision in the configured repository.");
    return revisions[0];
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
      if (!hasNextPage(response.headers)) return jobs;
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
