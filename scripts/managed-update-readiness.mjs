import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectTerminalReadiness } from "./managed-update-integration.mjs";

// Historical servers need no new HTTP endpoint: use their real factories and
// the maintained lifecycle probe built against that release's terminal APIs.
export async function verifyHistoricalTerminals(release, dataDir) {
  for (const root of [release, dataDir]) {
    if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()
      || fs.lstatSync(root).uid !== process.getuid()) throw new Error("Terminal readiness requires owned real directories.");
  }
  const { terminalMode } = inspectTerminalReadiness(release);
  const module = relative => import(pathToFileURL(path.join(release, "apps/server/dist/terminal", relative)).href);
  const [{ TerminalReadiness }, { NodePtyTerminalProcessFactory }] =
    await Promise.all([module("TerminalReadiness.js"), module("NodePtyTerminalProcess.js")]);
  if (terminalMode === "direct") {
    await new TerminalReadiness(dataDir, new NodePtyTerminalProcessFactory(), 5_000, ["direct"]).check();
    return { broker: "not-applicable", direct: "ready" };
  }
  const { DurableTerminalProcessFactory, terminalSocketPath } = await module("DurableTerminalProcess.js");
  const factory = new DurableTerminalProcessFactory(terminalSocketPath(dataDir), new NodePtyTerminalProcessFactory());
  await new TerminalReadiness(dataDir, factory).check();
  return { broker: "ready", direct: "ready" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [release, dataDir, ...extra] = process.argv.slice(2);
    if (!release || !dataDir || extra.length) throw new Error("Usage: managed-update-readiness.mjs <release> <data>");
    console.log(JSON.stringify(await verifyHistoricalTerminals(release, dataDir)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
