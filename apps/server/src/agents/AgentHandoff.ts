import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { agentProviderLabel, isRecord, type AgentProviderId } from "@cloudx/shared";

export interface AgentTranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
}

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const MAX_ENTRY_CHARS = 6_000;
const MAX_TOOL_CHARS = 240;
const HANDOFF_CONVERSATION_BUDGET = 80_000;
const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_BYTES = 32 * 1024;
// Codex injects these into user turns; they are context, not user requests.
const CODEX_CONTEXT_PREFIXES = ["<environment_context>", "<user_instructions>", "<permissions instructions>", "# AGENTS.md", "<turn_aborted>"];

// Reads a provider transcript into plain conversation entries. Reasoning,
// token accounting and tool output are left out; tool calls are kept as one
// line each so the next runner sees what was done.
export async function readAgentTranscript(providerId: AgentProviderId, transcriptPath: string): Promise<AgentTranscriptEntry[]> {
  const stat = await fs.lstat(transcriptPath);
  if (!stat.isFile()) throw new Error("The conversation transcript is not a regular file.");
  if (stat.size > MAX_TRANSCRIPT_BYTES) throw new Error("The conversation transcript is too large to hand off.");
  const entries: AgentTranscriptEntry[] = [];
  const lines = readline.createInterface({ input: createReadStream(transcriptPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim() || line.length > MAX_LINE_CHARS) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    entries.push(...(providerId === "claude" ? claudeEntries(record) : codexEntries(record)));
  }
  return entries;
}

function claudeEntries(record: unknown): AgentTranscriptEntry[] {
  if (!isRecord(record) || (record.type !== "user" && record.type !== "assistant") || record.isMeta === true || !isRecord(record.message)) return [];
  const role = record.type;
  const content = record.message.content;
  if (typeof content === "string") return textEntry(role, content);
  if (!Array.isArray(content)) return [];
  const entries: AgentTranscriptEntry[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") entries.push(...textEntry(role, block.text));
    else if (block.type === "tool_use" && typeof block.name === "string") entries.push(toolEntry(block.name, block.input));
  }
  return entries;
}

function codexEntries(record: unknown): AgentTranscriptEntry[] {
  if (!isRecord(record) || record.type !== "response_item" || !isRecord(record.payload)) return [];
  const payload = record.payload;
  if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant") && Array.isArray(payload.content)) {
    const role = payload.role;
    return payload.content.flatMap(block => {
      if (!isRecord(block) || typeof block.text !== "string") return [];
      if (role === "user" && CODEX_CONTEXT_PREFIXES.some(prefix => (block.text as string).trimStart().startsWith(prefix))) return [];
      return textEntry(role, block.text);
    });
  }
  if ((payload.type === "function_call" || payload.type === "custom_tool_call") && typeof payload.name === "string")
    return [toolEntry(payload.name, payload.arguments ?? payload.input)];
  return [];
}

function textEntry(role: "user" | "assistant", text: string): AgentTranscriptEntry[] {
  const trimmed = text.trim();
  if (!trimmed || /^<(command-name|local-command-stdout|local-command-caveat|system-reminder)>/u.test(trimmed)) return [];
  return [{ role, text: truncate(trimmed, MAX_ENTRY_CHARS) }];
}

function toolEntry(name: string, input: unknown): AgentTranscriptEntry {
  let detail = "";
  if (isRecord(input)) {
    const preferred = input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description;
    detail = typeof preferred === "string" ? preferred : JSON.stringify(input);
  } else if (typeof input === "string") {
    detail = input;
  }
  return { role: "tool", text: truncate(`${name}: ${detail.replace(/\s+/gu, " ").trim()}`, MAX_TOOL_CHARS) };
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)} …[truncated]` : value;
}

export interface AgentHandoffInput {
  cwd: string;
  from: { providerId: AgentProviderId; accountLabel?: string; sessionId?: string };
  to: { providerId: AgentProviderId; accountLabel: string };
  entries: AgentTranscriptEntry[];
  now?: Date;
}

export interface AgentHandoff {
  path: string;
  prompt: string;
}

// Writes the handoff under <cwd>/.cloudx/handoffs and returns the prompt that
// starts the next runner. The file stays for the user to inspect.
export async function writeAgentHandoff(input: AgentHandoffInput): Promise<AgentHandoff> {
  const now = input.now ?? new Date();
  const directory = path.join(input.cwd, ".cloudx", "handoffs");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  const filePath = path.join(directory, `${stamp}-${input.from.providerId}-to-${input.to.providerId}.md`);
  const [status, diffStat] = await Promise.all([
    gitOutput(input.cwd, ["status", "--short", "--untracked-files=normal"]),
    gitOutput(input.cwd, ["diff", "--stat", "HEAD"])
  ]);
  const fromLabel = agentProviderLabel(input.from.providerId);
  const lines = [
    `# CloudX handoff from ${fromLabel} to ${agentProviderLabel(input.to.providerId)}`,
    "",
    `- Created: ${now.toISOString()}`,
    `- Working directory: ${input.cwd}`,
    `- Previous runner: ${fromLabel}${input.from.accountLabel ? `, account ${input.from.accountLabel}` : ""}${input.from.sessionId ? `, session ${input.from.sessionId}` : ""}`,
    `- Next runner: ${agentProviderLabel(input.to.providerId)}, account ${input.to.accountLabel}`,
    "",
    "## Repository state",
    "",
    "```text",
    status === undefined ? "(git status unavailable)" : status.trim() || "(working tree clean)",
    "```",
    "",
    "```text",
    diffStat === undefined ? "(git diff unavailable)" : diffStat.trim() || "(no changes to tracked files)",
    "```",
    "",
    "## Conversation",
    "",
    "Earlier entries are omitted when the conversation exceeds the handoff size. Tool lines summarize calls; their output is not included.",
    "",
    ...formatConversation(input.entries)
  ];
  await fs.writeFile(filePath, `${lines.join("\n").trimEnd()}\n`, { mode: 0o600, flag: "wx" });
  const prompt = [
    `This conversation continues work started in a previous ${fromLabel} session in this directory.`,
    `Read the handoff file at ${filePath} for the earlier conversation and the repository state.`,
    "Summarize where the work stands in a few lines, then wait for my next instruction. Do not change files until I ask."
  ].join(" ");
  return { path: filePath, prompt };
}

function formatConversation(entries: AgentTranscriptEntry[]): string[] {
  const blocks: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    const block = entry.role === "tool" ? `- ${entry.text}` : `### ${entry.role === "user" ? "User" : "Assistant"}\n\n${entry.text}\n`;
    if (used + block.length > HANDOFF_CONVERSATION_BUDGET) {
      blocks.push(`_${index + 1} earlier entries omitted._\n`);
      break;
    }
    used += block.length;
    blocks.push(block);
  }
  if (!entries.length) blocks.push("_No conversation entries were recorded._");
  return blocks.reverse();
}

function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_BYTES, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => resolve(error ? undefined : stdout));
  });
}
