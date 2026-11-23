import { createRoot } from "react-dom/client";
import { SettingsDialog } from "../../../apps/web/src/ui/SettingsDialog.js";
import "../../../apps/web/src/styles.css";

createRoot(document.getElementById("root")!).render(
  <SettingsDialog
    config={{
      globalFields: [],
      plugins: [],
      values: { global: {}, plugins: {} },
    }}
    initialCategoryId="terminal"
    onCancel={() => {}}
    onSave={async () => {}}
  />,
);
