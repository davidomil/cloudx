import path from "node:path";

const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const MAX_PENDING_SELECTIONS = 32;

/** The native TUI's successful foreground selection replies are the identity authority. */
export class CodexConversationSelection {
  constructor(binding, save) {
    if (!binding || typeof binding.tabId !== "string" || !binding.tabId ||
        !CONVERSATION_ID.test(binding.executionId) || !path.isAbsolute(binding.receiptPath))
      throw new Error("Invalid Codex conversation execution binding.");
    this.binding = binding;
    this.save = save;
    this.pending = new Set();
  }

  fromClient(message) {
    if (!["thread/start", "thread/resume", "thread/fork"].includes(message.method)) return;
    if (message.params?.ephemeral === true || message.params?.threadSource === "system") return;
    if (message.id == null) throw new Error("Native conversation selection is missing its request identity.");
    if (this.pending.has(message.id)) throw new Error("Native conversation selection reused a pending request identity.");
    if (this.pending.size >= MAX_PENDING_SELECTIONS) throw new Error("Native conversation selection exceeded its pending request limit.");
    this.pending.add(message.id);
  }

  fromServer(message) {
    if (message.method || !this.pending.delete(message.id) || message.error) return;
    const thread = message.result?.thread;
    if (!thread || typeof thread.id !== "string" || !CONVERSATION_ID.test(thread.id) ||
        typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd) || thread.ephemeral === true ||
        thread.path != null && (typeof thread.path !== "string" || !path.isAbsolute(thread.path)))
      throw new Error("Native conversation selection returned an invalid thread identity.");
    this.save({
      version: 2, authority: "selected", tabId: this.binding.tabId, executionId: this.binding.executionId,
      sessionId: thread.id, cwd: thread.cwd,
      ...(typeof thread.path === "string" ? { transcriptPath: thread.path } : {})
    });
  }
}
