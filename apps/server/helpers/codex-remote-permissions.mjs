import path from "node:path";

const MAX_PENDING_REQUESTS = 32;
const SANDBOX_MODES = { dangerFullAccess: "danger-full-access", workspaceWrite: "workspace-write", readOnly: "read-only" };

/** Retain launch permissions across /new until native policy or saved-thread selection replaces them. */
export class CodexRemotePermissions {
  constructor(permissions) {
    if (typeof permissions.yoloMode !== "boolean" || !Array.isArray(permissions.additionalWritableRoots) ||
        !permissions.additionalWritableRoots.every(root => typeof root === "string" && path.isAbsolute(root)))
      throw new Error("Invalid Codex launch permissions.");
    this.permissions = permissions;
    this.launchPolicyActive = permissions.yoloMode;
    this.selectedThreadId = undefined;
    this.selectedProfile = undefined;
    this.pending = new Map();
  }

  fromClient(message) {
    if (message.method === "turn/start") {
      const params = message.params;
      const profile = this.selectedProfile;
      // Native resume restores profile identity, not legacy sandbox projections.
      // Apply it after the server has resolved roots so configured roots survive.
      if (params?.threadId === this.selectedThreadId && profile && params.permissions == null && params.sandboxPolicy == null) {
        params.permissions = profile.id;
        params.sandboxPolicy = null;
      }
      return;
    }
    if (message.method === "thread/settings/update") {
      const params = message.params;
      if (this.selectedThreadId && params?.threadId === this.selectedThreadId &&
          ["approvalPolicy", "approvalsReviewer", "sandboxPolicy", "permissions"].some(key => params[key] != null))
        this.track(message, { method: message.method, threadId: params.threadId });
      return;
    }
    if (!["thread/start", "thread/resume", "thread/fork"].includes(message.method)) return;
    const params = message.params;
    if (!params || params.ephemeral === true || params.threadSource === "system") return;
    const { additionalWritableRoots } = this.permissions;
    if (additionalWritableRoots.length && params.runtimeWorkspaceRoots != null) {
      params.runtimeWorkspaceRoots = this.withAdditionalRoots(params.runtimeWorkspaceRoots);
    }
    const resolveRoots = additionalWritableRoots.length > 0 && params.runtimeWorkspaceRoots == null;
    if (this.launchPolicyActive || resolveRoots || this.selectedProfile) {
      const profile = message.method === "thread/start" ? this.profileForNewThread(params) : undefined;
      this.track(message, { method: message.method, resolveRoots, profile });
    }
    if (this.launchPolicyActive && message.method === "thread/start") {
      params.approvalPolicy = "never";
      params.sandbox = "danger-full-access";
      params.permissions = null;
    }
  }

  fromServer(message) {
    if (message.method === "thread/settings/updated" && message.params?.threadId === this.selectedThreadId) {
      const settings = message.params.threadSettings;
      const id = settings?.activePermissionProfile?.id;
      this.selectedProfile = typeof id === "string" && id ? { id, sandbox: settings.sandboxPolicy?.type } : undefined;
    }
    if (message.method) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (message.error) return;
    // Remote clients delegate root selection to the backend. Extend its resolved
    // roots for the TUI, which submits them on turn/start before any model work.
    if (request.resolveRoots)
      message.result.runtimeWorkspaceRoots = this.withAdditionalRoots(message.result?.runtimeWorkspaceRoots);
    if (request.method !== "thread/settings/update") {
      const threadId = message.result?.thread?.id;
      if (typeof threadId !== "string" || !threadId) throw new Error("Native permission selection returned no thread identity.");
      this.selectedThreadId = threadId;
      const id = message.result.activePermissionProfile?.id;
      this.selectedProfile = typeof id === "string" && id
        ? { id, sandbox: message.result.sandbox?.type } : request.profile;
    }
    if (request.method !== "thread/start" && (request.method !== "thread/settings/update" || request.threadId === this.selectedThreadId)) {
      this.launchPolicyActive = false;
    }
  }

  profileForNewThread(params) {
    if (this.launchPolicyActive) return { id: ":danger-full-access", sandbox: "dangerFullAccess" };
    if (params.permissions != null || params.sandbox != null && params.sandbox !== SANDBOX_MODES[this.selectedProfile?.sandbox]) return;
    return this.selectedProfile;
  }

  withAdditionalRoots(roots) {
    if (!Array.isArray(roots) || !roots.every(root => typeof root === "string" && path.isAbsolute(root)))
      throw new Error("Native thread workspace roots are invalid.");
    return [...new Set([...roots, ...this.permissions.additionalWritableRoots])];
  }

  track(message, request) {
    if (message.id == null) throw new Error("Native permission request is missing its identity.");
    if (this.pending.has(message.id)) throw new Error("Native permission request reused a pending identity.");
    if (this.pending.size >= MAX_PENDING_REQUESTS) throw new Error("Native permission requests exceeded their pending limit.");
    this.pending.set(message.id, request);
  }
}
