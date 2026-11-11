import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceTab, WorkspaceWindow } from "@cloudx/shared";
import { HardwarePanel } from "../../../apps/web/src/ui/hardware/HardwarePanel.js";
import { applyCloudxTheme } from "../../../apps/web/src/ui/theme.js";
import "../../../apps/web/src/styles.css";

const at = "2026-11-11T00:00:00.000Z";
const codex: WorkspaceTab = {
  id: "fixture-codex",
  pluginId: "codex-terminal",
  title: "Camera bring-up",
  cwd: "/fixture",
  status: "running",
  indicator: { color: "green", label: "Running", updatedAt: at },
  createdAt: at,
  updatedAt: at,
};
const tabs: WorkspaceTab[] = [
  codex,
  {
    ...codex,
    id: "fixture-claude",
    title: "Claude worker",
    ownerPluginId: "forge",
    pluginMetadata: { "forge-workers": { workerId: "worker-1" } },
  },
];
const windows: WorkspaceWindow[] = [
  {
    id: "camera-lab",
    name: "Camera lab",
    defaultCwd: "/fixture",
    createdAt: at,
    updatedAt: at,
    layout: {
      activePaneId: "camera-pane",
      root: {
        type: "pane",
        pane: { id: "camera-pane", tabIds: [codex.id], activeTabId: codex.id },
      },
    },
  },
];

function Fixture() {
  const [owner, setOwner] = useState("");
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          padding: 8,
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <strong>CLOUDX / HARDWARE</strong>
        <label>
          Theme{" "}
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
        </label>
        <output>
          {owner ? `Opened owner: ${owner}` : "Hardware UI integration fixture"}
        </output>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <HardwarePanel tabs={tabs} windows={windows} onOpenOwner={setOwner} />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
