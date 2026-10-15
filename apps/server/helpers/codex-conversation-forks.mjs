import path from "node:path";

const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const MAX_PENDING_FORKS = 32;
export const MAX_CONVERSATION_FORKS = 128;

/** A confirmed foreground fork belongs to a sibling tab, never its source selection. */
export class CodexConversationForks {
  constructor(binding, selection, save) {
    if (!binding || typeof binding.tabId !== "string" || !binding.tabId ||
        !CONVERSATION_ID.test(binding.executionId) || !path.isAbsolute(binding.receiptPath) ||
        !Array.isArray(binding.resumeArgs) || !binding.resumeArgs.every(argument => typeof argument === "string"))
      throw new Error("Invalid Codex conversation fork execution binding.");
    if (!selection || binding.tabId !== selection.binding.tabId || binding.executionId !== selection.binding.executionId)
      throw new Error("Codex conversation forks belong to a different tab or execution.");
    this.binding = binding;
    this.selection = selection;
    this.save = save;
    this.pending = new Map();
    this.forks = [];
  }

  fromClient(message) {
    if (message.method !== "thread/fork" || message.params?.ephemeral === true || message.params?.threadSource === "system") return false;
    if (message.id == null) throw new Error("Native conversation fork is missing its request identity.");
    if (this.selection.unconfirmed) return { error: { code: -32600,
      message: "Select a saved session before opening a fork in another CloudX tab." } };
    if (!this.selection.selectedThreadId) return false;
    if (this.pending.has(message.id))
      throw new Error("Native conversation fork has an invalid or reused request identity.");
    if (this.pending.size >= MAX_PENDING_FORKS || this.forks.length >= MAX_CONVERSATION_FORKS)
      throw new Error("Native conversation forks exceeded their limit.");
    this.pending.set(message.id, this.selection.selectedThreadId);
    return true;
  }

  fromServer(message) {
    if (message.method) return;
    const sourceId = this.pending.get(message.id);
    if (!sourceId) return;
    this.pending.delete(message.id);
    if (message.error) return;
    if (this.selection.unconfirmed || sourceId !== this.selection.selectedThreadId)
      throw new Error("Native conversation fork lost its source selection.");
    const thread = message.result?.thread;
    if (!thread || !CONVERSATION_ID.test(thread.id) || thread.id === sourceId ||
        typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd) || thread.ephemeral === true ||
        thread.path != null && (typeof thread.path !== "string" || !path.isAbsolute(thread.path)))
      throw new Error("Native conversation fork returned an invalid child identity.");
    if (this.forks.some(fork => fork.sessionId === thread.id)) return false;
    return { sourceId, sourceCwd: this.selection.selectedCwd, sessionId: thread.id, cwd: thread.cwd,
      ...(typeof thread.path === "string" ? { transcriptPath: thread.path } : {}) };
  }

  publish({ sourceId, sourceCwd, ...fork }) {
    if (this.forks.some(existing => existing.sessionId === fork.sessionId)) return;
    if (this.forks.length >= MAX_CONVERSATION_FORKS) throw new Error("Native conversation forks exceeded their limit.");
    const value = { version: 1, tabId: this.binding.tabId, executionId: this.binding.executionId, forks: [...this.forks, fork] };
    if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw new Error("Native conversation fork journal exceeds its size limit.");
    this.save(value);
    this.forks.push(fork);
  }
}
