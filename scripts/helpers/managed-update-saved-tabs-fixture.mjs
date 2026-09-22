import fs from "node:fs";
import path from "node:path";

import { InstallerRunner, prepareManagedRelease } from "../install-cloudx.mjs";
import { ManagedUpdate, UpdateHost } from "../managed-update.mjs";
import { writeUpdateJson } from "../managed-update-store.mjs";

export function seedSavedTabProfile({ root, home, dataDir, webUrl }) {
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const timestamp = "2026-09-22T00:00:00.000Z";
  const conversationId = "12345678-1234-4234-8234-123456789abc";
  const tab = (id, pluginId, title) => ({ id, pluginId, title, cwd, status: "stopped",
    indicator: { color: "yellow", label: "Stopped", updatedAt: timestamp }, pluginMetadata: {}, createdAt: timestamp,
    updatedAt: timestamp, contextPath: path.join(dataDir, "context", `${id}.md`) });
  const sessions = [
    { tab: tab("saved-shell", "standard-terminal", "Saved shell"), initialInput: { command: "NEVER_REPLAY_SAVED_SHELL_COMMAND" } },
    { tab: tab("saved-codex", "codex-terminal", "Saved Codex"), initialInput: {
      resume: { mode: "session", sessionId: conversationId }, prompt: "NEVER_REPLAY_SAVED_CODEX_PROMPT", model: "fixture-model",
    } },
    { tab: tab("saved-web", "local-web", "Saved website"), initialInput: { url: webUrl } },
  ];
  const workspace = { activeWindowId: "saved-window", templates: [], windows: [{ id: "saved-window", name: "Saved workspace", defaultCwd: cwd,
    createdAt: timestamp, updatedAt: timestamp, pluginMetadata: {}, layout: { activePaneId: "saved-left", root: {
      type: "split", id: "saved-split", direction: "row", sizes: [40, 60], children: [
        { type: "pane", pane: { id: "saved-left", tabIds: ["saved-shell", "saved-web"], activeTabId: "saved-shell" } },
        { type: "pane", pane: { id: "saved-right", tabIds: ["saved-codex"], activeTabId: "saved-codex" } },
      ],
    } } }] };
  writeUpdateJson(path.join(dataDir, "sessions.json"), { version: 1, activeTabId: "saved-shell", sessions });
  writeUpdateJson(path.join(dataDir, "workspace.json"), workspace);
  fs.mkdirSync(path.join(dataDir, "context"));
  for (const { tab } of sessions) fs.writeFileSync(tab.contextPath, `Saved context for ${tab.id}.\n`, { mode: 0o600 });
  const codexHome = path.join(home, ".codex");
  const transcriptPath = path.join(codexHome, "sessions/2026/rollout-" + conversationId + ".jsonl");
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "session_meta", payload: { id: conversationId, cwd } })}\n{"type":"event_msg","payload":{"message":"Retain this exact conversation history."}}\n`, { mode: 0o600 });
  const identity = fs.statSync(codexHome);
  const launch = path.join(dataDir, "codex-launches/saved-codex");
  fs.mkdirSync(launch, { recursive: true });
  writeUpdateJson(path.join(launch, ".cloudx-source.json"), { version: 1, sourceId: "shared", home: codexHome, dev: String(identity.dev), ino: String(identity.ino) });
  writeUpdateJson(path.join(launch, ".cloudx-conversation.json"), { sessionId: conversationId, cwd, transcriptPath });
  const evidence = [transcriptPath,
    path.join(launch, ".cloudx-source.json"), path.join(launch, ".cloudx-conversation.json")]
    .map(file => ({ file, bytes: fs.readFileSync(file) }));
  const terminalLaunches = path.join(root, "unexpected-terminal-launches.jsonl");
  const terminalCommand = path.join(root, "fixture-terminal");
  fs.writeFileSync(terminalCommand, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(terminalLaunches)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  return { sessions, workspace, conversationId, evidence, terminalLaunches, terminalCommand };
}

// A separate process makes interruption real while each host mutation remains
// restricted to the two disposable services owned by this fixture.
if (process.argv[2] === "--interrupt-after-activation") {
  const fixture = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const record = JSON.parse(fs.readFileSync(fixture.recordFile, "utf8"));
  const save = value => writeUpdateJson(fixture.recordFile, value);
  class ScopedCommands extends InstallerRunner {
    constructor(cwd) { super({ cwd, nonInteractive: true, log() {} }); }
    scoped(command, args) {
      const scoped = command === "systemctl" ? args.map(arg => arg === "cloudx-terminal.service" ? fixture.brokerUnit : arg) : args;
      if (command === "systemctl" && scoped.some(arg => ["start", "stop", "restart", "kill", "enable", "disable"].includes(arg))
        && ![fixture.webUnit, fixture.brokerUnit].includes(scoped.at(-1))) throw new Error("The interrupted fixture may mutate only its owned services.");
      return scoped;
    }
    run(command, args, options) { return super.run(command, this.scoped(command, args), options); }
    inspect(command, args, options) { return super.inspect(command, this.scoped(command, args), options); }
    capture(command, args, options) { return super.capture(command, this.scoped(command, args), options); }
  }
  const host = new UpdateHost({ repoRoot: fixture.repoRoot, home: fixture.home, dataDir: fixture.dataDir, service: fixture.webUnit,
    port: fixture.port, runDir: fixture.runDir, save, commands: new ScopedCommands(fixture.repoRoot),
    prepareRelease: options => prepareManagedRelease({ ...options, runner: new ScopedCommands(options.releaseRoot) }) });
  const result = await new ManagedUpdate({ record, save, host, checkpoint: boundary => {
    if (boundary === "after:activate") process.kill(process.pid, "SIGKILL");
  } }).run();
  throw new Error(`The saved-tab fixture did not reach its interruption checkpoint: ${JSON.stringify(result)}`);
}
