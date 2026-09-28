import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCompleteWorkspaceTab, isUsableTabLayoutState } from "../packages/shared/src/index.ts";
import { SessionStateStore } from "../apps/server/src/workspace/SessionStateStore.ts";
import { WorkspaceLayoutStore } from "../apps/server/src/workspace/WorkspaceLayoutStore.ts";
import { PathPolicy } from "../apps/server/src/pathPolicy.ts";
import { CodexStateSources } from "../apps/server/src/plugins/CodexStateSources.ts";
import { CodexConversationRecovery } from "../apps/server/src/plugins/CodexConversationRecovery.ts";
import { CodexConversationSelection } from "../apps/server/helpers/codex-conversation-selection.mjs";
import { assertTerminalMigrationSafe, inspectTerminalRecovery, snapshotTerminalRecovery } from "./terminal-upgrade-recovery.mjs";
import { inspectRuntimeUpdate } from "./install-runtime.mjs";
import { ForgeExecutionRecovery } from "../apps/server/src/forge/ForgeExecution.ts";

const roots = [];
const conversationId = "12345678-1234-1234-1234-123456789abc";
const otherId = "12345678-1234-1234-1234-123456789def";
const forgeState = `plugin-data/forge-${createHash("sha256").update("forge").digest("hex")}.json`;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-migration-"));
  roots.push(dataDir);
  const write = (name, value) => {
    const target = path.resolve(dataDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
    return target;
  };
  const read = name => JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"));
  const tab = { id: "codex-1", pluginId: "codex-terminal", title: "Original title", cwd: "/project", status: "running", indicator: { color: "green", label: "Running", updatedAt: "now" }, createdAt: "then", updatedAt: "now" };
  write("workspace.json", { windows: [{ id: "window-1", name: "Original window", defaultCwd: "/project", createdAt: "then", updatedAt: "now", layout: { activePaneId: "pane-1", root: { type: "pane", pane: { id: "pane-1", tabIds: [tab.id, "shell-1"] } } } }] });
  write("sessions.json", { version: 1, activeTabId: tab.id, sessions: [
    { tab, initialInput: { resume: { mode: "session", sessionId: conversationId }, prompt: "Never replay this prompt" } },
    { tab: { ...tab, id: "shell-1", pluginId: "terminal", title: "Shell" }, initialInput: { command: "Never replay this command" } },
  ] });
  const transcriptPath = write(`codex-home/sessions/2026/rollout-${conversationId}.jsonl`, `${JSON.stringify({ type: "session_meta", payload: { id: conversationId, cwd: tab.cwd } })}\n{"type":"event_msg","payload":{"message":"exact history"}}\n`);
  const codexHome = path.join(dataDir, "codex-home");
  const home = fs.statSync(codexHome);
  write("codex-launches/codex-1/.cloudx-source.json", { version: 1, sourceId: "shared", home: codexHome, dev: String(home.dev), ino: String(home.ino) });
  write("codex-launches/codex-1/.cloudx-conversation.json", { sessionId: conversationId, cwd: tab.cwd, transcriptPath });
  const owned = { id: "worker-1", launchPending: false, gitPending: false, cleaned: false };
  write("forge-workers/workspaces/worker-1.json", owned);
  write(forgeState, [{ id: owned.id, status: "paused", worktreePath: "/preserved/checkout" }]);
  return { dataDir, write, read, tab, owned, transcriptPath, log: vi.fn() };
}

async function currentCodexFixture() {
  const f = fixture();
  const saved = f.read("sessions.json");
  await new SessionStateStore(f.dataDir).save(saved);
  const bindingFile = "codex-launches/codex-1/.cloudx-source.json";
  const { home } = f.read(bindingFile);
  fs.rmSync(path.join(f.dataDir, "codex-launches/codex-1"), { recursive: true });
  const sources = new CodexStateSources(f.dataDir, { CODEX_HOME: home });
  try {
    const binding = await sources.resolve();
    await sources.bind(f.tab.id, binding);
    expect(await sources.readBinding(f.tab.id)).toEqual(binding);
  } finally { await sources.dispose(); }
  f.write("codex-launches/codex-1/.cloudx-conversation.json", { sessionId: conversationId, cwd: f.tab.cwd, transcriptPath: f.transcriptPath });
  expect((await new SessionStateStore(f.dataDir).read()).sessions).toEqual(saved.sessions);
  const commands = { inspect: (_command, args) => Object.entries(args[2] === "cloudx-terminal.service" ? { LoadState: "not-found" } : {
    LoadState: "loaded", ActiveState: "active", MainPID: "123", ControlGroup: "/user/cloudx.service", WorkingDirectory: f.dataDir,
    KillMode: "control-group", SendSIGKILL: "yes",
  }).map(([key, value]) => `${key}=${value}`).join("\n") };
  return { ...f, bindingFile, plan: () => inspectRuntimeUpdate({ paths: { dataDir: f.dataDir, repoRoot: f.dataDir }, commands, target: { kind: "standard" } }) };
}

