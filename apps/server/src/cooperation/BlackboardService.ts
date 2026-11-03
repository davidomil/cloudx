import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  COOPERATION_LIMITS, boundsIntersect, connectionIntersectsRegion, cooperationActor, isCooperationId, itemBounds,
  type CooperationAssignment, type CooperationAsset, type CooperationBoard, type CooperationBoardSummary,
  type CooperationCaller, type CooperationEvent, type CooperationHostTab, type CooperationInboxEvent, type CooperationItem,
  type CooperationOperation, type CooperationPrecondition, type CooperationReceipt, type CooperationRecordKind,
  type CooperationTarget, type CooperationTransaction, type CooperationTurnCompletion
} from "@cloudx/shared";
import systemDesign from "./templates/system-design.json" with { type: "json" };
import decisionReview from "./templates/decision-review.json" with { type: "json" };
import sketchWip from "./templates/sketch-wip.json" with { type: "json" };
import { BoardFileProjection, boardMarkdown } from "./BoardFileProjection.js";
import { BoardUndoHistory } from "./BoardUndoHistory.js";
import { validateBlackboardAudit } from "./BlackboardAuditValidation.js";
import { BlackboardRepository } from "./BlackboardRepository.js";
import { boardSnapshot, emptyBlackboardState, type BlackboardState, type BoardCollection, type RecordChange, type StoredBoard } from "./BlackboardState.js";
import { CooperationError, requireCooperation } from "./CooperationError.js";
import { exactRecord, targetRecord, validateBoard, validateRecordChange, validateTarget, validateTransaction } from "./BoardValidation.js";

export { CooperationError } from "./CooperationError.js";

interface ServiceOptions { rootDir: string; now?: () => string }
export interface CooperationChange { boardId: string; reason: string; event?: CooperationEvent }
export interface CooperationTabMetadata { tabId: string; boardId: string | null; assignmentGeneration: number; generation: number; providerId?: "codex" | "claude"; label?: string }
const collections: BoardCollection[] = ["items", "connections", "regions", "reactions", "threads", "assets"];
const collectionFor: Record<CooperationRecordKind, BoardCollection> = { item: "items", connection: "connections", region: "regions", reaction: "reactions", thread: "threads" };
const userCaller: CooperationCaller = { kind: "user", userId: "local" };
const own = <T>(record: Record<string, T>, id: string): T | undefined => Object.hasOwn(record, id) ? record[id] : undefined;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const receiptKey = (boardId: string, operationId: string) => `${boardId}/${operationId}`;
const callerKey = (caller: CooperationCaller) => caller.kind === "user" ? cooperationActor(caller) : `${cooperationActor(caller)}@${caller.assignmentGeneration}`;

export class BlackboardService {
  private state = emptyBlackboardState();
  private ready = false;
  private readonly repository: BlackboardRepository;
  private readonly projection: BoardFileProjection;
  private readonly listeners = new Set<(change: CooperationChange) => void>();
  private readonly unavailableProjections = new Set<string>();
  private readonly now: () => string;

