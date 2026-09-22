import path from "node:path";

/** Apply CloudX launch permissions to the native backend without remote TUI CLI overrides. */
export function applyLaunchPermissions(message, permissions) {
  if (!permissions) return;
  if (typeof permissions.yoloMode !== "boolean" || !Array.isArray(permissions.additionalWritableRoots) ||
      !permissions.additionalWritableRoots.every(root => typeof root === "string" && path.isAbsolute(root)))
    throw new Error("Invalid Codex launch permissions.");
  if (!["thread/start", "thread/resume", "thread/fork"].includes(message.method)) return;
  const params = message.params;
  if (!params || params.ephemeral === true || params.threadSource === "system") return;
  if (message.method === "thread/start" && permissions.additionalWritableRoots.length && params.runtimeWorkspaceRoots == null)
    throw new Error("Native thread creation did not provide its resolved workspace roots.");
  if (permissions.additionalWritableRoots.length && params.runtimeWorkspaceRoots != null) {
    if (!Array.isArray(params.runtimeWorkspaceRoots) || !params.runtimeWorkspaceRoots.every(root => typeof root === "string" && path.isAbsolute(root)))
      throw new Error("Native thread workspace roots are invalid.");
    params.runtimeWorkspaceRoots = [...new Set([...params.runtimeWorkspaceRoots, ...permissions.additionalWritableRoots])];
  }
  if (message.method === "thread/start" && permissions.yoloMode) {
    params.approvalPolicy = "never";
    params.sandbox = "danger-full-access";
    params.permissions = null;
  }
}
