import type {
  CooperationAssignment, CooperationAsset, CooperationBoard, CooperationEvent, CooperationInboxEvent,
  CooperationReceipt, CooperationTurnCompletion
} from "@cloudx/shared";

export type StoredBoard = Omit<CooperationBoard, "members">;
export type BoardCollection = "items" | "connections" | "regions" | "reactions" | "threads" | "assets";
export interface RecordChange { collection: BoardCollection; id: string; before?: unknown; after?: unknown }
export interface StoredReceipt { receipt: CooperationReceipt; digest: string; callerKey: string; changes: RecordChange[]; undoneBy?: string }
export interface StoredStagedAsset { token: string; boardId: string; actor: string; asset: CooperationAsset }
export interface CooperationContinuationIntent {
  tabId: string; boardId: string; assignmentGeneration: number; ownerPluginId: string; logicalRunId: string; sourceRemoved: boolean;
}
export interface BlackboardState {
  schemaVersion: 1; stateGeneration: number; boards: Record<string, StoredBoard>;
  assignments: Record<string, CooperationAssignment>; tabGenerationCounters: Record<string, number>;
  inbox: CooperationInboxEvent[]; operationReceipts: Record<string, StoredReceipt>; recentEvents: Record<string, CooperationEvent[]>;
  stagedAssets: Record<string, StoredStagedAsset>; completions: CooperationTurnCompletion[];
  continuationIntents: Record<string, CooperationContinuationIntent>;
}

export function emptyBlackboardState(): BlackboardState {
  return { schemaVersion: 1, stateGeneration: 0, boards: {}, assignments: {}, tabGenerationCounters: {}, inbox: [], operationReceipts: {}, recentEvents: {}, stagedAssets: {}, completions: [], continuationIntents: {} };
}

export function boardSnapshot(state: BlackboardState, boardId: string): CooperationBoard {
  const board = state.boards[boardId];
  return { ...board, members: Object.values(state.assignments).filter(assignment => assignment.boardId === boardId)
    .map(({ boardId: _boardId, ...member }) => member).sort((a, b) => a.tabId.localeCompare(b.tabId)) };
}
