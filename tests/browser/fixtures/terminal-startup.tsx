import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceTab } from "@cloudx/shared";
import { TerminalPanel } from "../../../apps/web/src/ui/TerminalPanel.js";
import "@xterm/xterm/css/xterm.css";
import "../../../apps/web/src/styles.css";

function StartupFixture() {
  const [failed, setFailed] = useState(
    new URLSearchParams(location.search).has("failed"),
  );
  const tab: WorkspaceTab = {
    id: "startup-tab",
    pluginId: "codex-terminal",
    title: "Codex",
    cwd: "/workspace",
    status: failed ? "failed" : "running",
    indicator: { color: "green", label: "Running", updatedAt: "2026-09-27" },
    createdAt: "2026-09-27",
    updatedAt: "2026-09-27",
    ...(failed
      ? {
          recovery: {
            state: "missing" as const,
            canResume: false,
            startupFailed: true,
            message:
              "Codex exited before a selected conversation was confirmed. Review the terminal output and Settings → Codex, then open a new Codex tab.",
          },
        }
      : {}),
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <button onClick={() => setFailed(true)}>Report startup exit</button>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TerminalPanel
          tab={tab}
          active
          uiScale={1}
          onRecover={async () => {
            throw new Error("Startup has no conversation to resume.");
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StartupFixture />);
