#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

import { loadPolicy } from "./policy.mjs";
import { AREA_REVIEW_ROLES } from "./review-fanout.mjs";
import { compileAllSchemas } from "./schema-validator.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "../..");
const externalActionSha = /^[a-f0-9]{40}$/iu;
const repositoryPathPattern =
  /(?:^|[\s`'"(])((?:\.agents|\.github|apps|docs|packages|scripts|services)\/[A-Za-z0-9._/-]+)/gu;
const modelSecretName =
  /(?:^|_)(?:AI|ANTHROPIC|CODEX|GEMINI|MODEL|OPENAI)(?:_|$)/iu;
const loggedInCodexAction = "./.github/actions/run-logged-in-codex";
const loggedInCodexRunnerLabels = [
  "self-hosted",
  "Linux",
  "X64",
  "cloudx-codex",
];

export async function validateProcess(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const schemas = (options.compileSchemas ?? compileAllSchemas)();
  const policy = await loadPolicy(
    path.join(repoRoot, ".agents", "pr-review-policy.toml"),
  );
  const issues = [];
  const skills = validateSkills(repoRoot, issues);
  if (options.validatePolicyReferences !== false) {
    validatePolicyReferences(policy, skills, issues);
  }
  const workflows = validateWorkflows(repoRoot, issues);
  if (issues.length > 0) {
    throw new Error(
      `Repository AI process validation failed:\n${issues
        .sort()
        .map((issue) => `- ${issue}`)
        .join("\n")}`,
    );
  }
  return {
    schemas,
    policy_sha256: policy.policySha256,
    skills,
    workflows,
  };
}

export function validatePolicyReferences(policy, skills, issues = []) {
  const knownAreas = new Set(policy.labels.areas);
  const knownSkills = new Set(skills);
  const routes = [
    ["defaults", policy.defaults],
    ["cross_area", policy.cross_area],
    ...policy.path_rules.map((rule) => [rule.name, rule]),
  ];
  for (const [name, route] of routes) {
    const areas = route.areas ?? (route.area ? [route.area] : []);
    for (const area of areas) {
      if (!knownAreas.has(area)) {
        issues.push(
          `Policy route '${name}' references undeclared area '${area}'.`,
        );
      }
    }
    for (const skill of route.skills) {
      if (!knownSkills.has(skill)) {
        issues.push(
          `Policy route '${name}' references missing skill '${skill}'.`,
        );
      }
    }
  }
  return issues;
}

export function validateSkills(repoRoot, issues = []) {
  const skillsRoot = path.join(repoRoot, ".agents", "skills");
  const directories = requiredDirectories(skillsRoot, ".agents/skills", issues);
  if (!directories) {
    return [];
  }
  const packageScripts = readPackageScripts(repoRoot, issues);
  const skills = [];
  for (const directory of directories) {
    const skillPath = path.join(skillsRoot, directory, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      issues.push(`.agents/skills/${directory} must contain SKILL.md.`);
      continue;
    }
    let parsed;
    try {
      parsed = parseSkill(fs.readFileSync(skillPath, "utf8"), skillPath);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (parsed.frontmatter.name !== directory) {
      issues.push(
        `Skill directory '${directory}' disagrees with frontmatter name '${String(parsed.frontmatter.name ?? "")}'.`,
      );
    }
    if (
      typeof parsed.frontmatter.description !== "string" ||
      !parsed.frontmatter.description.trim()
    ) {
      issues.push(
        `Skill '${directory}' must have a non-empty frontmatter description.`,
      );
    }
    validateSkillReferences(
      repoRoot,
      skillPath,
      parsed.body,
      packageScripts,
      issues,
    );
    skills.push(directory);
  }
  return skills.sort();
}

export function validateWorkflows(repoRoot, issues = []) {
  const workflowRoot = path.join(repoRoot, ".github", "workflows");
  if (
    !fs.existsSync(workflowRoot) ||
    !fs.statSync(workflowRoot).isDirectory()
  ) {
    issues.push(
      "Required workflow directory .github/workflows does not exist.",
    );
    return [];
  }
  const workflows = fs
    .readdirSync(workflowRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (workflows.length === 0) {
    issues.push(
      "Required workflow directory .github/workflows contains no YAML workflows.",
    );
    return [];
  }
  for (const workflowName of workflows) {
    const workflowPath = path.join(workflowRoot, workflowName);
    const workflow = parseYaml(
      fs.readFileSync(workflowPath, "utf8"),
      `.github/workflows/${workflowName}`,
      issues,
    );
    if (workflow) {
      validateWorkflow(repoRoot, workflowName, workflow, issues);
    }
  }
  return workflows;
}

export function validateWorkflow(
  repoRoot,
  workflowName,
  workflow,
  issues = [],
) {
  if (!isRecord(workflow.jobs)) {
    issues.push(`Workflow '${workflowName}' must define a jobs object.`);
    return issues;
  }
  if (workflowName === "managed-issue.yml") {
    validateManagedIssueWorkflow(workflowName, workflow, issues);
  }
  if (workflowName === "ai-review.yml") {
    validateAiReviewWorkflow(workflowName, workflow, issues);
  }
  if (workflowName === "managed-automerge.yml") {
    validateManagedAutomergeWorkflow(workflowName, workflow, issues);
  }
  if (workflowName === "protected-merge.yml") {
    validateProtectedMergeWorkflow(workflowName, workflow, issues);
  }
  if (workflowName === "trusted-automerge.yml") {
    validateTrustedAutomergeWorkflow(workflowName, workflow, issues);
  }
  if (
    workflowName === "ci.yml" &&
    isRecord(workflow.jobs["isolated-verifier"])
  ) {
    validateCiWorkflow(workflowName, workflow, issues);
  }
  const triggers = workflowTriggers(workflow.on);
  for (const [jobName, job] of Object.entries(workflow.jobs).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (!isRecord(job)) {
      issues.push(
        `Workflow '${workflowName}' job '${jobName}' must be an object.`,
      );
      continue;
    }
    if (Object.hasOwn(job, "uses")) {
      validateUsesReference(
        repoRoot,
        workflowName,
        jobName,
        job.uses,
        "job",
        issues,
      );
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const step of steps) {
      if (isRecord(step) && Object.hasOwn(step, "uses")) {
        validateUsesReference(
          repoRoot,
          workflowName,
          jobName,
          step.uses,
          "step",
          issues,
        );
      }
      if (isRecord(step) && step.uses === loggedInCodexAction) {
        const withOptions = isRecord(step.with) ? step.with : {};
        const permissionProfile = String(
          withOptions["permission-profile"] ?? "",
        );
        if (
          !["cloudx-read-only", "cloudx-workspace"].includes(permissionProfile)
        ) {
          issues.push(
            `Workflow '${workflowName}' Codex job '${jobName}' uses an unsupported permission profile.`,
          );
        }
        if (
          !sameStrings(job["runs-on"], loggedInCodexRunnerLabels) ||
          withOptions.model !== "gpt-5.6" ||
          withOptions.effort !== "high" ||
          jobUsesModelSecret(job)
        ) {
          issues.push(
            `Workflow '${workflowName}' Codex job '${jobName}' must use the exact secret-free logged-in Codex runner contract.`,
          );
        }
      }
    }
    if (jobMintsAppToken(job)) {
      const checkout = steps.find(
        (step) =>
          isRecord(step) &&
          typeof step.uses === "string" &&
          step.uses.startsWith("actions/checkout@"),
      );
      if (
        !isRecord(checkout) ||
        !isRecord(checkout.with) ||
        ![
          "${{ inputs.expected_workflow_sha }}",
          "${{ github.workflow_sha }}",
        ].includes(checkout.with.ref)
      ) {
        issues.push(
          `Workflow '${workflowName}' App-token job '${jobName}' must check out the exact trusted workflow SHA.`,
        );
      }
      for (const step of steps.filter(isRecord)) {
        if (
          typeof step.uses === "string" &&
          step.uses.startsWith("actions/create-github-app-token@") &&
          ![
            [
              "${{ vars.CLOUDX_PUBLISHER_APP_ID }}",
              "${{ secrets.CLOUDX_PUBLISHER_APP_PRIVATE_KEY }}",
            ],
            [
              "${{ vars.CLOUDX_MERGE_APP_ID }}",
              "${{ secrets.CLOUDX_MERGE_APP_PRIVATE_KEY }}",
            ],
          ].some(
            ([appId, privateKey]) =>
              step.with?.["app-id"] === appId &&
              step.with?.["private-key"] === privateKey,
          )
        ) {
          issues.push(
            `Workflow '${workflowName}' App-token job '${jobName}' must use one exact Publisher or Merge Authority App credential pair.`,
          );
        }
      }
    }
    if (jobMintsMergeAuthorityToken(job) && !usesMainMergeMutex(job)) {
      issues.push(
        `Workflow '${workflowName}' Merge Authority job '${jobName}' must use the repository-wide cloudx-main-merge-v1 job mutex with queue max.`,
      );
    }
    if (!hasWritePermissions(job.permissions ?? workflow.permissions)) {
      continue;
    }
    if (jobUsesModelSecret(job) || jobUsesLoggedInCodex(job)) {
      issues.push(
        `Workflow '${workflowName}' privileged job '${jobName}' mixes model execution with GitHub write permissions.`,
      );
    }
    if (jobUsesPullRequestHead(job, triggers)) {
      issues.push(
        `Workflow '${workflowName}' privileged job '${jobName}' checks out or executes pull-request head code.`,
      );
    }
  }
  return issues;
}

const jobMintsAppToken = (job) =>
  Array.isArray(job.steps) &&
  job.steps.some(
    (step) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/create-github-app-token@"),
  );

const jobMintsMergeAuthorityToken = (job) =>
  Array.isArray(job.steps) &&
  job.steps.some(
    (step) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/create-github-app-token@") &&
      step.with?.["app-id"] === "${{ vars.CLOUDX_MERGE_APP_ID }}" &&
      step.with?.["private-key"] ===
        "${{ secrets.CLOUDX_MERGE_APP_PRIVATE_KEY }}",
  );

const usesMainMergeMutex = (job) =>
  isRecord(job.concurrency) &&
  job.concurrency.group === "cloudx-main-merge-v1" &&
  job.concurrency["cancel-in-progress"] === false &&
  job.concurrency.queue === "max";

export function validateAiReviewWorkflow(workflowName, workflow, issues = []) {
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
  const expectedJobs = [
    "prepare",
    ...AREA_REVIEW_ROLES.map((role) => role.replaceAll("-", "_")),
    "capture_area_reviews",
    "aggregate_review",
    "publish",
  ].sort();
  if (
    JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(expectedJobs)
  ) {
    issues.push(
      `Workflow '${workflowName}' must define only prepare, eleven explicit area reviewers, capture, aggregate, and publish jobs.`,
    );
  }
  const triggers = workflowTriggers(workflow.on);
  if (
    !triggers.has("pull_request_target") ||
    !triggers.has("workflow_dispatch") ||
    !isRecord(workflow.on?.workflow_dispatch?.inputs?.pr_number)
  ) {
    issues.push(
      `Workflow '${workflowName}' must preserve automatic same-repository review and attended fork workflow_dispatch.`,
    );
  }

  const prepare = jobs.prepare;
  if (!isRecord(prepare)) {
    issues.push(`Workflow '${workflowName}' must define trusted prepare job.`);
  } else {
    const prepareCommands = jobCommands(prepare);
    const prepareIf = String(prepare.if ?? "");
    const prepareCheckout = checkoutStep(prepare);
    if (
      hasWritePermissions(prepare.permissions ?? workflow.permissions) ||
      jobUsesModelSecret(prepare) ||
      !boundedTimeout(prepare, 20) ||
      !prepareIf.includes("github.event_name == 'workflow_dispatch'") ||
      !prepareIf.includes("github.ref == 'refs/heads/main'") ||
      !prepareIf.includes("head.repo.full_name == github.repository") ||
      !prepareCommands.includes("prepare-review.mjs") ||
      !prepareCommands.includes("pr-review-fanout.mjs plan") ||
      prepareCheckout?.with?.ref !== "${{ github.workflow_sha }}" ||
      AREA_REVIEW_ROLES.some(
        (role) =>
          !Object.hasOwn(prepare.outputs ?? {}, role.replaceAll("-", "_")),
      )
    ) {
      issues.push(
        `Workflow '${workflowName}' prepare job must bind a bounded exact subject and expose every deterministic policy role only from the main controller without fork auto-execution.`,
      );
    }
  }

  for (const role of AREA_REVIEW_ROLES) {
    const jobName = role.replaceAll("-", "_");
    const job = jobs[jobName];
    if (!isRecord(job)) {
      issues.push(
        `Workflow '${workflowName}' must define explicit area reviewer '${jobName}'.`,
      );
      continue;
    }
    const steps = Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
    const codex = steps.at(-1);
    const checkout = steps.find(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/checkout@"),
    );
    if (
      Object.hasOwn(job, "strategy") ||
      JSON.stringify(normalizedNeeds(job)) !== JSON.stringify(["prepare"]) ||
      !String(job.if ?? "").includes(
        `needs.prepare.outputs.${jobName} == 'true'`,
      ) ||
      hasWritePermissions(job.permissions ?? workflow.permissions) ||
      jobUsesModelSecret(job) ||
      !usesExactModelRunner(job) ||
      !boundedTimeout(job, 60) ||
      job.environment !== "cloudx-controller" ||
      checkout?.with?.ref !== "${{ needs.prepare.outputs.base_sha }}" ||
      !jobCommands(job).includes(`'${role}'`) ||
      codex?.uses !== loggedInCodexAction ||
      codex.with?.["prompt-file"] !== ".github/codex/prompts/area-review.md" ||
      codex.with?.["output-schema-file"] !==
        ".agents/schemas/review.schema.json" ||
      codex.with?.["permission-profile"] !== "cloudx-read-only" ||
      codex.with?.model !== "gpt-5.6" ||
      codex.with?.effort !== "high" ||
      codex.with?.["codex-args"] !== '["--ephemeral"]'
    ) {
      issues.push(
        `Workflow '${workflowName}' area reviewer '${jobName}' must be a fixed, explicit, exact-base, cloudx-controller-bound read-only Codex job with its own role.`,
      );
    }
  }

  const capture = jobs.capture_area_reviews;
  if (!isRecord(capture)) {
    issues.push(
      `Workflow '${workflowName}' must define trusted area-review capture job.`,
    );
  } else {
    const captureStep = (capture.steps ?? []).find(
      (step) => isRecord(step) && step.id === "capture",
    );
    const captureCheckout = checkoutStep(capture);
    const expectedNeeds = [
      "prepare",
      ...AREA_REVIEW_ROLES.map((role) => role.replaceAll("-", "_")),
    ].sort();
    const capturesEveryResult =
      isRecord(captureStep?.env) &&
      AREA_REVIEW_ROLES.every((role) => {
        const prefix = `PR_${role.toUpperCase().replaceAll("-", "_")}`;
        return (
          Object.hasOwn(captureStep.env, `${prefix}_JSON`) &&
          Object.hasOwn(captureStep.env, `${prefix}_RESULT`)
        );
      });
    if (
      JSON.stringify(normalizedNeeds(capture).sort()) !==
        JSON.stringify(expectedNeeds) ||
      !String(capture.if ?? "").includes("!cancelled()") ||
      !String(capture.if ?? "").includes("needs.prepare.result == 'success'") ||
      hasWritePermissions(capture.permissions ?? workflow.permissions) ||
      jobUsesModelSecret(capture) ||
      !boundedTimeout(capture, 20) ||
      !capturesEveryResult ||
      captureCheckout?.with?.ref !== "${{ github.workflow_sha }}" ||
      !String(captureStep?.run ?? "").includes("pr-review-fanout.mjs capture")
    ) {
      issues.push(
        `Workflow '${workflowName}' capture job must validate every selected success and unselected skip in one trusted static fanout manifest.`,
      );
    }
  }

  const aggregate = jobs.aggregate_review;
  if (!isRecord(aggregate)) {
    issues.push(
      `Workflow '${workflowName}' must define fresh review-pr aggregate job.`,
    );
  } else {
    const codex = Array.isArray(aggregate.steps)
      ? aggregate.steps.filter(isRecord).at(-1)
      : undefined;
    const aggregateCheckout = checkoutStep(aggregate);
    if (
      JSON.stringify(normalizedNeeds(aggregate).sort()) !==
        JSON.stringify(["capture_area_reviews", "prepare"]) ||
      hasWritePermissions(aggregate.permissions ?? workflow.permissions) ||
      jobUsesModelSecret(aggregate) ||
      !usesExactModelRunner(aggregate) ||
      !boundedTimeout(aggregate, 60) ||
      aggregate.environment !== "cloudx-controller" ||
      !jobCommands(aggregate).includes("'review-pr'") ||
      aggregateCheckout?.with?.ref !==
        "${{ needs.prepare.outputs.base_sha }}" ||
      codex?.uses !== loggedInCodexAction ||
      codex.with?.["prompt-file"] !==
        ".github/codex/prompts/review-aggregate.md" ||
      codex.with?.["output-schema-file"] !==
        ".agents/schemas/review.schema.json" ||
      codex.with?.["permission-profile"] !== "cloudx-read-only" ||
      codex.with?.model !== "gpt-5.6" ||
      codex.with?.effort !== "high" ||
      codex.with?.["codex-args"] !== '["--ephemeral"]'
    ) {
      issues.push(
        `Workflow '${workflowName}' aggregate must be a fresh cloudx-controller-bound read-only review-pr context over the canonical area manifest.`,
      );
    }
  }

  const publish = jobs.publish;
  if (!isRecord(publish)) {
    issues.push(
      `Workflow '${workflowName}' must define trusted publisher job.`,
    );
  } else {
    const commands = jobCommands(publish);
    const validation = commands.indexOf("pr-review-fanout.mjs aggregate");
    const publication = commands.indexOf("publish-review.mjs");
    const token = (publish.steps ?? []).find(
      (step) => isRecord(step) && step.id === "merge-token",
    );
    const publisherToken = (publish.steps ?? []).find(
      (step) => isRecord(step) && step.id === "publisher-token",
    );
    const publishStep = (publish.steps ?? []).find(
      (step) => isRecord(step) && step.id === "publish",
    );
    const mergeStep = (publish.steps ?? []).find(
      (step) =>
        isRecord(step) &&
        typeof step.run === "string" &&
        step.run.includes("exact-head-merge.mjs"),
    );
    if (
      JSON.stringify(normalizedNeeds(publish).sort()) !==
        JSON.stringify(
          ["aggregate_review", "capture_area_reviews", "prepare"].sort(),
        ) ||
      !usesMainMergeMutex(publish) ||
      hasWritePermissions(publish.permissions ?? workflow.permissions) ||
      jobUsesModelSecret(publish) ||
      !boundedTimeout(publish, 30) ||
      publish.environment !== "cloudx-controller" ||
      !isRecord(publisherToken) ||
      publisherToken.with?.["app-id"] !==
        "${{ vars.CLOUDX_PUBLISHER_APP_ID }}" ||
      publisherToken.with?.["private-key"] !==
        "${{ secrets.CLOUDX_PUBLISHER_APP_PRIVATE_KEY }}" ||
      publisherToken.with?.["permission-checks"] !== "write" ||
      publisherToken.with?.["permission-contents"] !== "read" ||
      publisherToken.with?.["permission-issues"] !== "write" ||
      publisherToken.with?.["permission-pull-requests"] !== "read" ||
      publishStep?.env?.GH_TOKEN !==
        "${{ steps.publisher-token.outputs.token }}" ||
      validation < 0 ||
      publication <= validation ||
      !isRecord(token) ||
      !String(token.if ?? "").includes(
        "steps.publish.outputs.conclusion == 'success'",
      ) ||
      !String(mergeStep?.if ?? "").includes(
        "steps.publish.outputs.conclusion == 'success'",
      ) ||
      !commands.includes("exact-head-merge.mjs")
    ) {
      issues.push(
        `Workflow '${workflowName}' publisher must keep GITHUB_TOKEN read-only, use the cloudx-controller Publisher App, and revalidate the aggregate manifest and exact identity before publication or Merge Authority credentials.`,
      );
    }
  }
  return issues;
}

export function validateManagedIssueWorkflow(
  workflowName,
  workflow,
  issues = [],
) {
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
  const triggers = workflowTriggers(workflow.on);
  if (!triggers.has("workflow_dispatch")) {
    issues.push(
      `Workflow '${workflowName}' must be dispatched by the durable manager rather than issue text directly.`,
    );
  }

  const modelJobs = [
    "triage",
    "triage_review",
    "plan",
    "plan_review",
    "reproduce",
    "implement",
    "implementation_review",
  ];
  for (const jobName of modelJobs) {
    const job = jobs[jobName];
    if (!isRecord(job)) {
      issues.push(
        `Workflow '${workflowName}' must define isolated model job '${jobName}'.`,
      );
      continue;
    }
    if (hasWritePermissions(job.permissions ?? workflow.permissions)) {
      issues.push(
        `Workflow '${workflowName}' model job '${jobName}' must not have GitHub write permissions.`,
      );
    }
    if (jobUsesModelSecret(job)) {
      issues.push(
        `Workflow '${workflowName}' model job '${jobName}' must use runner-owned Codex auth without model secrets.`,
      );
    }
    const steps = Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
    const lastStep = steps.at(-1);
    if (
      lastStep?.uses !== loggedInCodexAction ||
      !usesExactModelRunner(job) ||
      lastStep.with?.["permission-profile"] !==
        (jobName === "reproduce" ? "cloudx-workspace" : "cloudx-read-only") ||
      lastStep.with?.model !== "gpt-5.6" ||
      lastStep.with?.effort !== "high" ||
      lastStep.with?.["codex-args"] !==
        (jobName === "implement"
          ? '["--ephemeral","--disable","shell_tool"]'
          : '["--ephemeral"]')
    ) {
      issues.push(
        `Workflow '${workflowName}' model job '${jobName}' Codex must be the final step.`,
      );
    }
    if (!boundedTimeout(job, 60)) {
      issues.push(
        `Workflow '${workflowName}' model job '${jobName}' must have a timeout of at most 60 minutes.`,
      );
    }
  }

  const implementation = jobs.implement;
  if (isRecord(implementation)) {
    const steps = Array.isArray(implementation.steps)
      ? implementation.steps.filter(isRecord)
      : [];
    const codex = steps.find((step) => step.uses === loggedInCodexAction);
    const commands = jobCommands(implementation);
    if (
      codex?.with?.["permission-profile"] !== "cloudx-read-only" ||
      codex?.with?.["prompt-file"] !==
        ".managed/context/implementation-prompt.md" ||
      codex?.with?.["output-schema-file"] !==
        ".agents/schemas/managed-patch-proposal.schema.json" ||
      codex?.with?.["codex-args"] !==
        '["--ephemeral","--disable","shell_tool"]' ||
      !commands.includes("build-managed-implementation-prompt.mjs")
    ) {
      issues.push(
        `Workflow '${workflowName}' implementation model must receive one bounded prompt with read-only filesystem access and no shell tool; only the credential-free verifier may apply or execute candidate code.`,
      );
    }
  }

  const verify = jobs.verify;
  if (!isRecord(verify)) {
    issues.push(
      `Workflow '${workflowName}' must define verifier job 'verify'.`,
    );
  } else {
    if (hasWritePermissions(verify.permissions ?? workflow.permissions)) {
      issues.push(
        `Workflow '${workflowName}' verify job must not have GitHub write permissions.`,
      );
    }
    if (jobUsesModelSecret(verify)) {
      issues.push(
        `Workflow '${workflowName}' verify job executes candidate code and must not receive a model secret.`,
      );
    }
    const commands = jobCommands(verify);
    if (
      !commands.includes("verify-managed-candidate.mjs") ||
      !commands.includes("network none")
    ) {
      issues.push(
        `Workflow '${workflowName}' verify job must use the managed verifier with network none.`,
      );
    }
    if (!boundedTimeout(verify, 90)) {
      issues.push(
        `Workflow '${workflowName}' verify job must have a timeout of at most 90 minutes.`,
      );
    }
  }

  const publish = jobs.publish;
  if (!isRecord(publish)) {
    issues.push(
      `Workflow '${workflowName}' must define publisher job 'publish'.`,
    );
  } else {
    if (hasWritePermissions(publish.permissions ?? workflow.permissions)) {
      issues.push(
        `Workflow '${workflowName}' publish job must keep GITHUB_TOKEN read-only and use a short-lived App token.`,
      );
    }
    if (jobUsesModelSecret(publish)) {
      issues.push(
        `Workflow '${workflowName}' publish job must not receive a model secret.`,
      );
    }
    const commands = jobCommands(publish);
    const steps = Array.isArray(publish.steps)
      ? publish.steps.filter(isRecord)
      : [];
    if (
      !steps.some(
        (step) =>
          typeof step.uses === "string" &&
          step.uses.startsWith("actions/create-github-app-token@"),
      )
    ) {
      issues.push(
        `Workflow '${workflowName}' publish job must mint a short-lived GitHub App token.`,
      );
    }
    if (!commands.includes("publish-managed-candidate.mjs")) {
      issues.push(
        `Workflow '${workflowName}' publish job must use the trusted managed candidate publisher.`,
      );
    }
    if (publisherExecutesCandidate(commands)) {
      issues.push(
        `Workflow '${workflowName}' publish job must not execute candidate code.`,
      );
    }
    if (!boundedTimeout(publish, 30)) {
      issues.push(
        `Workflow '${workflowName}' publish job must have a timeout of at most 30 minutes.`,
      );
    }
  }
  return issues;
}

export function validateManagedAutomergeWorkflow(
  workflowName,
  workflow,
  issues = [],
) {
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
  const evaluate = jobs.evaluate;
  if (!isRecord(evaluate)) {
    issues.push(`Workflow '${workflowName}' must define evaluate job.`);
    return issues;
  }
  const steps = Array.isArray(evaluate.steps)
    ? evaluate.steps.filter(isRecord)
    : [];
  const standaloneAuthorization = steps.findIndex(
    (step) =>
      typeof step.run === "string" &&
      step.run.includes("/v1/merge-authorizations"),
  );
  const mergeToken = steps.findIndex(
    (step) =>
      step.id === "merge-token" &&
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/create-github-app-token@"),
  );
  const intent = steps.findIndex(
    (step) =>
      typeof step.run === "string" &&
      step.run.includes("publish-automation-intent.mjs") &&
      !step.run.includes("--complete"),
  );
  const merge = steps.findIndex(
    (step) =>
      typeof step.run === "string" && step.run.includes("exact-head-merge.mjs"),
  );
  const mergeStep = steps[merge];
  const mergeEnvironment = isRecord(mergeStep?.env) ? mergeStep.env : {};
  const mergeTokenStep = steps[mergeToken];
  const mergeTokenInputs = isRecord(mergeTokenStep?.with)
    ? mergeTokenStep.with
    : {};
  const mergeTokenPermissions = Object.keys(mergeTokenInputs)
    .filter((name) => name.startsWith("permission-"))
    .sort();
  const immediateCompletion = steps.find(
    (step) =>
      typeof step.run === "string" &&
      step.run.includes("publish-automation-intent.mjs --complete"),
  );
  const reconcile = jobs.reconcile_automation_intent;
  const reconcileSteps =
    isRecord(reconcile) && Array.isArray(reconcile.steps)
      ? reconcile.steps.filter(isRecord)
      : [];
  const reconcileToken = reconcileSteps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/create-github-app-token@"),
  );
  const reconcilePermissionInputs = isRecord(reconcileToken?.with)
    ? Object.keys(reconcileToken.with)
        .filter((name) => name.startsWith("permission-"))
        .sort()
    : [];
  const inputs = workflow.on?.workflow_dispatch?.inputs;
  if (
    !isRecord(inputs) ||
    ![
      "pr_number",
      "run_id",
      "issue_number",
      "merge_capability",
      "source_revision_sha256",
      "test_merge_sha",
      "test_merge_tree_sha",
    ].every((name) => isRecord(inputs[name])) ||
    !jobCommands(evaluate).includes("check-identity.mjs resolve")
  ) {
    issues.push(
      `Workflow '${workflowName}' must bind manager authorization to the exact live test merge commit and tree.`,
    );
  }
  const expectedManagedMergeEnvironment = {
    CLOUDX_MANAGER_RESULT_TOKEN: "${{ secrets.CLOUDX_MANAGER_RESULT_TOKEN }}",
    CLOUDX_MANAGER_URL: "${{ vars.CLOUDX_MANAGER_URL }}",
    EXPECTED_BASE_SHA: "${{ steps.identity.outputs.base-sha }}",
    EXPECTED_HEAD_SHA: "${{ steps.identity.outputs.head-sha }}",
    EXPECTED_POLICY_SHA256: "${{ steps.identity.outputs.policy-sha256 }}",
    EXPECTED_TEST_MERGE_SHA: "${{ steps.identity.outputs.test-merge-sha }}",
    EXPECTED_TEST_MERGE_TREE_SHA:
      "${{ steps.identity.outputs.test-merge-tree-sha }}",
    GITHUB_REPOSITORY: "${{ github.repository }}",
    MANAGED_ISSUE_NUMBER: "${{ inputs.issue_number }}",
    MANAGED_MERGE_CAPABILITY: "${{ inputs.merge_capability }}",
    MANAGED_RUN_ID: "${{ inputs.run_id }}",
    MANAGED_SOURCE_REVISION_SHA256: "${{ inputs.source_revision_sha256 }}",
    MANAGED_WORKFLOW_RUN_ATTEMPT: "${{ github.run_attempt }}",
    MANAGED_WORKFLOW_RUN_ID: "${{ github.run_id }}",
    MANAGED_WORKFLOW_SHA: "${{ github.workflow_sha }}",
    PR_NUMBER: "${{ inputs.pr_number }}",
  };
  if (
    standaloneAuthorization >= 0 ||
    merge < 0 ||
    !String(mergeStep?.run ?? "").includes(
      "exact-head-merge.mjs --require-merge --managed-authorization",
    )
  ) {
    issues.push(
      `Workflow '${workflowName}' must consume current source authorization inside the exact merge controller, never in a separate workflow step.`,
    );
  }
  if (
    mergeToken < 0 ||
    intent < 0 ||
    merge < 0 ||
    intent >= mergeToken ||
    mergeToken !== merge - 1
  ) {
    issues.push(
      `Workflow '${workflowName}' must mint the exact Merge Authority credential immediately before the managed merge controller after intent publication.`,
    );
  }
  if (
    Object.entries(expectedManagedMergeEnvironment).some(
      ([name, value]) => mergeEnvironment[name] !== value,
    )
  ) {
    issues.push(
      `Workflow '${workflowName}' managed merge controller must receive the exact manager credential and source identity bindings.`,
    );
  }
  if (
    mergeEnvironment.GH_TOKEN !== "${{ steps.merge-token.outputs.token }}" ||
    mergeTokenInputs["app-id"] !== "${{ vars.CLOUDX_MERGE_APP_ID }}" ||
    mergeTokenInputs["private-key"] !==
      "${{ secrets.CLOUDX_MERGE_APP_PRIVATE_KEY }}" ||
    JSON.stringify(mergeTokenPermissions) !==
      JSON.stringify([
        "permission-checks",
        "permission-contents",
        "permission-pull-requests",
      ]) ||
    mergeTokenInputs["permission-checks"] !== "read" ||
    mergeTokenInputs["permission-contents"] !== "write" ||
    mergeTokenInputs["permission-pull-requests"] !== "read"
  ) {
    issues.push(
      `Workflow '${workflowName}' managed merge controller must receive only the scoped Merge Authority credential for GitHub mutation.`,
    );
  }
  if (
    !isRecord(immediateCompletion) ||
    !String(immediateCompletion.if ?? "").includes("always()") ||
    immediateCompletion["continue-on-error"] !== true ||
    !isRecord(reconcile) ||
    JSON.stringify(normalizedNeeds(reconcile)) !==
      JSON.stringify(["evaluate"]) ||
    !String(reconcile.if ?? "").includes("always()") ||
    !String(reconcile.if ?? "").includes("github.run_attempt == 1") ||
    reconcile.environment !== "cloudx-controller" ||
    !boundedTimeout(reconcile, 20) ||
    !usesMainMergeMutex(reconcile) ||
    hasWritePermissions(reconcile.permissions ?? workflow.permissions) ||
    jobUsesModelSecret(reconcile) ||
    checkoutStep(reconcile)?.with?.ref !== "${{ github.workflow_sha }}" ||
    !isRecord(reconcileToken) ||
    reconcileToken.with?.["app-id"] !== "${{ vars.CLOUDX_MERGE_APP_ID }}" ||
    reconcileToken.with?.["private-key"] !==
      "${{ secrets.CLOUDX_MERGE_APP_PRIVATE_KEY }}" ||
    JSON.stringify(reconcilePermissionInputs) !==
      JSON.stringify(["permission-checks"]) ||
    reconcileToken.with?.["permission-checks"] !== "write" ||
    !jobCommands(reconcile).includes(
      "publish-automation-intent.mjs --reconcile",
    )
  ) {
    issues.push(
      `Workflow '${workflowName}' must attempt immediate completion and run one independent always reconciliation with exact checks-only Merge Authority identity.`,
    );
  }
  return issues;
}

export function validateProtectedMergeWorkflow(
  workflowName,
  workflow,
  issues = [],
) {
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
  const merge = jobs.merge;
  const inputs = workflow.on?.workflow_dispatch?.inputs;
  if (!isRecord(merge)) {
    issues.push(`Workflow '${workflowName}' must define protected merge job.`);
    return issues;
  }
  const commands = jobCommands(merge);
  if (
    !isRecord(inputs) ||
    !isRecord(inputs.expected_base_sha) ||
    !isRecord(inputs.expected_head_sha) ||
    merge.environment !== "cloudx-protected-merge" ||
    !usesMainMergeMutex(merge) ||
    !commands.includes("record-merge-intent.mjs --protected") ||
    !commands.includes(
      "exact-head-merge.mjs --require-merge --protected-manual",
    )
  ) {
    issues.push(
      `Workflow '${workflowName}' must require attended environment approval, exact base/head intent, and the protected Merge Authority path.`,
    );
  }
  return issues;
}

export function validateTrustedAutomergeWorkflow(
  workflowName,
  workflow,
  issues = [],
) {
  const authorize = isRecord(workflow.jobs)
    ? workflow.jobs["authorize-and-evaluate"]
    : undefined;
  if (!isRecord(authorize)) {
    issues.push(
      `Workflow '${workflowName}' must define authorize-and-evaluate job.`,
    );
    return issues;
  }
  const condition = String(authorize.if ?? "");
  if (
    !condition.includes("github.event_name == 'workflow_dispatch'") ||
    !condition.includes("github.ref == 'refs/heads/main'") ||
    !condition.includes("github.event.label.name == 'trusted-auto-merge'") ||
    authorize.environment !== "cloudx-controller" ||
    !usesMainMergeMutex(authorize)
  ) {
    issues.push(
      `Workflow '${workflowName}' must use cloudx-controller, accept manual intent only from the main controller, and preserve labeled pull-request intent plus the merge mutex.`,
    );
  }
  return issues;
}

export function validateCiWorkflow(workflowName, workflow, issues = []) {
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!isRecord(job) || !boundedTimeout(job, 120)) {
      issues.push(
        `Workflow '${workflowName}' job '${jobName}' must have an explicit bounded timeout.`,
      );
    }
  }
  const verifier = jobs["isolated-verifier"];
  if (!isRecord(verifier)) {
    issues.push(`Workflow '${workflowName}' must define isolated-verifier.`);
    return issues;
  }
  const steps = Array.isArray(verifier.steps)
    ? verifier.steps.filter(isRecord)
    : [];
  const checkouts = steps.filter(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@"),
  );
  const trusted = checkouts.some(
    (step) =>
      step.with?.ref ===
        "${{ github.event.pull_request.base.sha || github.sha }}" &&
      step.with?.path === "controller",
  );
  const source = checkouts.some(
    (step) =>
      step.with?.path === "source" && step.with?.ref === "${{ github.sha }}",
  );
  const commands = jobCommands(verifier);
  if (
    !trusted ||
    !source ||
    !commands.includes(
      "--file controller/containers/ci/Dockerfile controller",
    ) ||
    !commands.includes("/source:/source:ro") ||
    !commands.includes("results.json:/results/results.json:rw") ||
    !commands.includes("install -m 0600") ||
    !["DAC_OVERRIDE", "SETUID", "SETGID", "KILL"].every((capability) =>
      commands.includes(`--cap-add ${capability}`),
    )
  ) {
    issues.push(
      `Workflow '${workflowName}' isolated verifier must build from the trusted controller and mount only read-only candidate source plus one evidence file.`,
    );
  }
  if (
    !commands.includes("--init") ||
    !commands.includes("--network none") ||
    !commands.includes("--read-only") ||
    !commands.includes("--cap-drop ALL") ||
    !commands.includes("--security-opt no-new-privileges") ||
    !commands.includes("--pids-limit 512") ||
    !commands.includes("--memory 7g") ||
    !commands.includes("--cpus 2") ||
    !commands.includes("--shm-size 1g") ||
    !commands.includes(
      "--tmpfs /tmp:rw,noexec,nosuid,nodev,size=2g,mode=1777",
    ) ||
    !commands.includes("--tmpfs /work:rw,exec,nosuid,nodev,size=8g,mode=1777")
  ) {
    issues.push(
      `Workflow '${workflowName}' isolated verifier must use a reaping init and the exact bounded no-network runtime with no-exec temporary storage and an executable candidate workspace.`,
    );
  }
  const identity = jobs.identity;
  const identityCommands = isRecord(identity) ? jobCommands(identity) : "";
  const identitySteps =
    isRecord(identity) && Array.isArray(identity.steps)
      ? identity.steps.filter(isRecord)
      : [];
  const identityCheckouts = identitySteps.filter(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@"),
  );
  if (
    !isRecord(identity) ||
    !identityCheckouts.some(
      (step) =>
        step.with?.path === "controller" &&
        step.with?.ref === "${{ github.event.pull_request.base.sha }}",
    ) ||
    !identityCheckouts.some(
      (step) =>
        step.with?.path === "source" && step.with?.ref === "${{ github.sha }}",
    ) ||
    !identityCommands.includes("check-identity.mjs create-ci-artifact") ||
    !identitySteps.some(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/upload-artifact@") &&
        step.with?.name === "cloudx-ci-identity-v2",
    )
  ) {
    issues.push(
      `Workflow '${workflowName}' must emit one trusted controller-generated identity for the exact tested merge.`,
    );
  }
  return issues;
}

function boundedTimeout(job, maximum) {
  return (
    Number.isInteger(job["timeout-minutes"]) &&
    job["timeout-minutes"] > 0 &&
    job["timeout-minutes"] <= maximum
  );
}

function jobCommands(job) {
  return (Array.isArray(job.steps) ? job.steps : [])
    .filter(isRecord)
    .map((step) => (typeof step.run === "string" ? step.run : ""))
    .join("\n");
}

function normalizedNeeds(job) {
  if (typeof job.needs === "string") return [job.needs];
  return Array.isArray(job.needs) ? [...job.needs] : [];
}

function checkoutStep(job) {
  return (Array.isArray(job.steps) ? job.steps : []).find(
    (step) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@"),
  );
}

function publisherExecutesCandidate(commands) {
  return (
    /\b(?:npx|pnpm|pytest|python(?:3)?)\b/iu.test(commands) ||
    /\bnpm\s+(?:exec|run|test)\b/iu.test(commands) ||
    /\b(?:docker|podman)\s+(?:compose\s+)?run\b/iu.test(commands) ||
    /\bgit\s+(?:checkout|switch)\b[^\n]*(?:candidate|bundle|FETCH_HEAD)/iu.test(
      commands,
    )
  );
}

function parseSkill(source, skillPath) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(
    source,
  );
  if (!match) {
    throw new Error(`${skillPath} must begin with YAML frontmatter.`);
  }
  const document = parseDocument(match[1], {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${skillPath} has invalid YAML frontmatter: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const frontmatter = document.toJS();
  if (!isRecord(frontmatter)) {
    throw new Error(`${skillPath} frontmatter must be an object.`);
  }
  return { frontmatter, body: match[2] };
}

function validateSkillReferences(
  repoRoot,
  skillPath,
  body,
  packageScripts,
  issues,
) {
  const references = new Set();
  for (const target of markdownLinkTargets(body)) {
    if (!isExternalReference(target)) {
      references.add(
        resolveSkillReference(repoRoot, skillPath, target, issues),
      );
    }
  }
  for (const match of body.matchAll(repositoryPathPattern)) {
    references.add(match[1]);
  }
  for (const reference of references) {
    if (!reference) {
      continue;
    }
    const relativePath = reference.replace(/[.,;:)]+$/u, "");
    if (/[*{}]/u.test(relativePath)) {
      continue;
    }
    if (!fs.existsSync(path.join(repoRoot, relativePath))) {
      issues.push(
        `Skill '${path.basename(path.dirname(skillPath))}' references missing repository path '${relativePath}'.`,
      );
    }
  }
  for (const match of body.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/gu)) {
    if (!packageScripts.has(match[1])) {
      issues.push(
        `Skill '${path.basename(path.dirname(skillPath))}' references missing npm script '${match[1]}'.`,
      );
    }
  }
}

function resolveSkillReference(repoRoot, skillPath, target, issues) {
  let decoded;
  try {
    decoded = decodeURIComponent(
      target.replace(/^<|>$/gu, "").split(/[?#]/u, 1)[0],
    );
  } catch {
    issues.push(
      `Skill '${path.basename(path.dirname(skillPath))}' contains an invalid encoded link '${target}'.`,
    );
    return undefined;
  }
  if (!decoded) {
    return undefined;
  }
  const resolved = path.resolve(path.dirname(skillPath), decoded);
  const relative = path.relative(repoRoot, resolved);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    issues.push(
      `Skill '${path.basename(path.dirname(skillPath))}' link '${target}' must resolve inside the repository.`,
    );
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

function markdownLinkTargets(body) {
  return [...body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)].map(
    (match) => match[1],
  );
}

function isExternalReference(target) {
  return target.startsWith("#") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target);
}

function readPackageScripts(repoRoot, issues) {
  const packagePath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packagePath)) {
    issues.push(
      "Repository package.json does not exist; npm command references cannot be validated.",
    );
    return new Set();
  }
  try {
    const packageDocument = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return new Set(
      Object.keys(
        isRecord(packageDocument.scripts) ? packageDocument.scripts : {},
      ),
    );
  } catch (error) {
    issues.push(
      `Repository package.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Set();
  }
}

