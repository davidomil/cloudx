import type { ForgeChangeRequest, ForgeCiDiagnostic } from "@cloudx/shared";
import { ForgeHttpClient } from "./ForgeHttpClient.js";
import { ForgeProviderError } from "./ForgeProvider.js";
import { boolean, integer, list, record, string } from "./validation.js";
import { ciDiagnostic, ciEvidenceFailure, ciId, ciJobName, ciSha, ciUrl, classifyCiLog, classifyDiagnostic, finishCiDiagnostic, maxCiFailureJobs, type CiJob } from "./ciEvidence.js";

export class GitLabCiDiagnostics {
  private readonly path: string;

  constructor(private readonly http: ForgeHttpClient) {
    this.path = `/projects/${encodeURIComponent(http.repository.projectPath)}`;
  }

  async collect(change: ForgeChangeRequest): Promise<ForgeCiDiagnostic> {
    const diagnostic = ciDiagnostic(this.http.repository, change);
    try {
      if (!change.targetHeadSha) throw new ForgeProviderError("CI repair requires a current target head.");
      const request = await this.snapshot(change, diagnostic);
      if (!request) return finishCiDiagnostic(diagnostic);
      if (!request.head_pipeline) throw new ForgeProviderError("GitLab has not supplied a current pipeline identity.");
      const headPipeline = record(request.head_pipeline);
      const pipelineId = ciId(headPipeline.id);
      const pipeline = record((await this.http.request(`${this.path}/pipelines/${pipelineId}`)).body);
      const testedSha = ciSha(pipeline.sha);
      diagnostic.testedSha = testedSha;
      if (ciId(pipeline.id) !== pipelineId || ciSha(headPipeline.sha) !== testedSha ||
          ciId(pipeline.project_id) !== ciId(request.target_project_id))
        throw new ForgeProviderError("GitLab returned inconsistent pipeline repository or commit evidence.");
      if (!await this.testedCurrentBase(testedSha, change)) {
        diagnostic.state = "obsolete"; diagnostic.reason = "The pipeline tested a superseded source or target commit.";
        return finishCiDiagnostic(diagnostic);
      }
      const status = string(pipeline.status);
      if (["created", "waiting_for_resource", "preparing", "pending", "running", "manual", "scheduled"].includes(status)) {
        diagnostic.state = "pending"; diagnostic.reason = "The required GitLab pipeline is pending.";
        return finishCiDiagnostic(diagnostic);
      }
      if (status !== "failed") {
        diagnostic.state = "blocked"; diagnostic.reason = "No terminal failed required pipeline was found; cancelled and skipped pipelines do not trigger repair.";
        return finishCiDiagnostic(diagnostic);
      }
      const failed = await this.failedJobs(pipelineId, testedSha, ciId(pipeline.project_id));
      if (!failed.length || failed.length > maxCiFailureJobs)
        throw new ForgeProviderError("No bounded set of required failed jobs is available.");
      for (const job of failed) {
        const id = ciId(job.id);
        const evidence: CiJob = {
          runId: String(pipelineId), runAttempt: 1, jobId: String(id),
          name: ciJobName(job.name), url: ciUrl(job.web_url),
          conclusion: string(job.status), testedSha, classification: "unknown",
        };
        diagnostic.jobs.push(evidence);
        const log = await this.http.ciLog(`${this.path}/jobs/${id}/trace`);
        evidence.log = log;
        evidence.classification = this.classification(job, log);
      }
      const latestRequest = await this.snapshot(change, diagnostic);
      if (!latestRequest) return finishCiDiagnostic(diagnostic);
      const latestHead = record(latestRequest.head_pipeline);
      const latest = record((await this.http.request(`${this.path}/pipelines/${pipelineId}`)).body);
      const latestJobs = await this.failedJobs(pipelineId, testedSha, ciId(pipeline.project_id));
      if (ciId(latestHead.id) !== pipelineId || ciSha(latestHead.sha) !== testedSha ||
          ciId(latest.id) !== pipelineId || ciSha(latest.sha) !== testedSha || latest.status !== "failed" ||
          ciId(latest.project_id) !== ciId(pipeline.project_id) ||
          this.jobIdentity(latestJobs) !== this.jobIdentity(failed)) {
        diagnostic.state = "obsolete"; diagnostic.reason = "The pipeline or failing job attempts changed while reading traces.";
      } else classifyDiagnostic(diagnostic);
    } catch (error) {
      diagnostic.state = "blocked"; diagnostic.reason = ciEvidenceFailure(error);
    }
    return finishCiDiagnostic(diagnostic);
  }

