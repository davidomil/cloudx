import { isAgentTab, type HardwareAgentReadiness } from "@cloudx/shared";
import type { AgentLaunchRecords } from "../agents/AgentLaunchRecords.js";
import type { SessionStore } from "../sessionStore.js";

const requiredKeys = ["CLOUDX_HARDWARE_CONTEXT", "CLOUDX_HARDWARE_HELPER"];

/** A newly written locator does not prove an already running process received its environment. */
export function hardwareAgentReadiness(sessions: Pick<SessionStore, "listTabs" | "agentProvider" | "agentLineage">,
  launches: Pick<AgentLaunchRecords, "read">): Promise<HardwareAgentReadiness[]> {
  return Promise.all(sessions.listTabs().filter(isAgentTab).map(async tab => {
    const providerId = sessions.agentProvider(tab.id)!;
    const { executionId } = sessions.agentLineage(tab.id);
    const identity = { tabId: tab.id, providerId, ...(executionId ? { executionId } : {}) };
    if (tab.status !== "running") return { ...identity, state: "unavailable" as const, reason: "The original AI client is not running." };
    try {
      const launch = await launches.read(tab.id, providerId);
      if (!executionId || !launch || launch.executionId !== executionId || !requiredKeys.every(key => launch.environmentKeys.includes(key) && launch.enforcedEnvironmentKeys.includes(key)))
        return { ...identity, state: "relaunch_required" as const, reason: "Relaunch this AI tab deliberately to load its Hardware helper and system skills." };
      return { ...identity, state: "ready" as const };
    } catch {
      return { ...identity, state: "unavailable" as const, reason: "The original AI launch record cannot be verified." };
    }
  }));
}
