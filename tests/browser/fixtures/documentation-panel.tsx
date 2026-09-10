import { createRoot } from "react-dom/client";
import { DocumentationPanel } from "../../../apps/web/src/ui/DocumentationPanel.js";
import { fetchJson } from "../../../apps/web/src/api.js";
import "../../../apps/web/src/styles.css";

createRoot(document.getElementById("root")!).render(
  <DocumentationPanel
    callHook={(hookId, input) =>
      fetchJson(`/fixture-hooks/${hookId}`, {
        method: "POST",
        body: JSON.stringify(input),
      })
    }
  />,
);
