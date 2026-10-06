import { createRoot } from "react-dom/client";
import { WorkspaceRecoveryPanel } from "../../../apps/web/src/ui/WorkspaceRecoveryPanel.js";

import { ForgePanel } from "../../../apps/web/src/ui/ForgePanel.js";
import { fetchJson } from "../../../apps/web/src/api.js";
import "@xterm/xterm/css/xterm.css";
import "../../../apps/web/src/styles.css";

createRoot(document.getElementById("root")!).render(
  new URLSearchParams(window.location.search).has("codex-recovery") ? (
    <WorkspaceRecoveryPanel
      tab={{
        id: "codex-recovery",
        pluginId: "codex-terminal",
        title: "Saved Codex",
        cwd: "/fixture/repository",
        status: "failed",
        indicator: { color: "red", label: "Missing", updatedAt: "2026-09-28" },
        createdAt: "2026-09-28",
        updatedAt: "2026-09-28",
      }}
      recovery={{
        state: "missing",
        message: "The previous process ended.",
        conversationId: "saved-conversation",
        canResume: true,
      }}
      onRecover={async (input) => {
        await fetchJson("/fixture-recover", {
          method: "POST",
          body: JSON.stringify(input),
        });
      }}
    />
  ) : (
    <ForgeFixture />
  ),
);

function ForgeFixture() {
  return (
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
    />
  );
}
