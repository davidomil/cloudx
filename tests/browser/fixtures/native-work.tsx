import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { CodexNativeWork, WorkspaceTab } from "@cloudx/shared";
import { recoverTab } from "../../../apps/web/src/api.js";
import { TerminalPanel } from "../../../apps/web/src/ui/TerminalPanel.js";
import "@xterm/xterm/css/xterm.css";
import "../../../apps/web/src/styles.css";

const updatedAt = "2026-10-12T20:28:20Z";
const affected: WorkspaceTab = {
  id: "affected",
  pluginId: "codex-terminal",
  title: "Affected Codex",
  cwd: "/workspace/affected",
  status: "running",
  createdAt: updatedAt,
  updatedAt,
  indicator: { color: "green", label: "Running", updatedAt },
  nativeWork: {
    version: 1,
    tabId: "affected",
    executionId: "affected-execution",
    threadId: "exact-conversation",
    updatedAt,
    turnStatus: "failed",
    goalStatus: "blocked",
    lastError: {
      kind: "terminal",
      message: "Provider stream processing failed after retries.",
      requestId: "request-after-http-200",
      httpStatusCode: 200,
      code: "stream_error",
    },
  },
};

function NativeWorkFixture() {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    affected,
    {
      ...affected,
      id: "sibling",
      title: "Working Codex",
      cwd: "/workspace/sibling",
      nativeWork: {
        version: 1,
        tabId: "sibling",
        executionId: "sibling-execution",
        threadId: "sibling-conversation",
        updatedAt,
        turnStatus: "running",
        goalStatus: "active",
      },
    },
  ]);
  const [activeTab, setActiveTab] = useState("affected");
  Object.assign(window, {
    observeNativeWork: (work: Partial<CodexNativeWork>) =>
      setTabs((current) =>
        current.map((tab) =>
          tab.id === "affected"
            ? { ...tab, nativeWork: { ...tab.nativeWork!, ...work } }
            : tab,
        ),
      ),
  });
  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <nav aria-label="Fixture tabs">
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}>
            {tab.title}
          </button>
        ))}
      </nav>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-tab={tab.id}
          hidden={activeTab !== tab.id}
          style={{ flex: 1, minHeight: 0 }}
        >
          <TerminalPanel
            tab={tab}
            active={activeTab === tab.id}
            uiScale={1}
            onRecover={async (input) => {
              const restored = await recoverTab(tab.id, input);
              setTabs((current) =>
                current.map((currentTab) =>
                  currentTab.id === tab.id ? restored : currentTab,
                ),
              );
            }}
          />
        </div>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<NativeWorkFixture />);
