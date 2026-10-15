import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import type { ForgeWorker, WorkspaceTab } from "@cloudx/shared";
import { TerminalPanel } from "../../../apps/web/src/ui/TerminalPanel.js";
import { ForgeWorkerTerminalOverlay } from "../../../apps/web/src/ui/ForgeWorkerTerminalOverlay.js";
import "@xterm/xterm/css/xterm.css";
import "../../../apps/web/src/styles.css";

declare global {
  interface Window {
    testTerminal: Terminal;
    terminalWriteCount: number;
    queuedTerminalOutputPaused: boolean;
    resumeQueuedTerminalOutput: () => void;
  }
}

window.terminalWriteCount = 0;
const writeTerminal = Terminal.prototype.write;
Terminal.prototype.write = function (data, callback) {
  window.terminalWriteCount++;
  writeTerminal.call(this, data, callback);
};
const openTerminal = Terminal.prototype.open;
Terminal.prototype.open = function (parent) {
  window.testTerminal = this;
  openTerminal.call(this, parent);
};

function TerminalCopyFixture() {
  const [tabId, setTabId] = useState("copy-tab");
  const [sidebarClicks, setSidebarClicks] = useState(0);
  const view = new URLSearchParams(window.location.search).get("view");
  const split =
    new URLSearchParams(window.location.search).get("split") === "true";
  const tab: WorkspaceTab = {
    id: tabId,
    pluginId: view === "terminal" ? "standard-terminal" : "codex-terminal",
    title: view === "terminal" ? "Terminal" : "Codex",
    cwd: "/workspace",
    status: "running",
    indicator: { color: "green", label: "Running", updatedAt: "2026-10-02" },
    createdAt: "2026-10-02",
    updatedAt: "2026-10-02",
    ...(view === "forge"
      ? {
          ownerPluginId: "forge",
          pluginMetadata: { "forge-workers": { workerId: "copy-worker" } },
        }
      : {}),
  };
  if (view === "forge" || view === "forge-history") {
    const worker: ForgeWorker = {
      id: "copy-worker",
      kind: "issue",
      number: 171,
      title: "Streaming copy",
      status: "running",
      tabId,
      repository: {
        provider: "github",
        apiUrl: "https://api.github.com",
        projectPath: "davidomil/cloudx",
      },
      baseBranch: "main",
      templateId: "fixture",
      autoPost: false,
      startedAt: "2026-10-02",
      updatedAt: "2026-10-02",
    };
    return (
      <ForgeWorkerTerminalOverlay
        worker={worker}
        workerTabs={view === "forge" ? [tab] : []}
        loadHistory={async () => ({
          tabId,
          capturedAt: "2026-10-02",
          screen: {
            cols: 80,
            rows: 24,
            data: "    first saved line\r\n    界 café middle\r\n    last saved line",
          },
        })}
        uiScale={1}
        onClose={() => undefined}
      />
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <button
        onClick={() =>
          setTabId(tabId === "copy-tab" ? "other-tab" : "copy-tab")
        }
      >
        Switch tab
      </button>
      {split && (
        <aside aria-label="Sidebar">
          <button onClick={() => setSidebarClicks((clicks) => clicks + 1)}>
            Sidebar action
          </button>
          <output aria-label="Sidebar clicks">{sidebarClicks}</output>
        </aside>
      )}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <section aria-label="Source pane" style={{ flex: 1, minWidth: 0 }}>
          <TerminalPanel tab={tab} active uiScale={1} />
        </section>
        {split && (
          <section
            aria-label="Other pane"
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minWidth: 0,
            }}
          >
            <input
              aria-label="Other pane input"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
            <div style={{ flex: 1, minHeight: 0 }}>
              <TerminalPanel
                tab={{ ...tab, id: "other-pane", title: "Other terminal" }}
                active
                uiScale={1}
              />
            </div>
          </section>
        )}
      </div>
      {split && (
        <div aria-label="Empty workbench space" style={{ height: 32 }} />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<TerminalCopyFixture />);
