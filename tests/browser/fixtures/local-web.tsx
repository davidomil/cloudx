import { createRoot } from "react-dom/client";
import { WebViewerPanel } from "../../../apps/web/src/ui/WebViewerPanel.js";
import "../../../apps/web/src/styles.css";

createRoot(document.getElementById("root")!).render(
  <WebViewerPanel
    tab={{
      id: new URLSearchParams(location.search).get("tabId")!,
      pluginId: "local-web",
      title: "Local Web storage fixture",
      cwd: "/fixture",
      status: "running",
      indicator: { color: "green", label: "OK", updatedAt: "2026-11-04" },
      createdAt: "2026-11-04",
      updatedAt: "2026-11-04",
    }}
  />,
);