  async testedCurrentBase(testedSha: string, change: Pick<ForgeChangeRequest, "headSha" | "targetHeadSha">): Promise<boolean> {
    if (testedSha === change.headSha) {
      const params = new URLSearchParams();
      params.append("refs[]", change.headSha);
      params.append("refs[]", ciSha(change.targetHeadSha));
      const mergeBase = record((await this.http.request(`${this.path}/repository/merge_base?${params}`)).body);
      return ciSha(mergeBase.id) === change.targetHeadSha;
    }
    const commit = record((await this.http.request(`${this.path}/repository/commits/${testedSha}`)).body);
    if (ciSha(commit.id) !== testedSha) throw new ForgeProviderError("GitLab returned a different tested commit.");
    const parents = list(commit.parent_ids).map(ciSha);
    return parents.length === 2 && parents.includes(change.headSha) && parents.includes(ciSha(change.targetHeadSha));
  }

  private async snapshot(change: ForgeChangeRequest, diagnostic: ForgeCiDiagnostic): Promise<Record<string, unknown> | undefined> {
    const request = record((await this.http.request(`${this.path}/merge_requests/${change.number}`)).body);
    const target = record((await this.http.request(`${this.path}/repository/branches/${encodeURIComponent(change.baseBranch)}`)).body);
    if (integer(request.iid) !== change.number || target.name !== change.baseBranch)
      throw new ForgeProviderError("GitLab returned a different request or target branch.");
    if (request.state !== "opened" || ciSha(request.sha) !== change.headSha || request.source_branch !== change.headBranch ||
        request.target_branch !== change.baseBranch || ciSha(record(target.commit).id) !== change.targetHeadSha) {
      diagnostic.state = "obsolete"; diagnostic.reason = "The request source, target, branches, or open state changed.";
      return;
    }
    return request;
  }

  private async failedJobs(pipelineId: number, testedSha: string, projectId: number): Promise<Record<string, unknown>[]> {
    const jobs = (await this.http.all(`${this.path}/pipelines/${pipelineId}/jobs?include_retried=false`)).map(record);
    const failed = jobs.filter(job => {
      if (boolean(job.allow_failure) || job.status !== "failed") return false;
      const pipeline = record(job.pipeline);
      if (ciId(pipeline.id) !== pipelineId || ciId(pipeline.project_id) !== projectId ||
          ciSha(pipeline.sha) !== testedSha || ciSha(record(job.commit).id) !== testedSha)
        throw new ForgeProviderError("GitLab failed job evidence belongs to a different pipeline or commit.");
      return true;
    }).sort((a, b) => ciId(a.id) - ciId(b.id));
    if (new Set(failed.map(job => ciId(job.id))).size !== failed.length)
      throw new ForgeProviderError("GitLab returned duplicate failed job identities.");
    return failed;
  }

  private classification(job: Record<string, unknown>, log: string): CiJob["classification"] {
    const classification = classifyCiLog(log);
    if (classification === "credentials" || classification === "policy" || classification === "infrastructure") return classification;
    const reason = string(job.failure_reason);
    if (["runner_system_failure", "stuck_or_timeout_failure", "scheduler_failure", "data_integrity_failure", "runner_unsupported"].includes(reason)) return "infrastructure";
    if (!["script_failure", "job_execution_timeout"].includes(reason)) return "unknown";
    return classification;
  }

  private jobIdentity(jobs: Record<string, unknown>[]): string {
    return JSON.stringify(jobs.map(job => [ciId(job.id), job.status, job.failure_reason]));
  }
}
