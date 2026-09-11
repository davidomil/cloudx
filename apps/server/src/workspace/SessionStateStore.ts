import { isCompleteWorkspaceTab, isRecord, type WorkspaceTab } from "@cloudx/shared";

import { JsonStateFile } from "../jsonStateFile.js";

export interface SavedSession {
  tab: WorkspaceTab;
  initialInput?: Record<string, unknown>;
}

export interface SavedSessions {
  version: 1;
  activeTabId?: string;
  sessions: SavedSession[];
}

export class SessionStateStore {
  private readonly file: JsonStateFile;
  private pendingWrite = Promise.resolve();
  private writeError: unknown;

  constructor(dataDir: string) {
    this.file = new JsonStateFile(dataDir, "sessions.json", "Open tab sessions", 0o600);
  }

  async read(): Promise<SavedSessions | undefined> {
    const value = await this.file.read<unknown>();
    if (value === undefined) return undefined;
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions) || !value.sessions.every(isSavedSession)) {
      throw new Error("Open tab sessions file is invalid; expected version 1.");
    }
    const ids = value.sessions.map(session => session.tab.id);
    if (new Set(ids).size !== ids.length || (value.activeTabId !== undefined && !ids.includes(value.activeTabId as string))) {
      throw new Error("Open tab sessions contain duplicate or unknown active tab IDs.");
    }
    return value as unknown as SavedSessions;
  }

  save(state: SavedSessions): Promise<void> {
    const snapshot = structuredClone(state);
    const write = this.pendingWrite.then(() => this.file.write(snapshot));
    this.pendingWrite = write.then(() => { this.writeError = undefined; }, error => { this.writeError = error; });
    return write;
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
    if (this.writeError !== undefined) throw this.writeError;
  }
}

function isSavedSession(value: unknown): value is SavedSession {
  return isRecord(value) && isCompleteWorkspaceTab(value.tab) &&
    /^[a-zA-Z0-9_-]+$/.test(value.tab.id) && value.tab.ownerPluginId === undefined &&
    (value.initialInput === undefined || isRecord(value.initialInput));
}
