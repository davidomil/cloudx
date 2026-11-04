import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceTab } from "@cloudx/shared";
import { HardwarePanel } from "../../../apps/web/src/ui/hardware/HardwarePanel.js";
import { applyCloudxTheme } from "../../../apps/web/src/ui/theme.js";
import "../../../apps/web/src/styles.css";

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
        <HardwarePanel
          tabs={[
            { id: "fixture-claude", title: "Claude worker" } as WorkspaceTab,
          ]}
          onOpenOwner={setOwner}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
