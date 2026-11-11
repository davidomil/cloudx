import type {
  HardwareOwner,
  WorkspaceTab,
  WorkspaceWindow,
} from "@cloudx/shared";
import { ExternalLink } from "lucide-react";
import { ControlButton } from "../Control.js";
import { findPaneContainingTab } from "../layout.js";
import { ownerLabel } from "./hardwareModel.js";

export interface HardwareOwnerProps {
  tabs?: WorkspaceTab[];
  windows?: WorkspaceWindow[];
  onOpenOwner?: (tabId: string) => void;
}

export function HardwareOwnerView({
  owner,
  tabs,
  windows,
  onOpenOwner,
}: HardwareOwnerProps & { owner: HardwareOwner }) {
  const tab =
    owner.kind === "agent"
      ? tabs?.find((tab) => tab.id === owner.tabId)
      : undefined;
  const workspace =
    tab &&
    windows?.find((window) =>
      findPaneContainingTab(window.layout.root, tab.id),
    );
  const location =
    workspace?.name ??
    (tab?.ownerPluginId === "forge"
      ? "Forge worker"
      : tab
        ? windows && "Not placed in a workspace"
        : "Owner tab unavailable");
  return (
    <div className="hardware-owner">
      <strong>{ownerLabel(owner, tabs)}</strong>
      {owner.kind === "agent" ? (
        <>
          {location ? (
            <small className="hardware-muted">{location}</small>
          ) : null}
          <ControlButton
            size="compact"
            disabled={!tab || !onOpenOwner}
            title={
              tab && onOpenOwner
                ? `Open owning tab: ${tab.title}`
                : "The original owning tab is unavailable"
            }
            onClick={(event) => {
              event.stopPropagation();
              if (tab) onOpenOwner?.(tab.id);
            }}
          >
            <ExternalLink size={13} />
            Open owner tab
          </ControlButton>
        </>
      ) : null}
    </div>
  );
}
