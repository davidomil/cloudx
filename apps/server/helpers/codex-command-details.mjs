import { constants } from "node:fs";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

// Keep these bounds aligned with the shared, browser-safe snapshot parser.
export const MAX_COMMANDS = 20;
export const MAX_COMMAND_BYTES = 128 * 1024;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_ID_CHARS = 1024;
const MAX_HISTORY_REQUESTS = 32;
// Native unified exec retains a 1 MiB head/tail aggregate, even when deltas contain more.
const NATIVE_AGGREGATE_BYTES = 1024 * 1024;

/** Observes command items without interpreting terminal rows or changing native messages. */
export class CodexCommandDetailsCapture {
  constructor(binding, save, { debounceMs = 100, onError = () => {} } = {}) {
    this.binding = binding;
    this.save = save;
    this.debounceMs = debounceMs;
    this.onError = onError;
    this.commands = [];
    this.resumeRequests = new Set();
    this.historyRequests = new Map();
    this.dirty = false;
    this.writing = undefined;
    this.timer = undefined;
    this.unavailable = false;
    this.reportedError = false;
    this.changed();
  }

  fromClient(message) {
    this.observe(() => {
      if (!["thread/resume", "thread/fork", "thread/items/list"].includes(message.method) || message.id == null) return;
      if (this.resumeRequests.size + this.historyRequests.size >= MAX_HISTORY_REQUESTS)
        throw new Error("Command history request limit exceeded.");
      if (message.method !== "thread/items/list") { this.resumeRequests.add(message.id); return; }
      const params = message.params;
      if (!identity(params?.threadId) || params.turnId != null && !identity(params.turnId) ||
          params.sortDirection != null && !["asc", "desc"].includes(params.sortDirection))
        throw new Error("Invalid native command history request.");
      this.historyRequests.set(message.id, { threadId: params.threadId, turnId: params.turnId, descending: params.sortDirection === "desc" });
    });
  }

  fromServer(message) {
    this.observe(() => {
      const history = !message.method && this.historyRequests.get(message.id);
      if (history) {
        this.historyRequests.delete(message.id);
        if (message.error) return;
        const entries = message.result?.data;
        if (!Array.isArray(entries)) throw new Error("Invalid native command history page.");
        for (const entry of entries) {
          if (entry?.item?.type !== "commandExecution") continue;
          if (history.turnId != null && entry.turnId !== history.turnId)
            throw new Error("Native command history belongs to a different turn.");
          this.commandItem(history.threadId, entry.turnId, entry.item, history.descending);
        }
        return;
      }
      if (!message.method && this.resumeRequests.delete(message.id)) {
        if (message.error) return;
        const thread = message.result?.thread;
        if (!identity(thread?.id) || !Array.isArray(thread.turns)) return;
        for (const turn of thread.turns)
          for (const item of turn.items ?? []) this.commandItem(thread.id, turn.id, item);
        return;
      }
      if (message.id != null) return;
      const params = message.params;
      if (["item/started", "item/completed"].includes(message.method)) {
        this.commandItem(params?.threadId, params?.turnId, params?.item);
      } else if (message.method === "item/commandExecution/outputDelta") {
        if (!identity(params?.threadId) || !identity(params?.turnId) || !identity(params?.itemId) || typeof params?.delta !== "string")
          throw new Error("Invalid native command output identity.");
        const command = this.find(params.threadId, params.turnId, params.itemId);
        // Deltas for an unknown or already completed item cannot establish a command's identity.
        if (!command || command.status !== "inProgress" || command.outputTruncated) return;
        const output = boundedText(command.output + params.delta, MAX_OUTPUT_BYTES);
        command.output = output.text;
        command.outputTruncated ||= output.truncated;
        this.retainRecent();
        this.changed();
      }
    });
  }

