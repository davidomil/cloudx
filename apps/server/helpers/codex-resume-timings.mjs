const MAX_EVENTS = 256;
const MAX_PENDING = 32;

/** Numeric, bounded measurements; never retain protocol payloads or identities. */
export class CodexResumeTimings {
  constructor(save, preparationMs = 0, now = () => performance.now()) {
    this.save = save;
    this.now = now;
    this.started = now();
    this.pending = new Map();
    this.events = 0;
    this.backendPages = 0;
    this.record("launch_prepared", { durationMs: Number.isFinite(preparationMs) ? Math.max(0, Math.round(preparationMs)) : 0 });
  }

  record(event, values = {}) {
    if (this.events++ >= MAX_EVENTS) return;
    this.save(`CloudX resume timing ${JSON.stringify({ event, elapsedMs: Math.max(0, Math.round(this.now() - this.started)), ...values })}\n`);
  }

  fromClient(message) {
    if (message.method === "initialize") {
      this.initialization = { id: message.id, started: this.now() };
      this.record("native_initializing");
    }
    if (message.method !== "thread/list" || message.id == null || this.pending.size >= MAX_PENDING) return;
    if (!this.listStarted) {
      this.listStarted = true;
      this.record("first_list_requested");
    }
    this.pending.set(message.id, { started: this.now(), pages: 0, indexed: message.params?.useStateDbOnly === true });
  }

  fromServer(message, delivered = true) {
    if (message.method) return;
    if (this.initialization?.id === message.id) {
      this.record("native_initialized", { durationMs: Math.round(this.now() - this.initialization.started), failed: Boolean(message.error) });
      this.initialization = undefined;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    request.pages++;
    this.backendPages++;
    const rows = delivered && Array.isArray(message.result?.data) ? message.result.data.length : 0;
    this.record("list_page", { backendPages: this.backendPages, requestPages: request.pages,
      durationMs: Math.round(this.now() - request.started), rows, indexed: request.indexed, delivered, failed: Boolean(message.error) });
    if (rows && !this.usable) {
      this.usable = true;
      this.record("first_usable_rows", { backendPages: this.backendPages, rows });
    }
    if (delivered) this.pending.delete(message.id);
  }

  disconnected() {
    this.record("client_disconnected", { pendingLists: this.pending.size });
    this.pending.clear();
  }
}
