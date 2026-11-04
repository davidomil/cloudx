#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function sessionIds(value) {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !SESSION_ID.test(id))
    || new Set(value).size !== value.length) throw new Error("Terminal attachment probe requires unique saved session IDs.");
  return value;
}

export async function probeTerminalAttachments({ mode, sessionIds: expected }, { factory, readSessions, isMissingSession }) {
  if (!["capture", "verify"].includes(mode)) throw new Error("Choose capture or verify for terminal attachment checks.");
  let candidates;
  if (mode === "capture") {
    if (expected !== undefined) throw new Error("Capture reads saved sessions instead of accepting replacement IDs.");
    let saved;
    try { saved = await readSessions(); } catch (error) {
      throw new Error("Saved terminal sessions could not be read.", { cause: error });
    }
    if (saved !== undefined && (saved?.version !== 1 || !Array.isArray(saved.sessions)
      || saved.sessions.some(session => !session?.tab || typeof session.tab !== "object"))) throw new Error("Saved terminal sessions are invalid.");
    candidates = sessionIds((saved?.sessions ?? []).filter(({ tab }) => tab.ownerPluginId === undefined
      && ["standard-terminal", "codex-terminal"].includes(tab.pluginId)).map(({ tab }) => tab.id));
  } else candidates = sessionIds(expected);
  const attached = [];
  for (const id of candidates) {
    let terminal;
    let stopObservingExit;
    try {
      terminal = await factory.attach(id);
      if (typeof terminal?.detach !== "function") throw new Error("Terminal attachment does not support detaching.");
      if (mode === "capture") {
        let exited = false;
        stopObservingExit = terminal.onExit(() => { exited = true; });
        // Durable attachments deliver a retained exit through a microtask.
        await Promise.resolve();
        if (exited) continue;
      }
      attached.push(id);
    } catch (error) {
      if (mode === "capture" && isMissingSession(error)) continue;
      throw new Error(`Terminal attachment could not be verified for saved session ${id}.`, { cause: error });
    } finally {
      stopObservingExit?.();
      if (typeof terminal?.detach === "function") terminal.detach();
    }
  }
  return { sessionIds: attached };
}

function ownedDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Terminal attachment paths must be absolute.");
  const root = path.resolve(value);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || fs.realpathSync(root) !== root)
    throw new Error("Terminal attachment paths must be owned directories without symbolic links.");
  return root;
}

function readExpectedSessions(file) {
  if (!path.isAbsolute(file ?? "")) throw new Error("The saved attachment list must use an absolute private file path.");
  const parent = ownedDirectory(path.dirname(file));
  const fd = fs.openSync(path.join(parent, path.basename(file)), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077)
      throw new Error("The saved attachment list must be an owned private regular file.");
    let value;
    try { value = JSON.parse(fs.readFileSync(fd, "utf8")); } catch (error) {
      throw new Error("The saved attachment list must contain valid JSON.", { cause: error });
    }
    if (!value || Object.keys(value).length !== 1) throw new Error("The saved attachment list must contain only sessionIds.");
    return sessionIds(value.sessionIds);
  } finally { fs.closeSync(fd); }
}

export function parseTerminalProbeArguments(argv) {
  const [mode, release, data, resultPath, file, ...extra] = argv;
  if (!["capture", "verify"].includes(mode) || extra.length || !path.isAbsolute(resultPath ?? "") || resultPath !== path.resolve(resultPath) ||
      mode === "capture" && file !== undefined || mode === "verify" && !file)
    throw new Error("Usage: managed-update-terminals.mjs capture <release> <data> <private-result-file> | verify <release> <data> <private-result-file> <private-session-list>");
  ownedDirectory(path.dirname(resultPath));
  if (fs.lstatSync(resultPath, { throwIfNoEntry: false })) throw new Error("The terminal attachment result file must not already exist.");
  return { mode, releaseRoot: ownedDirectory(release), dataDir: ownedDirectory(data),
    resultPath,
    ...(mode === "verify" ? { sessionIds: readExpectedSessions(file) } : {}) };
}

export async function inspectTerminalAttachments({ releaseRoot, dataDir, mode, sessionIds: expected }) {
  const release = ownedDirectory(releaseRoot);
  const data = ownedDirectory(dataDir);
  const factoryFile = path.join(release, "apps/server/dist/terminal/DurableTerminalProcess.js");
  const { DurableTerminalProcessFactory, terminalSocketPath } = await import(pathToFileURL(factoryFile).href);
  const { SessionStateStore } = await import(pathToFileURL(path.join(release, "apps/server/dist/workspace/SessionStateStore.js")).href);
  const { PluginSessionMissingError } = await import(pathToFileURL(createRequire(factoryFile).resolve("@cloudx/plugin-api")).href);
  const factory = new DurableTerminalProcessFactory(terminalSocketPath(data), {
    spawn() { throw new Error("The managed attachment probe cannot spawn terminal processes."); },
  });
  return probeTerminalAttachments({ mode, sessionIds: expected }, {
    factory, readSessions: () => new SessionStateStore(data).read(), isMissingSession: error => error instanceof PluginSessionMissingError,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseTerminalProbeArguments(process.argv.slice(2));
    const result = await inspectTerminalAttachments(options);
    fs.writeFileSync(options.resultPath, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600, flush: true });
    console.log("true");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
