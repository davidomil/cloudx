import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { isRecord } from "@cloudx/shared";
import { SaxesParser } from "saxes";

export interface VerificationTranscriptEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export async function readVerificationTranscript(file: string | undefined): Promise<VerificationTranscriptEvent[]> {
  if (!file) return [];
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer);
    assert.ok(bytesRead < buffer.length, "The synthetic native transcript exceeded its 2 MiB limit.");
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, -1).map(line => {
      const item: unknown = JSON.parse(line);
      assert.ok(isRecord(item) && typeof item.type === "string", "Invalid native transcript event.");
      return { type: item.type, ...(isRecord(item.payload) ? { payload: item.payload } : {}) };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  } finally { await handle?.close(); }
}

/** A saved answer belongs to this submission only after a fresh native start and matching completion. */
export function completedNativeTurn(events: VerificationTranscriptEvent[], firstNewEvent: number, threadId: string, answer: string) {
  if (!events.length) return undefined;
  assert.equal(events[0]?.type, "session_meta", "Native transcript has no session header.");
  assert.equal(events[0]?.payload?.id, threadId, "Native transcript belongs to a different selected conversation.");
  assert.ok(events.length >= firstNewEvent, "Native transcript was truncated during verification.");
  const fresh = events.slice(firstNewEvent);
  const starts = fresh.filter(item => item.type === "event_msg" && item.payload?.type === "task_started");
  assert.ok(starts.length <= 1, "A verification submission unexpectedly started multiple native turns.");
  const turnId = starts[0]?.payload?.turn_id;
  if (typeof turnId !== "string" || !turnId) return undefined;
  const startIndex = events.indexOf(starts[0]!);
  const completedIndex = events.findIndex((item, index) => index > startIndex && item.type === "event_msg" && item.payload?.type === "task_complete" && item.payload.turn_id === turnId);
  const completed = events[completedIndex];
  if (!completed) return undefined;
  assert.equal(completed.payload?.last_agent_message, answer, "The native completion saved a different answer.");
  const contexts = events.slice(startIndex + 1, completedIndex).filter(item => item.type === "turn_context");
  assert.ok(contexts.some(item => item.payload?.turn_id === turnId), "The completed native turn has no matching launch context.");
  assert.ok(contexts.every(item => item.payload?.turn_id === turnId), "Launch context belongs to a different native turn.");
  const context = contexts.at(-1)!.payload;
  assert.ok(context, "The completed native turn has no matching launch context.");
  return { threadId, turnId, context };
}

export function completedVerificationTurn(events: VerificationTranscriptEvent[], firstNewEvent: number, threadId: string, answer: string) {
  const completed = completedNativeTurn(events, firstNewEvent, threadId, answer);
  if (!completed) return undefined;
  const { context, turnId } = completed;
  const startIndex = events.findIndex((item, index) => index >= firstNewEvent && item.type === "event_msg" && item.payload?.type === "task_started" && item.payload.turn_id === turnId);
  const contextIndex = events.findIndex(item => item.type === "turn_context" && item.payload === context);
  const workspaceRoots = Object.hasOwn(context, "workspace_roots")
    ? context.workspace_roots
    : worldStateWorkspaceRoots(events, startIndex, contextIndex);
  assert.ok(Array.isArray(workspaceRoots) && workspaceRoots.length > 0 && workspaceRoots.every(root => typeof root === "string" && root.length > 0), "The native turn has invalid workspace roots.");
  return { ...completed, workspaceRoots: workspaceRoots as string[] };
}

/** 0.166.0 writes world state immediately before the context that identifies its owning turn. */
function worldStateWorkspaceRoots(events: VerificationTranscriptEvent[], startIndex: number, contextIndex: number): string[] {
  let filesystem: unknown;
  let currentTurnState = false;
  let activeTurn: unknown;
  let stateTurn: unknown;
  let contextTurn: unknown;
  let completedBaseline = false;
  let inheritedBaseline = false;
  for (let index = 0; index < contextIndex; index++) {
    const event = events[index]!;
    if (event.type === "event_msg" && event.payload?.type === "task_started") {
      if (!completedBaseline) filesystem = undefined;
      inheritedBaseline = completedBaseline;
      completedBaseline = false;
      activeTurn = event.payload.turn_id;
      stateTurn = undefined;
      contextTurn = undefined;
    }
    if (event.type === "compacted" || event.type === "event_msg" && event.payload?.type === "thread_rolled_back") {
      filesystem = undefined;
      currentTurnState = false;
      completedBaseline = false;
      inheritedBaseline = false;
      contextTurn = undefined;
    }
    if (event.type === "turn_context") {
      if (event.payload?.turn_id !== activeTurn) {
        filesystem = undefined;
        completedBaseline = false;
        inheritedBaseline = false;
        contextTurn = undefined;
      } else if (typeof filesystem === "string" && (stateTurn === activeTurn || inheritedBaseline)) contextTurn = activeTurn;
    }
    if (event.type === "event_msg" && event.payload?.type === "task_complete" && contextTurn && event.payload.turn_id === contextTurn) {
      completedBaseline = true;
      inheritedBaseline = false;
      activeTurn = undefined;
    }
    if (event.type !== "world_state") continue;
    const payload = event.payload;
    assert.ok(payload && typeof payload.full === "boolean" && isRecord(payload.state), "Malformed native world state.");
    if (payload.full) filesystem = undefined;
    if (Object.hasOwn(payload.state, "environments")) {
      const environments = payload.state.environments;
      if (!isRecord(environments)) filesystem = undefined;
      else if (Object.hasOwn(environments, "filesystem")) filesystem = environments.filesystem;
    }
    stateTurn = activeTurn;
    completedBaseline = false;
    inheritedBaseline = false;
    contextTurn = undefined;
    if (index > startIndex) currentTurnState = true;
  }
  // Native writes no delta when comparison state is unchanged. Only inherit a baseline
  // already bound to a completed turn, never an orphan snapshot or a reset history.
  assert.ok(currentTurnState || inheritedBaseline, "The current turn has no matching native world state.");
  assert.ok(typeof filesystem === "string", "Native world state has no filesystem evidence.");
  return filesystemWorkspaceRoots(filesystem);
}

export function filesystemWorkspaceRoots(xml: string): string[] {
  const parser = new SaxesParser();
  const elements: string[] = [];
  const roots: string[] = [];
  let root = "";
  let rootBlocks = 0;
  try {
    parser.on("doctype", () => { throw new Error("Native filesystem evidence must not contain a DTD."); });
    parser.on("opentag", tag => {
      assert.ok(elements.length !== 0 || tag.name === "filesystem");
      assert.notEqual(elements.join("/"), "filesystem/workspace_roots/root");
      elements.push(tag.name);
      if (elements.join("/") === "filesystem/workspace_roots") assert.equal(++rootBlocks, 1);
      if (elements.join("/") === "filesystem/workspace_roots/root") {
        assert.equal(Object.keys(tag.attributes).length, 0);
        root = "";
      }
    });
    const appendRootText = (text: string) => { if (elements.join("/") === "filesystem/workspace_roots/root") root += text; };
    parser.on("text", appendRootText);
    parser.on("cdata", appendRootText);
    parser.on("closetag", () => {
      if (elements.join("/") === "filesystem/workspace_roots/root") roots.push(root);
      elements.pop();
    });
    parser.write(xml).close();
  } catch (cause) {
    throw new Error("Malformed native filesystem XML.", { cause });
  }
  assert.ok(rootBlocks === 1 && roots.length > 0 && roots.every(root => root.length > 0), "Native filesystem evidence has invalid workspace roots.");
  return roots;
}