  commandItem(threadId, turnId, item, prepend = false) {
    if (item?.type !== "commandExecution") return;
    if (!identity(threadId) || !identity(turnId) || !identity(item.id) || typeof item.command !== "string" ||
        typeof item.cwd !== "string" || !item.cwd || item.cwd.length > 16_384 ||
        !["inProgress", "completed", "failed", "declined"].includes(item.status) ||
        item.aggregatedOutput != null && typeof item.aggregatedOutput !== "string" ||
        item.exitCode != null && !Number.isSafeInteger(item.exitCode))
      throw new Error("Invalid native command details item.");
    let command = this.find(threadId, turnId, item.id);
    if (!command) {
      command = { threadId, turnId, id: item.id, output: "", outputTruncated: false };
      if (prepend) this.commands.unshift(command);
      else this.commands.push(command);
    }
    const text = boundedText(item.command, MAX_COMMAND_BYTES);
    Object.assign(command, { command: text.text, commandTruncated: text.truncated, cwd: item.cwd, status: item.status });
    if (typeof item.aggregatedOutput === "string") {
      const output = boundedText(item.aggregatedOutput, MAX_OUTPUT_BYTES);
      const aggregateBytes = Buffer.byteLength(item.aggregatedOutput);
      const moreStreamedOutput = aggregateBytes >= NATIVE_AGGREGATE_BYTES && Buffer.byteLength(command.output) > aggregateBytes;
      const nativeOmission = aggregateBytes >= NATIVE_AGGREGATE_BYTES && /\n\.\.\. [1-9]\d* bytes omitted \.\.\.\n/.test(item.aggregatedOutput);
      if (!moreStreamedOutput) {
        command.output = output.text;
        command.outputTruncated = output.truncated || nativeOmission;
      }
    }
    if (item.exitCode != null) command.exitCode = item.exitCode;
    this.retainRecent();
    this.changed();
  }

  find(threadId, turnId, id) {
    return this.commands.find(command => command.threadId === threadId && command.turnId === turnId && command.id === id);
  }

  retainRecent() {
    let total = this.commands.reduce((bytes, command) => bytes + Buffer.byteLength(command.command) + Buffer.byteLength(command.output), 0);
    while (this.commands.length > MAX_COMMANDS || total > MAX_TOTAL_BYTES) {
      const removed = this.commands.shift();
      total -= Buffer.byteLength(removed.command) + Buffer.byteLength(removed.output);
    }
  }

  snapshot() {
    return {
      version: 1, tabId: this.binding.tabId, executionId: this.binding.executionId,
      status: this.unavailable ? "unavailable" : "available",
      commands: this.commands.map(command => ({ ...command })),
      ...(this.unavailable ? { reason: "Native command details could not be captured." } : {})
    };
  }

  observe(operation) {
    if (this.unavailable) return;
    try { operation(); }
    catch (error) {
      this.unavailable = true;
      this.commands = [];
      this.resumeRequests.clear();
      this.historyRequests.clear();
      this.report(error);
      this.changed();
    }
  }

  report(error) {
    if (this.reportedError) return;
    this.reportedError = true;
    try { this.onError(error); } catch { /* Diagnostics cannot interrupt native protocol forwarding. */ }
  }

  changed() {
    this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.debounceMs);
  }

  async flush() {
    if (this.writing) { await this.writing; return this.flush(); }
    if (!this.dirty) return;
    this.dirty = false;
    const value = this.snapshot();
    this.writing = Promise.resolve().then(() => this.save(value)).catch(error => this.report(error));
    await this.writing;
    this.writing = undefined;
  }

  async close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
    if (this.dirty) await this.close();
  }
}

function identity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;
}

function boundedText(value, limit) {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return { text: value, truncated: false };
  let end = limit;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** Async atomic replacement keeps storage work out of the native forwarding path. */
export async function saveCommandDetails(receiptPath, value) {
  const temporary = `${receiptPath}.${randomBytes(8).toString("hex")}.tmp`;
  let file;
  try {
    file = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    file = undefined;
    await fs.rename(temporary, receiptPath);
  } finally {
    await file?.close();
    await fs.rm(temporary, { force: true });
  }
}
