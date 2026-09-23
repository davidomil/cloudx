import path from "node:path";

/** Initialize launch permissions, then preserve the native TUI's runtime choices. */
export class CodexRemotePermissions {
  constructor(permissions) {
    if (typeof permissions.yoloMode !== "boolean" || !Array.isArray(permissions.additionalWritableRoots) ||
        !permissions.additionalWritableRoots.every(root => typeof root === "string" && path.isAbsolute(root)))
      throw new Error("Invalid Codex launch permissions.");
    this.permissions = permissions;
    this.initialized = false;
  }

  fromClient(message) {
    if (!["thread/start", "thread/resume", "thread/fork"].includes(message.method)) return;
    const params = message.params;
    if (!params || params.ephemeral === true || params.threadSource === "system") return;
    const { yoloMode, additionalWritableRoots } = this.permissions;
    if (message.method === "thread/start" && additionalWritableRoots.length && params.runtimeWorkspaceRoots == null)
      throw new Error("Native thread creation did not provide its resolved workspace roots.");
    if (additionalWritableRoots.length && params.runtimeWorkspaceRoots != null) {
      if (!Array.isArray(params.runtimeWorkspaceRoots) || !params.runtimeWorkspaceRoots.every(root => typeof root === "string" && path.isAbsolute(root)))
        throw new Error("Native thread workspace roots are invalid.");
      params.runtimeWorkspaceRoots = [...new Set([...params.runtimeWorkspaceRoots, ...additionalWritableRoots])];
    }
    if (!this.initialized && message.method === "thread/start" && yoloMode) {
      params.approvalPolicy = "never";
      params.sandbox = "danger-full-access";
      params.permissions = null;
    }
    this.initialized = true;
  }
}