async function completedForgeFixture(status) {
  const f = fixture();
  const execution = await new ForgeExecutionRecovery(f.dataDir).prepare();
  const attemptId = randomUUID();
  const turn = { workerId: "worker-1", attemptId, threadId: randomUUID(), turnId: randomUUID(), status: "completed" };
  const turnFile = `forge-workers/turns/worker-1/${attemptId}.json`;
  const worker = { id: "worker-1", kind: status === "completed" ? "review" : "issue", number: 128, status,
    worktreePath: "/preserved/checkout", tabId: "worker-tab", completion: { attemptId, turn } };
  f.write(forgeState, [worker]);
  f.write(turnFile, turn);
  f.write("forge-workers/tabs/worker-tab.json", { tabId: worker.tabId, workerId: worker.id, attemptId, closed: false, quiescent: true, execution });
  const receipt = { executionId: execution.executionId, bootId: execution.bootId, pidNamespace: execution.pidNamespace, pid: process.pid, started: "123" };
  f.write(path.relative(f.dataDir, path.join(execution.directory, "ready.json")), receipt);
  f.write(path.relative(f.dataDir, path.join(execution.directory, "complete.json")), { ...receipt, exitCode: 0 });
  return { ...f, execution, worker, turnFile };
}

async function launchViewFixture(selected = false) {
  const f = await currentCodexFixture();
  const view = path.join(f.dataDir, "codex-launches", f.tab.id);
  const store = path.join(f.read(f.bindingFile).home, "sessions");
  fs.symlinkSync(store, path.join(view, "sessions"));
  const receiptPath = path.join(view, ".cloudx-conversation.json");
  const transcriptPath = path.join(view, "sessions", path.relative(store, f.transcriptPath));
  if (selected) {
    const saved = f.read("sessions.json");
    saved.sessions[0].initialInput.codexExecutionId = otherId;
    f.write("sessions.json", saved);
    const selection = new CodexConversationSelection({ tabId: f.tab.id, executionId: otherId, receiptPath }, value => f.write(receiptPath, value));
    selection.fromClient({ id: 1, method: "thread/resume" });
    selection.fromServer({ id: 1, result: { thread: { id: conversationId, cwd: f.tab.cwd, path: transcriptPath } } });
  } else {
    execFileSync(process.execPath, [new URL("../apps/server/helpers/codex-conversation-hook.mjs", import.meta.url).pathname, receiptPath], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: conversationId, cwd: f.tab.cwd, transcript_path: transcriptPath }),
    });
  }
  return { ...f, view, store, receiptPath, aliasPath: transcriptPath };
}

