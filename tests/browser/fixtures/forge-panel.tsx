import { createRoot } from "react-dom/client";
import { ForgePanel } from "../../../apps/web/src/ui/ForgePanel.js";
import { fetchJson } from "../../../apps/web/src/api.js";
import "../../../apps/web/src/styles.css";

createRoot(document.getElementById("root")!).render(
  <ForgePanel
    callHook={(hookId, input, tabId) =>
      fetchJson(`/fixture-hooks/${hookId}`, {
        method: "POST",
        body: JSON.stringify({ input, tabId }),
      })
    }
    tab={{
      id: "forge-tab",
      pluginId: "forge",
      title: "Forge",
      cwd: "/fixture/repository",
      status: "idle",
      indicator: { color: "green", label: "Ready", updatedAt: "2026-09-15" },
      createdAt: "2026-09-15",
      updatedAt: "2026-09-15",
    }}
    windowId="window-1"
    paneId="pane-2"
    workerTabs={[]}
    active
    uiScale={100}
    repositorySettingsKey="repository:0"
    repositoryChangePending={false}
  />,
);
