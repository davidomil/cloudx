import { isCooperationId, type CooperationFeedbackClaim } from "@cloudx/shared";
import { exactRecord, validateRecordChange, validateStoredTarget } from "./BoardValidation.js";
import { requireCooperation } from "./CooperationError.js";
import type { BlackboardState } from "./BlackboardState.js";

const actorPattern = /^(user|agent):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const revision = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const ids = (value: unknown, maximum = 10000): value is string[] => Array.isArray(value) && value.length <= maximum && value.every(isCooperationId) && new Set(value).size === value.length;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const nativeIdentity = (record: { providerTurnId?: string; nativeExecutionId?: string }) => record.providerTurnId === undefined && record.nativeExecutionId === undefined || isCooperationId(record.providerTurnId) && isCooperationId(record.nativeExecutionId);

export function validateBlackboardAudit(state: BlackboardState): void {
  const undoIds = new Set<string>();
  for (const stored of Object.values(state.operationReceipts)) {
    exactRecord(stored, ["receipt", "digest", "callerKey", "changes"], ["undoneBy"], "Saved operation");
    const receipt = stored.receipt;
    exactRecord(receipt, ["operationId", "boardId", "boardRevision", "eventCursor", "actor", "changedIds", "answeredEventIds", "committedAt", "projectionStatus"], ["assignmentGeneration", "providerId", "ownerPluginId", "logicalRunId", "attemptId", "providerTurnId", "nativeExecutionId"], "Saved receipt");
    requireCooperation(isCooperationId(receipt.operationId) && isCooperationId(receipt.boardId) && revision(receipt.boardRevision) && revision(receipt.eventCursor) &&
      actorPattern.test(receipt.actor) && ids(receipt.changedIds) && ids(receipt.answeredEventIds, 32) && date(receipt.committedAt) && nativeIdentity(receipt) && ["published", "unavailable"].includes(receipt.projectionStatus) &&
      /^[a-f0-9]{64}$/.test(stored.digest) && (stored.undoneBy === undefined || isCooperationId(stored.undoneBy)), "INTEGRITY_ERROR", "Saved receipt provenance is invalid.");
    const expectedCaller = receipt.actor.startsWith("agent:") ? `${receipt.actor}@${receipt.assignmentGeneration}` : receipt.actor;
    requireCooperation(stored.callerKey === expectedCaller && (!receipt.actor.startsWith("agent:") || revision(receipt.assignmentGeneration)), "INTEGRITY_ERROR", "Saved receipt actor does not match its assignment.");
    if (stored.undoneBy) {
      const key = `${receipt.boardId}/${stored.undoneBy}`;
      const inverse = Object.hasOwn(state.operationReceipts, key) ? state.operationReceipts[key] : undefined;
      requireCooperation(inverse && !undoIds.has(key) && inverse.receipt.actor === receipt.actor && inverse.receipt.boardId === receipt.boardId && inverse.receipt.eventCursor > receipt.eventCursor,
        "INTEGRITY_ERROR", "Saved undo lineage must identify one later inverse receipt by the same author.");
      undoIds.add(key);
    }
  }

  const eventIds = new Set<string>();
  for (const event of state.inbox) {
    exactRecord(event, ["eventId", "sequence", "boardId", "boardRevision", "kind", "author", "target", "targetRevision", "state", "createdAt"], ["reactionId", "threadId", "recipientTabId", "assignmentGeneration", "claim", "transferredFrom", "transferHistory", "ownerAdmission"], "Saved feedback");
    requireCooperation(!eventIds.has(event.eventId) && ["question", "reply", "ready"].includes(event.kind) && actorPattern.test(event.author) && revision(event.boardRevision) &&
      event.boardRevision <= state.boards[event.boardId].revision && date(event.createdAt) && (event.threadId === undefined || isCooperationId(event.threadId)) && (event.reactionId === undefined || isCooperationId(event.reactionId)),
      "INTEGRITY_ERROR", "Saved feedback identity or provenance is invalid.");
    eventIds.add(event.eventId);
    validateStoredTarget(event.target);
    if (["queued", "nativeAccepted", "unknown", "claimed"].includes(event.state)) {
      const assignment = event.recipientTabId ? state.assignments[event.recipientTabId] : undefined;
      requireCooperation(assignment?.boardId === event.boardId && assignment.assignmentGeneration === event.assignmentGeneration, "INTEGRITY_ERROR", "Pending feedback must name a current board binding.");
    }
    if (event.state === "claimed") requireCooperation(event.claim && event.claim.tabId === event.recipientTabId && event.claim.assignmentGeneration === event.assignmentGeneration, "INTEGRITY_ERROR", "Claimed feedback requires its durable owner.");
    if (event.claim) validateClaim(event.claim);
    if (event.transferredFrom) validateClaim(event.transferredFrom);
    if (event.transferHistory) { requireCooperation(Array.isArray(event.transferHistory), "INTEGRITY_ERROR", "Transfer history must be a list."); event.transferHistory.forEach(validateClaim); }
    if (event.ownerAdmission) {
      const admission = event.ownerAdmission;
      exactRecord(admission, ["tabId", "assignmentGeneration", "ownerPluginId", "logicalRunId", "attemptId"], [], "Owner admission");
      requireCooperation(isCooperationId(admission.tabId) && revision(admission.assignmentGeneration) && isCooperationId(admission.ownerPluginId) && isCooperationId(admission.logicalRunId) && isCooperationId(admission.attemptId), "INTEGRITY_ERROR", "Owner admission must name one exact tracked attempt.");
    }
  }

  for (const [token, staged] of Object.entries(state.stagedAssets)) {
    exactRecord(staged, ["token", "boardId", "actor", "asset"], [], "Staged image");
    requireCooperation(isCooperationId(token) && staged.token === token && Object.hasOwn(state.boards, staged.boardId) && /^(user:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|agent:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}@[1-9][0-9]*)$/.test(staged.actor), "INTEGRITY_ERROR", "Staged image ownership is invalid.");
    validateRecordChange({ collection: "assets", id: staged.asset.id, after: staged.asset });
  }

  for (const completion of state.completions) {
    exactRecord(completion, ["boardId", "tabId", "assignmentGeneration", "startCursor", "resultingBoardRevision", "receiptOperationIds", "changedIds", "answeredEventIds", "completedAt"], ["providerTurnId", "nativeExecutionId", "attemptId", "noChangeReason"], "Turn completion");
    requireCooperation(Object.hasOwn(state.boards, completion.boardId) && isCooperationId(completion.tabId) && revision(completion.assignmentGeneration) && Number.isSafeInteger(completion.startCursor) && completion.startCursor >= 0 &&
      Number.isSafeInteger(completion.resultingBoardRevision) && completion.resultingBoardRevision >= 0 && completion.resultingBoardRevision <= state.boards[completion.boardId].revision &&
      ids(completion.receiptOperationIds, 100) && Array.isArray(completion.changedIds) && Array.isArray(completion.answeredEventIds) && date(completion.completedAt) && nativeIdentity(completion) &&
      (completion.changedIds.length > 0 || completion.answeredEventIds.length > 0 || typeof completion.noChangeReason === "string" && completion.noChangeReason.trim().length > 0 && completion.noChangeReason.length <= 4000),
      "INTEGRITY_ERROR", "Saved cooperation completion is invalid.");
    const receipts = completion.receiptOperationIds.map(id => state.operationReceipts[`${completion.boardId}/${id}`]);
    requireCooperation(receipts.every(stored => stored && stored.receipt.actor === `agent:${completion.tabId}` && stored.receipt.assignmentGeneration === completion.assignmentGeneration && stored.receipt.attemptId === completion.attemptId &&
      stored.receipt.providerTurnId === completion.providerTurnId && stored.receipt.nativeExecutionId === completion.nativeExecutionId &&
      stored.receipt.eventCursor > completion.startCursor && stored.receipt.boardRevision <= completion.resultingBoardRevision), "INTEGRITY_ERROR", "Saved completion cites another turn's receipts.");
    const changed = new Set(receipts.flatMap(stored => stored.receipt.changedIds));
    const answered = new Set(receipts.flatMap(stored => stored.receipt.answeredEventIds));
    requireCooperation(ids(completion.changedIds, changed.size) && changed.size === completion.changedIds.length && completion.changedIds.every(id => changed.has(id)) &&
      ids(completion.answeredEventIds, answered.size) && answered.size === completion.answeredEventIds.length && completion.answeredEventIds.every(id => answered.has(id)),
      "INTEGRITY_ERROR", "Saved completion must match committed board work.");
  }
}

function validateClaim(claim: CooperationFeedbackClaim): void {
  exactRecord(claim, ["tabId", "assignmentGeneration"], ["attemptId", "providerId", "ownerPluginId", "logicalRunId"], "Feedback claim");
  requireCooperation(isCooperationId(claim.tabId) && revision(claim.assignmentGeneration) && (claim.attemptId === undefined || isCooperationId(claim.attemptId)) &&
    (claim.providerId === undefined || claim.providerId === "codex" || claim.providerId === "claude") && (claim.ownerPluginId === undefined || isCooperationId(claim.ownerPluginId)) &&
    (claim.logicalRunId === undefined || isCooperationId(claim.logicalRunId)), "INTEGRITY_ERROR", "Feedback ownership lineage is invalid.");
}
