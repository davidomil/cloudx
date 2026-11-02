import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceTab } from "@cloudx/shared";
import { CooperationPanel } from "../../../apps/web/src/ui/cooperation/CooperationPanel.js";
import {
  AgentSwitchMenu,
  useAgentSwitchMenu,
} from "../../../apps/web/src/ui/AgentSwitchMenu.js";
import { TabPanel } from "../../../apps/web/src/ui/TabPanel.js";
import { applyCloudxTheme } from "../../../apps/web/src/ui/theme.js";
import "../../../apps/web/src/styles.css";

const timestamp = "2026-11-02T00:00:00.000Z";
const agentTabs: WorkspaceTab[] = [
  { id: "fixture-codex", title: "Codex Architect" },
  { id: "fixture-claude", title: "Claude Reviewer", ownerPluginId: "forge" },
].map((tab) => ({
  ...tab,
  pluginId: "codex-terminal",
  cwd: "/fixture",
  status: "idle",
  indicator: { color: "green", label: "Ready", updatedAt: timestamp },
  createdAt: timestamp,
  updatedAt: timestamp,
}));
const manager: WorkspaceTab = {
  ...agentTabs[0]!,
  id: "fixture-manager",
  pluginId: "cooperation",
  title: "Cooperation",
  ownerPluginId: undefined,
};
function Fixture() {
  const [views, setViews] = useState<WorkspaceTab[]>([manager]);
  const [active, setActive] = useState(manager.id);
  const menu = useAgentSwitchMenu(true);
  function open(boardId: string, title: string, newView = false) {
    const existing =
      !newView &&
      views.find((tab) => tab.pluginMetadata?.cooperation?.boardId === boardId);
    if (existing) {
      setActive(existing.id);
      return;
    }
    const tab = {
      ...manager,
      id: crypto.randomUUID(),
      title,
      pluginMetadata: { cooperation: { boardId } },
    };
    setViews((current) => [...current, tab]);
    setActive(tab.id);
  }
  return (
    <main
      className="app-shell"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: 0,
        gap: 0,
      }}
    >
      <header
        style={{
          display: "flex",
          gap: 8,
          padding: 8,
          flexWrap: "wrap",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <strong
          style={{ color: "var(--color-accent-tertiary)", padding: "7px 8px" }}
        >
          CLOUDX / COOPERATION
        </strong>
        {agentTabs.map((tab) => (
          <button key={tab.id} type="button" {...menu.tabHandlers(tab)}>
            {tab.title}
          </button>
        ))}
        <select
          aria-label="Fixture theme"
          defaultValue="cloudx-neon"
          onChange={(event) =>
            applyCloudxTheme(
              event.target.value as Parameters<typeof applyCloudxTheme>[0],
            )
          }
        >
          <option value="cloudx-neon">CloudX neon</option>
          <option value="minimalist-dark">Minimalist dark</option>
        </select>
      </header>
      <nav className="tab-strip" aria-label="Board views">
        {views.map((tab) => (
          <span key={tab.id} style={{ display: "contents" }}>
            <button
              type="button"
              className={`tab-button ${tab.id === active ? "selected" : ""}`}
              onClick={() => setActive(tab.id)}
            >
              {tab.title}
            </button>
            {tab.id !== manager.id ? (
              <button
                type="button"
                aria-label={`Close ${tab.title} view`}
                onClick={() => {
                  setViews((current) =>
                    current.filter((view) => view.id !== tab.id),
                  );
                  if (active === tab.id) setActive(manager.id);
                }}
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
      </nav>
      <div className="pane-body" style={{ flex: 1 }}>
        {views.map((tab) => (
          <TabPanel active={tab.id === active} keepMounted key={tab.id}>
            <CooperationPanel
              tab={tab}
              tabs={agentTabs}
              active={tab.id === active}
              onOpenBoard={open}
            />
          </TabPanel>
        ))}
      </div>
      {menu.position ? (
        <AgentSwitchMenu
          tab={agentTabs.find((tab) => tab.id === menu.position?.tabId)!}
          x={menu.position.x}
          y={menu.position.y}
          callHook={async () => ({}) as never}
          onSwitched={() => {}}
          onOpenAccounts={() => {}}
          onClose={menu.close}
          cooperationEnabled
          accountsEnabled={false}
          onOpenBoard={open}
        />
      ) : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
