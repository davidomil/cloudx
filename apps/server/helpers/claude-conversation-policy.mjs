import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseClaudeResolvedLaunchPolicy } from "@cloudx/shared/claude-launch-policy.mjs";

export const EXECUTION_POLICY = ".cloudx-conversation-policy.json";
const NAVIGATION = ".cloudx-conversation-navigation.json";
const SESSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function json(file, maximum = 2 * 1024 * 1024) {
  let descriptor;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > maximum) throw new Error("Invalid Claude conversation policy file.");
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maximum) throw new Error("Invalid Claude conversation policy file.");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!bytes) break;
      length += bytes;
    }
    if (length > maximum) throw new Error("Claude conversation policy file exceeds its size limit.");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function policyMode(policy) {
  return parseClaudeResolvedLaunchPolicy(policy).mode;
}

function directory(directory, create = false) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("Invalid Claude conversation policy directory.");
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid Claude conversation policy directory.");
  } catch (error) { if (create && error.code === "ENOENT") mkdirSync(directory, { mode: 0o700 }); else throw error; }
}

function recordPath(directory, sessionId) {
  if (!SESSION_ID.test(sessionId ?? "")) throw new Error("An exact Claude conversation ID is required for its launch policy.");
  return path.join(directory, `${sessionId}.json`);
}

export function readConversationPolicy(directoryPath, sessionId) {
  const file = recordPath(directoryPath, sessionId);
  try { directory(directoryPath); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  const value = json(file);
  if (value === undefined) return undefined;
  if (!value || value.version !== 1 || value.sessionId !== sessionId || !OWNER_ID.test(value.accountId ?? "") || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd))
    throw new Error("Invalid recorded Claude conversation policy.");
  policyMode(value.policy);
  return value;
}

export function assertConversationOwner(recorded, input) {
  if (recorded.accountId !== input.accountId) throw new Error("This Claude conversation was launched with a different account. Resume with its recorded account, or start a new conversation; CloudX has not changed either account.");
  if (path.resolve(recorded.cwd) !== path.resolve(input.cwd)) throw new Error("This Claude conversation belongs to a different workspace. Resume in its recorded workspace, or start a new conversation.");
  if (input.policy && policyMode(recorded.policy) !== policyMode(input.policy))
    throw new Error("This Claude conversation has a different launch mode. Its recorded mode is preserved; start a new conversation to change the source policy.");
}

// Publish only a complete, new record. Multiple hook/server processes may bind
// the same new conversation; an existing owner is always checked, never replaced.
export function bindConversationPolicy(directoryPath, sessionId, input) {
  if (input.historical) return;
  policyMode(input.policy);
  const existing = readConversationPolicy(directoryPath, sessionId);
  if (existing) return assertConversationOwner(existing, input);
  directory(directoryPath, true);
  const target = recordPath(directoryPath, sessionId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify({ version: 1, sessionId, accountId: input.accountId, cwd: input.cwd, policy: input.policy })}\n`); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try {
    try { linkSync(temporary, target); }
    catch (error) { if (error.code !== "EEXIST") throw error; assertConversationOwner(readConversationPolicy(directoryPath, sessionId), input); }
  } finally { rmSync(temporary, { force: true }); }
}

function writeNavigation(configDir, value) {
  const target = path.join(configDir, NAVIGATION);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); renameSync(temporary, target); }
  finally { rmSync(temporary, { force: true }); }
}

// SessionStart is observational: Claude does not block on its errors. Every
// prompt repeats the ownership check synchronously before native model work.
export function guardConversationEvent(configDir, executionId, event, payload) {
  if (!["SessionStart", "UserPromptSubmit"].includes(event)) return undefined;
  const binding = json(path.join(configDir, EXECUTION_POLICY));
  if (binding === undefined) return undefined;
  if (binding.version !== 1 || binding.executionId !== executionId || !SESSION_ID.test(executionId) || !OWNER_ID.test(binding.tabId ?? "") ||
      !OWNER_ID.test(binding.accountId ?? "") || !path.isAbsolute(binding.cwd ?? "") || !path.isAbsolute(binding.policyDirectory ?? ""))
    throw new Error("Claude conversation policy belongs to a different or invalid execution. Start a new conversation.");
  policyMode(binding.policy);
  if (!SESSION_ID.test(payload?.session_id ?? "") || typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd))
    throw new Error("Claude did not provide a verifiable conversation identity before this prompt.");
  if (path.resolve(payload.cwd) !== path.resolve(binding.cwd)) throw new Error("Claude changed workspace inside this execution. Start a new conversation in that workspace before sending work.");
  const previous = json(path.join(configDir, NAVIGATION), 16_384);
  const source = event === "SessionStart" ? payload.source
    : previous?.executionId === executionId && previous.sessionId === payload.session_id ? previous.source : "unknown";
  const navigation = { version: 1, executionId, sessionId: payload.session_id, source: typeof source === "string" ? source : "unknown" };
  if (event === "SessionStart") writeNavigation(configDir, navigation);
  const recorded = readConversationPolicy(binding.policyDirectory, payload.session_id);
  let historical = false;
  if (recorded) assertConversationOwner(recorded, binding);
  else {
    const knownNew = ["startup", "clear"].includes(source) && !(binding.historical && binding.sessionId === payload.session_id);
    historical = !knownNew;
    if (historical && binding.policy.mode === "cloudx-managed")
      throw new Error("This historical Claude conversation has no verified launch policy. Resume it in a new Native project execution, or start a new CloudX-managed conversation. This prompt was blocked before model work.");
    if (!historical) bindConversationPolicy(binding.policyDirectory, payload.session_id, binding);
  }
  writeNavigation(configDir, { ...navigation, historical });
  return { historical };
}
