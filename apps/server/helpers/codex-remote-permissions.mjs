import path from "node:path";

const MAX_PENDING_REQUESTS = 32;

/** Retain launch permissions across /new until native policy or saved-thread selection replaces them. */
export class CodexRemotePermissions {
  constructor(permissions) {
    if (typeof permissions.yoloMode !== "boolean" || !Array.isArray(permissions.additionalWritableRoots) ||
        !permissions.additionalWritableRoots.every(root => typeof root === "string" && path.isAbsolute(root)))
      throw new Error("Invalid Codex launch permissions.");
    this.permissions = permissions;
    this.launchPolicyActive = permissions.yoloMode;
    this.selectedThreadId = undefined;
    this.pending = new Map();
  }

  fromClient(message) {
    if (message.method === "thread/settings/update") {
      const params = message.params;
      if (this.launchPolicyActive && this.selectedThreadId && params?.threadId === this.selectedThreadId &&
          ["approvalPolicy", "approvalsReviewer", "sandboxPolicy", "permissions"].some(key => params[key] != null))
        this.track(message, { method: message.method, threadId: params.threadId });
      return;
    }
    if (!["thread/start", "thread/resume", "thread/fork"].includes(message.method)) return;
    const params = message.params;
    if (!params || params.ephemeral === true || params.threadSource === "system") return;
    const { additionalWritableRoots } = this.permissions;
    if (message.method === "thread/start" && additionalWritableRoots.length && params.runtimeWorkspaceRoots == null)
      throw new Error("Native thread creation did not provide its resolved workspace roots.");
    if (additionalWritableRoots.length && params.runtimeWorkspaceRoots != null) {
      if (!Array.isArray(params.runtimeWorkspaceRoots) || !params.runtimeWorkspaceRoots.every(root => typeof root === "string" && path.isAbsolute(root)))
        throw new Error("Native thread workspace roots are invalid.");
      params.runtimeWorkspaceRoots = [...new Set([...params.runtimeWorkspaceRoots, ...additionalWritableRoots])];
    }
    if (!this.launchPolicyActive) return;
    this.track(message, { method: message.method });
    if (message.method === "thread/start") {
      params.approvalPolicy = "never";
      params.sandbox = "danger-full-access";
      params.permissions = null;
    }
  }

  fromServer(message) {
    if (message.method) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (message.error) return;
    if (request.method === "thread/start") {
      const threadId = message.result?.thread?.id;
      if (typeof threadId !== "string" || !threadId) throw new Error("Native permission selection returned no thread identity.");
      this.selectedThreadId = threadId;
    } else if (request.method !== "thread/settings/update" || request.threadId === this.selectedThreadId) {
      this.launchPolicyActive = false;
      this.pending.clear();
    }
  }

  track(message, request) {
    if (message.id == null) throw new Error("Native permission request is missing its identity.");
    if (this.pending.has(message.id)) throw new Error("Native permission request reused a pending identity.");
    if (this.pending.size >= MAX_PENDING_REQUESTS) throw new Error("Native permission requests exceeded their pending limit.");
    this.pending.set(message.id, request);
  }
}
