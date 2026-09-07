export class WorkspaceWindowNotFoundError extends Error {
  readonly code = "WORKSPACE_WINDOW_NOT_FOUND";
  readonly statusCode = 404;

  constructor(windowId: string) {
    super(`Unknown workspace window: ${windowId}`);
    this.name = "WorkspaceWindowNotFoundError";
  }
}

export class WorkspacePaneConflictError extends Error {
  readonly code = "WORKSPACE_PANE_CONFLICT";
  readonly statusCode = 409;

  constructor(windowId: string, paneId: string) {
    super(`Workspace pane ${paneId} is not available in window ${windowId}.`);
    this.name = "WorkspacePaneConflictError";
  }
}

export class WorkspaceWindowConflictError extends Error {
  readonly code = "WORKSPACE_WINDOW_CONFLICT";
  readonly statusCode = 409;

  constructor(windowId: string) {
    super(`Workspace window ${windowId} changed while the command was running.`);
    this.name = "WorkspaceWindowConflictError";
  }
}
