import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const contract = "execution-json-v1";

// Import eagerly in both process owners: an in-place update must not change
// which supervisor a running broker or web server launches next.
export const terminalSupervisorSource = loadSupervisor();
export const terminalSupervisorRuntime = Object.freeze({
  contract,
  sourceSha256: createHash("sha256").update(terminalSupervisorSource).digest("hex"),
  pinned: true
});

function loadSupervisor(): string {
  let source: string;
  try {
    source = readFileSync(new URL("../../helpers/terminal-supervisor.py", import.meta.url), "utf8");
  } catch (cause) {
    throw new Error("The bundled terminal-supervisor.py helper is required before starting CloudX services.", { cause });
  }
  const actual = /^CLOUDX_TERMINAL_SUPERVISOR_CONTRACT = "([^"]+)"$/mu.exec(source)?.[1];
  if (actual !== contract) {
    throw new Error(`Terminal supervisor contract mismatch: this CloudX process requires ${contract}, but its helper declares ${actual ?? "no contract"}. Complete the installation before restarting the web and terminal services.`);
  }
  return source;
}
