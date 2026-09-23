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
  const separateReviewWorkers = !service.includes("function workerWorkspace(");
  if (separateReviewWorkers) {
    const comparison = "  private async prepareReviewComparison(\n";
    const refresh = maintained.indexOf("  refreshReviewWorkspace(\n");
    const comparisonStart = maintained.indexOf(comparison, to);
    const ancestor = maintained.indexOf("  private async isAncestor(");
    const afterAncestor = maintained.indexOf("  private async verifyRebaseRecovery(", ancestor);
    if (refresh < 0 || refresh >= from || comparisonStart < to || ancestor < 0 || afterAncestor < ancestor)
      throw new Error("Managed Forge review integration is missing its maintained review checkout methods.");
    methods = maintained.slice(refresh, comparisonStart) + maintained.slice(ancestor, afterAncestor);
    replace(FORGE_RUNTIME_FILE, "  baseCommit: string;", `  baseCommit: string;
  reviewBaseSha?: string;
  reviewRefresh?: { headSha: string; baseSha: string; baseBranch: string };`);
    replace(FORGE_RUNTIME_FILE, "        owned.baseCommit = commit;", "        owned.baseCommit = commit;\n        if (input.review) owned.reviewBaseSha = input.baseSha!.toLowerCase();");
    replace(FORGE_RUNTIME_FILE, "    let mergeBases: string[];", `    await this.requireReviewMergeBase(owned, headSha, baseSha, signal);
  }

  private async requireReviewMergeBase(owned: OwnedWorkspace, headSha: string, baseSha: string, signal?: AbortSignal): Promise<void> {
    let mergeBases: string[];`);
  }
  const modernQueue = "private serialize<T>(id: string, name: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>";
  const legacyQueue = "private serialize<T>(id: string, operation: () => Promise<T>): Promise<T>";
  if (!runtime.includes(modernQueue)) {
    if (!runtime.includes(legacyQueue)) throw new Error("Managed Forge review integration does not recognize the target runtime queue.");
    methods = methods.replace(/this\.serialize\(workspace\.id, "(?:refreshReviewWorkspace|prepareReviewScope|retainReviewBaseline)", signal, async \(\) => \{/g,
      "this.serialize(workspace.id, async () => {\n      signal?.throwIfAborted();");
  }
  const insertion = separateReviewWorkers ? "  private async prepareReviewComparison(\n" : followingMethod;
  replace(FORGE_RUNTIME_FILE, insertion, methods + insertion);
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
  } else if (separateReviewWorkers) {
    integrateSeparateReviewWorkers(changes, replace);
    replace(FORGE_SERVICE_FILE, "    worker.attemptId = randomUUID();", "    worker.attemptId = randomUUID();\n" + capture);
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
  if (separateReviewWorkers)
    replace(FORGE_VALIDATION_FILE, '  if (report.kind === "review")\n    return { kind: "review", ...parseReview(report) };',
      '  if (report.kind === "review") {\n    text(report.body, "review body", 100_000);\n    return { kind: "review", ...parseReview(report) };\n  }');
  else
    replace(FORGE_VALIDATION_FILE, '    return { kind: "review", ...parseReview(report) };',
      '    text(report.body, "review body", 100_000);\n    return { kind: "review", ...parseReview(report) };');
  return changes;
}

function integrateSeparateReviewWorkers(changes, replace) {
  changes[FORGE_SERVICE_FILE] += `
interface ManagedReviewRuntime {
  refreshReviewWorkspace(workspace: ReturnType<typeof workerWorkspace>, comparison: { headSha: string; baseSha: string; baseBranch: string }, signal?: AbortSignal): Promise<void>;
}
function workerWorkspace(worker: ForgeWorker) {
  if (!worker.worktreePath || !worker.repositoryPath) throw new Error("Review workspace is missing.");
  return { id: worker.id, repositoryPath: worker.repositoryPath, worktreePath: worker.worktreePath, branch: worker.branch ?? "" };
}
function archiveManagedDraft(worker: ForgeWorker) {
  const saved = worker as ForgeWorker & { reviewHistory?: ForgeReviewDraft[] };
  if (!saved.draft) return;
  if ((saved.reviewHistory?.length ?? 0) >= 1000) throw new Error("Review history is full. Inspect this reviewer before continuing.");
  (saved.reviewHistory ??= []).push(saved.draft);
  saved.draft = undefined;
}
function completedManagedDraft(worker: ForgeWorker): boolean {
  const saved = worker as ForgeWorker & { draft?: ForgeReviewDraft & { id: string }; completion?: { attemptId: string } };
  return saved.kind === "review" && saved.draft?.id !== undefined && saved.draft.id === saved.completion?.attemptId;
}
`;
  // These targets used to delete each review checkout at completion and on
  // interruption. Keep it until explicit removal so the saved evidence exists.
  for (const previous of ['worker.status = "paused";\n        ', 'await this.quiesce(worker, { retainReport });\n        ',
    'await this.quiesce(worker, { retainReport: worker.kind === "issue" && !worker.pendingPublication });\n              '])
    replace(FORGE_SERVICE_FILE, `${previous}if (worker.kind === "review") await this.cleanup(worker);`, previous.trimEnd());
  replace(FORGE_SERVICE_FILE, `        if (worker.kind === "review" && status === "stopped")
          await this.cleanup(worker);
`, "");
  replace(FORGE_SERVICE_FILE, `        await this.cleanup(worker);
        worker.status = "completed";`, `        await this.quiesce(worker);
        worker.status = "completed";`);
  replace(FORGE_SERVICE_FILE, "    if (recoveringResources) {", `    if (completedManagedDraft(worker)) {
      await this.recoverResources(worker);
      await this.quiesce(worker);
      controller.signal.throwIfAborted();
      worker.status = "completed";
      worker.error = undefined;
      await this.persist();
      if (worker.autoPost && !this.autoReviewParent(worker) && worker.draft?.status === "draft") await this.postDraft(worker);
      return structuredClone(worker);
    }
    if (recoveringResources) {`);
  replace(FORGE_SERVICE_FILE, `        await this.cleanup(worker);
        worker.headSha = change.headSha;`, `        if (worker.worktreePath)
          await (this.deps.runtime as Runtime & ManagedReviewRuntime).refreshReviewWorkspace(workerWorkspace(worker), change, controller.signal);
        worker.headSha = change.headSha;`);
  replace(FORGE_SERVICE_FILE, '    worker.attemptId = randomUUID();', '    if (worker.kind === "review") archiveManagedDraft(worker);\n    worker.attemptId = randomUUID();');
  replace(FORGE_SERVICE_FILE, `      worker.draft = {
        ...parseReview({ ...input, headSha: worker.draft.headSha }),`, `      worker.draft = {
        ...worker.draft,
        ...parseReview({ ...input, headSha: worker.draft.headSha }),`);
  replace(FORGE_SERVICE_FILE, '          await this.quiesce(worker, { closeTab: report.kind === "review" });',
    '          if (report.kind === "review") retainReport = true;\n          await this.quiesce(worker, { closeTab: report.kind === "review", retainReport });');
  replace(FORGE_SERVICE_FILE, `            worker.draft = { ...parseReview(report), status: "draft" };
            await this.cleanup(worker);`, `            const draft = { ...parseReview(report), id: worker.attemptId!, startedAt: worker.startedAt, status: "draft" };
            const scope = await retainManagedReview(this.deps.runtime, workerWorkspace(worker), worker, report.headSha, this.operations.get(worker.id)?.signal);
            recordManagedReview(worker, draft, scope);
            await this.persist();
            await this.quiesce(worker);
            this.operations.get(worker.id)?.signal.throwIfAborted();
            retainReport = false;`);
  replace(FORGE_VALIDATION_FILE, `function parseSavedReview(value: unknown): ForgeReviewDraft {
  const input = object(value);`, `function parseSavedReview(value: unknown): ForgeReviewDraft & { id: string; startedAt: string } {
  const input = object(value);
  const id = text(input.id, "saved review identity", 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error("Invalid saved review identity.");
  const startedAt = isoTimestamp(input.startedAt, "review start timestamp");`);
  replace(FORGE_VALIDATION_FILE, "return { ...review, status };", "return { id, startedAt, ...review, status };");
  replace(FORGE_VALIDATION_FILE, "return { ...review, status, publication:", "return { id, startedAt, ...review, status, publication:");
  replace(FORGE_VALIDATION_FILE, "    if (worker.draft !== undefined) parsed.draft = parseSavedReview(worker.draft);", `    if (worker.draft !== undefined)
      parsed.draft = parseSavedReview({ id: worker.id, startedAt: worker.startedAt, ...object(worker.draft) });
    if (worker.reviewHistory !== undefined) {
      if (!Array.isArray(worker.reviewHistory) || worker.reviewHistory.length > 1000) throw new Error("Invalid saved review history.");
      const reviewHistory = worker.reviewHistory.map(parseSavedReview);
      const ids = [...reviewHistory, ...(parsed.draft ? [parsed.draft as ForgeReviewDraft & { id: string }] : [])].map(draft => draft.id.toLowerCase());
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate saved review identity.");
      Object.assign(parsed, { reviewHistory });
    }
    if (worker.kind !== "review" && (worker.draft !== undefined || worker.reviewHistory !== undefined))
      throw new Error("Only review workers can have review drafts or history.");`);
}