function parseYaml(source, label, issues) {
  const document = parseDocument(source, {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    issues.push(
      `${label} is invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
    return undefined;
  }
  const value = document.toJS();
  if (!isRecord(value)) {
    issues.push(`${label} must contain a YAML object.`);
    return undefined;
  }
  return value;
}

function validateActionReference(
  repoRoot,
  workflowName,
  jobName,
  action,
  issues,
) {
  if (action.startsWith("./")) {
    const resolved = path.resolve(repoRoot, action);
    const relative = path.relative(repoRoot, resolved);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      issues.push(
        `Workflow '${workflowName}' job '${jobName}' local action '${action}' must resolve inside the repository.`,
      );
    } else if (!fs.existsSync(resolved)) {
      issues.push(
        `Workflow '${workflowName}' job '${jobName}' references missing local action '${action}'.`,
      );
    }
    return;
  }
  if (action.startsWith("docker://")) {
    return;
  }
  const separator = action.lastIndexOf("@");
  const revision = separator === -1 ? "" : action.slice(separator + 1);
  if (!externalActionSha.test(revision)) {
    issues.push(
      `Workflow '${workflowName}' job '${jobName}' action '${action}' must use a full-length commit SHA.`,
    );
  }
}

function validateUsesReference(
  repoRoot,
  workflowName,
  jobName,
  action,
  location,
  issues,
) {
  if (typeof action !== "string") {
    issues.push(
      `Workflow '${workflowName}' job '${jobName}' ${location} 'uses' value must be a string.`,
    );
    return;
  }
  validateActionReference(repoRoot, workflowName, jobName, action, issues);
}

function workflowTriggers(on) {
  if (typeof on === "string") {
    return new Set([on]);
  }
  if (Array.isArray(on)) {
    return new Set(on.filter((entry) => typeof entry === "string"));
  }
  return new Set(isRecord(on) ? Object.keys(on) : []);
}

function hasWritePermissions(permissions) {
  if (permissions === "write-all") {
    return true;
  }
  return (
    isRecord(permissions) &&
    Object.values(permissions).some((permission) => permission === "write")
  );
}

function jobUsesModelSecret(job) {
  return containsModelSecret(job);
}

function jobUsesLoggedInCodex(job) {
  return (job?.steps ?? []).some((step) => step?.uses === loggedInCodexAction);
}

function usesExactModelRunner(job) {
  return sameStrings(job?.["runs-on"], loggedInCodexRunnerLabels);
}

function sameStrings(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  return (
    JSON.stringify(actual.map(String).sort()) ===
    JSON.stringify(expected.map(String).sort())
  );
}

function containsModelSecret(value, key = "") {
  if (typeof value === "string") {
    const names = [
      ...value.matchAll(
        /secrets(?:\.([A-Za-z0-9_]+)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])/gu,
      ),
    ].map((match) => match[1] ?? match[2]);
    return (
      names.some((name) => modelSecretName.test(name)) ||
      (names.length > 0 && modelSecretName.test(key))
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsModelSecret(entry, key));
  }
  return (
    isRecord(value) &&
    Object.entries(value).some(([entryKey, entry]) =>
      containsModelSecret(entry, entryKey),
    )
  );
}

function jobUsesPullRequestHead(job, triggers) {
  const steps = Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
  for (const step of steps) {
    if (
      typeof step.uses === "string" &&
      step.uses.toLowerCase().startsWith("actions/checkout@")
    ) {
      if (
        triggers.has("pull_request") ||
        containsPullRequestHeadReference(step.with)
      ) {
        return true;
      }
    }
    if (typeof step.run === "string" && executesPullRequestHead(step.run)) {
      return true;
    }
  }
  return false;
}

function containsPullRequestHeadReference(value) {
  const source = JSON.stringify(value ?? {});
  return /github\.event\.pull_request\.head|github\.head_ref|refs\/pull\//iu.test(
    source,
  );
}

function executesPullRequestHead(command) {
  return (
    /\bgh\s+pr\s+checkout\b/iu.test(command) ||
    /\bgit\s+(?:checkout|switch)\b[^\n]*(?:pull_request\.head|github\.head_ref|refs\/pull\/)/iu.test(
      command,
    )
  );
}

function requiredDirectories(root, label, issues) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    issues.push(`Required skill directory ${label} does not exist.`);
    return undefined;
  }
  const directories = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (directories.length === 0) {
    issues.push(`Required skill directory ${label} contains no skills.`);
    return undefined;
  }
  return directories;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  validateProcess()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
