import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceTab } from "@cloudx/shared";
import { TerminalPanel } from "../../../apps/web/src/ui/TerminalPanel.js";
import "@xterm/xterm/css/xterm.css";
import "../../../apps/web/src/styles.css";

function CommandDetailsFixture() {
  const [activeTab, setActiveTab] = useState("alpha");
  Object.assign(window, { activateCommandTab: setActiveTab });
  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <nav aria-label="Fixture tabs">
        {["alpha", "beta"].map((id) => (
          <button key={id} onClick={() => setActiveTab(id)}>
            {id}
          </button>
        ))}
      </nav>
      {["alpha", "beta"].map((id) => {
        const tab: WorkspaceTab = {
          id,
          pluginId: "codex-terminal",
          title: `Codex ${id}`,
          cwd: `/workspace/${id}`,
          status: "running",
          createdAt: "2026-10-12",
          updatedAt: "2026-10-12",
          indicator: {
            color: "green",
            label: "Running",
            updatedAt: "2026-10-12",
          },
        };
        return (
          <div
            key={id}
            data-tab={id}
            hidden={activeTab !== id}
            style={{ flex: 1, minHeight: 0 }}
          >
            <TerminalPanel tab={tab} active={activeTab === id} uiScale={1} />
          </div>
        );
      })}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<CommandDetailsFixture />);
