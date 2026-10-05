import { createRoot } from "react-dom/client";
import { ForgePanel } from "../../../apps/web/src/ui/ForgePanel.js";
import { useWorkspaceCleanup } from "../../../apps/web/src/ui/workspaceCleanupSession.js";
import { fetchJson } from "../../../apps/web/src/api.js";
import "../../../apps/web/src/styles.css";

function EnvironmentsFixture() {
  const cleanup = useWorkspaceCleanup();
  return (
    <ForgePanel
      callHook={(hookId, input, tabId) =>
        fetchJson(`/fixture-hooks/${hookId}`, {
          method: "POST",
          body: JSON.stringify({ input, tabId }),
        })
      }
      cleanup={cleanup}
      tab={{
        id: "forge-tab",
        pluginId: "forge",
        title: "Forge",
        cwd: "/fixture/repository",
        status: "idle",
        indicator: { color: "green", label: "Ready", updatedAt: "2026-10-05" },
        createdAt: "2026-10-05",
        updatedAt: "2026-10-05",
      }}
      windowId="window-1"
      paneId="pane-1"
      workerTabs={[]}
      active
      uiScale={100}
      repositorySettingsKey="repository:0"
      repositoryChangePending={false}
    />
  );
}

createRoot(document.getElementById("root")!).render(<EnvironmentsFixture />);
