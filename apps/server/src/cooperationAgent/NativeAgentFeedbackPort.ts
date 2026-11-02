import { constants, watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { CooperationProvider } from "@cloudx/shared";

import type { AgentCooperationContext } from "./AgentCooperationContext.js";

export interface AgentFeedbackEnvelope {
  recipientTabId: string;
  assignmentGeneration: number;
  boardId: string;
  boardRevision: number;
  eventIds: string[];
  text: string;
  immediate?: boolean;
  executionId?: string;
}
export interface AgentFeedbackDelivery {
  state: "queued" | "nativeAccepted" | "unknown" | "unavailable";
  reason?: string;
  providerTurnId?: string;
}
export interface NativeFeedbackObservation extends AgentFeedbackDelivery {
  tabId: string;
  providerId: CooperationProvider;
  executionId: string;
  boardId: string;
  assignmentGeneration: number;
  eventIds: string[];
}
export interface NativeCooperationTurn {
  tabId: string; providerId: CooperationProvider; executionId: string; providerTurnId: string;
  boardId: string | null; assignmentGeneration: number; status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string; completedAt?: string;
}
interface NativeControlLocator {
  version: 1; providerId: CooperationProvider; tabId: string; executionId: string;
  socketPath: string; status: "ready" | "closed"; boundaryEpoch?: number; deliveries: NativeFeedbackObservation[];
  currentTurn?: NativeCooperationTurn;
}

/** Talks only to the native owner already attached to the addressed tab. */
export class NativeAgentFeedbackPort {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly listeners = new Set<(value: NativeFeedbackObservation) => void>();
  private readonly observed = new Map<string, string>();
  private readonly boundaries = new Map<string, string>();
  private readonly boundaryListeners = new Set<(tabId: string) => void>();
  private readonly turnListeners = new Set<(turn: NativeCooperationTurn) => void>();
  private readonly turns = new Map<string, string>();

  constructor(private readonly options: { contexts: AgentCooperationContext }) {}

  onDelivery(listener: (value: NativeFeedbackObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onBoundary(listener: (tabId: string) => void): () => void {
    this.boundaryListeners.add(listener);
    return () => this.boundaryListeners.delete(listener);
  }

  onTurn(listener: (turn: NativeCooperationTurn) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  async deliver(envelope: AgentFeedbackEnvelope): Promise<AgentFeedbackDelivery> {
    const contextPath = this.options.contexts.contextPath(envelope.recipientTabId);
    await this.observe(envelope.recipientTabId);
    let locator: NativeControlLocator;
    try { locator = await readJson(`${contextPath}.native.json`) as NativeControlLocator; }
    catch (error) {
      return { state: "unavailable", reason: (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "The original AI session has not advertised a cooperation control channel." : "The original AI session control receipt is unreadable." };
    }
    if (locator.version !== 1 || locator.tabId !== envelope.recipientTabId || locator.status !== "ready" ||
      envelope.executionId && envelope.executionId !== locator.executionId ||
      typeof locator.socketPath !== "string" || !path.isAbsolute(locator.socketPath))
      return { state: "unavailable", reason: "The original AI session control channel is not ready." };
    const context = await this.options.contexts.prepare(envelope.recipientTabId);
    if (context.assignmentGeneration !== envelope.assignmentGeneration || context.boardId !== envelope.boardId)
      return { state: "unavailable", reason: "The blackboard assignment changed before native delivery." };
    if (context.providerId && context.providerId !== locator.providerId || context.executionId && context.executionId !== locator.executionId)
      return { state: "unavailable", reason: "The original native execution changed before delivery." };
    return requestNativeControl(locator.socketPath, { ...envelope, capability: context.capability });
  }

  async observe(tabId: string): Promise<void> {
    if (this.watchers.has(tabId)) return;
    const contextPath = this.options.contexts.contextPath(tabId);
    const filename = `${path.basename(contextPath)}.native.json`;
    const watcher = watch(path.dirname(contextPath), (_event, name) => {
      if (name?.toString() === filename) void this.readObservation(tabId);
    });
    watcher.on("error", () => { watcher.close(); this.watchers.delete(tabId); });
    this.watchers.set(tabId, watcher);
    await this.readObservation(tabId);
  }

  forget(tabId: string): void {
    this.watchers.get(tabId)?.close();
    this.watchers.delete(tabId);
    this.boundaries.delete(tabId);
    this.turns.delete(tabId);
    for (const key of this.observed.keys()) if (key.startsWith(`[${JSON.stringify(tabId)},`)) this.observed.delete(key);
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.listeners.clear();
    this.boundaryListeners.clear();
    this.turnListeners.clear();
    this.turns.clear();
    this.observed.clear();
    this.boundaries.clear();
  }

  private async readObservation(tabId: string): Promise<void> {
    let locator: NativeControlLocator;
    try { locator = await readJson(`${this.options.contexts.contextPath(tabId)}.native.json`) as NativeControlLocator; }
    catch { return; }
    if (locator.version !== 1 || locator.tabId !== tabId || !Array.isArray(locator.deliveries)) return;
    const boundary = JSON.stringify([locator.providerId, locator.executionId, locator.boundaryEpoch ?? 0]);
    if (this.boundaries.get(tabId) !== boundary && locator.status === "ready") {
      this.boundaries.set(tabId, boundary);
      for (const listener of this.boundaryListeners) listener(tabId);
    }
    if (locator.currentTurn?.providerTurnId) {
      const currentTurn = { ...locator.currentTurn, tabId, providerId: locator.providerId, executionId: locator.executionId };
      const fingerprint = JSON.stringify(currentTurn);
      if (this.turns.get(tabId) !== fingerprint) {
        this.turns.set(tabId, fingerprint);
        for (const listener of this.turnListeners) listener(currentTurn);
      }
    }
    for (const delivery of locator.deliveries) {
      if (!Array.isArray(delivery.eventIds) || !["nativeAccepted", "unknown"].includes(delivery.state)) continue;
      const identity = JSON.stringify([tabId, locator.executionId, delivery.eventIds]);
      const fingerprint = JSON.stringify(delivery);
      if (this.observed.get(identity) === fingerprint) continue;
      this.observed.set(identity, fingerprint);
      const value = { ...delivery, tabId, providerId: locator.providerId, executionId: locator.executionId };
      for (const listener of this.listeners) listener(value);
    }
  }
}

function requestNativeControl(socketPath: string, request: Record<string, unknown>): Promise<AgentFeedbackDelivery> {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    let sent = false;
    let input = "";
    let settled = false;
    const finish = (result: AgentFeedbackDelivery) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10000, () => finish({ state: sent ? "unknown" : "unavailable", reason: "The original native control channel did not acknowledge delivery." }));
    socket.on("error", () => finish({ state: sent ? "unknown" : "unavailable", reason: "The original native control channel disconnected." }));
    socket.on("connect", () => { sent = true; socket.write(`${JSON.stringify(request)}\n`); });
    socket.on("data", chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > 128 * 1024) { finish({ state: "unknown", reason: "The native control receipt exceeds its bound." }); return; }
      if (!input.includes("\n")) return;
      try {
        const result = JSON.parse(input.slice(0, input.indexOf("\n")));
        if (!["queued", "nativeAccepted", "unknown", "unavailable"].includes(result.state)) throw new Error("invalid receipt");
        finish(result);
      } catch { finish({ state: "unknown", reason: "The native control receipt is invalid." }); }
    });
    socket.on("close", () => finish({ state: sent ? "unknown" : "unavailable", reason: "The native control channel closed before acknowledgment." }));
  });
}

async function readJson(filePath: string): Promise<unknown> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid native cooperation state.");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
