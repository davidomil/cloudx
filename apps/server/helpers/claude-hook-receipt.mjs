#!/usr/bin/env node
// Claude Code hook that records which conversation a CloudX tab runs and the
// state of its latest turn. Receipts use the same shapes as the Codex worker
// bridge so recovery and switching read one format.
//
// Usage: claude-hook-receipt.mjs <configDir> <tabId> <executionId> <event>
// The hook payload arrives as JSON on stdin. The hook always exits 0 so a
// receipt failure never blocks the user's session.
//
// Claude runs Stop hooks in parallel, and another hook can block the stop and
// continue the same prompt. So Stop only records a pending stop and starts
// `claude-hook-receipt.mjs --settle <configDir> <stopId>`, which completes the
// turn once the transcript shows the Stop hooks finished without continuing.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
// File names match AGENT_TURN_RECEIPT and CLAUDE_FORGE_TURN_BINDING in the
// server, and the receipt CodexConversationRecovery reads.
const CONVERSATION_RECEIPT = ".cloudx-conversation.json";
const TURN_RECEIPT = ".cloudx-turn.json";
const FORGE_TURN_BINDING = ".cloudx-forge-turn.json";
const PENDING_STOP = ".cloudx-turn-stop.json";
const MAX_INPUT_BYTES = 1_048_576;
const MAX_FINAL_TEXT_BYTES = 1024 * 1024;
const SETTLE_POLL_MS = 200;
// Longer than Claude Code's default 10-minute hook timeout. If no summary
// appears by then, the Stop that did fire completes the turn.
const SETTLE_TIMEOUT_MS = 15 * 60_000;
// Claude Code writes this user record when a Stop hook blocks and the turn continues.
const STOP_FEEDBACK_PREFIX = "Stop hook feedback";
// Attachments Claude Code writes when Stop hook output continues the turn.
const CONTINUING_ATTACHMENTS = new Set(["hook_additional_context", "hook_blocking_error"]);

export function receiptsForEvent(event, payload, binding) {
  if (!payload || typeof payload !== "object" || !CONVERSATION_ID.test(String(payload.session_id ?? ""))) return [];
  const sessionId = payload.session_id;
  const updatedAt = new Date().toISOString();
  const receipts = [];
  if (event === "SessionStart" || event === "UserPromptSubmit") {
    if (typeof payload.cwd === "string" && path.isAbsolute(payload.cwd)) {
      receipts.push({
        name: CONVERSATION_RECEIPT,
        value: {
          version: 2, authority: "selected", tabId: binding.tabId, executionId: binding.executionId,
          sessionId, cwd: payload.cwd,
          ...(typeof payload.transcript_path === "string" && path.isAbsolute(payload.transcript_path) ? { transcriptPath: payload.transcript_path } : {})
        }
      });
    }
  }
  const turnId = typeof payload.prompt_id === "string" && payload.prompt_id ? payload.prompt_id : undefined;
  if (event === "UserPromptSubmit") receipts.push({ name: TURN_RECEIPT, value: { version: 1, sessionId, ...(turnId ? { turnId } : {}), status: "running", updatedAt } });
  if (event === "Stop") receipts.push({ name: TURN_RECEIPT, value: { version: 1, sessionId, ...(turnId ? { turnId } : {}), status: "completed", updatedAt } });
  if (event === "StopFailure") receipts.push({ name: TURN_RECEIPT, value: { version: 1, sessionId, ...(turnId ? { turnId } : {}), status: "failed", updatedAt } });
  return receipts;
}

