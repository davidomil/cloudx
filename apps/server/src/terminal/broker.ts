import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadConfig } from "../config.js";
import { NodePtyTerminalProcessFactory } from "./NodePtyTerminalProcess.js";
import { TerminalBroker } from "./TerminalBroker.js";
import { terminalSocketPath } from "./TerminalBrokerProtocol.js";

const config = loadConfig();
const broker = new TerminalBroker(terminalSocketPath(config.dataDir), new NodePtyTerminalProcessFactory(), config.terminalReplayBytes);
await broker.start();
if (process.env.NOTIFY_SOCKET) {
  try { await promisify(execFile)("systemd-notify", ["--ready"]); } catch (error) {
    await broker.stop();
    throw new Error("The terminal broker could not notify systemd that its socket is ready.", { cause: error });
  }
}
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void broker.stop().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}
process.send?.({ type: "ready" });
