export const FORGE_RUNTIME_FILE = "apps/server/src/forge/ForgeRuntime.ts";
export const FORGE_SERVICE_FILE = "apps/server/src/forge/ForgeWorkflowService.ts";
export const FORGE_VALIDATION_FILE = "apps/server/src/forge/ForgeWorkflowValidation.ts";
export const FORGE_EVIDENCE_FILE = "apps/server/src/forge/ManagedForgeReviewEvidence.ts";
export const FORGE_INTEGRATION_FILES = [FORGE_RUNTIME_FILE, FORGE_SERVICE_FILE, FORGE_VALIDATION_FILE, FORGE_EVIDENCE_FILE];
export const FORGE_INTEGRATION_SOURCE_FILES = ["scripts/managed-update-forge-integration.mjs", FORGE_RUNTIME_FILE, FORGE_EVIDENCE_FILE];

// Historical reviewers keep their full-review workflow. Only its persisted
// comparison evidence and retained Git objects are owned by this integration.
export function prepareManagedForgeIntegration(readTarget, readCoordinator) {
  const changes = Object.fromEntries(FORGE_INTEGRATION_FILES.slice(0, 3).map(file => [file, readTarget(file)]));
  const service = changes[FORGE_SERVICE_FILE], validation = changes[FORGE_VALIDATION_FILE], runtime = changes[FORGE_RUNTIME_FILE];
  const native = [service.includes("worker.reviewBaseline = { reviewId: draft.id, revision: scope.current };"),
    validation.includes("parsed.completion.reviewScope = scope;") && validation.includes("parsed.reviewBaseline = { reviewId, revision };"),
    runtime.includes("  prepareReviewScope(\n") && runtime.includes("  retainReviewBaseline(\n")];
  const integrated = service.includes("captureManagedReviewScope(") && validation.includes("preserveManagedReviewEvidence(worker, parsed);");
  if (native.every(Boolean)) return {};
  if (integrated && native[2] && readTarget(FORGE_EVIDENCE_FILE).includes("export function preserveManagedReviewEvidence(")) return {};
  if (native.some(Boolean) || integrated) throw new Error("Managed Forge review integration does not recognize the target evidence contract.");

  function replace(file, before, after) {
    if (changes[file].split(before).length !== 2)
      throw new Error(`Managed Forge review integration does not recognize the target contract in ${file}.`);
    changes[file] = changes[file].replace(before, after);
  }

  changes[FORGE_EVIDENCE_FILE] = readCoordinator(FORGE_EVIDENCE_FILE);
  changes[FORGE_SERVICE_FILE] = 'import { captureManagedReviewScope, startManagedReview, retainManagedReview, recordManagedReview } from "./ManagedForgeReviewEvidence.js";\n' + service;
  changes[FORGE_VALIDATION_FILE] = 'import { preserveManagedReviewEvidence } from "./ManagedForgeReviewEvidence.js";\n' + validation;
  changes[FORGE_RUNTIME_FILE] = 'import type { ForgeReviewRevision, ForgeReviewScope } from "./ManagedForgeReviewEvidence.js";\n' + runtime;

  const maintained = readCoordinator(FORGE_RUNTIME_FILE);
  const firstMethod = "  prepareReviewScope(\n", followingMethod = "  private async requireCleanReviewHead(";
  const from = maintained.indexOf(firstMethod), to = maintained.indexOf(followingMethod, from);
  if (from < 0 || to < from || maintained.indexOf(firstMethod, from + firstMethod.length) !== -1)
    throw new Error("Managed Forge review integration is missing its maintained runtime methods.");
  let methods = maintained.slice(from, to);
  const modernQueue = "private serialize<T>(id: string, name: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>";
  const legacyQueue = "private serialize<T>(id: string, operation: () => Promise<T>): Promise<T>";
  if (!runtime.includes(modernQueue)) {
    if (!runtime.includes(legacyQueue)) throw new Error("Managed Forge review integration does not recognize the target runtime queue.");
    methods = methods.replace(/this\.serialize\(workspace\.id, "(?:prepareReviewScope|retainReviewBaseline)", signal, async \(\) => \{/g,
      "this.serialize(workspace.id, async () => {\n      signal?.throwIfAborted();");
  }
  replace(FORGE_RUNTIME_FILE, followingMethod, methods + followingMethod);
  replace(FORGE_RUNTIME_FILE,
    "private async requireReviewMergeBase(owned: OwnedWorkspace, headSha: string, baseSha: string, signal?: AbortSignal): Promise<void>",
    "private async requireReviewMergeBase(owned: OwnedWorkspace, headSha: string, baseSha: string, signal?: AbortSignal): Promise<string>");
  replace(FORGE_RUNTIME_FILE, '      throw new Error("The review commits do not have a unique merge base for comparison.");\n',
    '      throw new Error("The review commits do not have a unique merge base for comparison.");\n    return mergeBases[0]!;\n');

  replace(FORGE_SERVICE_FILE, "    worker.attemptId = randomUUID();", `    const reviewScope = worker.kind === "review"
      ? await captureManagedReviewScope(this.deps.runtime, workerWorkspace(worker), context.item, signal) : undefined;
    worker.attemptId = randomUUID();`);
  const nativeCompletion = service.includes("  private async completeAttempt(worker: ForgeWorker): Promise<boolean> {");
  const completion = `    worker.completion = {
      attemptId: worker.attemptId,
      deadlineAt: new Date(Date.now() + settings.maxRunMinutes * 60_000).toISOString(),
    };`;
  const capture = `    startManagedReview(worker, worker.attemptId, new Date(Date.now() + settings.maxRunMinutes * 60_000).toISOString(), reviewScope);`;
  if (nativeCompletion) {
    replace(FORGE_SERVICE_FILE, completion, completion + "\n" + capture);
    replace(FORGE_SERVICE_FILE, "await this.quiesce(worker, { closeTab: false, successful: true });",
      'await this.quiesce(worker, { closeTab: false, successful: true, retainReport: report.kind === "review" });');
    replace(FORGE_SERVICE_FILE,
      '      worker.draft = { ...parseReview(report), id: completion.attemptId, startedAt: worker.startedAt, status: "draft" };',
      `      const scope = await retainManagedReview(this.deps.runtime, workerWorkspace(worker), worker, report.headSha, this.operations.get(worker.id)?.signal);
      await this.deps.reports.remove(completion.attemptId);
      this.operations.get(worker.id)?.signal.throwIfAborted();
      worker.attemptId = undefined;
      recordManagedReview(worker, { ...parseReview(report), id: completion.attemptId, startedAt: worker.startedAt, status: "draft" }, scope);`);
  } else {
    replace(FORGE_SERVICE_FILE, "    worker.attemptId = randomUUID();", "    worker.attemptId = randomUUID();\n" + capture);
    replace(FORGE_SERVICE_FILE, `            retainReport = true;
            worker.draft = { ...parseReview(report), id: worker.attemptId!, startedAt: worker.startedAt, status: "draft" };
            await this.persist();
            retainReport = false;
            await this.quiesce(worker);`, `            retainReport = true;
            const draft = { ...parseReview(report), id: worker.attemptId!, startedAt: worker.startedAt, status: "draft" };
            await this.quiesce(worker, { retainReport: true });
            const scope = await retainManagedReview(this.deps.runtime, workerWorkspace(worker), worker, report.headSha, this.operations.get(worker.id)?.signal);
            recordManagedReview(worker, draft, scope);
            await this.persist();
            await this.quiesce(worker);
            this.operations.get(worker.id)?.signal.throwIfAborted();
            retainReport = false;`);
  }
  // Native readers rebuild completion; older readers clone it. Validate and
  // preserve evidence after either reader has normalized drafts and history.
  replace(FORGE_VALIDATION_FILE, "    if (worker.autoReview !== undefined) {",
    "    preserveManagedReviewEvidence(worker, parsed);\n    if (worker.autoReview !== undefined) {");
  replace(FORGE_VALIDATION_FILE, 'const body = text(input.body, "review body");',
    'const body = text(input.body, "review body", 100_512);');
  replace(FORGE_VALIDATION_FILE, '    return { kind: "review", ...parseReview(report) };',
    '    text(report.body, "review body", 100_000);\n    return { kind: "review", ...parseReview(report) };');
  return changes;
}
