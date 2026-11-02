#!/usr/bin/env node
import { watch } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { TranscriptReader } from "./claude-hook-receipt.mjs";
import { CooperationNativeControl, readPrivateJson } from "./cooperation-native-control.mjs";

/** A regular MCP child uses Claude's documented own-session inbox socket. */
export class ClaudeCooperationBroker {
  constructor(binding, env = process.env) {
    this.binding = binding;
    this.env = env;
    this.pending = new Map();
    this.watchers = [];
    this.reading = Promise.resolve();
  }

  async start() {
    if (!this.env.CLAUDE_CODE_MESSAGING_SOCKET) throw new Error("The original Claude session did not expose its native inbox socket.");
    this.control = await new CooperationNativeControl({ ...this.binding, providerId: "claude" }, envelope => this.deliver(envelope)).start();
    this.watchers.push(watch(this.binding.configDir, (_event, name) => {
      if (name?.toString() === ".cloudx-conversation.json") void this.followConversation().catch(reportError);
      if (name?.toString() === ".cloudx-turn.json") void this.readTurn().catch(reportError);
    }));
    await this.followConversation();
    return this;
  }

  async followConversation() {
    let identity;
    try { identity = await readPrivateJson(path.join(this.binding.configDir, ".cloudx-conversation.json")); }
    catch { return; }
    if (identity.tabId !== this.binding.tabId || identity.executionId !== this.binding.executionId ||
      typeof identity.sessionId !== "string" || typeof identity.transcriptPath !== "string" || !path.isAbsolute(identity.transcriptPath)) return;
    if (this.sessionId && this.sessionId !== identity.sessionId) {
      for (const entry of this.pending.values()) await this.control.mark(entry.eventIds, "unknown", { reason: "The native Claude conversation changed before feedback acknowledgment." });
      this.pending.clear();
      this.promptId = undefined;
    }
    this.sessionId = identity.sessionId;
    if (this.transcriptPath === identity.transcriptPath && this.transcriptWatcher) return;
    try { await fs.access(path.dirname(identity.transcriptPath)); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    this.transcriptWatcher?.close();
    this.transcriptPath = identity.transcriptPath;
    let size = 0;
    try { size = (await fs.stat(this.transcriptPath)).size; } catch { /* Native creates its transcript after SessionStart. */ }
    this.transcript = new TranscriptReader(this.transcriptPath, size);
    this.transcriptWatcher = watch(path.dirname(this.transcriptPath), (_event, filename) => {
      if (filename?.toString() === path.basename(this.transcriptPath)) void this.readTranscript().catch(reportError);
    });
    this.transcriptWatcher.on("error", () => this.transcriptWatcher.close());
    await this.control.boundary();
  }

  readTranscript() {
    this.reading = this.reading.catch(() => undefined).then(async () => {
      const accepted = [];
      const prompts = [];
      this.transcript?.read(line => {
        let record;
        try { record = JSON.parse(line); } catch { return; }
        if (record.type === "user" && record.isSidechain !== true && typeof record.promptId === "string") {
          this.promptId = record.promptId;
          prompts.push(record.promptId);
        }
        if (record.type !== "queue-operation" || record.operation !== "enqueue") return;
        const content = typeof record.content === "string" ? record.content : JSON.stringify(record.content);
        for (const [marker, entry] of this.pending) {
          if (!content.includes(marker)) continue;
          accepted.push(entry);
          this.pending.delete(marker);
        }
      });
      for (const providerTurnId of prompts) await this.control.turn({ providerTurnId, status: "running" });
      for (const entry of accepted) await this.control.mark(entry.eventIds, "nativeAccepted", { reason: "The original Claude session persisted the message in its native input queue." });
      for (const entry of accepted) entry.accept?.();
    });
    return this.reading;
  }

  async readTurn() {
    await this.followConversation();
    await this.readTranscript();
    let value;
    try { value = await readPrivateJson(path.join(this.binding.configDir, ".cloudx-turn.json")); } catch { return; }
    if (value.sessionId !== this.sessionId) return;
    if (this.promptId && value.turnId && value.turnId !== this.promptId) return;
    const providerTurnId = value.turnId ?? this.control.currentTurn?.providerTurnId;
    if (providerTurnId) await this.control.turn({ providerTurnId, status: value.status });
    await this.control.boundary();
  }

  async deliver(envelope) {
    await this.followConversation();
    if (!this.sessionId || !this.transcript) return { state: "queued", reason: "The original Claude conversation is still connecting." };
    if (this.binding.owned) {
      let turn;
      try { turn = await readPrivateJson(path.join(this.binding.configDir, ".cloudx-turn.json")); } catch { return { state: "queued", reason: "The owner attempt has not started its native turn." }; }
      if (turn.status !== "running") return { state: "queued", reason: "ownerContinuationRequired" };
      if (!envelope.immediate) return { state: "queued", reason: "The owner attempt is running; feedback waits for its tracked continuation boundary." };
    }
    const marker = `CLOUDX_COOPERATION_EVENTS:${envelope.eventIds.join(",")}`;
    let accept;
    const accepted = new Promise(resolve => { accept = resolve; });
    this.pending.set(marker, { eventIds: envelope.eventIds, accept });
    const frame = {
      type: "user", session_id: this.sessionId, msg_id: envelope.eventIds[0], priority: "next",
      message: { role: "user", content: `${marker}\n$cooperation-board $cooperation-feedback\n${envelope.text}` }
    };
    await postNativeMessage(this.env.CLAUDE_CODE_MESSAGING_SOCKET, this.env.CLAUDE_CODE_MESSAGING_TOKEN, frame);
    await this.readTranscript();
    let timer;
    if (this.pending.has(marker)) {
      try { await Promise.race([accepted, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
      finally { clearTimeout(timer); }
    }
    if (!this.pending.has(marker)) return { state: "nativeAccepted", reason: "The original Claude session persisted the message in its native input queue." };
    return { state: "unknown", reason: "Submitted to the original Claude inbox; waiting for its native queue receipt. Its inbound policy remains in force." };
  }

  async close() {
    for (const watcher of this.watchers) watcher.close();
    this.transcriptWatcher?.close();
    await this.reading;
    await this.control?.close();
  }
}

function postNativeMessage(socketPath, token, frame) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.setTimeout(5000, () => socket.destroy(new Error("The original Claude inbox did not accept a connection.")));
    socket.on("error", reject);
    socket.once("connect", () => {
      const auth = token ? `${JSON.stringify({ type: "auth", token })}\n` : "";
      socket.end(`${auth}${JSON.stringify(frame)}\n`, resolve);
    });
  });
}

function reportError(error) { process.stderr.write(`CloudX cooperation observation: ${error.message}\n`); }

async function runMcpBroker() {
  const [configDir, tabId, executionId] = process.argv.slice(2);
  const contextPath = process.env.CLOUDX_COOPERATION_CONTEXT;
  if (!contextPath || !configDir || !tabId || !executionId) throw new Error("The Claude cooperation bridge is missing its original session binding.");
  const binding = { configDir, tabId, executionId, contextPath, owned: process.env.CLOUDX_COOPERATION_OWNED === "1" };
  let broker;
  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  let pending = "";
  let chain = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    pending += chunk;
    if (Buffer.byteLength(pending) > 1024 * 1024) { process.stdin.destroy(new Error("MCP input exceeds its bound.")); return; }
    let line;
    while ((line = pending.indexOf("\n")) >= 0) {
      const input = pending.slice(0, line);
      pending = pending.slice(line + 1);
      chain = chain.then(async () => {
        const request = JSON.parse(input);
        if (request.id == null) return;
        if (request.method === "initialize") {
          broker ??= await new ClaudeCooperationBroker(binding).start();
          send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "cloudx-cooperation", version: "1.0.0" }, instructions: "Use the cooperation-board skill and the current per-tab helper for board content. Native board feedback arrives in the original session inbox." } });
        } else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "cooperation_context", description: "Read this tab's current blackboard assignment without exposing its private capability.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
        else if (request.method === "tools/call" && request.params?.name === "cooperation_context") {
          const { capability: _secret, ...context } = await readPrivateJson(contextPath);
          send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(context) }] } });
        } else if (request.method === "ping") send({ jsonrpc: "2.0", id: request.id, result: {} });
        else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown cooperation MCP method." } });
      }).catch(error => { process.stderr.write(`${error.message}\n`); });
    }
  });
  process.stdin.on("end", () => { void chain.then(() => broker?.close()); });
  process.stdin.on("error", () => { void broker?.close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpBroker().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
