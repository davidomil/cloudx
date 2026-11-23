import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { App } from "../../../apps/web/src/ui/App.js";
import "@xterm/xterm/css/xterm.css";
import "../../../apps/web/src/styles.css";

const terminals: Terminal[] = [];
const openTerminal = Terminal.prototype.open;
Terminal.prototype.open = function (parent) {
  terminals.push(this);
  openTerminal.call(this, parent);
};
Object.assign(window, { phoneTerminals: terminals });

createRoot(document.getElementById("root")!).render(<App />);
