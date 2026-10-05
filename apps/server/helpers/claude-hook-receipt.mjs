#!/usr/bin/env node
// Claude Code hook that records which conversation a CloudX tab runs and the
// state of its latest turn. Receipts use the same shapes as the Codex worker
// bridge so recovery and switching read one format.
//
// Usage: claude-hook-receipt.mjs <configDir> <tabId> <executionId> <event>
// The hook payload arrives as JSON on stdin. The hook always exits 0 so a
// receipt failure never blocks the user's session.
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
// File names match AGENT_TURN_RECEIPT and CLAUDE_FORGE_TURN_BINDING in the
// server, and the receipt CodexConversationRecovery reads.
const CONVERSATION_RECEIPT = ".cloudx-conversation.json";
const TURN_RECEIPT = ".cloudx-turn.json";
const FORGE_TURN_BINDING = ".cloudx-forge-turn.json";
const MAX_INPUT_BYTES = 1_048_576;

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
    if (typeof payload.last_assistant_message === "string" && Buffer.byteLength(payload.last_assistant_message) <= 1024 * 1024)
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

async function main() {
  const [configDir, tabId, executionId, event] = process.argv.slice(2);
  if (!configDir || !path.isAbsolute(configDir) || !tabId || !CONVERSATION_ID.test(executionId ?? "") || !event) return;
  const payload = JSON.parse(await readStdin());
  for (const receipt of receiptsForEvent(event, payload, { tabId, executionId })) writeAtomicFile(path.join(configDir, receipt.name), receipt.value);
  const forge = readForgeBinding(configDir);
  if (forge) for (const receipt of forgeReceiptsForEvent(event, payload, forge, readJson(forge.receiptPath))) writeAtomicFile(receipt.path, receipt.value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`CloudX receipt: ${error instanceof Error ? error.message : String(error)}\n`); }).finally(() => process.exit(0));
}
