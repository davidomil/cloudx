import { createRoot } from "react-dom/client";
import { callHook } from "../../../apps/web/src/api.js";
import { CodexSettingsPanel } from "../../../apps/web/src/ui/CodexSettingsPanel.js";
import { CodexSettingsEditor } from "../../../apps/web/src/ui/CodexSettingsEditor.js";
import "../../../apps/web/src/styles.css";

const editor = new CodexSettingsEditor();
createRoot(document.getElementById("root")!).render(
  <main style={{ height: "100%", overflow: "auto", padding: 16 }}>
    <CodexSettingsPanel editor={editor} callHook={callHook} />
  </main>,
);
