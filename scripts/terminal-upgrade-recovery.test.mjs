import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCompleteWorkspaceTab, isUsableTabLayoutState } from "../packages/shared/src/index.ts";
import { SessionStateStore } from "../apps/server/src/workspace/SessionStateStore.ts";
import { WorkspaceLayoutStore } from "../apps/server/src/workspace/WorkspaceLayoutStore.ts";
import { PathPolicy } from "../apps/server/src/pathPolicy.ts";
import { CodexStateSources } from "../apps/server/src/plugins/CodexStateSources.ts";
import { assertTerminalMigrationSafe, snapshotTerminalRecovery } from "./terminal-upgrade-recovery.mjs";

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
    const target = path.join(dataDir, name);
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

describe("controlled terminal replacement snapshots", () => {
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
