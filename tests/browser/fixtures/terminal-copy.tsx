import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceTab } from "@cloudx/shared";
import { TerminalPanel } from "../../../apps/web/src/ui/TerminalPanel.js";
import "@xterm/xterm/css/xterm.css";
import "../../../apps/web/src/styles.css";

function TerminalCopyFixture() {
  const [tabId, setTabId] = useState("copy-tab");
  const tab: WorkspaceTab = {
    id: tabId,
    pluginId: "codex-terminal",
    title: "Codex",
    cwd: "/workspace",
    status: "running",
    indicator: { color: "green", label: "Running", updatedAt: "2026-10-02" },
    createdAt: "2026-10-02",
    updatedAt: "2026-10-02",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <button
        onClick={() =>
          setTabId(tabId === "copy-tab" ? "other-tab" : "copy-tab")
        }
      >
        Switch tab
      </button>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TerminalPanel tab={tab} active uiScale={1} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<TerminalCopyFixture />);