// A Forge attempt owns exactly one turn: the first prompt after launch. Later
// prompts typed into the same tab do not replace its receipt.
export function forgeReceiptsForEvent(event, payload, binding, current) {
  if (!binding || !payload || typeof payload !== "object" || !CONVERSATION_ID.test(String(payload.session_id ?? ""))) return [];
  const threadId = payload.session_id;
  if (binding.expectedThreadId && threadId !== binding.expectedThreadId) return [];
  const turnId = typeof payload.prompt_id === "string" && payload.prompt_id ? payload.prompt_id : "turn-1";
  const identity = { workerId: binding.workerId, attemptId: binding.attemptId, threadId, turnId };
  if (event === "UserPromptSubmit") {
    if (current) return [];
    return [{ path: binding.receiptPath, value: { ...identity, status: "running" } }];
  }
  if (!current || current.status !== "running" || current.threadId !== threadId || current.turnId !== turnId) return [];
  if (event === "Stop") {
    const receipts = [{ path: binding.receiptPath, value: { ...current, status: "completed" } }];
    if (typeof payload.last_assistant_message === "string" && Buffer.byteLength(payload.last_assistant_message) <= MAX_FINAL_TEXT_BYTES)
      receipts.unshift({ path: `${binding.receiptPath}.final.json`, value: { ...current, status: "completed", text: payload.last_assistant_message } });
    return receipts;
  }
  if (event === "StopFailure") {
    const error = typeof payload.error === "string" ? payload.error : typeof payload.error?.message === "string" ? payload.error.message : "Claude Code stopped the turn after an API error.";
    return [{ path: binding.receiptPath, value: { ...current, status: "failed", error: error.slice(0, 10_000) } }];
  }
  return [];
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function readForgeBinding(configDir) {
  const binding = readJson(path.join(configDir, FORGE_TURN_BINDING));
  if (!binding) return undefined;
  if (typeof binding.workerId !== "string" || typeof binding.attemptId !== "string" || typeof binding.receiptPath !== "string" || !path.isAbsolute(binding.receiptPath))
    throw new Error("Forge turn binding is invalid.");
  return binding;
}

function writeAtomicFile(target, value) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const file = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(file, JSON.stringify(value));
    fsyncSync(file);
  } finally { closeSync(file); }
  renameSync(temporary, target);
  const directory = openSync(path.dirname(target), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error("Hook payload exceeds the size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function applyEvent(configDir, binding, event, payload, { tab = true } = {}) {
  if (tab) for (const receipt of receiptsForEvent(event, payload, binding)) writeAtomicFile(path.join(configDir, receipt.name), receipt.value);
  const forge = readForgeBinding(configDir);
  if (forge) for (const receipt of forgeReceiptsForEvent(event, payload, forge, readJson(forge.receiptPath))) writeAtomicFile(receipt.path, receipt.value);
}

// Reads what the transcript gained after a Stop: "continued" when a Stop hook
// blocked or added context, "settled" when the Stop hooks finished without
// either, else undefined.
export function stopOutcome(appended) {
  for (const line of appended.split("\n")) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === "user" && messageText(record).startsWith(STOP_FEEDBACK_PREFIX)) return "continued";
    if (record?.type === "attachment" && CONTINUING_ATTACHMENTS.has(record.attachment?.type)) return "continued";
    if (record?.type === "system" && record.subtype === "stop_hook_summary")
      return Array.isArray(record.hookAdditionalContext) && record.hookAdditionalContext.length ? "continued" : "settled";
  }
  return undefined;
}

function messageText(record) {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map(part => typeof part?.text === "string" ? part.text : "").join("") : "";
}

function readFrom(file, offset) {
  if (!file) return "";
  let size;
  try { size = statSync(file).size; }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  if (size <= offset) return "";
  const buffer = Buffer.alloc(Math.min(size - offset, MAX_INPUT_BYTES * 16));
  const descriptor = openSync(file, "r");
  try { return buffer.subarray(0, readSync(descriptor, buffer, 0, buffer.length, offset)).toString("utf8"); }
  finally { closeSync(descriptor); }
}

// The turn stays running until the settle process sees the Stop hooks finish.
// A transcript that does not exist yet is read from its start once it does;
// without any transcript path, only the settle timeout completes the turn.
function recordStop(configDir, binding, payload) {
  const transcriptPath = typeof payload?.transcript_path === "string" && path.isAbsolute(payload.transcript_path) ? payload.transcript_path : undefined;
  let offset = 0;
  try { if (transcriptPath) offset = statSync(transcriptPath).size; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const stopId = randomUUID();
  writeAtomicFile(path.join(configDir, PENDING_STOP), { stopId, binding, transcriptPath, offset, payload });
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--settle", configDir, stopId], { detached: true, stdio: "ignore" }).unref();
}

async function settle(configDir, stopId) {
  const pendingPath = path.join(configDir, PENDING_STOP);
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (true) {
    const pending = readJson(pendingPath);
    // A later Stop owns the turn now.
    if (pending?.stopId !== stopId) return;
    const outcome = stopOutcome(readFrom(pending.transcriptPath, pending.offset));
    if (outcome || Date.now() > deadline) {
      rmSync(pendingPath, { force: true });
      if (outcome === "continued") return;
      // When a newer prompt already replaced the tab's turn, only the Forge
      // attempt, which tracks its own first turn, still completes.
      const current = readJson(path.join(configDir, TURN_RECEIPT));
      const tab = !current || (current.sessionId === pending.payload.session_id && current.turnId === pending.payload.prompt_id);
      return applyEvent(configDir, pending.binding, "Stop", pending.payload, { tab });
    }
    await sleep(SETTLE_POLL_MS);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--settle") {
    const [, configDir, stopId] = args;
    if (configDir && path.isAbsolute(configDir) && stopId) await settle(configDir, stopId);
    return;
  }
  const [configDir, tabId, executionId, event] = args;
  if (!configDir || !path.isAbsolute(configDir) || !tabId || !CONVERSATION_ID.test(executionId ?? "") || !event) return;
  const payload = JSON.parse(await readStdin());
  if (event === "Stop") return recordStop(configDir, { tabId, executionId }, payload);
  applyEvent(configDir, { tabId, executionId }, event, payload);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`CloudX receipt: ${error instanceof Error ? error.message : String(error)}\n`); }).finally(() => process.exit(0));
}
