import type {
  ForgeIssueCompletionReport,
  ForgeReviewComment,
  ForgeReviewSubmission,
  ForgeWorker,
} from "@cloudx/shared";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 100_000): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error(`Invalid ${name}.`);
  return value;
}
export function parseReview(value: unknown): ForgeReviewSubmission {
  const input = object(value);
  const headSha = text(input.headSha, "review head", 64);
  if (!/^[a-f0-9]{40,64}$/i.test(headSha))
    throw new Error("Invalid review head.");
  if (!["comment", "approve", "request_changes"].includes(String(input.event)))
    throw new Error("Invalid review event.");
  if (!Array.isArray(input.comments) || input.comments.length > 100)
    throw new Error("A review can contain at most 100 comments.");
  const comments: ForgeReviewComment[] = input.comments.map((raw) => {
    const comment = object(raw);
    const body = text(comment.body, "comment body", 20_000);
    if (!body.trim()) throw new Error("Review comments must not be empty.");
    if (comment.path === undefined) {
      if (
        comment.line !== undefined ||
        comment.side !== undefined ||
        comment.oldPath !== undefined
      )
        throw new Error("Inline comment fields require a file path.");
      return { body };
    }
    const file = text(comment.path, "comment path", 4096);
    if (
      !file ||
      file.startsWith("/") ||
      file.includes("\\") ||
      file.split("/").some((part) => part === ".." || part === ".") ||
      /[\x00-\x1f]/.test(file)
    )
      throw new Error("Review file paths must be relative.");
    if (!Number.isSafeInteger(comment.line) || Number(comment.line) < 1)
      throw new Error("Inline comments need a positive line number.");
    if (
      comment.side !== undefined &&
      comment.side !== "LEFT" &&
      comment.side !== "RIGHT"
    )
      throw new Error("Invalid comment side.");
    return {
      body,
      path: file,
      line: Number(comment.line),
      ...(comment.side ? { side: comment.side as "LEFT" | "RIGHT" } : {}),
      ...(comment.oldPath !== undefined
        ? { oldPath: text(comment.oldPath, "old path", 4096) }
        : {}),
    };
  });
  const body = text(input.body, "review body");
  if (!body.trim() && !comments.length)
    throw new Error("A review must contain a summary or comments.");
  return {
    headSha,
    event: input.event as ForgeReviewSubmission["event"],
    body,
    comments,
  };
}
export function parseWorkerReport(
  value: unknown,
):
  | ForgeIssueCompletionReport
  | ({ kind: "review" } & ForgeReviewSubmission) {
  const report = object(value);
  if (report.kind === "review")
    return { kind: "review", ...parseReview(report) };
  if (report.kind !== "issue")
    throw new Error("Completion report must identify issue or review work.");
  const title = text(report.title, "change title", 256);
  const body = text(report.body, "change body");
  if (!title.trim() || !body.trim())
    throw new Error("Issue completion requires a title and summary.");
  const ids = report.resolvedDiscussionIds ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 256)
  )
    throw new Error("Invalid resolved discussion IDs.");
  const replies =
    report.discussionReplies === undefined ? [] : report.discussionReplies;
  if (!Array.isArray(replies) || replies.length > 100)
    throw new Error("An issue report can contain at most 100 discussion replies.");
  const discussionIds = new Set<string>();
  const discussionReplies = replies.map(raw => {
    const reply = object(raw);
    const discussionId = text(reply.discussionId, "reply discussion ID", 256);
    if (!discussionId.trim() || discussionIds.has(discussionId))
      throw new Error("Reply discussion IDs must be nonblank and unique.");
    discussionIds.add(discussionId);
    const body = text(reply.body, "discussion reply body", 20_000);
    if (!body.trim()) throw new Error("Discussion replies must not be empty.");
    return { discussionId, body };
  });
  return {
    kind: "issue",
    title,
    body,
    resolvedDiscussionIds: [...new Set(ids)] as string[],
    discussionReplies,
  };
}

