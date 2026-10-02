import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import type { WorkspaceTab } from "@cloudx/shared";
import { TerminalPanel } from "../../../apps/web/src/ui/TerminalPanel.js";
import "@xterm/xterm/css/xterm.css";
import "../../../apps/web/src/styles.css";

declare global {
  interface Window {
    testTerminal: Terminal;
    terminalWriteCount: number;
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