  constructor(private readonly options: ServiceOptions) {
    this.repository = new BlackboardRepository(path.resolve(options.rootDir));
    this.projection = new BoardFileProjection(this.repository);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async init(): Promise<void> {
    await this.repository.serialize(async () => {
      const state = await this.repository.load();
      this.validateState(state);
      for (const boardId of Object.keys(state.boards)) await this.projection.publish(boardSnapshot(state, boardId));
      this.state = state;
      this.ready = true;
      this.unavailableProjections.clear();
    });
  }

  subscribe(listener: (change: CooperationChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listBoards(): CooperationBoardSummary[] {
    this.assertReady();
    return Object.keys(this.state.boards).map(id => this.getBoard(id)).map(board => ({
      boardId: board.boardId, title: board.title, revision: board.revision, status: board.status,
      eventCursor: board.eventCursor, members: board.members, itemCount: board.items.length,
      openQuestions: board.threads.filter(thread => thread.status !== "resolved").length
    })).sort((a, b) => a.title.localeCompare(b.title));
  }

  getBoard(boardId: string, caller?: CooperationCaller): CooperationBoard {
    this.assertReady();
    this.requireBoard(this.state, boardId);
    if (caller) this.authorize(this.state, boardId, caller, false);
    return structuredClone(boardSnapshot(this.state, boardId));
  }

  async readBoard(boardId: string, caller?: CooperationCaller) {
    return this.repository.serialize(async () => {
      const board = this.getBoard(boardId, caller);
      await this.projection.verify(board);
      return { board, ...this.projection.paths(boardId), projectionHash: this.projection.hash(board) };
    });
  }

  assignmentForTab(tabId: string): CooperationAssignment | undefined {
    this.assertReady();
    const assignment = own(this.state.assignments, tabId);
    return assignment ? structuredClone(assignment) : undefined;
  }

  allAssignments(): CooperationAssignment[] { this.assertReady(); return structuredClone(Object.values(this.state.assignments)); }

  metadataForTab(tabId: string): CooperationTabMetadata {
    this.assertReady();
    this.requireId(tabId);
    const assignment = own(this.state.assignments, tabId);
    const generation = own(this.state.tabGenerationCounters, tabId) ?? 0;
    return { tabId, boardId: assignment?.boardId ?? null, assignmentGeneration: generation, generation,
      ...(assignment ? { providerId: assignment.providerId, label: assignment.label } : {}) };
  }

  async createBoard(input: { title: string; template?: string; tab?: CooperationHostTab }, caller = userCaller): Promise<CooperationBoard> {
    this.requireUser(caller);
    this.requireTitle(input.title);
    return this.repository.serialize(async () => {
      this.assertReady();
      const next = structuredClone(this.state);
      const boardId = `board-${randomUUID()}`;
      const board: StoredBoard = { schemaVersion: 1, boardId, title: input.title.trim(), revision: 0, status: "draft", eventCursor: 0,
        items: [], connections: [], regions: [], reactions: [], threads: [], assets: [] };
      try {
        const templates: Record<string, unknown> = { "system-design": systemDesign, "decision-review": decisionReview, "sketch-wip": sketchWip };
        if (input.template && input.template !== "blank") {
          requireCooperation(Object.hasOwn(templates, input.template), "INVALID_REQUEST", "Unknown board template.");
          const fixture = JSON.parse(JSON.stringify(templates[input.template]), (key, value) => {
            if (["createdBy", "updatedBy", "author", "ownerActor"].includes(key)) return cooperationActor(caller);
            if (key === "removedAtBoardRevision") return 0;
            return value;
          }) as CooperationBoard;
          for (const collection of collections) (board[collection] as unknown[]) = fixture[collection];
          for (const asset of board.assets) {
            const bytes = await fs.readFile(new URL("../../assets/cooperation/payment-pipeline-sketch.png", import.meta.url));
            const validated = await this.decodeImage(bytes, asset.mime, asset.id);
            Object.assign(asset, validated);
            await this.repository.writeBytes(`boards/${boardId}/${asset.relativePath}`, bytes);
          }
        }
        next.boards[boardId] = board;
        next.recentEvents[boardId] = [];
        const touched = new Set([boardId]);
        if (input.tab) this.assignInState(next, input.tab, boardId, touched);
        await this.commit(next, touched, "created");
        return this.getBoard(boardId);
      } catch (error) {
        if (!own(this.state.boards, boardId)) await this.repository.removeBoard(boardId).catch(() => undefined);
        throw error;
      }
    });
  }

  async assign(tab: CooperationHostTab, boardId: string | null, expectedGeneration?: number, caller = userCaller) {
    this.requireUser(caller);
    this.validateHostTab(tab);
    return this.repository.serialize(async () => {
      this.assertReady();
      const current = this.metadataForTab(tab.tabId);
      if (expectedGeneration !== undefined) requireCooperation(current.assignmentGeneration === expectedGeneration, "ASSIGNMENT_CHANGED", "The tab assignment changed. Read its current binding.");
      const next = structuredClone(this.state);
      const touched = new Set<string>();
      delete next.continuationIntents[tab.tabId];
      this.assignInState(next, tab, boardId, touched);
      await this.commit(next, touched, "assignment");
      return { assignment: this.metadataForTab(tab.tabId), board: boardId ? this.getBoard(boardId) : null };
    });
  }

  async removeTab(tabId: string): Promise<void> {
    this.requireId(tabId);
    await this.repository.serialize(async () => {
      const next = structuredClone(this.state);
      const touched = new Set<string>();
      const continuation = own(next.continuationIntents, tabId);
      if (continuation) {
        continuation.sourceRemoved = true;
        await this.commit(next, new Set(), "continuation");
        return;
      }
      this.detachInState(next, tabId, touched);
      next.tabGenerationCounters[tabId] = (own(next.tabGenerationCounters, tabId) ?? 0) + 1;
      await this.commit(next, touched, "assignment");
    });
  }

  async reconcileTabs(tabs: CooperationHostTab[], options: { restorationComplete: boolean }): Promise<void> {
    requireCooperation(options.restorationComplete === true, "INVALID_REQUEST", "All host owners must finish restoring before assignment reconciliation.");
    tabs.forEach(tab => this.validateHostTab(tab));
    requireCooperation(new Set(tabs.map(tab => tab.tabId)).size === tabs.length, "INVALID_REQUEST", "Restored host tab IDs must be unique.");
    await this.repository.serialize(async () => {
      const next = structuredClone(this.state);
      const touched = new Set<string>();
      next.continuationIntents = {};
      for (const assignment of Object.values(next.assignments)) {
        const tab = tabs.find(tab => tab.tabId === assignment.tabId);
        if (!tab) {
          this.detachInState(next, assignment.tabId, touched);
          next.tabGenerationCounters[assignment.tabId] = assignment.assignmentGeneration + 1;
        } else if (assignment.providerId !== tab.providerId || assignment.label !== tab.label) {
          assignment.providerId = tab.providerId;
          assignment.label = tab.label;
          this.touch(next, assignment.boardId, "assignment", "user:local", [assignment.tabId]);
          touched.add(assignment.boardId);
        }
      }
      await this.commit(next, touched, "restored");
    });
  }

  async transferAssignment(oldTabId: string, newTab: CooperationHostTab, admission?: { ownerPluginId: string; logicalRunId: string; attemptId: string }): Promise<void> {
    this.validateHostTab(newTab);
    await this.repository.serialize(async () => {
      const previous = own(this.state.assignments, oldTabId);
      requireCooperation(previous && !own(this.state.assignments, newTab.tabId), "ASSIGNMENT_CHANGED", "The source must be assigned and the destination unassigned.");
      const intent = own(this.state.continuationIntents, oldTabId);
      requireCooperation(!intent || intent.boardId === previous.boardId && intent.assignmentGeneration === previous.assignmentGeneration, "ASSIGNMENT_CHANGED", "The continuation binding changed before transfer.");
      requireCooperation(!intent || admission && admission.ownerPluginId === intent.ownerPluginId && admission.logicalRunId === intent.logicalRunId && isCooperationId(admission.attemptId),
        "FORBIDDEN", "Owner continuation admission must name the exact replacement attempt.");
      const next = structuredClone(this.state);
      const touched = new Set<string>();
      this.assignInState(next, { ...newTab, role: previous.role }, previous.boardId, touched);
      const destination = next.assignments[newTab.tabId];
      destination.role = previous.role;
      for (const event of next.inbox.filter(event => event.boardId === previous.boardId && event.recipientTabId === oldTabId && event.state !== "answered")) {
        const origin = { tabId: oldTabId, assignmentGeneration: previous.assignmentGeneration, providerId: previous.providerId, ...event.claim };
        event.transferredFrom ??= origin;
        event.transferHistory = [...event.transferHistory ?? [], origin];
        this.addressEvent(next, event, newTab.tabId);
        if (admission) event.ownerAdmission = { ...admission, tabId: newTab.tabId, assignmentGeneration: destination.assignmentGeneration };
      }
      this.detachInState(next, oldTabId, touched);
      delete next.continuationIntents[oldTabId];
      next.tabGenerationCounters[oldTabId] = previous.assignmentGeneration + 1;
      await this.commit(next, touched, "assignment");
    });
  }

  async beginContinuation(tabId: string, owner: { ownerPluginId: string; logicalRunId: string }): Promise<boolean> {
    this.requireId(tabId); this.requireId(owner.ownerPluginId); this.requireId(owner.logicalRunId);
    return this.repository.serialize(async () => {
      this.assertReady();
      const assignment = own(this.state.assignments, tabId);
      if (!assignment) return false;
      const previous = own(this.state.continuationIntents, tabId);
      if (previous) {
        requireCooperation(previous.ownerPluginId === owner.ownerPluginId && previous.logicalRunId === owner.logicalRunId && previous.boardId === assignment.boardId && previous.assignmentGeneration === assignment.assignmentGeneration,
          "FORBIDDEN", "Another logical owner holds this board continuation.");
        return true;
      }
      const next = structuredClone(this.state);
      next.continuationIntents[tabId] = { tabId, boardId: assignment.boardId, assignmentGeneration: assignment.assignmentGeneration,
        ownerPluginId: owner.ownerPluginId, logicalRunId: owner.logicalRunId, sourceRemoved: false };
      await this.commit(next, new Set(), "continuation");
      return true;
    });
  }

  async abortContinuation(tabId: string): Promise<void> {
    this.requireId(tabId);
    await this.repository.serialize(async () => {
      const intent = own(this.state.continuationIntents, tabId);
      if (!intent) return;
      const next = structuredClone(this.state);
      delete next.continuationIntents[tabId];
      const touched = new Set<string>();
      if (intent.sourceRemoved) {
        this.detachInState(next, tabId, touched);
        next.tabGenerationCounters[tabId] = intent.assignmentGeneration + 1;
      }
      await this.commit(next, touched, "continuation");
    });
  }

  continuationForTab(tabId: string) {
    this.assertReady();
    const intent = own(this.state.continuationIntents, tabId);
    return intent ? structuredClone(intent) : undefined;
  }

  async renameBoard(boardId: string, title: string, caller = userCaller): Promise<CooperationBoard> {
    this.requireUser(caller); this.requireTitle(title);
    return this.manage(boardId, "renamed", next => { this.requireBoard(next, boardId).title = title.trim(); });
  }

  async selectResponder(boardId: string, tabId: string, caller = userCaller): Promise<CooperationBoard> {
    this.requireUser(caller); this.requireId(tabId);
    return this.manage(boardId, "responder", next => {
      const recipient = own(next.assignments, tabId);
      requireCooperation(recipient?.boardId === boardId, "UNASSIGNED", "Select a responder assigned to this board.");
      for (const member of Object.values(next.assignments).filter(member => member.boardId === boardId)) member.role = member.tabId === tabId ? "responder" : "observer";
      for (const event of next.inbox.filter(event => event.boardId === boardId && event.state === "needsResponder")) { delete event.ownerAdmission; this.addressEvent(next, event, tabId); }
    });
  }

  async closeBoard(boardId: string, caller = userCaller): Promise<CooperationBoard> {
    this.requireUser(caller);
    return this.manage(boardId, "closed", next => {
      requireCooperation(!Object.values(next.assignments).some(member => member.boardId === boardId), "FORBIDDEN", "Detach all AI tabs before closing this board.");
      this.requireBoard(next, boardId).status = "closed";
    });
  }

  async deleteBoard(boardId: string, caller = userCaller): Promise<void> {
    this.requireUser(caller);
    await this.repository.serialize(async () => {
      const board = this.requireBoard(this.state, boardId);
      requireCooperation(board.status === "closed" && !Object.values(this.state.assignments).some(assignment => assignment.boardId === boardId), "FORBIDDEN", "Only a closed board without assigned tabs can be deleted.");
      const next = structuredClone(this.state);
      delete next.boards[boardId]; delete next.recentEvents[boardId];
      next.inbox = next.inbox.filter(event => event.boardId !== boardId);
      next.completions = next.completions.filter(completion => completion.boardId !== boardId);
      for (const [key, stored] of Object.entries(next.operationReceipts)) if (stored.receipt.boardId === boardId) delete next.operationReceipts[key];
      for (const [token, staged] of Object.entries(next.stagedAssets)) if (staged.boardId === boardId) delete next.stagedAssets[token];
      await this.commit(next, new Set(), "deleted");
      await this.repository.removeBoard(boardId);
      this.notify({ boardId, reason: "deleted" });
    });
  }

  async exportBoard(boardId: string, format: "json" | "markdown", caller?: CooperationCaller): Promise<string> {
    const { board } = await this.readBoard(boardId, caller);
    requireCooperation(format === "json" || format === "markdown", "INVALID_REQUEST", "Choose JSON or Markdown export.");
    return format === "json" ? this.projection.serialize(board) : boardMarkdown(board);
  }

  async apply(transaction: CooperationTransaction, caller: CooperationCaller): Promise<CooperationReceipt> {
    validateTransaction(transaction);
    this.validateCaller(caller);
    return this.repository.serialize(async () => {
      this.assertReady();
      this.authorize(this.state, transaction.boardId, caller, true);
      if (caller.kind === "agent") requireCooperation(transaction.assignmentGeneration === caller.assignmentGeneration, "ASSIGNMENT_CHANGED", "The transaction binding is stale.");
      const key = receiptKey(transaction.boardId, transaction.operationId);
      const previous = own(this.state.operationReceipts, key);
      if (previous) {
        requireCooperation(previous.digest === digest(transaction) && previous.callerKey === callerKey(caller), "OPERATION_ID_REUSED", "This operation ID already identifies different work.");
        return structuredClone(previous.receipt);
      }
      requireCooperation(!this.unavailableProjections.has(transaction.boardId), "INTEGRITY_ERROR", "Repair board publication before writing.");
      const before = this.getBoard(transaction.boardId, caller);
      await this.projection.verify(before);
      requireCooperation(before.revision === transaction.expectedBoardRevision, "REVISION_CONFLICT", "The board changed. Read it again before deciding on another transaction.", { boardRevision: before.revision, changedIds: before.items.map(item => item.id) });
      this.validatePreconditions(before, transaction.preconditions);
      const next = structuredClone(this.state);
      const board = this.requireBoard(next, transaction.boardId);
      const requirements = new Set<string>();
      for (const operation of transaction.operations) this.applyOperation(next, board, operation, caller, transaction, requirements);
      this.enforceWip(before, boardSnapshot(next, board.boardId), caller);
      this.refreshAnchors(board);
      this.requirePreconditions(before, boardSnapshot(next, board.boardId), transaction.preconditions, requirements);
      const answeredEventIds = this.answerEvents(next, transaction, caller);
      const changes = this.recordChanges(before, boardSnapshot(next, board.boardId));
      const changedIds = [...new Set(changes.map(change => change.id))];
      const event = this.touch(next, board.boardId, "content", cooperationActor(caller), changedIds, transaction.operationId);
      for (const inbox of next.inbox.filter(inbox => inbox.boardId === board.boardId && inbox.boardRevision === before.revision + 1)) inbox.sequence = event.sequence;
      const receipt: CooperationReceipt = {
        operationId: transaction.operationId, boardId: board.boardId, boardRevision: board.revision, eventCursor: board.eventCursor,
        actor: cooperationActor(caller), changedIds, answeredEventIds, committedAt: this.now(), projectionStatus: "published",
        ...(caller.kind === "agent" ? { assignmentGeneration: caller.assignmentGeneration, providerId: caller.providerId,
          ownerPluginId: caller.ownerPluginId, logicalRunId: caller.logicalRunId, attemptId: caller.attemptId,
          providerTurnId: caller.providerTurnId, nativeExecutionId: caller.nativeExecutionId } : {})
      };
      next.operationReceipts[key] = { receipt, digest: digest(transaction), callerKey: callerKey(caller), changes };
      for (const operation of transaction.operations) if (operation.kind === "undoOwnOperation") next.operationReceipts[receiptKey(board.boardId, operation.operationId)].undoneBy = transaction.operationId;
      await this.commit(next, new Set([board.boardId]), "transaction", receipt);
      return structuredClone(receipt);
    });
  }

  async receipt(boardId: string, operationId: string, caller?: CooperationCaller): Promise<CooperationReceipt | null> {
    this.getBoard(boardId, caller);
    const stored = own(this.state.operationReceipts, receiptKey(boardId, operationId));
    if (!stored) return null;
    if (caller?.kind === "agent") requireCooperation(stored.callerKey === callerKey(caller), "FORBIDDEN", "Receipts belong to the caller and its assignment generation.");
    return structuredClone(stored.receipt);
  }

  events(boardId: string, afterCursor = 0, caller?: CooperationCaller): CooperationEvent[] {
    const board = this.getBoard(boardId, caller);
    requireCooperation(Number.isSafeInteger(afterCursor) && afterCursor >= 0 && afterCursor <= board.eventCursor, "INVALID_REQUEST", "Event cursor is outside the board history.");
    const events = this.state.recentEvents[boardId] ?? [];
    requireCooperation(!events.length || afterCursor >= events[0].sequence - 1, "CURSOR_EXPIRED", "The event cursor expired. Explicitly resynchronize from a current snapshot.");
    return structuredClone(events.filter(event => event.sequence > afterCursor));
  }

  inbox(boardId: string, caller?: CooperationCaller): CooperationInboxEvent[] {
    this.getBoard(boardId, caller);
    return structuredClone(this.state.inbox.filter(event => event.boardId === boardId &&
      (caller?.kind !== "agent" || event.recipientTabId === caller.tabId && event.assignmentGeneration === caller.assignmentGeneration)));
  }

  async claimEvent(boardId: string, eventId: string, caller: CooperationCaller): Promise<CooperationInboxEvent> {
    requireCooperation(caller.kind === "agent", "FORBIDDEN", "Only the addressed AI tab can claim feedback.");
    return this.repository.serialize(async () => {
      this.authorize(this.state, boardId, caller, true);
      const next = structuredClone(this.state);
      const event = next.inbox.find(event => event.boardId === boardId && event.eventId === eventId);
      requireCooperation(event && event.recipientTabId === caller.tabId && event.assignmentGeneration === caller.assignmentGeneration, "ASSIGNMENT_CHANGED", "The feedback is no longer addressed to this binding.");
      requireCooperation(event.state !== "answered" && event.state !== "unknown", "FORBIDDEN", "Answered or uncertain delivery cannot be claimed automatically.");
      if (event.claim) requireCooperation(event.claim.attemptId === caller.attemptId, "FORBIDDEN", "Another native attempt holds this feedback claim.");
      if (event.ownerAdmission) requireCooperation(event.ownerAdmission.attemptId === caller.attemptId && event.ownerAdmission.tabId === caller.tabId && event.ownerAdmission.assignmentGeneration === caller.assignmentGeneration,
        "FORBIDDEN", "Only the admitted workflow attempt can claim this addressed feedback.");
      event.claim = { tabId: caller.tabId, assignmentGeneration: caller.assignmentGeneration,
        ...(caller.attemptId ? { attemptId: caller.attemptId } : {}), ...(caller.providerId ? { providerId: caller.providerId } : {}),
        ...(caller.ownerPluginId ? { ownerPluginId: caller.ownerPluginId } : {}), ...(caller.logicalRunId ? { logicalRunId: caller.logicalRunId } : {}) };
      event.state = "claimed";
      this.touch(next, boardId, "feedback", cooperationActor(caller), [event.target.id]);
      await this.commit(next, new Set([boardId]), "feedback");
      return structuredClone(event);
    });
  }

  async setDeliveryState(boardId: string, eventIds: string[], state: "queued" | "nativeAccepted" | "unknown", caller?: CooperationCaller): Promise<void> {
    requireCooperation(["queued", "nativeAccepted", "unknown"].includes(state) && Array.isArray(eventIds) && eventIds.length > 0 && eventIds.length <= 32 && eventIds.every(isCooperationId), "INVALID_REQUEST", "Delivery updates require a bounded addressed event list.");
    await this.repository.serialize(async () => {
      if (caller) this.authorize(this.state, boardId, caller, false);
      const next = structuredClone(this.state);
      for (const id of eventIds) {
        const event = next.inbox.find(event => event.boardId === boardId && event.eventId === id);
        requireCooperation(event, "NOT_FOUND", "Feedback event does not exist.");
        requireCooperation(event.recipientTabId && event.assignmentGeneration && own(next.assignments, event.recipientTabId)?.boardId === boardId && own(next.assignments, event.recipientTabId)?.assignmentGeneration === event.assignmentGeneration,
          "ASSIGNMENT_CHANGED", "Delivery requires the current addressed member binding.");
        requireCooperation(event.state !== "answered" && event.state !== "claimed", "FORBIDDEN", "Delivery cannot overwrite a claim or answer.");
        requireCooperation(event.state !== "unknown" || state === "unknown", "DELIVERY_UNKNOWN", "The user must inspect and redirect uncertain delivery.");
        requireCooperation(event.state !== "nativeAccepted" || state !== "queued", "FORBIDDEN", "Native acceptance cannot be silently resent.");
        if (caller?.kind === "agent") requireCooperation(event.recipientTabId === caller.tabId && event.assignmentGeneration === caller.assignmentGeneration, "ASSIGNMENT_CHANGED", "Delivery belongs to another board member.");
        event.state = state;
      }
      this.touch(next, boardId, "feedback", "user:local", eventIds);
      await this.commit(next, new Set([boardId]), "feedback");
    });
  }

  async redirectEvent(boardId: string, eventId: string, tabId: string, caller = userCaller): Promise<void> {
    this.requireUser(caller);
    await this.repository.serialize(async () => {
      const next = structuredClone(this.state);
      const event = next.inbox.find(event => event.boardId === boardId && event.eventId === eventId);
      requireCooperation(event && event.state !== "answered", "NOT_FOUND", "An unanswered feedback event is required.");
      delete event.claim;
      delete event.ownerAdmission;
      this.addressEvent(next, event, tabId);
      this.touch(next, boardId, "feedback", cooperationActor(caller), [event.target.id]);
      await this.commit(next, new Set([boardId]), "feedback");
    });
  }

  async confirmNativeDelivery(boardId: string, eventIds: string[], tabId: string, assignmentGeneration: number): Promise<void> {
    requireCooperation(Array.isArray(eventIds) && eventIds.length > 0 && eventIds.length <= 32 && eventIds.every(isCooperationId), "INVALID_REQUEST", "Native confirmation requires a bounded event list.");
    await this.repository.serialize(async () => {
      this.authorize(this.state, boardId, { kind: "agent", tabId, assignmentGeneration }, false);
      const next = structuredClone(this.state);
      let changed = false;
      for (const eventId of eventIds) {
        const event = next.inbox.find(event => event.boardId === boardId && event.eventId === eventId);
        requireCooperation(event?.recipientTabId === tabId && event.assignmentGeneration === assignmentGeneration, "ASSIGNMENT_CHANGED", "The native receipt belongs to a superseded board binding.");
        if (event.state === "claimed" || event.state === "answered" || event.state === "nativeAccepted") continue;
        requireCooperation(event.state === "queued" || event.state === "unknown", "FORBIDDEN", "Native confirmation requires an addressed pending event.");
        event.state = "nativeAccepted"; changed = true;
      }
      if (!changed) return;
      this.touch(next, boardId, "feedback", "user:local", eventIds);
      await this.commit(next, new Set([boardId]), "feedback");
    });
  }

  async releaseAttempt(tabId: string, attemptId: string): Promise<void> {
    await this.repository.serialize(async () => {
      const next = structuredClone(this.state);
      const touched = new Set<string>();
      for (const event of next.inbox.filter(event => event.state === "claimed" && event.claim?.tabId === tabId && event.claim.attemptId === attemptId)) {
        delete event.claim;
        event.state = "queued";
        touched.add(event.boardId);
      }
      for (const boardId of touched) this.touch(next, boardId, "feedback", "user:local", []);
      await this.commit(next, touched, "feedback");
    });
  }

  async completeTurn(boardId: string, input: { receiptOperationIds: string[]; respondsToEventIds?: string[]; startCursor: number; providerTurnId?: string; noChangeReason?: string }, caller: CooperationCaller): Promise<CooperationTurnCompletion> {
    requireCooperation(caller.kind === "agent", "FORBIDDEN", "Only an assigned AI tab can complete its cooperation turn.");
    exactRecord(input, ["receiptOperationIds", "startCursor"], ["respondsToEventIds", "providerTurnId", "noChangeReason"], "Turn completion");
    requireCooperation(Array.isArray(input.receiptOperationIds) && input.receiptOperationIds.length <= 100 && input.receiptOperationIds.every(isCooperationId) && Number.isSafeInteger(input.startCursor) && input.startCursor >= 0,
      "INVALID_REQUEST", "Completion requires a bounded receipt list and start cursor.");
    requireCooperation(input.respondsToEventIds === undefined || Array.isArray(input.respondsToEventIds) && input.respondsToEventIds.length <= 32 && input.respondsToEventIds.every(isCooperationId), "INVALID_REQUEST", "Turn answers require a bounded event list.");
    requireCooperation(input.noChangeReason === undefined || typeof input.noChangeReason === "string" && input.noChangeReason.trim().length > 0 && input.noChangeReason.length <= 4000, "INVALID_REQUEST", "A no-change explanation must contain 1 to 4000 characters.");
    requireCooperation(input.providerTurnId === undefined || isCooperationId(input.providerTurnId), "INVALID_REQUEST", "Provider turn identity is invalid.");
    return this.repository.serialize(async () => {
      this.authorize(this.state, boardId, caller, false);
      requireCooperation(input.providerTurnId === caller.providerTurnId, "FORBIDDEN", "Completion must identify the current trusted native turn.");
      const board = this.requireBoard(this.state, boardId);
      requireCooperation(input.startCursor <= board.eventCursor && (!input.noChangeReason || input.noChangeReason.length <= 4000), "INVALID_REQUEST", "Completion cursor or explanation is invalid.");
      const receipts = input.receiptOperationIds.map(id => own(this.state.operationReceipts, receiptKey(boardId, id)));
      requireCooperation(receipts.every(stored => stored && stored.callerKey === callerKey(caller) && stored.receipt.attemptId === caller.attemptId &&
        stored.receipt.providerTurnId === caller.providerTurnId && stored.receipt.nativeExecutionId === caller.nativeExecutionId && stored.receipt.eventCursor > input.startCursor),
        "FORBIDDEN", "Completion receipts must belong to this native execution, turn, and assignment.");
      const changedIds = [...new Set(receipts.flatMap(stored => stored!.receipt.changedIds))];
      const answeredEventIds = [...new Set(receipts.flatMap(stored => stored!.receipt.answeredEventIds))];
      requireCooperation(changedIds.length || answeredEventIds.length || input.noChangeReason?.trim(), "INVALID_REQUEST", "Record board work or a specific no-change reason before completing this turn.");
      requireCooperation(!input.respondsToEventIds || input.respondsToEventIds.every(id => answeredEventIds.includes(id)), "INVALID_REQUEST", "Completion cannot claim an uncommitted answer.");
      const completion: CooperationTurnCompletion = { boardId, tabId: caller.tabId, assignmentGeneration: caller.assignmentGeneration,
        startCursor: input.startCursor, resultingBoardRevision: board.revision, receiptOperationIds: [...new Set(input.receiptOperationIds)], changedIds, answeredEventIds,
        ...(caller.providerTurnId ? { providerTurnId: caller.providerTurnId, nativeExecutionId: caller.nativeExecutionId } : {}), ...(caller.attemptId ? { attemptId: caller.attemptId } : {}),
        ...(input.noChangeReason ? { noChangeReason: input.noChangeReason.trim() } : {}), completedAt: this.now() };
      const next = structuredClone(this.state);
      next.completions.push(completion);
      await this.commit(next, new Set(), "completion");
      this.notify({ boardId, reason: "completion" });
      return completion;
    });
  }

  completionsForTab(tabId: string): CooperationTurnCompletion[] { this.assertReady(); return structuredClone(this.state.completions.filter(completion => completion.tabId === tabId)); }

  async stageAsset(boardId: string, input: { mime: string; bytes: Buffer }, caller = userCaller) {
    this.validateCaller(caller);
    return this.repository.serialize(async () => {
      this.authorize(this.state, boardId, caller, true);
      const asset = await this.decodeImage(input.bytes, input.mime, `image-${randomUUID()}`);
      const current = this.requireBoard(this.state, boardId);
      const staged = Object.values(this.state.stagedAssets).filter(staged => staged.boardId === boardId);
      requireCooperation(current.assets.length + staged.length < COOPERATION_LIMITS.assets &&
        current.assets.reduce((sum, asset) => sum + asset.byteLength, 0) + staged.reduce((sum, staged) => sum + staged.asset.byteLength, 0) + asset.byteLength <= COOPERATION_LIMITS.boardImageBytes,
      "LIMIT_EXCEEDED", "The board cannot accept more original images.");
      const token = `stage-${randomUUID()}`;
      await this.repository.writeBytes(`staging/${token}`, input.bytes);
      const next = structuredClone(this.state);
      next.stagedAssets[token] = { token, boardId, actor: callerKey(caller), asset };
      try { await this.commit(next, new Set(), "staged"); }
      catch (error) {
        if (!own(this.state.stagedAssets, token)) await this.repository.removeBytes(`staging/${token}`).catch(() => undefined);
        throw error;
      }
      return { stagedToken: token, asset: structuredClone(asset) };
    });
  }

  async discardStagedAsset(boardId: string, token: string, caller = userCaller): Promise<void> {
    await this.repository.serialize(async () => {
      this.authorize(this.state, boardId, caller, false);
      const staged = own(this.state.stagedAssets, token);
      requireCooperation(staged && staged.boardId === boardId && staged.actor === callerKey(caller), "ASSET_INVALID", "The staged image does not belong to this caller.");
      const next = structuredClone(this.state); delete next.stagedAssets[token];
      await this.commit(next, new Set(), "staged");
    });
  }

  async resolveAsset(boardId: string, assetId: string, caller?: CooperationCaller) {
    return this.repository.serialize(async () => {
      const board = this.getBoard(boardId, caller);
      const asset = board.assets.find(asset => asset.id === assetId);
      requireCooperation(asset, "ASSET_INVALID", "The original image is not on this board.");
      const relative = `boards/${boardId}/${asset.relativePath}`;
      const bytes = await this.repository.readBytes(relative);
      requireCooperation(bytes.length === asset.byteLength && digestBytes(bytes) === asset.sha256, "INTEGRITY_ERROR", "The original image differs from its committed manifest.");
      return { asset, localPath: this.repository.resolve(relative), bytes };
    });
  }

  async repairProjection(boardId: string, caller = userCaller): Promise<void> {
    this.requireUser(caller);
    await this.repository.serialize(async () => {
      await this.projection.publish(this.getBoard(boardId));
      this.unavailableProjections.delete(boardId);
      this.notify({ boardId, reason: "repaired" });
    });
  }

  private applyOperation(state: BlackboardState, board: StoredBoard, operation: CooperationOperation, caller: CooperationCaller, transaction: CooperationTransaction, requirements: Set<string>): void {
    const actor = cooperationActor(caller);
    const requireRecord = <T extends { id: string }>(kind: CooperationRecordKind, records: T[], id: string): T => {
      const record = records.find(record => record.id === id);
      requireCooperation(record, "TARGET_STALE", `${kind} ${id} no longer exists.`);
      if ((this.state.boards[board.boardId][collectionFor[kind]] as { id: string }[]).some(record => record.id === id)) requirements.add(`${kind}/${id}`);
      return record;
    };
    const endpoints = (edge: { from: { itemId: string }; to: { itemId: string } }) => {
      requireRecord("item", board.items, edge.from.itemId); requireRecord("item", board.items, edge.to.itemId);
    };
    switch (operation.kind) {
      case "createItem": {
        this.requireFreshRecord(state, board, operation.item.id);
        requireCooperation(operation.item.kind !== "image", "ASSET_INVALID", "Use attachAsset to add an original image and its item atomically.");
        board.items.push({ ...structuredClone(operation.item), revision: 1, createdBy: actor, updatedBy: actor } as CooperationItem);
        break;
      }
      case "updateItem": {
        const item = requireRecord("item", board.items, operation.itemId);
        const previous = structuredClone(item);
        Object.assign(item, structuredClone(operation.patch), { revision: item.revision + 1, updatedBy: actor });
        if (item.kind === "note" || item.kind === "code") {
          const oldBlocks = previous.kind === "note" || previous.kind === "code" ? previous.content.blocks : [];
          if (Array.isArray(item.content.blocks)) for (const block of item.content.blocks) {
            const old = oldBlocks.find(old => old.id === block.id);
            block.revision = old ? old.revision + (old.text === block.text ? 0 : 1) : 1;
          }
        }
        if (operation.patch.geometry) for (const edge of board.connections.filter(edge => edge.from.itemId === item.id || edge.to.itemId === item.id)) {
          requireRecord("connection", board.connections, edge.id); endpoints(edge);
        }
        break;
      }
      case "deleteItem": {
        const item = requireRecord("item", board.items, operation.itemId);
        this.preserveTarget(board, { kind: "item", id: item.id }, item);
        for (const edge of board.connections.filter(edge => edge.from.itemId === item.id || edge.to.itemId === item.id)) {
          requireRecord("connection", board.connections, edge.id); endpoints(edge);
          this.preserveTarget(board, { kind: "connection", id: edge.id }, edge);
        }
        board.connections = board.connections.filter(edge => edge.from.itemId !== item.id && edge.to.itemId !== item.id);
        board.items = board.items.filter(record => record.id !== item.id);
        for (const region of board.regions.filter(region => region.protectedItemIds.includes(item.id))) {
          requireRecord("region", board.regions, region.id);
          region.protectedItemIds = region.protectedItemIds.filter(id => id !== item.id); region.revision++;
        }
        break;
      }
      case "createConnection":
        this.requireFreshRecord(state, board, operation.connection.id);
        endpoints(operation.connection);
        board.connections.push({ ...structuredClone(operation.connection), revision: 1, createdBy: actor, updatedBy: actor }); break;
      case "updateConnection": {
        const edge = requireRecord("connection", board.connections, operation.connectionId);
        endpoints(edge);
        Object.assign(edge, structuredClone(operation.patch), { revision: edge.revision + 1, updatedBy: actor });
        endpoints(edge); break;
      }
      case "deleteConnection": {
        const edge = requireRecord("connection", board.connections, operation.connectionId);
        endpoints(edge); this.preserveTarget(board, { kind: "connection", id: edge.id }, edge);
        board.connections = board.connections.filter(record => record.id !== edge.id); break;
      }
      case "createRegion":
        this.requireUser(caller);
        this.requireFreshRecord(state, board, operation.region.id);
        board.regions.push({ ...structuredClone(operation.region), revision: 1, ownerActor: actor }); break;
      case "updateRegion": {
        this.requireUser(caller);
        const region = requireRecord("region", board.regions, operation.regionId);
        Object.assign(region, structuredClone(operation.patch), { revision: region.revision + 1 }); break;
      }
      case "markRegionReady": {
        this.requireUser(caller);
        const region = requireRecord("region", board.regions, operation.regionId);
        requireCooperation(region.mode === "wip", "INVALID_REQUEST", "Only a work-in-progress region can become ready.");
        region.mode = "ready"; region.revision++;
        this.enqueueFeedback(state, board, "ready", { kind: "region", id: region.id }, caller, operation.recipientTabId); break;
      }
      case "deleteRegion": {
        this.requireUser(caller);
        const region = requireRecord("region", board.regions, operation.regionId);
        this.preserveTarget(board, { kind: "region", id: region.id }, region);
        board.regions = board.regions.filter(record => record.id !== region.id); break;
      }
      case "addReaction": {
        this.requireFreshRecord(state, board, operation.reaction.id);
        requireCooperation(!operation.reaction.target.snapshot, "TARGET_STALE", "New reactions must target a live object.");
        requireCooperation(!operation.reaction.target.anchor || operation.reaction.target.anchor.status === "attached", "TARGET_STALE", "Select current text before adding anchored feedback.");
        validateTarget(boardSnapshot(state, board.boardId), operation.reaction.target);
        const reaction = { ...structuredClone(operation.reaction), author: actor, revision: 1 };
        if (reaction.kind === "question") {
          reaction.threadId ??= `thread-${randomUUID()}`;
          this.requireFreshRecord(state, board, reaction.threadId);
          board.threads.push({ id: reaction.threadId, revision: 1, target: structuredClone(reaction.target), questionReactionId: reaction.id, status: "open",
            messages: [{ id: `message-${randomUUID()}`, author: actor, text: reaction.description, sourceRefs: [] }] });
          if (caller.kind === "user") this.enqueueFeedback(state, board, "question", reaction.target, caller, operation.recipientTabId, reaction.id, reaction.threadId);
        } else requireCooperation(!reaction.threadId, "INVALID_REQUEST", "Only a question creates a linked thread.");
        board.reactions.push(reaction); break;
      }
      case "updateReaction": {
        const reaction = requireRecord("reaction", board.reactions, operation.reactionId);
        requireCooperation(caller.kind === "user" || reaction.author === actor, "FORBIDDEN", "Agents can edit only their own reactions.");
        Object.assign(reaction, structuredClone(operation.patch), { revision: reaction.revision + 1 }); break;
      }
      case "removeReaction": {
        const reaction = requireRecord("reaction", board.reactions, operation.reactionId);
        requireCooperation(caller.kind === "user" || reaction.author === actor, "FORBIDDEN", "Agents can remove only their own reactions.");
        board.reactions = board.reactions.filter(record => record.id !== reaction.id);
        if (reaction.threadId) {
          const thread = requireRecord("thread", board.threads, reaction.threadId);
          delete thread.questionReactionId; thread.revision++;
        }
        for (const event of state.inbox.filter(event => event.reactionId === reaction.id && event.boardId === board.boardId && event.state !== "answered")) {
          delete event.recipientTabId; delete event.assignmentGeneration; delete event.claim; event.state = "needsResponder";
          delete event.reactionId;
        }
        break;
      }
      case "appendThreadMessage": {
        const thread = requireRecord("thread", board.threads, operation.threadId);
        requireCooperation(thread.status !== "resolved", "FORBIDDEN", "The user must reopen this resolved discussion before adding messages.");
        thread.messages.push({ ...structuredClone(operation.message), author: actor }); thread.revision++;
        if (caller.kind === "agent") thread.status = "answered";
        else { thread.status = "open"; if (operation.requestResponse) this.enqueueFeedback(state, board, "reply", thread.target, caller, operation.recipientTabId, thread.questionReactionId, thread.id); }
        break;
      }
      case "resolveThread": {
        this.requireUser(caller);
        const thread = requireRecord("thread", board.threads, operation.threadId);
        thread.status = operation.resolved === false ? "open" : "resolved"; thread.revision++; break;
      }
      case "reattachTarget": {
        this.requireUser(caller);
        requireCooperation(!operation.target.snapshot, "TARGET_STALE", "Reattach feedback to a current live object.");
        requireCooperation(!operation.target.anchor || operation.target.anchor.status === "attached", "TARGET_STALE", "Reattachment requires a reviewed current text selection.");
        validateTarget(boardSnapshot(state, board.boardId), operation.target);
        const record = operation.targetKind === "reaction" ? requireRecord("reaction", board.reactions, operation.targetId) : requireRecord("thread", board.threads, operation.targetId);
        record.target = structuredClone(operation.target); record.revision++;
        const thread = operation.targetKind === "reaction" && "threadId" in record ? board.threads.find(thread => thread.id === record.threadId) : operation.targetKind === "thread" ? board.threads.find(thread => thread.id === record.id) : undefined;
        if (thread) {
          requireRecord("thread", board.threads, thread.id); thread.target = structuredClone(operation.target); if (thread !== record) thread.revision++;
          const reaction = board.reactions.find(reaction => reaction.id === thread.questionReactionId);
          if (reaction && reaction !== record) { requireRecord("reaction", board.reactions, reaction.id); reaction.target = structuredClone(operation.target); reaction.revision++; }
        }
        break;
      }
      case "attachAsset": {
        this.requireFreshRecord(state, board, operation.item.id);
        const staged = own(state.stagedAssets, operation.stagedToken);
        requireCooperation(staged && staged.boardId === board.boardId && staged.actor === callerKey(caller) && operation.item.kind === "image" && operation.item.content.assetId === staged.asset.id,
          "ASSET_INVALID", "Attach the original staged image owned by this caller.");
        board.assets.push(structuredClone(staged.asset));
        board.items.push({ ...structuredClone(operation.item), revision: 1, createdBy: actor, updatedBy: actor });
        delete state.stagedAssets[operation.stagedToken];
        break;
      }
      case "undoOwnOperation": this.undoOperation(state, board, operation.operationId, caller, requirements); break;
    }
    requireCooperation(transaction.operations.filter(operation => operation.kind === "undoOwnOperation").length === 0 || transaction.operations.length === 1,
      "INVALID_REQUEST", "Undo is a complete transaction and cannot be mixed with new edits.");
  }

  private undoOperation(state: BlackboardState, board: StoredBoard, operationId: string, caller: CooperationCaller, requirements: Set<string>): void {
    const stored = own(state.operationReceipts, receiptKey(board.boardId, operationId));
    requireCooperation(stored && stored.receipt.actor === cooperationActor(caller) && !stored.undoneBy, "FORBIDDEN", "Only the author can undo a committed operation once.");
    requireCooperation(!stored.receipt.answeredEventIds.length, "FORBIDDEN", "An answered feedback receipt is durable evidence and cannot be undone.");
    const issuedEvents = state.inbox.filter(event => event.boardId === board.boardId && event.boardRevision === stored.receipt.boardRevision);
    requireCooperation(issuedEvents.every(event => event.state === "needsResponder"), "FORBIDDEN", "This operation addressed feedback to a native turn. Remove its reaction instead; its discussion and delivery evidence remain.");
    state.inbox = state.inbox.filter(event => !issuedEvents.includes(event));
    const history = new BoardUndoHistory(state, stored);
    for (const change of stored.changes) {
      const current = (board[change.collection] as { id: string }[]).find(record => record.id === change.id);
      requireCooperation(history.canRestore(change, current), "REVISION_CONFLICT", "Undo would overwrite later work. Read the current records.", { changedIds: [change.id] });
    }
    for (const change of stored.changes) {
      const records = board[change.collection] as { id: string; revision?: number }[];
      const current = records.find(record => record.id === change.id);
      const kind = Object.entries(collectionFor).find(([, collection]) => collection === change.collection)?.[0];
      if (kind && current) requirements.add(`${kind}/${current.id}`);
      if (change.before) {
        const restored = structuredClone(change.before) as { id: string; revision?: number; updatedBy?: string };
        if (restored.revision !== undefined) restored.revision = (current?.revision ?? restored.revision) + 1;
        if ("updatedBy" in restored) restored.updatedBy = cooperationActor(caller);
        if (change.collection === "items") {
          const item = restored as CooperationItem;
          const oldItem = current as CooperationItem | undefined;
          if (item.kind === "note" || item.kind === "code") for (const block of item.content.blocks) {
            const existing = oldItem && (oldItem.kind === "note" || oldItem.kind === "code") ? oldItem.content.blocks.find(old => old.id === block.id) : undefined;
            block.revision = Math.max(block.revision, existing?.revision ?? 0) + 1;
          }
        }
        if (change.collection === "threads") {
          const thread = current as CooperationBoard["threads"][number] | undefined;
          const previous = restored as CooperationBoard["threads"][number];
          for (const message of thread?.messages ?? []) if (!previous.messages.some(record => record.id === message.id)) this.preserveTarget(board, { kind: "threadMessage", id: message.id }, message);
        }
        if (current) records[records.indexOf(current)] = restored; else records.push(restored);
      } else if (current) {
        if (change.collection === "items") {
          const incident = board.connections.filter(edge => edge.from.itemId === current.id || edge.to.itemId === current.id);
          requireCooperation(incident.every(edge => stored.changes.some(change => change.collection === "connections" && change.id === edge.id && !change.before)), "REVISION_CONFLICT", "Undo would remove an endpoint used by a later connection.");
          this.preserveTarget(board, { kind: "item", id: current.id }, current as CooperationItem);
        } else if (change.collection === "connections") this.preserveTarget(board, { kind: "connection", id: current.id }, current as CooperationBoard["connections"][number]);
        else if (change.collection === "regions") this.preserveTarget(board, { kind: "region", id: current.id }, current as CooperationBoard["regions"][number]);
        else if (change.collection === "assets") continue;
        else if (change.collection === "threads") for (const message of (current as CooperationBoard["threads"][number]).messages) this.preserveTarget(board, { kind: "threadMessage", id: message.id }, message);
        records.splice(records.indexOf(current), 1);
      }
    }
  }

  private requireFreshRecord(state: BlackboardState, board: StoredBoard, id: string): void {
    const live = collections.some(collection => (board[collection] as { id: string }[]).some(record => record.id === id));
    const historical = Object.values(state.operationReceipts).some(stored => stored.receipt.boardId === board.boardId && stored.changes.some(change => change.id === id));
    requireCooperation(!live && !historical, "INVALID_REQUEST", "A new record requires a unique ID that has not been used on this board.");
  }

  private validatePreconditions(board: CooperationBoard, preconditions: CooperationPrecondition[]): void {
    const seen = new Set<string>();
    for (const precondition of preconditions) {
      const key = `${precondition.targetKind}/${precondition.targetId}`;
      requireCooperation(!seen.has(key), "INVALID_REQUEST", "Preconditions must not repeat a record."); seen.add(key);
      const record = (board[collectionFor[precondition.targetKind]] as { id: string; revision: number }[]).find(record => record.id === precondition.targetId);
      requireCooperation(record?.revision === precondition.expectedRevision, "REVISION_CONFLICT", "A record precondition changed. Read its current revision.", { targetId: precondition.targetId, currentRevision: record?.revision ?? null });
    }
  }

  private requirePreconditions(board: CooperationBoard, after: CooperationBoard, preconditions: CooperationPrecondition[], requirements: Set<string>): void {
    for (const change of this.recordChanges(board, after)) {
      const kind = Object.entries(collectionFor).find(([, collection]) => collection === change.collection)?.[0];
      if (kind && change.before) requirements.add(`${kind}/${change.id}`);
    }
    const provided = new Set(preconditions.map(precondition => `${precondition.targetKind}/${precondition.targetId}`));
    requireCooperation([...requirements].every(key => provided.has(key)), "REVISION_CONFLICT", "Every changed record and connection endpoint requires its observed revision.", { required: [...requirements] });
  }

  private enforceWip(before: CooperationBoard, after: CooperationBoard, caller: CooperationCaller): void {
    if (caller.kind === "user") return;
    const regions = before.regions.filter(region => region.mode === "wip");
    const changedItems = new Set(this.recordChanges(before, after).filter(change => change.collection === "items").map(change => change.id));
    const affectedEdges = new Set(this.recordChanges(before, after).filter(change => change.collection === "connections").map(change => change.id));
    for (const edge of [...before.connections, ...after.connections]) if (changedItems.has(edge.from.itemId) || changedItems.has(edge.to.itemId)) affectedEdges.add(edge.id);
    for (const region of regions) {
      for (const item of [...before.items, ...after.items].filter(item => changedItems.has(item.id))) {
        requireCooperation(!region.protectedItemIds.includes(item.id) && !boundsIntersect(itemBounds(item), region.geometry), "REGION_PROTECTED", "This scene edit intersects a user work-in-progress region.", { regionId: region.id, targetId: item.id });
      }
      for (const snapshot of [before, after]) for (const edge of snapshot.connections.filter(edge => affectedEdges.has(edge.id))) {
        requireCooperation(!region.protectedItemIds.includes(edge.from.itemId) && !region.protectedItemIds.includes(edge.to.itemId) &&
          !connectionIntersectsRegion(edge, snapshot.items, region.geometry), "REGION_PROTECTED", "The connector route or label intersects a user work-in-progress region.", { regionId: region.id, targetId: edge.id });
      }
    }
  }

  private preserveTarget(board: StoredBoard, target: CooperationTarget, record: CooperationItem | CooperationBoard["connections"][number] | CooperationBoard["regions"][number] | CooperationBoard["threads"][number]["messages"][number]): void {
    for (const annotation of [...board.reactions, ...board.threads]) if (annotation.target.kind === target.kind && annotation.target.id === target.id) {
      annotation.target.snapshot = { removedAtBoardRevision: board.revision + 1, record: structuredClone(record) };
      if (annotation.target.anchor) annotation.target.anchor.status = "stale";
      annotation.revision++;
    }
  }

  private refreshAnchors(board: StoredBoard): void {
    for (const annotation of [...board.reactions, ...board.threads]) {
      const anchor = annotation.target.anchor;
      if (!anchor || anchor.status === "stale") continue;
      const item = board.items.find(item => item.id === annotation.target.id);
      const block = item && (item.kind === "note" || item.kind === "code") ? item.content.blocks.find(block => block.id === anchor.blockId) : undefined;
      if (!block || block.revision !== anchor.blockRevision) { anchor.status = "stale"; annotation.revision++; }
    }
  }

  private enqueueFeedback(state: BlackboardState, board: StoredBoard, kind: CooperationInboxEvent["kind"], target: CooperationTarget, caller: CooperationCaller, recipientTabId?: string | null, reactionId?: string, threadId?: string): void {
    const authorRecord = targetRecord(boardSnapshot(state, board.boardId), target);
    const targetRevision = authorRecord && "revision" in authorRecord ? authorRecord.revision : 1;
    const event: CooperationInboxEvent = { eventId: `feedback-${randomUUID()}`, sequence: board.eventCursor + 1, boardId: board.boardId,
      boardRevision: board.revision + 1, kind, author: cooperationActor(caller), target: structuredClone(target), state: "needsResponder", createdAt: this.now(),
      targetRevision,
      ...(reactionId ? { reactionId } : {}), ...(threadId ? { threadId } : {}) };
    const author = authorRecord && ("createdBy" in authorRecord ? authorRecord.createdBy : "author" in authorRecord ? authorRecord.author : undefined);
    const authorTabId = author?.startsWith("agent:") ? author.slice(6) : undefined;
    const authorMember = authorTabId ? own(state.assignments, authorTabId) : undefined;
    const responder = Object.values(state.assignments).find(assignment => assignment.boardId === board.boardId && assignment.role === "responder");
    const recipient = recipientTabId === undefined ? (authorMember?.boardId === board.boardId ? authorTabId : responder?.tabId) : recipientTabId;
    if (recipient) this.addressEvent(state, event, recipient);
    state.inbox.push(event);
  }

  private addressEvent(state: BlackboardState, event: CooperationInboxEvent, tabId: string): void {
    const member = own(state.assignments, tabId);
    requireCooperation(member?.boardId === event.boardId, "UNASSIGNED", "The responder must be assigned to this board.");
    event.recipientTabId = tabId; event.assignmentGeneration = member.assignmentGeneration; event.state = "queued"; delete event.claim;
  }

  private answerEvents(state: BlackboardState, transaction: CooperationTransaction, caller: CooperationCaller): string[] {
    if (!transaction.respondsToEventIds.length) return [];
    requireCooperation(caller.kind === "agent", "FORBIDDEN", "Only a claimed AI response can answer an inbox event.");
    for (const id of transaction.respondsToEventIds) {
      const event = state.inbox.find(event => event.eventId === id && event.boardId === transaction.boardId);
      requireCooperation(event && event.state === "claimed" && event.recipientTabId === caller.tabId && event.assignmentGeneration === caller.assignmentGeneration && event.claim?.attemptId === caller.attemptId,
        "ASSIGNMENT_CHANGED", "Claim the addressed feedback in this attempt before answering.");
      const answersThread = event.threadId && transaction.operations.some(operation => operation.kind === "appendThreadMessage" && operation.threadId === event.threadId);
      const answersReady = event.kind === "ready" && transaction.operations.some(operation => ["createItem", "updateItem", "createConnection", "updateConnection"].includes(operation.kind));
      requireCooperation(answersThread || answersReady, "INVALID_REQUEST", "The transaction must answer at the feedback target.");
      if (event.kind === "ready") {
        const region = this.requireBoard(state, event.boardId).regions.find(region => region.id === event.target.id);
        requireCooperation(region?.mode === "ready" && region.revision === event.targetRevision, "REGION_PROTECTED", "This ready event no longer releases the current draft revision.");
      }
      event.state = "answered";
    }
    return [...new Set(transaction.respondsToEventIds)];
  }

  private assignInState(state: BlackboardState, tab: CooperationHostTab, boardId: string | null, touched: Set<string>): void {
    this.validateHostTab(tab);
    const previous = own(state.assignments, tab.tabId);
    if (boardId) this.requireBoard(state, boardId);
    if (previous?.boardId === boardId) {
      previous.providerId = tab.providerId; previous.label = tab.label;
      touched.add(boardId!); this.touch(state, boardId!, "assignment", "user:local", [tab.tabId]); return;
    }
    this.detachInState(state, tab.tabId, touched);
    const generation = (own(state.tabGenerationCounters, tab.tabId) ?? 0) + 1;
    state.tabGenerationCounters[tab.tabId] = generation;
    if (!boardId) return;
    const members = Object.values(state.assignments).filter(assignment => assignment.boardId === boardId);
    requireCooperation(members.length < 64, "LIMIT_EXCEEDED", "A board supports at most 64 assigned AI tabs.");
    const role = !members.some(member => member.role === "responder") ? "responder" : "observer";
    state.assignments[tab.tabId] = { tabId: tab.tabId, providerId: tab.providerId, label: tab.label, boardId, assignmentGeneration: generation, role };
    this.requireBoard(state, boardId).status = "active";
    this.touch(state, boardId, "assignment", "user:local", [tab.tabId]); touched.add(boardId);
  }

  private detachInState(state: BlackboardState, tabId: string, touched: Set<string>): void {
    const previous = own(state.assignments, tabId);
    if (!previous) return;
    delete state.assignments[tabId];
    for (const event of state.inbox.filter(event => event.boardId === previous.boardId && event.recipientTabId === tabId && event.state !== "answered")) {
      delete event.recipientTabId; delete event.assignmentGeneration; delete event.claim; event.state = "needsResponder";
    }
    const remaining = Object.values(state.assignments).filter(assignment => assignment.boardId === previous.boardId);
    if (!remaining.length) this.requireBoard(state, previous.boardId).status = "closed";
    this.touch(state, previous.boardId, "assignment", "user:local", [tabId]); touched.add(previous.boardId);
  }

  private async manage(boardId: string, reason: string, action: (state: BlackboardState) => void): Promise<CooperationBoard> {
    return this.repository.serialize(async () => {
      this.requireBoard(this.state, boardId);
      requireCooperation(!this.unavailableProjections.has(boardId), "INTEGRITY_ERROR", "Repair publication before changing this board.");
      await this.projection.verify(boardSnapshot(this.state, boardId));
      const next = structuredClone(this.state); action(next);
      this.touch(next, boardId, "lifecycle", "user:local", [boardId]);
      await this.commit(next, new Set([boardId]), reason);
      return this.getBoard(boardId);
    });
  }

  private touch(state: BlackboardState, boardId: string, kind: CooperationEvent["kind"], actor: CooperationEvent["actor"], changedIds: string[], operationId = `host-${randomUUID()}`): CooperationEvent {
    const board = this.requireBoard(state, boardId);
    board.revision++; board.eventCursor++;
    const event: CooperationEvent = { eventId: `event-${randomUUID()}`, boardId, sequence: board.eventCursor, boardRevision: board.revision,
      operationId, actor, changedIds, kind, createdAt: this.now() };
    const events = own(state.recentEvents, boardId) ?? [];
    state.recentEvents[boardId] = [...events, event].slice(-COOPERATION_LIMITS.events);
    return event;
  }

  private recordChanges(before: CooperationBoard, after: CooperationBoard): RecordChange[] {
    const changes: RecordChange[] = [];
    for (const collection of collections) {
      const oldRecords = new Map(before[collection].map(record => [record.id, record]));
      const newRecords = new Map(after[collection].map(record => [record.id, record]));
      for (const id of new Set([...oldRecords.keys(), ...newRecords.keys()])) {
        const old = oldRecords.get(id); const next = newRecords.get(id);
        if (JSON.stringify(old) !== JSON.stringify(next)) changes.push({ collection, id, ...(old ? { before: structuredClone(old) } : {}), ...(next ? { after: structuredClone(next) } : {}) });
      }
    }
    return changes;
  }

  private async commit(next: BlackboardState, boardIds: Set<string>, reason: string, receipt?: CooperationReceipt): Promise<void> {
    for (const [token, staged] of Object.entries(next.stagedAssets)) {
      const actor = /^agent:(.+)@(\d+)$/.exec(staged.actor);
      const assignment = actor ? own(next.assignments, actor[1]) : undefined;
      const revoked = actor && (!assignment || assignment.boardId !== staged.boardId || assignment.assignmentGeneration !== Number(actor[2]) || own(next.continuationIntents, actor[1])?.sourceRemoved);
      if (!own(next.boards, staged.boardId) || revoked) delete next.stagedAssets[token];
    }
    next.stateGeneration++;
    for (const boardId of boardIds) validateBoard(boardSnapshot(next, boardId));
    const removedStages = Object.values(this.state.stagedAssets).filter(staged => !own(next.stagedAssets, staged.token));
    const attached = Object.values(this.state.stagedAssets).filter(staged => !own(next.stagedAssets, staged.token) && own(next.boards, staged.boardId)?.assets.some(asset => asset.id === staged.asset.id));
    const written: string[] = [];
    try {
      for (const staged of attached) {
        const bytes = await this.repository.readBytes(`staging/${staged.token}`);
        requireCooperation(digestBytes(bytes) === staged.asset.sha256, "ASSET_INVALID", "The staged original changed before attachment.");
        const relative = `boards/${staged.boardId}/${staged.asset.relativePath}`;
        await this.repository.writeBytes(relative, bytes); written.push(relative);
      }
      await this.repository.commit(next);
    } catch (error) {
      if (error instanceof CooperationError && error.details?.authorityReplaced) {
        this.state = next;
        for (const boardId of boardIds) this.unavailableProjections.add(boardId);
        if (receipt) receipt.projectionStatus = "unavailable";
        throw new CooperationError("INTEGRITY_ERROR", error.message, { ...error.details, ...(receipt ? { receipt } : {}) });
      }
      for (const relative of written) await this.repository.removeBytes(relative).catch(() => undefined);
      throw error;
    }
    this.state = next;
    const cleanupFailures: string[] = [];
    for (const staged of removedStages) {
      try { await this.repository.removeBytes(`staging/${staged.token}`); }
      catch { cleanupFailures.push(staged.token); }
    }
    const failedBoards: string[] = [];
    for (const boardId of boardIds) {
      try { await this.projection.publish(boardSnapshot(next, boardId)); }
      catch {
        this.unavailableProjections.add(boardId);
        failedBoards.push(boardId);
        if (receipt) receipt.projectionStatus = "unavailable";
        this.notify({ boardId, reason: "publicationFailed" });
        continue;
      }
      this.notify({ boardId, reason, event: own(next.recentEvents, boardId)?.at(-1) });
    }
    if (failedBoards.length) throw new CooperationError("COMMITTED_PROJECTION_UNAVAILABLE", "The state committed, but board files could not be published. Read the receipt and repair publication before writing.", { ...(receipt ? { receipt } : {}), boardId: failedBoards[0], boardIds: failedBoards });
    if (cleanupFailures.length) throw new CooperationError("INTEGRITY_ERROR", "The state committed, but cancelled image staging files could not be removed.", { committed: true, cleanupRequired: cleanupFailures });
  }

  private validateState(state: BlackboardState): void {
    try {
      exactRecord(state, ["schemaVersion", "stateGeneration", "boards", "assignments", "tabGenerationCounters", "inbox", "operationReceipts", "recentEvents", "stagedAssets", "completions", "continuationIntents"]);
      requireCooperation(state.schemaVersion === 1 && Number.isSafeInteger(state.stateGeneration) && state.stateGeneration >= 0, "INTEGRITY_ERROR", "Unsupported authority version or generation.");
      for (const field of ["boards", "assignments", "tabGenerationCounters", "operationReceipts", "recentEvents", "stagedAssets", "continuationIntents"] as const) requireCooperation(state[field] && typeof state[field] === "object" && !Array.isArray(state[field]), "INTEGRITY_ERROR", "Authority dictionaries are invalid.");
      requireCooperation(Array.isArray(state.inbox) && Array.isArray(state.completions), "INTEGRITY_ERROR", "Authority feedback history is invalid.");
      for (const [boardId, board] of Object.entries(state.boards)) {
        requireCooperation(isCooperationId(boardId) && board.boardId === boardId && !Object.hasOwn(board, "members"), "INTEGRITY_ERROR", "Stored boards cannot duplicate assignment authority.");
        validateBoard(boardSnapshot(state, boardId));
        requireCooperation((board.status === "active") === Object.values(state.assignments).some(member => member.boardId === boardId), "INTEGRITY_ERROR", "Saved lifecycle must match assigned membership.");
      }
      for (const [tabId, assignment] of Object.entries(state.assignments)) {
        requireCooperation(isCooperationId(tabId) && assignment.tabId === tabId && own(state.boards, assignment.boardId) && own(state.tabGenerationCounters, tabId) === assignment.assignmentGeneration,
          "INTEGRITY_ERROR", "Saved assignment references are inconsistent.");
      }
      for (const [tabId, generation] of Object.entries(state.tabGenerationCounters)) requireCooperation(isCooperationId(tabId) && Number.isSafeInteger(generation) && generation >= 0, "INTEGRITY_ERROR", "Saved tab generation counters are invalid.");
      for (const [tabId, intent] of Object.entries(state.continuationIntents)) requireCooperation(intent.tabId === tabId && own(state.assignments, tabId)?.boardId === intent.boardId &&
        own(state.assignments, tabId)?.assignmentGeneration === intent.assignmentGeneration && isCooperationId(intent.ownerPluginId) && isCooperationId(intent.logicalRunId) && typeof intent.sourceRemoved === "boolean",
        "INTEGRITY_ERROR", "Saved logical continuation ownership is inconsistent.");
      for (const [key, stored] of Object.entries(state.operationReceipts)) requireCooperation(stored && key === receiptKey(stored.receipt.boardId, stored.receipt.operationId) && own(state.boards, stored.receipt.boardId) &&
        stored.receipt.boardRevision <= state.boards[stored.receipt.boardId].revision && Array.isArray(stored.changes) && typeof stored.digest === "string" && typeof stored.callerKey === "string", "INTEGRITY_ERROR", "Saved receipt history is invalid.");
      for (const stored of Object.values(state.operationReceipts)) for (const change of stored.changes) {
        validateRecordChange(change);
        requireCooperation((!change.before || (change.before as { id: string }).id === change.id) && (!change.after || (change.after as { id: string }).id === change.id), "INTEGRITY_ERROR", "Saved history must retain each record's stable identity.");
      }
      for (const [boardId, events] of Object.entries(state.recentEvents)) {
        const board = own(state.boards, boardId);
        requireCooperation(board && Array.isArray(events) && events.length <= COOPERATION_LIMITS.events && (events.at(-1)?.sequence ?? 0) === board.eventCursor, "INTEGRITY_ERROR", "Saved event window does not match its board cursor.");
        let previous: number | undefined;
        for (const event of events) {
          exactRecord(event, ["eventId", "sequence", "boardId", "boardRevision", "operationId", "actor", "changedIds", "kind", "createdAt"]);
          requireCooperation(isCooperationId(event.eventId) && event.boardId === boardId && isCooperationId(event.operationId) && /^((user)|(agent)):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.actor) &&
            Number.isSafeInteger(event.sequence) && event.sequence >= 1 && (previous === undefined || previous + 1 === event.sequence) &&
            Number.isSafeInteger(event.boardRevision) && event.boardRevision >= 1 && event.boardRevision <= board.revision && Array.isArray(event.changedIds) && event.changedIds.every(isCooperationId) &&
            ["content", "assignment", "lifecycle", "feedback"].includes(event.kind) && typeof event.createdAt === "string", "INTEGRITY_ERROR", "Saved event records must be bounded and monotonic.");
          previous = event.sequence;
        }
      }
      requireCooperation(Object.keys(state.boards).every(boardId => Object.hasOwn(state.recentEvents, boardId)), "INTEGRITY_ERROR", "Every board requires its event window.");
      for (const event of state.inbox) requireCooperation(own(state.boards, event.boardId) && isCooperationId(event.eventId) && Number.isSafeInteger(event.sequence) && event.sequence <= state.boards[event.boardId].eventCursor &&
        Number.isSafeInteger(event.targetRevision) && event.targetRevision >= 1 &&
        ["needsResponder", "queued", "nativeAccepted", "unknown", "claimed", "answered"].includes(event.state), "INTEGRITY_ERROR", "Saved inbox state is invalid.");
      validateBlackboardAudit(state);
    } catch (error) {
      throw new CooperationError("INTEGRITY_ERROR", `The cooperation authority failed validation. ${error instanceof Error ? error.message : "Preserve it for repair."}`);
    }
  }

  private async decodeImage(bytes: Buffer, mime: string, assetId: string): Promise<CooperationAsset> {
    requireCooperation(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= COOPERATION_LIMITS.imageBytes && ["image/png", "image/jpeg", "image/webp"].includes(mime), "ASSET_INVALID", "Use a bounded PNG, JPEG or WebP original.");
    try {
      const image = sharp(bytes, { limitInputPixels: COOPERATION_LIMITS.imagePixels, failOn: "warning", animated: false });
      const metadata = await image.metadata();
      requireCooperation(`image/${metadata.format}` === mime || metadata.format === "jpeg" && mime === "image/jpeg", "ASSET_INVALID", "Declared MIME does not match the decoded original.");
      requireCooperation((metadata.pages ?? 1) === 1 && metadata.width && metadata.height && metadata.width * metadata.height <= COOPERATION_LIMITS.imagePixels, "ASSET_INVALID", "The original must be one bounded image.");
      await image.raw().toBuffer();
      return { id: assetId, mime: mime as CooperationAsset["mime"], sha256: digestBytes(bytes), byteLength: bytes.length,
        width: metadata.width, height: metadata.height, relativePath: `assets/${assetId}.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}` };
    } catch (error) {
      if (error instanceof CooperationError) throw error;
      throw new CooperationError("ASSET_INVALID", "The original image could not be completely decoded.");
    }
  }

  private authorize(state: BlackboardState, boardId: string, caller: CooperationCaller, writing: boolean): void {
    this.validateCaller(caller);
    const board = this.requireBoard(state, boardId);
    if (caller.kind === "agent") {
      const assignment = own(state.assignments, caller.tabId);
      requireCooperation(assignment, "UNASSIGNED", "This AI tab has no blackboard assignment.");
      requireCooperation(!own(state.continuationIntents, caller.tabId)?.sourceRemoved, "UNASSIGNED", "This worker tab ended. Its board is held only for the owning continuation.");
      requireCooperation(assignment.boardId === boardId && assignment.assignmentGeneration === caller.assignmentGeneration, "ASSIGNMENT_CHANGED", "The board binding changed. Read current context.");
      requireCooperation(!caller.providerId || assignment.providerId === caller.providerId, "ASSIGNMENT_CHANGED", "The tab provider changed. Read current context before writing.");
    }
    if (writing) requireCooperation(board.status !== "closed", "BOARD_CLOSED", "Assign a tab to reopen this retained board before editing.");
  }

  private requireBoard(state: BlackboardState, boardId: string): StoredBoard {
    this.requireId(boardId);
    const board = own(state.boards, boardId);
    requireCooperation(board, "NOT_FOUND", "The blackboard does not exist."); return board;
  }
  private assertReady() { requireCooperation(this.ready, "INTEGRITY_ERROR", "The cooperation service has not finished validating saved state."); }
  private requireId(id: unknown): asserts id is string { requireCooperation(isCooperationId(id), "INVALID_REQUEST", "Use a valid stable record ID."); }
  private requireTitle(title: unknown): asserts title is string { requireCooperation(typeof title === "string" && title.trim().length > 0 && title.length <= 200, "INVALID_REQUEST", "A title must contain 1 to 200 characters."); }
  private requireUser(caller: CooperationCaller) { this.validateCaller(caller); requireCooperation(caller.kind === "user", "FORBIDDEN", "Blackboard management and draft protection belong to the user."); }
  private validateCaller(caller: CooperationCaller) {
    requireCooperation(caller && (caller.kind === "user" || caller.kind === "agent"), "FORBIDDEN", "A verified caller is required.");
    this.requireId(caller.kind === "user" ? caller.userId : caller.tabId);
    if (caller.kind === "agent") {
      requireCooperation(Number.isSafeInteger(caller.assignmentGeneration) && caller.assignmentGeneration >= 1, "ASSIGNMENT_CHANGED", "A current assignment generation is required.");
      requireCooperation(caller.providerTurnId === undefined && caller.nativeExecutionId === undefined || isCooperationId(caller.providerTurnId) && isCooperationId(caller.nativeExecutionId),
        "FORBIDDEN", "Trusted native execution and turn identity must be supplied together.");
    }
  }
  private validateHostTab(tab: CooperationHostTab) {
    this.requireId(tab.tabId); this.requireTitle(tab.label);
    requireCooperation(tab.providerId === "codex" || tab.providerId === "claude", "INVALID_REQUEST", "Only an authoritative Codex or Claude tab can join a board.");
  }
  private notify(change: CooperationChange) { for (const listener of this.listeners) { try { listener(structuredClone(change)); } catch { /* A view subscriber cannot invalidate committed state. */ } } }
}

function digestBytes(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
