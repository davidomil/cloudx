import type { HardwareAgentReadiness, WorkspaceTab } from "@cloudx/shared";
import { ExternalLink } from "lucide-react";
import { ControlButton } from "../Control.js";

export function HardwareReadiness({
  executions,
  tabs,
  onOpenOwner,
  canOpenOwner,
}: {
  executions: HardwareAgentReadiness[];
  tabs?: WorkspaceTab[];
  onOpenOwner?: (tabId: string) => void;
  canOpenOwner: (tabId: string) => boolean;
}) {
  const affected = executions.filter(
    (execution) => execution.state !== "ready",
  );
  if (!affected.length) return null;
  return (
    <details className="hardware-agent-readiness">
      <summary>
        {affected.length} AI{" "}
        {affected.length === 1 ? "execution needs" : "executions need"} Hardware
        attention
      </summary>
      <p className="hardware-muted">
        Existing executions need an explicit relaunch when their Hardware helper
        is missing. Inventory management remains available.
      </p>
      <ul>
        {affected.map((execution) => (
          <li
            key={`${execution.tabId}:${execution.executionId ?? "unstarted"}`}
          >
            <div>
              <strong>
                {tabs?.find((tab) => tab.id === execution.tabId)?.title ??
                  execution.tabId}{" "}
                · {execution.providerId}
              </strong>
              <span className="hardware-badge state-ineligible">
                {execution.state === "relaunch_required"
                  ? "Relaunch required"
                  : "Unavailable"}
              </span>
              <code>{execution.executionId ?? "No active execution"}</code>
              <p>
                {execution.reason ??
                  "This execution is not ready to use Hardware skills."}
              </p>
            </div>
            <ControlButton
              size="compact"
              disabled={!canOpenOwner(execution.tabId)}
              title={
                canOpenOwner(execution.tabId)
                  ? "Open this AI tab"
                  : "The owning tab is unavailable"
              }
              onClick={() => onOpenOwner?.(execution.tabId)}
            >
              <ExternalLink size={13} />
              Open owner
            </ControlButton>
          </li>
        ))}
      </ul>
    </details>
  );
}
