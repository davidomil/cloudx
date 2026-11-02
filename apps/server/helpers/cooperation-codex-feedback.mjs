import { randomUUID } from "node:crypto";

/** Injects RPCs through the original broker; the native composer is untouched. */
export class CodexCooperationFeedback {
  constructor(options) {
    this.options = options;
    this.pending = new Map();
    this.modals = new Set();
    this.turnId = undefined;
    this.initializing = new Set();
    this.initialized = false;
  }

  fromClient(message) {
    if (message.method === "initialize") this.initializing.add(message.id);
    if (!message.method && message.id != null) this.modals.delete(message.id);
  }

  fromServer(message) {
    if (!message.method && this.initializing.delete(message.id)) {
      this.initialized = !message.error;
      this.options.boundary?.();
    }
    if (message.method && message.id != null) this.modals.add(message.id);
    if (message.params?.threadId === this.options.threadId()) {
      if (message.method === "turn/started") {
        this.turnId = message.params.turn?.id;
        this.options.turn?.({ providerTurnId: this.turnId, status: "running" });
      }
      if (message.method === "turn/completed" && message.params.turn?.id === this.turnId) {
        this.options.turn?.({ providerTurnId: this.turnId, status: message.params.turn?.status });
        this.turnId = undefined;
        this.options.boundary?.();
      }
    }
    const pending = !message.method ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.resolve({ state: "unavailable", reason: message.error.message ?? "Native Codex refused the feedback." });
    else {
      const turnId = message.result?.turn?.id ?? message.result?.turnId;
      pending.resolve(typeof turnId === "string" ? { state: "nativeAccepted", providerTurnId: turnId }
        : { state: "unknown", reason: "Native Codex accepted a request without a turn identity." });
    }
    return false;
  }

  async deliver(envelope) {
    const threadId = this.options.threadId();
    if (!this.initialized || !threadId || !this.options.connected()) return { state: "queued", reason: "The original Codex conversation is still connecting." };
    if (this.modals.size) return { state: "queued", reason: "Codex is waiting for an approval or user answer." };
    if (this.options.owned && !this.turnId) return { state: "queued", reason: "ownerContinuationRequired" };
    if (this.turnId && !envelope.immediate) return { state: "queued", reason: "Codex is working; feedback waits for the next turn boundary." };
    const id = `cloudx-cooperation:${randomUUID()}`;
    const input = [
      { type: "text", text: `$cooperation-board $cooperation-feedback\n${envelope.text}` },
      ...(this.options.skills ?? []).map(skill => ({ type: "skill", ...skill }))
    ];
    const message = this.turnId
      ? { id, method: "turn/steer", params: { threadId, expectedTurnId: this.turnId, input } }
      : { id, method: "turn/start", params: { threadId, input } };
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ state: "unknown", reason: "The original Codex owner did not return a feedback receipt." });
      }, 5000);
      this.pending.set(id, { resolve, timer });
      try { this.options.send(message); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); resolve({ state: "unavailable", reason: error.message }); }
    });
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ state: "unknown", reason: "The original Codex owner disconnected during feedback delivery." });
    }
    this.pending.clear();
  }
}
