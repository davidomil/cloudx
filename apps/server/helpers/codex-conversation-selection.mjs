import path from "node:path";

const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const MAX_PENDING_SELECTIONS = 32;
const MAX_CACHED_SELECTIONS = 32;

/** Native foreground selections and history edits own the selected conversation receipt. */
export class CodexConversationSelection {
  constructor(binding, save) {
    if (!binding || typeof binding.tabId !== "string" || !binding.tabId ||
        !CONVERSATION_ID.test(binding.executionId) || !path.isAbsolute(binding.receiptPath))
      throw new Error("Invalid Codex conversation execution binding.");
    this.binding = binding;
    this.save = save;
    this.pending = new Map();
    this.selectedThreadId = undefined;
    this.subscribedSelections = new Set();
    this.unconfirmed = false;
  }

  fromClient(message) {
    if (this.unconfirmed) return;
    if (message.method === "thread/read") {
      if (message.params?.threadId !== this.selectedThreadId && this.subscribedSelections.has(message.params?.threadId))
        this.invalidate();
      return;
    }
    if (!["thread/start", "thread/resume", "thread/fork", "thread/revert", "thread/unsubscribe"].includes(message.method)) return;
    if (message.params?.ephemeral === true || message.params?.threadSource === "system") return;
    if (message.method === "thread/unsubscribe" && !this.subscribedSelections.has(message.params?.threadId)) return;
    const expectedThreadId = message.method === "thread/revert" ? message.params?.threadId : undefined;
    if (message.method === "thread/revert" && (!expectedThreadId || expectedThreadId !== this.selectedThreadId)) return;
    if (message.id == null) throw new Error("Native conversation selection is missing its request identity.");
    if (this.pending.has(message.id)) throw new Error("Native conversation selection reused a pending request identity.");
    if (this.pending.size >= MAX_PENDING_SELECTIONS) throw new Error("Native conversation selection exceeded its pending request limit.");
    this.pending.set(message.id, { expectedThreadId, unsubscribe: message.method === "thread/unsubscribe" ? message.params.threadId : undefined });
  }

  fromServer(message) {
    if (message.method) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (this.unconfirmed || message.error || request.expectedThreadId && request.expectedThreadId !== this.selectedThreadId) return;
    if (request.unsubscribe) {
      if (message.result?.status === "unsubscribed") this.subscribedSelections.delete(request.unsubscribe);
      return;
    }
    const thread = message.result?.thread;
    if (!thread || typeof thread.id !== "string" || !CONVERSATION_ID.test(thread.id) ||
        request.expectedThreadId && thread.id !== request.expectedThreadId ||
        typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd) || thread.ephemeral === true ||
        thread.path != null && (typeof thread.path !== "string" || !path.isAbsolute(thread.path)))
      throw new Error("Native conversation selection returned an invalid thread identity.");
    // Native can replay cached agents without another selection request. Once
    // that is possible, later turns or resumes cannot prove durable foreground
    // authority for this execution. A fresh launch can establish it again.
    const retainsAnotherSelection = [...this.subscribedSelections].some(id => id !== thread.id);
    if (retainsAnotherSelection && thread.source && typeof thread.source === "object" && "subAgent" in thread.source ||
        !this.subscribedSelections.has(thread.id) && this.subscribedSelections.size >= MAX_CACHED_SELECTIONS) {
      this.invalidate();
      return;
    }
    this.save({
      version: 2, authority: "selected", tabId: this.binding.tabId, executionId: this.binding.executionId,
      sessionId: thread.id, cwd: thread.cwd,
      ...(typeof thread.path === "string" ? { transcriptPath: thread.path } : {})
    });
    this.selectedThreadId = thread.id;
    this.subscribedSelections.add(thread.id);
  }

  invalidate() {
    this.unconfirmed = true;
    this.pending.clear();
    this.subscribedSelections.clear();
    this.save({
      version: 2, authority: "unconfirmed", reason: "cached-navigation",
      tabId: this.binding.tabId, executionId: this.binding.executionId
    });
  }
}
