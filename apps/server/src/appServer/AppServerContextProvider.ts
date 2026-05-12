import type { SessionStore } from "../sessionStore.js";
import type { AppServerClient } from "./AppServerClient.js";

export interface VoiceContextProvider {
  context(activeTabId?: string): Promise<Record<string, unknown>>;
}

export class AppServerContextProvider implements VoiceContextProvider {
  private appServer: AppServerClient | undefined;

  constructor(
    private readonly sessions: SessionStore,
    private readonly appServerFactory: (() => AppServerClient | undefined) | undefined
  ) {}

  async context(activeTabId?: string): Promise<Record<string, unknown>> {
    const workspace = await this.sessions.buildVoiceContext(activeTabId);
    this.appServer ??= this.appServerFactory?.();
    if (!this.appServer) {
      return { workspace, appServer: { enabled: false } };
    }

    const activeTab = activeTabId ? this.sessions.getTab(activeTabId) : undefined;
    try {
      const appServer = await this.appServer.readVoiceContext(activeTab?.cwd);
      return { workspace, appServer: { enabled: true, ...appServer } };
    } catch (error) {
      return {
        workspace,
        appServer: {
          enabled: true,
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }
}
