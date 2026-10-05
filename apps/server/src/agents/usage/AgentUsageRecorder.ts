import { FORGE_WORKER_METADATA_KEY, isRecord, type AgentProviderId, type WorkspaceTab } from "@cloudx/shared";

import type { AgentAccountStore } from "../AgentAccountStore.js";
import type { AgentUsageLedger } from "./AgentUsageLedger.js";

// Turns agent terminal events into ledger segments. Recording never blocks or
// fails a session; errors go to the reporter.
export class AgentUsageRecorder {
  constructor(
    private readonly ledger: Pick<AgentUsageLedger, "open" | "close">,
    private readonly accounts: Pick<AgentAccountStore, "list">,
    private readonly report: (error: unknown) => void = () => undefined
  ) {}

  conversationStarted(tab: WorkspaceTab, providerId: AgentProviderId, accountId: string | undefined, sessionId: string): void {
    void (async () => {
      const account = accountId ? (await this.accounts.list()).find(entry => entry.id === accountId) : undefined;
      await this.ledger.open(
        { tabId: tab.id, ...forgeOwner(tab) },
        { providerId, sessionId, accountKind: account?.kind ?? "subscription" }
      );
    })().catch(this.report);
  }

  ended(tabId: string): void {
    this.ledger.close(tabId).catch(this.report);
  }
}

function forgeOwner(tab: WorkspaceTab): { forgeWorkerId?: string } {
  const metadata = tab.pluginMetadata?.[FORGE_WORKER_METADATA_KEY];
  return isRecord(metadata) && typeof metadata.workerId === "string" ? { forgeWorkerId: metadata.workerId } : {};
}