function parsePendingPublication(
  value: unknown,
): NonNullable<ForgeWorker["pendingPublication"]> {
  const input = object(value);
  const report = parseWorkerReport(input.report);
  if (report.kind !== "issue")
    throw new Error("Pending publication requires an issue completion report.");
  const headSha = input.headSha === undefined
    ? undefined
    : text(input.headSha, "published head", 64);
  if (headSha !== undefined && !/^[a-f0-9]{40,64}$/i.test(headSha))
    throw new Error("Invalid published head.");
  const replyIds = new Set(report.discussionReplies.map(reply => reply.discussionId));
  const replied = input.repliedDiscussionIds;
  if (
    !Array.isArray(replied) ||
    replied.length > 100 ||
    replied.some(id => typeof id !== "string" || !replyIds.has(id)) ||
    new Set(replied).size !== replied.length
  )
    throw new Error("Published reply IDs must be unique and belong to the completion report.");
  const replyingTo = input.replyingToDiscussionId;
  if (
    replyingTo !== undefined &&
    (typeof replyingTo !== "string" || !replyIds.has(replyingTo) || replied.includes(replyingTo))
  )
    throw new Error("The in-flight reply must belong to the report and must not already be published.");
  if ((replied.length || replyingTo !== undefined) && headSha === undefined)
    throw new Error("Discussion reply progress requires a published head.");
  return {
    report,
    ...(headSha !== undefined ? { headSha } : {}),
    repliedDiscussionIds: [...replied] as string[],
    ...(replyingTo !== undefined ? { replyingToDiscussionId: replyingTo as string } : {}),
  };
}

export function parseWorkers(value: unknown): ForgeWorker[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new Error("Invalid saved Forge worker list.");
  const ids = new Set<string>();
  return value.map((raw) => {
    const worker = object(raw);
    for (const key of [
      "id",
      "title",
      "baseBranch",
      "templateId",
      "startedAt",
      "updatedAt",
    ])
      text(worker[key], `worker ${key}`);
    if (
      !/^[a-f0-9-]{36}$/.test(String(worker.id)) ||
      ids.has(String(worker.id))
    )
      throw new Error("Invalid or duplicate worker identity.");
    ids.add(String(worker.id));
    if (
      !["issue", "review"].includes(String(worker.kind)) ||
      ![
        "starting",
        "running",
        "paused",
        "awaiting_review",
        "stopped",
        "completed",
        "failed",
        "cleanup_failed",
      ].includes(String(worker.status))
    )
      throw new Error("Invalid worker state.");
    if (
      !Number.isSafeInteger(worker.number) ||
      Number(worker.number) < 1 ||
      typeof worker.autoPost !== "boolean"
    )
      throw new Error("Invalid worker fields.");
    if (
      !Number.isFinite(Date.parse(String(worker.startedAt))) ||
      !Number.isFinite(Date.parse(String(worker.updatedAt)))
    )
      throw new Error("Invalid worker timestamps.");
    const repository = object(worker.repository);
    if (!["github", "gitlab"].includes(String(repository.provider)))
      throw new Error("Invalid saved repository provider.");
    text(repository.apiUrl, "repository URL", 4096);
    text(repository.projectPath, "repository path", 4096);
    for (const key of [
      "repositoryPath",
      "worktreePath",
      "branch",
      "tabId",
      "attemptId",
      "changeUrl",
      "headSha",
      "feedbackDigest",
      "error",
    ])
      if (worker[key] !== undefined) text(worker[key], key);
    if (worker.attemptId && !/^[a-f0-9-]{36}$/.test(String(worker.attemptId)))
      throw new Error("Invalid report identity.");
    if (
      worker.publicationState !== undefined &&
      !["creating", "uncertain", "created"].includes(
        String(worker.publicationState),
      )
    )
      throw new Error("Invalid publication state.");
    if (
      worker.changeNumber !== undefined &&
      (!Number.isSafeInteger(worker.changeNumber) ||
        Number(worker.changeNumber) < 1)
    )
      throw new Error("Invalid change request number.");
    if (worker.draft) {
      const draft = object(worker.draft);
      parseReview(draft);
      if (
        !["draft", "posting", "posted", "post_failed"].includes(
          String(draft.status),
        )
      )
        throw new Error("Invalid saved review state.");
    }
    const parsed = structuredClone(worker) as unknown as ForgeWorker;
    if (worker.pendingPublication !== undefined) {
      if (worker.kind !== "issue")
        throw new Error("Only issue workers can have pending publication.");
      parsed.pendingPublication = parsePendingPublication(worker.pendingPublication);
    }
    return parsed;
  });
}
