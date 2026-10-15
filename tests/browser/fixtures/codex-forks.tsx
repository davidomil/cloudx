import { createRoot } from "react-dom/client";
import { App } from "../../../apps/web/src/ui/App.js";
import "@xterm/xterm/css/xterm.css";
import "../../../apps/web/src/styles.css";

createRoot(document.getElementById("root")!).render(<App />);
