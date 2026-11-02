import { FORGE_WORKER_METADATA_KEY, isRecord, type AgentProviderId, type WorkspaceTab } from "@cloudx/shared";

import type { AgentAccountStore } from "../AgentAccountStore.js";
import type { AgentUsageLedger } from "./AgentUsageLedger.js";

// Turns agent terminal events into ledger segments. Recording never blocks or
// fails a session; errors go to the reporter.
export class AgentUsageRecorder {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly ledger: Pick<AgentUsageLedger, "open" | "close">,
    private readonly accounts: Pick<AgentAccountStore, "list">,
    private readonly report: (error: unknown) => void = () => undefined,
    private readonly conversationWindow: (tabId: string, launchWindow?: string) => string | undefined = (_tabId, launchWindow) => launchWindow
  ) {}

  conversationStarted(tab: WorkspaceTab, providerId: AgentProviderId, accountId: string | undefined, sessionId: string, launchWindow?: string): void {
    const windowId = this.conversationWindow(tab.id, launchWindow);
    this.pending = this.pending.then(async () => {
      const account = accountId ? (await this.accounts.list()).find(entry => entry.id === accountId) : undefined;
      await this.ledger.open(
        { tabId: tab.id, ...(windowId ? { windowId } : {}), ...forgeOwner(tab) },
        { providerId, sessionId, accountKind: account?.kind ?? "subscription" }
      );
    }).catch(this.report);
  }

  ended(tabId: string): void {
    this.pending = this.pending.then(() => this.ledger.close(tabId)).catch(this.report);
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}

function forgeOwner(tab: WorkspaceTab): { forgeWorkerId?: string } {
  const metadata = tab.pluginMetadata?.[FORGE_WORKER_METADATA_KEY];
  return isRecord(metadata) && typeof metadata.workerId === "string" ? { forgeWorkerId: metadata.workerId } : {};
}