describe("controlled terminal replacement snapshots", () => {
  it.each([false, true])("preserves a launch-view receipt and snapshots its canonical transcript (selected=%s)", async selected => {
    const f = await launchViewFixture(selected);
    const receipt = fs.readFileSync(f.receiptPath);
    expect(f.plan().blockers).toEqual([]);
    const backup = snapshotTerminalRecovery(f);
    expect(fs.readFileSync(path.join(backup, `codex-launches/${f.tab.id}/.cloudx-conversation.json`))).toEqual(receipt);
    expect(fs.readFileSync(f.receiptPath)).toEqual(receipt);
    expect(fs.readFileSync(path.join(backup, `transcripts/${f.tab.id}.jsonl`))).toEqual(fs.readFileSync(f.transcriptPath));
    expect(JSON.parse(fs.readFileSync(path.join(backup, "manifest.json"))).conversations)
      .toEqual([{ tabId: f.tab.id, lastObservedSessionId: conversationId, transcriptPath: f.transcriptPath, snapshot: `transcripts/${f.tab.id}.jsonl` }]);
  });

  it.each(["external alias", "other tab", "replaced launch link", "nested directory link", "transcript link", "sibling store"])("rejects a receipt through an %s without changing saved tabs or evidence", async kind => {
    const f = await launchViewFixture(true);
    const receipt = JSON.parse(fs.readFileSync(f.receiptPath));
    if (kind === "external alias" || kind === "other tab") {
      const alias = path.join(f.dataDir, kind === "other tab" ? "codex-launches/other/sessions" : "external-sessions");
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.symlinkSync(f.store, alias);
      receipt.transcriptPath = path.join(alias, path.relative(f.store, f.transcriptPath));
    } else if (kind === "replaced launch link") {
      fs.cpSync(f.store, `${f.store}.copy`, { recursive: true });
      fs.unlinkSync(path.join(f.view, "sessions"));
      fs.symlinkSync(`${f.store}.copy`, path.join(f.view, "sessions"));
    } else if (kind === "nested directory link") {
      fs.renameSync(path.dirname(f.transcriptPath), `${f.store}.year`);
      fs.symlinkSync(`${f.store}.year`, path.dirname(f.transcriptPath));
    } else if (kind === "transcript link") {
      fs.renameSync(f.transcriptPath, `${f.transcriptPath}.original`);
      fs.symlinkSync(`${f.transcriptPath}.original`, f.transcriptPath);
    } else {
      fs.cpSync(f.store, `${f.store}-sibling`, { recursive: true });
      receipt.transcriptPath = f.transcriptPath.replace(f.store, `${f.store}-sibling`);
    }
    f.write(f.receiptPath, receipt);
    const originals = ["sessions.json", "workspace.json", f.receiptPath, f.transcriptPath].map(file => [file, fs.readFileSync(path.resolve(f.dataDir, file))]);
    expect(f.plan().blockers).toHaveLength(1);
    expect(() => snapshotTerminalRecovery(f)).toThrow(/session store|symlink/);
    for (const [file, bytes] of originals) expect(fs.readFileSync(path.resolve(f.dataDir, file))).toEqual(bytes);
    expect(fs.readdirSync(f.dataDir).some(name => name.startsWith("terminal-recovery-"))).toBe(false);
  });

  it.each(["link", "store"])("rejects a %s replaced with identical transcript bytes during snapshot", async kind => {
    const f = await launchViewFixture(true);
    const write = fs.writeFileSync;
    let replaced = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, bytes, options) => {
      if (!replaced && String(file).includes("terminal-recovery-")) {
        replaced = true;
        if (kind === "link") {
          fs.cpSync(f.store, `${f.store}.copy`, { recursive: true });
          fs.unlinkSync(path.join(f.view, "sessions"));
          fs.symlinkSync(`${f.store}.copy`, path.join(f.view, "sessions"));
        } else {
          fs.renameSync(f.store, `${f.store}.original`);
          fs.cpSync(`${f.store}.original`, f.store, { recursive: true });
        }
      }
      return write(file, bytes, options);
    });
    expect(() => snapshotTerminalRecovery(f)).toThrow(/session store/);
    expect(fs.readdirSync(f.dataDir).some(name => name.startsWith("terminal-recovery-"))).toBe(false);
  });

  it("does not erase an external link traversal when resolving receipt dot segments", async () => {
    const f = await launchViewFixture(true);
    const outside = path.join(f.dataDir, "outside");
    fs.cpSync(f.store, outside, { recursive: true });
    fs.mkdirSync(path.join(outside, "deep"));
    fs.symlinkSync(path.join(outside, "deep"), path.join(f.store, "traversal"));
    const receipt = JSON.parse(fs.readFileSync(f.receiptPath));
    receipt.transcriptPath = `${f.store}/traversal/../${path.relative(f.store, f.transcriptPath)}`;
    expect(path.resolve(receipt.transcriptPath)).toBe(f.transcriptPath);
    expect(fs.realpathSync.native(receipt.transcriptPath)).not.toBe(f.transcriptPath);
    f.write(f.receiptPath, receipt);
    expect(() => snapshotTerminalRecovery(f)).toThrow("outside its bound session store");
  });

  it.each(["tabId", "executionId", "missing execution", "version", "authority"])("rejects stale or invalid native %s", async field => {
    const f = await launchViewFixture(true);
    const receipt = JSON.parse(fs.readFileSync(f.receiptPath));
    if (field === "missing execution") {
      const saved = f.read("sessions.json");
      delete saved.sessions[0].initialInput.codexExecutionId;
      f.write("sessions.json", saved);
    } else {
      receipt[field] = field === "executionId" ? conversationId : field === "version" ? 3 : "wrong";
      f.write(f.receiptPath, receipt);
    }
    const executionId = f.read("sessions.json").sessions[0].initialInput.codexExecutionId;
    expect(() => new CodexConversationRecovery(f.view).readForExecution(f.tab.id, executionId)).toThrow();
    expect(f.plan().blockers).toHaveLength(1);
    expect(() => snapshotTerminalRecovery(f)).toThrow(/selection binding|different tab or execution/);
  });

  it("plans and snapshots production-written Codex bindings and saved tabs without replaying inputs", async () => {
    const f = await currentCodexFixture();
    const binding = f.read(f.bindingFile);
    expect(binding.durable).toEqual(expect.objectContaining({ filesystemId: expect.any(String), birthtimeNs: expect.any(String) }));
    expect(f.plan()).toMatchObject({ requiresInterruption: true, blockers: [], recovery: { legacySessionIdentitiesUnavailable: false } });
    const saved = fs.readFileSync(path.join(f.dataDir, "sessions.json"));
    const backup = snapshotTerminalRecovery(f);
    expect(JSON.parse(fs.readFileSync(path.join(backup, f.bindingFile), "utf8"))).toEqual(binding);
    expect(fs.readFileSync(path.join(backup, "sessions.json"))).toEqual(saved);
    expect(fs.readFileSync(path.join(f.dataDir, "sessions.json"))).toEqual(saved);
    expect(JSON.parse(fs.readFileSync(path.join(backup, "manifest.json"), "utf8")).conversations)
      .toEqual([{ tabId: f.tab.id, lastObservedSessionId: conversationId, transcriptPath: f.transcriptPath, snapshot: `transcripts/${f.tab.id}.jsonl` }]);
  });

  it.each(["filesystemId", "filesystemType", "birthtimeNs", "uid", "ino"])("rejects a changed production Codex %s during planning and snapshotting", async field => {
    const f = await currentCodexFixture();
    const binding = f.read(f.bindingFile);
    const owner = field === "ino" ? binding : binding.durable;
    owner[field] = owner[field] === "1" ? "2" : "1";
    f.write(f.bindingFile, binding);
    const sources = new CodexStateSources(f.dataDir, { CODEX_HOME: binding.home });
    try { await expect(sources.readBinding(f.tab.id)).rejects.toThrow("ownership changed"); }
    finally { await sources.dispose(); }
    expect(f.plan().blockers).toEqual([{ service: "recovery", message: expect.stringContaining("source ownership changed") }]);
    for (const operation of [inspectTerminalRecovery, snapshotTerminalRecovery])
      expect(() => operation(f)).toThrow("source ownership changed");
    expect(fs.readdirSync(f.dataDir).some(name => name.startsWith("terminal-recovery-"))).toBe(false);
  });

  it.each([null, {}, { filesystemId: "0", filesystemType: "ef53", birthtimeNs: "1", uid: "1" }])("rejects malformed durable Codex ownership %#", async durable => {
    const f = await currentCodexFixture();
    f.write(f.bindingFile, { ...f.read(f.bindingFile), durable });
    expect(() => snapshotTerminalRecovery(f)).toThrow("invalid source ownership");
  });

  it("matches the production ownership decision after device numbering changes", async () => {
    const f = await currentCodexFixture();
    const binding = f.read(f.bindingFile);
    binding.dev = (BigInt(binding.dev) + 1n).toString();
    f.write(f.bindingFile, binding);
    const sources = new CodexStateSources(f.dataDir, { CODEX_HOME: binding.home });
    const durableFilesystem = ["ef53", "9123683e"].includes(binding.durable.filesystemType) && binding.durable.birthtimeNs !== "0";
    try {
      if (durableFilesystem) {
        await expect(sources.readBinding(f.tab.id)).resolves.toMatchObject({ home: binding.home, ino: binding.ino, durable: binding.durable });
        expect(f.plan().blockers).toEqual([]);
        expect(snapshotTerminalRecovery(f)).toBeTypeOf("string");
      } else {
        await expect(sources.readBinding(f.tab.id)).rejects.toThrow("device changed");
        expect(() => snapshotTerminalRecovery(f)).toThrow("source ownership changed");
      }
    } finally { await sources.dispose(); }
  });

  it.each(["before planning", "during snapshot"])("rejects a source directory replaced %s with the same transcript bytes", async timing => {
    const f = await currentCodexFixture();
    const { home } = f.read(f.bindingFile);
    const replace = () => {
      fs.renameSync(home, `${home}.original`);
      fs.cpSync(`${home}.original`, home, { recursive: true });
    };
    if (timing === "before planning") {
      replace();
      expect(f.plan().blockers).toEqual([{ service: "recovery", message: expect.stringContaining("source ownership changed") }]);
    } else {
      const write = fs.writeFileSync;
      let replaced = false;
      vi.spyOn(fs, "writeFileSync").mockImplementation((file, bytes, options) => {
        if (!replaced && String(file).includes("terminal-recovery-")) { replaced = true; replace(); }
        return write(file, bytes, options);
      });
    }
    expect(() => snapshotTerminalRecovery(f)).toThrow("source ownership changed");
    expect(fs.readdirSync(f.dataDir).some(name => name.startsWith("terminal-recovery-"))).toBe(false);
    expect(fs.readFileSync(f.transcriptPath)).toEqual(fs.readFileSync(f.transcriptPath.replace(home, `${home}.original`)));
  });

  it("preserves exact tabs, layout, last observed Codex conversation, transcript, and Forge ownership privately", () => {
    const f = fixture();
    const originals = ["workspace.json", "sessions.json", forgeState, "forge-workers/workspaces/worker-1.json", "codex-launches/codex-1/.cloudx-source.json", "codex-launches/codex-1/.cloudx-conversation.json"];
    const before = originals.map(name => fs.readFileSync(path.join(f.dataDir, name)));
    expect(f.read("sessions.json").sessions.every(({ tab }) => isCompleteWorkspaceTab(tab))).toBe(true);
    expect(f.read("workspace.json").windows.every(window => isUsableTabLayoutState(window.layout))).toBe(true);
    assertTerminalMigrationSafe(f);
    const backup = snapshotTerminalRecovery(f);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o700);
    for (const [index, relative] of originals.entries()) {
      expect(fs.readFileSync(path.join(backup, relative))).toEqual(before[index]);
      expect(fs.readFileSync(path.join(f.dataDir, relative))).toEqual(before[index]);
      expect(fs.statSync(path.join(backup, relative)).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(path.join(backup, "transcripts/codex-1.jsonl"))).toEqual(fs.readFileSync(f.transcriptPath));
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json"), "utf8"));
    expect(manifest.conversations).toEqual([{ tabId: "codex-1", lastObservedSessionId: conversationId, transcriptPath: f.transcriptPath, snapshot: "transcripts/codex-1.jsonl" }]);
    for (const file of manifest.files)
      expect(file.sha256).toBe(createHash("sha256").update(fs.readFileSync(path.join(backup, file.snapshot))).digest("hex"));
    expect(manifest.recovery).toContain("not proof of the current native selection");
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining("no commands or prompts are replayed"));
  });

  it("does not create state on a fresh installation", () => {
    const f = fixture();
    fs.rmSync(f.dataDir, { recursive: true });
    assertTerminalMigrationSafe(f);
    expect(snapshotTerminalRecovery(f)).toBeUndefined();
    expect(fs.existsSync(f.dataDir)).toBe(false);
  });

  it("refuses a legacy layout without saved tab identities", () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.dataDir, "sessions.json"));
    expect(() => snapshotTerminalRecovery(f)).toThrow("Legacy workspace has no saved session identities");
  });

  it.each([
    ["an empty session list", []],
    ["a missing active-window tab", ["shell-1", "shell-2"]],
    ["a missing nested-pane tab", ["codex-1", "shell-2"]],
    ["a missing inactive-window tab", ["codex-1", "shell-1"]],
  ])("refuses %s without changing the saved state", async (_description, savedIds) => {
    const f = fixture();
    const workspace = f.read("workspace.json");
    workspace.activeWindowId = "window-1";
    workspace.windows[0].layout = { activePaneId: "pane-1", root: { type: "split", id: "split-1", direction: "row", sizes: [50, 50], children: [
      { type: "pane", pane: { id: "pane-1", tabIds: ["codex-1"] } },
      { type: "split", id: "split-2", direction: "column", sizes: [40, 60], children: [
        { type: "pane", pane: { id: "pane-2", tabIds: ["shell-1"] } },
        { type: "pane", pane: { id: "pane-3", tabIds: [] } },
      ] },
    ] } };
    workspace.windows.push({ ...workspace.windows[0], id: "window-2", name: "Inactive window",
      layout: { activePaneId: "pane-4", root: { type: "pane", pane: { id: "pane-4", tabIds: ["shell-2"] } } } });
    f.write("workspace.json", workspace);
    const sessions = f.read("sessions.json").sessions;
    sessions.push({ tab: { ...sessions[1].tab, id: "shell-2" } });
    f.write("sessions.json", { version: 1, sessions: sessions.filter(({ tab }) => savedIds.includes(tab.id)) });
    const originals = ["workspace.json", "sessions.json"].map(relative => [relative, fs.readFileSync(path.join(f.dataDir, relative))]);
    const loaded = await new SessionStateStore(f.dataDir).read();
    expect(loaded.sessions.map(({ tab }) => tab.id)).toEqual(savedIds);
    const layout = new WorkspaceLayoutStore(f.dataDir, new PathPolicy(["/project"]));
    expect(layout.tabIdsForWindow("window-1")).toEqual(["codex-1", "shell-1"]);
    expect(layout.tabIdsForWindow("window-2")).toEqual(["shell-2"]);

    expect(() => snapshotTerminalRecovery(f)).toThrow(/Workspace tab .* has no saved session identity; broker replacement stopped/);

    for (const [relative, bytes] of originals) expect(fs.readFileSync(path.join(f.dataDir, relative))).toEqual(bytes);
    expect(fs.readdirSync(f.dataDir).some(name => name.startsWith("terminal-recovery-"))).toBe(false);
  });

  it.each(["absent", "empty"])("preserves an empty workspace with %s saved sessions", kind => {
    const f = fixture();
    const workspace = f.read("workspace.json");
    workspace.windows[0].layout.root.pane.tabIds = [];
    f.write("workspace.json", workspace);
    if (kind === "absent") fs.unlinkSync(path.join(f.dataDir, "sessions.json"));
    else f.write("sessions.json", { version: 1, sessions: [] });
    const backup = snapshotTerminalRecovery(f);
    expect(JSON.parse(fs.readFileSync(path.join(backup, "workspace.json"), "utf8"))).toEqual(workspace);
    expect(fs.existsSync(path.join(backup, "sessions.json"))).toBe(kind === "empty");
  });

  it.each(["launchPending", "gitPending"])("refuses %s without changing ownership", flag => {
    const f = fixture();
    const original = JSON.stringify({ ...f.owned, [flag]: true });
    const file = f.write("forge-workers/workspaces/worker-1.json", original);
    for (const operation of [assertTerminalMigrationSafe, snapshotTerminalRecovery])
      expect(() => operation(f)).toThrow(/pending launch or Git operation.*Local resources were preserved/);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it.each(["starting", "running", "cleanup_failed", "awaiting_publication", "awaiting_merge"])("blocks a %s worker before interruption", status => {
    const f = fixture();
    f.write(forgeState, [{ id: "worker-1", status }]);
    expect(() => assertTerminalMigrationSafe(f)).toThrow(/active or has unresolved work/);
  });

  it("refuses a legacy worker with missing workspace ownership without claiming a reboot is required", () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.dataDir, "forge-workers/workspaces/worker-1.json"));
    expect(() => assertTerminalMigrationSafe(f)).toThrow(/missing workspace ownership.*service restarts do not prove a worker ended/);
    expect(f.read(forgeState)[0].status).toBe("paused");
  });

  it("blocks a retained completed workspace with missing ownership", () => {
    const f = fixture();
    f.write(forgeState, [{ id: "worker-1", kind: "issue", number: 129, status: "completed", retainedWorkspace: { worktreePath: "/preserved/checkout", retainedPaths: ["notes.txt"] } }]);
    fs.unlinkSync(path.join(f.dataDir, "forge-workers/workspaces/worker-1.json"));
    expect(() => assertTerminalMigrationSafe(f)).toThrow("missing workspace ownership");
  });
  it.each(["workers", "ownership"])("blocks contradictory duplicate %s", kind => {
    const f = fixture();
    if (kind === "workers") f.write(forgeState, [...f.read(forgeState), ...f.read(forgeState)]);
    else f.write("forge-workers/workspaces/nested/worker-1.json", { ...f.owned, cleaned: true });
    expect(() => assertTerminalMigrationSafe(f)).toThrow(/Invalid Forge/);
  });

  it.each([{}, { closed: false, quiescent: false }])("rejects incomplete or live worker tab ownership %#", fields => {
    const f = fixture();
    f.write("forge-workers/tabs/worker-tab.json", { tabId: "worker-tab", workerId: "worker-1", ...fields });
    expect(() => assertTerminalMigrationSafe(f)).toThrow("Forge terminal ownership is active or unresolved");
  });

  it("preserves retired worker tab and execution receipts", () => {
    const f = fixture();
    f.write("forge-workers/tabs/worker-tab.json", { tabId: "worker-tab", workerId: "worker-1", closed: true, quiescent: true });
    f.write("forge-workers/executions/execution-1/complete.json", { exitCode: 0 });
    const backup = snapshotTerminalRecovery(f);
    expect(fs.readFileSync(path.join(backup, "forge-workers/executions/execution-1/complete.json"), "utf8")).toBe('{"exitCode":0}\n');
  });

  it.each(["paused", "completed"])("accepts a retained %s terminal only with exact completed attempt and execution receipts", async status => {
    const f = await completedForgeFixture(status);
    await expect(new ForgeExecutionRecovery(f.dataDir).assertEnded(f.execution)).resolves.toBeUndefined();
    expect(() => assertTerminalMigrationSafe(f)).not.toThrow();
    const backup = snapshotTerminalRecovery(f);
    expect(fs.readFileSync(path.join(backup, f.turnFile), "utf8")).toBe(fs.readFileSync(path.join(f.dataDir, f.turnFile), "utf8"));
    expect(f.read(forgeState)).toEqual([f.worker]);
  });

  it.each(["missing completion", "wrong attempt", "wrong thread", "wrong turn", "running turn", "missing turn", "missing ready", "missing complete", "wrong execution", "wrong supervisor", "replacement directory"])("blocks a completed terminal with %s", async fault => {
    const f = await completedForgeFixture("paused");
    if (fault === "missing completion") delete f.worker.completion;
    if (fault === "wrong attempt") f.worker.completion.attemptId = randomUUID();
    if (fault === "wrong thread") f.worker.completion.turn.threadId = randomUUID();
    if (fault === "wrong turn") f.worker.completion.turn.turnId = randomUUID();
    if (fault === "running turn") f.worker.completion.turn.status = "running";
    f.write(forgeState, [f.worker]);
    if (fault === "missing turn") fs.unlinkSync(path.join(f.dataDir, f.turnFile));
    if (fault === "missing ready") fs.unlinkSync(path.join(f.execution.directory, "ready.json"));
    if (fault === "missing complete") fs.unlinkSync(path.join(f.execution.directory, "complete.json"));
    if (fault === "wrong execution" || fault === "wrong supervisor") {
      const file = path.relative(f.dataDir, path.join(f.execution.directory, "complete.json"));
      f.write(file, { ...f.read(file), ...(fault === "wrong execution" ? { executionId: randomUUID() } : { started: "999" }) });
    }
    if (fault === "replacement directory") {
      fs.renameSync(f.execution.directory, `${f.execution.directory}-original`);
      fs.cpSync(`${f.execution.directory}-original`, f.execution.directory, { recursive: true });
    }
    expect(() => assertTerminalMigrationSafe(f)).toThrow("missing or conflicting terminal ownership");
  });

  it.each(["missing", "different worker", "different attempt"])("refuses a referenced worker tab with %s ownership", kind => {
    const f = fixture();
    f.write(forgeState, [{ id: "worker-1", status: "failed", worktreePath: "/preserved/checkout", tabId: "worker-tab", attemptId: "attempt-1" }]);
    if (kind === "different worker") f.write("forge-workers/workspaces/worker-2.json", { ...f.owned, id: "worker-2" });
    if (kind !== "missing") f.write("forge-workers/tabs/worker-tab.json", {
      tabId: "worker-tab", workerId: kind === "different worker" ? "worker-2" : "worker-1",
      attemptId: kind === "different attempt" ? "attempt-2" : "attempt-1", closed: true, quiescent: true,
    });
    for (const operation of [assertTerminalMigrationSafe, snapshotTerminalRecovery])
      expect(() => operation(f)).toThrow(/missing or conflicting terminal ownership/);
    expect(f.read(forgeState)[0].tabId).toBe("worker-tab");
  });

  it("preserves closed legacy worker ownership without inventing an attempt identity", () => {
    const f = fixture();
    f.write(forgeState, [{ id: "worker-1", status: "failed", tabId: "worker-tab", attemptId: "attempt-1" }]);
    const tab = { tabId: "worker-tab", workerId: "worker-1", closed: true, quiescent: true };
    f.write("forge-workers/tabs/worker-tab.json", tab);
    const backup = snapshotTerminalRecovery(f);
    expect(JSON.parse(fs.readFileSync(path.join(backup, "forge-workers/tabs/worker-tab.json"), "utf8"))).toEqual(tab);
  });

  it.each(["receipt", "transcript", "source binding"])("requires a Codex %s before termination", missing => {
    const f = fixture();
    const target = missing === "receipt" ? path.join(f.dataDir, "codex-launches/codex-1/.cloudx-conversation.json")
      : missing === "source binding" ? path.join(f.dataDir, "codex-launches/codex-1/.cloudx-source.json") : f.transcriptPath;
    fs.unlinkSync(target);
    expect(() => snapshotTerminalRecovery(f)).toThrow();
    expect(fs.readdirSync(f.dataDir).some(name => name.startsWith("terminal-recovery-"))).toBe(false);
  });

  it.each([true, false])("preserves an explicitly ended legacy tab without guessing a conversation (binding=%s)", binding => {
    const f = fixture();
    fs.unlinkSync(path.join(f.dataDir, "codex-launches/codex-1/.cloudx-conversation.json"));
    if (!binding) fs.unlinkSync(path.join(f.dataDir, "codex-launches/codex-1/.cloudx-source.json"));
    const saved = f.read("sessions.json");
    saved.sessions[0] = { tab: { ...f.tab, status: "failed", recovery: { state: "missing", canResume: false, message: "Select a saved session." } } };
    f.write("sessions.json", saved);
    const originals = ["sessions.json", "workspace.json", f.transcriptPath].map(file => [file, fs.readFileSync(path.resolve(f.dataDir, file))]);
    expect(inspectTerminalRecovery(f).warnings).toEqual([expect.stringContaining("select an exact saved session in Terminal recovery or close the tab")]);
    const backup = snapshotTerminalRecovery(f);
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json")));
    expect(manifest.conversations).toEqual([]);
    expect(manifest.unavailableConversations).toEqual([{ tabId: f.tab.id, message: expect.stringContaining("No conversation ID was inferred") }]);
    expect(f.log).toHaveBeenCalledWith(manifest.unavailableConversations[0].message);
    expect(JSON.parse(fs.readFileSync(path.join(backup, "sessions.json")))).toEqual(saved);
    for (const [file, bytes] of originals) expect(fs.readFileSync(path.resolve(f.dataDir, file))).toEqual(bytes);
  });

  it.each(["unknown process", "running status", "resumable", "native execution", "malformed receipt"])("does not waive conversation evidence for an ended tab with %s", kind => {
    const f = fixture();
    const receipt = path.join(f.dataDir, "codex-launches/codex-1/.cloudx-conversation.json");
    fs.unlinkSync(receipt);
    const saved = f.read("sessions.json");
    saved.sessions[0].tab = { ...f.tab, status: "failed", recovery: { state: "missing", canResume: false, message: "Unavailable." } };
    if (kind === "unknown process") saved.sessions[0].tab.recovery.state = "unavailable";
    if (kind === "running status") saved.sessions[0].tab.status = "running";
    if (kind === "resumable") saved.sessions[0].tab.recovery.canResume = true;
    if (kind === "native execution") saved.sessions[0].initialInput.codexExecutionId = otherId;
    if (kind === "malformed receipt") f.write(receipt, {});
    f.write("sessions.json", saved);
    expect(() => snapshotTerminalRecovery(f)).toThrow("missing or conflicting conversation identity");
    expect(fs.readdirSync(f.dataDir).some(name => name.startsWith("terminal-recovery-"))).toBe(false);
  });

  it("stops if conversation evidence appears while snapshotting an unavailable legacy tab", () => {
    const f = fixture();
    const receiptPath = path.join(f.dataDir, "codex-launches/codex-1/.cloudx-conversation.json");
    const receipt = fs.readFileSync(receiptPath);
    fs.unlinkSync(receiptPath);
    const saved = f.read("sessions.json");
    saved.sessions[0].tab.status = "failed";
    saved.sessions[0].tab.recovery = { state: "missing", canResume: false, message: "Unavailable." };
    f.write("sessions.json", saved);
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, bytes, options) => {
      if (String(file).includes("terminal-recovery-")) write(receiptPath, receipt);
      return write(file, bytes, options);
    });
    expect(() => snapshotTerminalRecovery(f)).toThrow("Recovery source changed during snapshot");
    expect(fs.readFileSync(receiptPath)).toEqual(receipt);
    expect(fs.readdirSync(f.dataDir).some(name => name.startsWith("terminal-recovery-"))).toBe(false);
  });

  it("refuses conflicting last observed and persisted conversation IDs", () => {
    const f = fixture();
    const saved = f.read("sessions.json");
    saved.sessions[0].initialInput.resume.sessionId = otherId;
    f.write("sessions.json", saved);
    expect(() => snapshotTerminalRecovery(f)).toThrow("missing or conflicting conversation identity");
  });

  it("refuses a changed Codex source directory identity", () => {
    const f = fixture();
    const binding = f.read("codex-launches/codex-1/.cloudx-source.json");
    f.write("codex-launches/codex-1/.cloudx-source.json", { ...binding, ino: "0" });
    expect(() => snapshotTerminalRecovery(f)).toThrow("source ownership changed");
  });

  it("refuses a source binding rejected by the production Codex source owner", async () => {
    const f = fixture();
    const binding = f.read("codex-launches/codex-1/.cloudx-source.json");
    f.write("codex-launches/codex-1/.cloudx-source.json", { ...binding, obsolete: true });
    const sources = new CodexStateSources(f.dataDir, { CODEX_HOME: binding.home });
    await expect(sources.readBinding("codex-1")).rejects.toThrow("Invalid Codex source binding");
    await sources.dispose();
    expect(() => snapshotTerminalRecovery(f)).toThrow("invalid source ownership");
  });

  it.each([{ pendingPublication: {} }, { mergeAttempted: true }, { publicationState: "uncertain" }, { draft: { status: "posting" } }, { draft: { status: "post_failed" } }])("refuses unresolved publication %#", fields => {
    const f = fixture();
    f.write(forgeState, [{ id: "worker-1", status: "paused", ...fields }]);
    expect(() => assertTerminalMigrationSafe(f)).toThrow("active or has unresolved work");
  });

  it("refuses malformed session records instead of guessing recoverable tabs", () => {
    const f = fixture();
    f.write("sessions.json", { version: 1, sessions: [null] });
    expect(() => snapshotTerminalRecovery(f)).toThrow("Invalid saved tab identities");
  });

  it.each([
    { recovery: { state: "bogus" } }, { recovery: { state: "missing", message: "gone", canResume: "yes" } },
    { contextPath: 1 }, { statusMessage: [] }, { pluginMetadata: { forge: null } },
    { indicator: { color: "green", label: "Running", updatedAt: "now", message: {} } },
  ])("refuses optional tab fields rejected by the production session loader %#", async fields => {
    const f = fixture();
    const saved = f.read("sessions.json");
    Object.assign(saved.sessions[0].tab, fields);
    f.write("sessions.json", saved);
    expect(isCompleteWorkspaceTab(saved.sessions[0].tab)).toBe(false);
    await expect(new SessionStateStore(f.dataDir).read()).rejects.toThrow("Open tab sessions file is invalid");
    expect(() => snapshotTerminalRecovery(f)).toThrow("Invalid saved tab identities");
  });

  it.each([
    { broken: true },
    { activePaneId: "unknown", root: { type: "pane", pane: { id: "pane-1", tabIds: [] } } },
    { activePaneId: "pane-1", root: { type: "pane", pane: { id: "pane-1", tabIds: ["codex-1", "codex-1"] } } },
    { activePaneId: "pane-1", root: { type: "pane", pane: { id: "pane-1", tabIds: [], activeTabId: "unknown" } } },
    { activePaneId: "pane-1", root: { type: "split", id: "split-1", direction: "row", sizes: [20, 20], children: [] } },
  ])("refuses a layout rejected by the production workspace validator %#", layout => {
    const f = fixture();
    const workspace = f.read("workspace.json");
    workspace.windows[0].layout = layout;
    f.write("workspace.json", workspace);
    expect(isUsableTabLayoutState(layout)).toBe(false);
    expect(() => snapshotTerminalRecovery(f)).toThrow("no recoverable workspace layout");
  });

  it("refuses a saved window that the production loader would drop", () => {
    const f = fixture();
    f.write("workspace.json", { windows: [{}] });
    expect(() => snapshotTerminalRecovery(f)).toThrow("no recoverable workspace layout");
  });

  it("preserves a valid split layout with its exact pane sizes and selections", () => {
    const f = fixture();
    const workspace = f.read("workspace.json");
    workspace.activeWindowId = "window-1";
    workspace.windows[0].layout = { activePaneId: "pane-2", root: { type: "split", id: "split-1", direction: "column", sizes: [35, 65], children: [
      { type: "pane", pane: { id: "pane-1", tabIds: ["codex-1"], activeTabId: "codex-1" } },
      { type: "pane", pane: { id: "pane-2", tabIds: ["shell-1"], activeTabId: "shell-1" } },
    ] } };
    expect(isUsableTabLayoutState(workspace.windows[0].layout)).toBe(true);
    const original = f.write("workspace.json", workspace);
    const backup = snapshotTerminalRecovery(f);
    expect(fs.readFileSync(path.join(backup, "workspace.json"))).toEqual(fs.readFileSync(original));
  });

  it.each(["id", "cwd"])("refuses transcript %s that does not match its receipt", field => {
    const f = fixture();
    fs.writeFileSync(f.transcriptPath, JSON.stringify({ type: "session_meta", payload: { id: conversationId, cwd: f.tab.cwd, [field]: field === "id" ? otherId : "/other" } }));
    expect(() => snapshotTerminalRecovery(f)).toThrow("transcript metadata does not match");
  });

  it("refuses a transcript outside its bound Codex store", () => {
    const f = fixture();
    f.write("codex-launches/codex-1/.cloudx-conversation.json", { sessionId: conversationId, cwd: f.tab.cwd, transcriptPath: path.join(f.dataDir, `rollout-${conversationId}.jsonl`) });
    expect(() => snapshotTerminalRecovery(f)).toThrow("outside its bound session store");
  });

  it.each(["sessions.json", "forge-workers/workspaces", "codex-launches/codex-1", "codex-home/sessions"])("rejects symlinked %s", relative => {
    const f = fixture();
    const target = path.join(f.dataDir, relative);
    fs.renameSync(target, `${target}.original`);
    fs.symlinkSync(`${target}.original`, target);
    expect(() => snapshotTerminalRecovery(f)).toThrow(/owned regular file|without symlinks|Unsafe/);
  });

  it.each(["duplicate", "unknown active", "unsafe ID"])("rejects %s tab identity", kind => {
    const f = fixture();
    const saved = f.read("sessions.json");
    if (kind === "duplicate") saved.sessions.push(saved.sessions[0]);
    if (kind === "unknown active") saved.activeTabId = "unknown";
    if (kind === "unsafe ID") saved.sessions[0].tab.id = "../outside";
    f.write("sessions.json", saved);
    expect(() => snapshotTerminalRecovery(f)).toThrow(/tab identit/);
  });

  it.each(["write", "verification", "flush", "source change"])("refuses replacement after backup %s failure", failure => {
    const f = fixture();
    const workspace = fs.readFileSync(path.join(f.dataDir, "workspace.json"));
    const realWrite = fs.writeFileSync;
    if (failure === "flush") vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("disk flush failed"); });
    else vi.spyOn(fs, "writeFileSync").mockImplementation((target, bytes, options) => {
      if (String(target).includes("terminal-recovery-")) {
        if (failure === "write") throw new Error("disk full");
        if (failure === "verification") return realWrite(target, "corrupt", options);
        realWrite(f.transcriptPath, "changed during snapshot");
      }
      return realWrite(target, bytes, options);
    });
    expect(() => snapshotTerminalRecovery(f)).toThrow(/backup failed; do not stop the broker/);
    expect(fs.readFileSync(path.join(f.dataDir, "workspace.json"))).toEqual(workspace);
    expect(fs.readdirSync(f.dataDir).some(name => name.startsWith("terminal-recovery-"))).toBe(false);
  });
});
