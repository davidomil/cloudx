import { isDeepStrictEqual } from "node:util";
import type { CooperationItem } from "@cloudx/shared";
import type { BlackboardState, RecordChange, StoredReceipt } from "./BlackboardState.js";

export class BoardUndoHistory {
  private readonly laterReceipts: StoredReceipt[];
  private readonly reversedOperations: Map<string, StoredReceipt>;

  constructor(state: BlackboardState, private readonly original: StoredReceipt) {
    this.laterReceipts = Object.values(state.operationReceipts)
      .filter(stored => stored.receipt.boardId === original.receipt.boardId && stored.receipt.eventCursor > original.receipt.eventCursor)
      .sort((a, b) => b.receipt.eventCursor - a.receipt.eventCursor);
    this.reversedOperations = new Map(this.laterReceipts.filter(stored => stored.undoneBy).map(stored => [stored.undoneBy!, stored]));
  }

  canRestore(change: RecordChange, current: unknown): boolean {
    if (isDeepStrictEqual(current, change.after)) return true;
    if (!sameContent(current, change.after)) return false;
    const canceled = new Set<string>();
    const touchesRecord = (candidate: RecordChange) => candidate.collection === change.collection && candidate.id === change.id;
    for (const stored of this.laterReceipts) {
      const mutation = stored.changes.find(touchesRecord);
      if (!mutation) continue;
      if (stored.receipt.actor !== this.original.receipt.actor) return false;
      if (canceled.delete(stored.receipt.operationId)) continue;
      const reversed = this.reversedOperations.get(stored.receipt.operationId);
      const revertedChange = reversed?.changes.find(touchesRecord);
      if (!reversed || !revertedChange || !sameContent(mutation.after, revertedChange.before)) return false;
      canceled.add(reversed.receipt.operationId);
    }
    return canceled.size === 0;
  }
}

function sameContent(first: unknown, second: unknown): boolean {
  return isDeepStrictEqual(withoutMonotonicRevisions(first), withoutMonotonicRevisions(second));
}

function withoutMonotonicRevisions(value: unknown): unknown {
  if (value === undefined) return value;
  const { revision: _revision, ...record } = value as Record<string, unknown>;
  if (record.kind !== "note" && record.kind !== "code") return record;
  const item = value as Extract<CooperationItem, { kind: "note" | "code" }>;
  return { ...record, content: { ...item.content, blocks: item.content.blocks.map(({ revision: _revision, ...block }) => block) } };
}
