import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexStateSources as CurrentCodexStateSources } from "../apps/server/src/plugins/CodexStateSources.ts";

import { MISSING_SETTINGS_FILES, prepareMissingSettingsIntegration } from "./managed-update-settings-integration.mjs";
import { CODEX_SOURCES, SESSION_INTEGRATION_FILES, SESSION_PERSISTENCE_FILES,
  prepareCodexSourceIntegration, prepareSessionIntegration } from "./managed-update-session-integration.mjs";
import { inspectTerminalRecovery } from "./terminal-upgrade-recovery.mjs";

const historicalCommit = "224a75ef7b3efced05b2c6b3b136250d9a532dc3";
const copied = Object.fromEntries(SESSION_PERSISTENCE_FILES.map(file => [file, fs.readFileSync(file, "utf8")]));
const require = createRequire(import.meta.url);

// Execute the migration's historical production classes, including their real
// validators and filesystem persistence, without requiring a historical build.
function historicalRuntime(commit) {
  const sources = new Map();
  function historical(file) {
    if (!sources.has(file)) sources.set(file, execFileSync("git", ["show", `${commit}:${file}`], { encoding: "utf8" }));
    return sources.get(file);
  }
  const settings = prepareMissingSettingsIntegration(historical);
  const migrated = prepareSessionIntegration(file => settings[file] ?? historical(file));
  const modules = new Map();
  function load(file, overrides = {}, cache = modules) {
    if (cache.has(file)) return cache.get(file).exports;
    const source = overrides[file] ?? migrated[file] ?? settings[file] ?? copied[file] ?? (file === "packages/shared/src/cloudxUpdate.ts" ? fs.readFileSync(file, "utf8") : historical(file));
    const compiled = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
    expect(compiled.diagnostics).toEqual([]);
    const module = { exports: {} };
    cache.set(file, module);
    const dependency = name => {
      if (name.startsWith("node:")) return require(name);
      if (name.startsWith("@cloudx/")) return load(`packages/${name.slice(8)}/src/index.ts`, overrides, cache);
      if (name.startsWith(".")) return load(path.posix.normalize(path.posix.join(path.posix.dirname(file), name)).replace(/\.js$/, ".ts"), overrides, cache);
      return require(name);
    };
    const javascript = compiled.outputText.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(path.resolve(file)).href));
    new Function("require", "module", "exports", javascript)(dependency, module, module.exports);
    return module.exports;
  }
  return { historical, migrated, load };
}

const runtime = historicalRuntime(historicalCommit);
const { historical, migrated, load } = runtime;
const { SessionStateStore } = load("apps/server/src/workspace/SessionStateStore.ts");
const { CodexTerminalPlugin } = load("apps/server/src/plugins/CodexTerminalPlugin.ts");
const fixtures = [];
const conversationId = "12345678-1234-4234-8234-123456789abc";

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.store.dispose();
    await fixture.sources?.dispose();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function savedWorkspace(target = runtime) {
  const { SessionStore } = target.load("apps/server/src/sessionStore.ts");
  const { SessionStateStore } = target.load("apps/server/src/workspace/SessionStateStore.ts");
  const { WorkspaceLayoutStore } = target.load("apps/server/src/workspace/WorkspaceLayoutStore.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-saved-tab-migration-"));
  const timestamp = "2026-09-22T00:00:00.000Z";
  const saved = { version: 1, activeTabId: "saved-shell", sessions: [
    ["saved-shell", "standard-terminal", { command: "DO_NOT_REPLAY_COMMAND" }],
    ["saved-codex", "codex-terminal", { prompt: "DO_NOT_REPLAY_PROMPT", resume: { mode: "session", sessionId: conversationId }, model: "saved-model" }],
    ["saved-web", "local-web", { url: "http://localhost:4200/saved?view=original" }],
  ].map(([id, pluginId, initialInput]) => ({ tab: { id, pluginId, title: id, cwd: root, status: "stopped",
    indicator: { color: "yellow", label: "Stopped", updatedAt: timestamp }, createdAt: timestamp, updatedAt: timestamp,
    pluginMetadata: { fixture: { saved: true } }, contextPath: path.join(root, `${id}.md`) }, initialInput })) };
  const savedSessions = new SessionStateStore(root);
  await savedSessions.save(saved);
  const pathPolicy = { ensureDirectory: vi.fn(async cwd => cwd), defaultDirectoryExpression: () => root };
  const workspace = new WorkspaceLayoutStore(root, pathPolicy);
  const window = workspace.getActiveWindow();
  const layout = { activePaneId: "saved-left", root: { type: "split", id: "saved-split", direction: "row", sizes: [35, 65], children: [
    { type: "pane", pane: { id: "saved-left", tabIds: ["saved-shell", "saved-web"], activeTabId: "saved-shell" } },
    { type: "pane", pane: { id: "saved-right", tabIds: ["saved-codex"], activeTabId: "saved-codex" } },
  ] } };
  await workspace.updateWindow(window.id, { layout });
  const sessions = new Map();
  const plugins = ["standard-terminal", "codex-terminal", "local-web"].map(id => ({ id, displayName: id, acronym: id,
    panelKind: id === "local-web" ? "web-viewer" : "terminal", requiresDirectory: false,
    createSession: vi.fn(async input => {
      const state = { url: input.initialInput?.url };
      const session = { tab: input.tab, state, snapshot: () => ({ status: "running", state }), stop: vi.fn(), controls: input.controls };
      sessions.set(input.tab.id, session);
      return session;
    }) }));
  const registry = { get: id => plugins.find(plugin => plugin.id === id), list: () => plugins };
  plugins[1].recoverSession = input => plugins[1].createSession(input);
  const context = { create: vi.fn(async tab => path.join(root, `${tab.id}.md`)), record: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const errors = vi.fn();
  const createStore = () => new SessionStore(registry, pathPolicy, context, undefined, workspace, undefined, errors, savedSessions);
  const fixture = { root, saved, savedSessions, workspace, layout, window, plugins, sessions, errors, createStore, store: createStore() };
  fixtures.push(fixture);
  return fixture;
}

async function preservedCodexConversation(target = runtime) {
  const { CodexTerminalPlugin } = target.load("apps/server/src/plugins/CodexTerminalPlugin.ts");
  const { CodexStateSources } = target.load("apps/server/src/plugins/CodexStateSources.ts");
  const fixture = await savedWorkspace(target);
  const codexHome = path.join(fixture.root, "codex-home");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  const tab = fixture.saved.sessions[1].tab;
  const currentSources = new CurrentCodexStateSources(fixture.root, { CODEX_HOME: codexHome });
  let view;
  try {
    const binding = await currentSources.resolve();
    view = await currentSources.bind(tab.id, binding);
    expect((await currentSources.readBinding(tab.id)).durable).toEqual(binding.durable);
  } finally { await currentSources.dispose(); }
  fixture.sources = new CodexStateSources(fixture.root, { CODEX_HOME: codexHome });
  const transcript = path.join(codexHome, "sessions", `rollout-${conversationId}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: conversationId, cwd: tab.cwd } })}\n`);
  const receipt = path.join(view, ".cloudx-conversation.json");
  fs.writeFileSync(receipt, JSON.stringify({ sessionId: conversationId, cwd: tab.cwd, transcriptPath: transcript }), { mode: 0o600 });
  const factory = { spawn: vi.fn() };
  const plugin = new CodexTerminalPlugin(factory, undefined, fixture.root, fixture.sources);
  const createSession = vi.spyOn(plugin, "createSession").mockResolvedValue({});
  const input = { tab, cwd: tab.cwd, initialInput: fixture.saved.sessions[1].initialInput, prepareCodexSession: vi.fn() };
  return { ...fixture, plugin, factory, createSession, input, receipt, transcript, view };
}

describe("saved-tab recovery in the managed pre-broker target", () => {
  it("recognizes each historical migration anchor and rejects partial integration", () => {
    expect(Object.keys(migrated)).toEqual(SESSION_INTEGRATION_FILES);
    expect(MISSING_SETTINGS_FILES).toContain("apps/server/src/server.ts");
    expect(() => prepareSessionIntegration(file => migrated[file])).toThrow("does not recognize");
  });

  it("restores and explicitly resumes saved conversations on actual 0.1.3 without a Codex preparation callback", async () => {
    const target = historicalRuntime("c664071e04091db6be78df09d8c91a1975e9313c");
    const fixture = await preservedCodexConversation(target);
    fixture.createSession.mockRestore();
    fixture.plugins[1] = fixture.plugin;
    vi.spyOn(target.load("apps/server/src/rulesSkills/CodexHomeOverlay.ts"), "materializeCodexHomeOverlay").mockImplementation(async input => ({
      codexHome: await input.sources.bind(input.tabId, input.source), rulesSkillsRoot: fixture.root, systemRules: [],
    }));
    const terminal = { onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}), kill: vi.fn(), write: vi.fn() };
    fixture.factory.spawn.mockResolvedValue(terminal);
    await fixture.store.restore();
    expect(fixture.factory.spawn).not.toHaveBeenCalled();
    expect(fixture.store.getTab("saved-codex").recovery).toMatchObject({ conversationId, canResume: true });
    expect((await fixture.store.snapshot()).windows.find(window => window.id === fixture.window.id).layout).toEqual(fixture.layout);

    await fixture.store.recoverTab("saved-codex", { action: "resume-conversation", sessionId: conversationId });
    expect(fixture.factory.spawn).toHaveBeenCalledTimes(1);
    const launch = JSON.stringify(fixture.factory.spawn.mock.calls[0]);
    expect(launch).toContain(conversationId);
    expect(launch).toContain("codex-conversation-hook.mjs");
    expect(launch).not.toMatch(/DO_NOT_REPLAY_(PROMPT|COMMAND)/);
    expect(terminal.write).not.toHaveBeenCalled();
    expect(fixture.input.prepareCodexSession).not.toHaveBeenCalled();
    expect((await fixture.savedSessions.read()).sessions[1].initialInput)
      .toEqual({ model: "saved-model", resume: { mode: "session", sessionId: conversationId } });
    expect(fixture.store.getTab("saved-codex").recovery).toBeUndefined();

    const tab = await fixture.store.createTab({ pluginId: "codex-terminal", cwd: fixture.root, initialInput: { model: "saved-model" } });
    const receipt = path.join(fixture.sources.viewPath(tab.id), ".cloudx-conversation.json");
    execFileSync(process.execPath, [path.resolve("apps/server/helpers/codex-conversation-hook.mjs"), receipt], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: conversationId, cwd: tab.cwd, transcript_path: fixture.transcript }),
    });
    await vi.waitFor(async () => {
      expect((await fixture.savedSessions.read()).sessions.find(session => session.tab.id === tab.id).initialInput)
        .toEqual({ model: "saved-model", resume: { mode: "session", sessionId: conversationId } });
    });
  });

  it("preserves native durable source ownership and rejects an unknown historical reader", () => {
    const current = fs.readFileSync(CODEX_SOURCES, "utf8");
    expect(prepareCodexSourceIntegration(current)).toBe(current);
    expect(prepareCodexSourceIntegration(migrated[CODEX_SOURCES])).toBe(migrated[CODEX_SOURCES]);
    expect(() => prepareCodexSourceIntegration(historical(CODEX_SOURCES).replace('"dev,home,ino,sourceId,version"', '"unknown"')))
      .toThrow("does not recognize the target source ownership contract");
  });

  it.each([
    "a9613fafdc0ed1765fcf72ea7d9f61de08c3914a", "26d8291b89309acb59fdea1cbe09234d41d0164f", "643ad8eb1c0ebe12cf4e112d72265fbe53814b65",
    "ad72433b2d6283811fad6bfe288748f2c24b0c5e", historicalCommit,
  ])("recovers current production ownership through the actual %s source reader without replay", async commit => {
    const fixture = await preservedCodexConversation();
    const original = execFileSync("git", ["show", `${commit}:${CODEX_SOURCES}`], { encoding: "utf8" });
    const { CodexStateSources: HistoricalSources } = load(CODEX_SOURCES, { [CODEX_SOURCES]: prepareCodexSourceIntegration(original) }, new Map());
    const file = path.join(fixture.view, ".cloudx-source.json");
    const binding = JSON.parse(fs.readFileSync(file, "utf8"));
    const sources = new HistoricalSources(fixture.root, { CODEX_HOME: binding.home });
    const plugin = new CodexTerminalPlugin(fixture.factory, undefined, fixture.root, sources);
    const createSession = vi.spyOn(plugin, "createSession").mockResolvedValue({});
    try {
      expect(await sources.readBinding(fixture.input.tab.id)).toMatchObject({ durable: binding.durable });
      expect(await plugin.describeRecovery(fixture.input)).toMatchObject({ conversationId, canResume: true });
      await plugin.recoverSession(fixture.input);
      expect(createSession).toHaveBeenCalledExactlyOnceWith({ ...fixture.input,
        initialInput: { model: "saved-model", resume: { mode: "session", sessionId: conversationId } }, prepareCodexSession: undefined,
      });
      expect(fixture.input.prepareCodexSession).not.toHaveBeenCalled();
      createSession.mockClear();
      binding.durable.birthtimeNs = (BigInt(binding.durable.birthtimeNs) + 1n).toString();
      fs.writeFileSync(file, JSON.stringify(binding));
      expect(await plugin.describeRecovery(fixture.input)).toMatchObject({ canResume: false });
      await expect(plugin.recoverSession(fixture.input)).rejects.toThrow("stale");
      expect(createSession).not.toHaveBeenCalled();
    } finally { await sources.dispose(); }
  });

  it("restores tab identities, inputs and split layout without starting terminal sessions", async () => {
    const fixture = await savedWorkspace();
    await fixture.store.restore();
    const snapshot = await fixture.store.snapshot();
    expect(snapshot.activeTabId).toBe(fixture.saved.activeTabId);
    expect(snapshot.tabs.map(tab => tab.id)).toEqual(fixture.saved.sessions.map(session => session.tab.id));
    expect(snapshot.windows.find(window => window.id === fixture.window.id).layout).toEqual(fixture.layout);
    for (const plugin of fixture.plugins.slice(0, 2)) expect(plugin.createSession).not.toHaveBeenCalled();
    expect(fixture.plugins[2].createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      tab: expect.objectContaining({ id: "saved-web" }), initialInput: fixture.saved.sessions[2].initialInput,
    }));
    for (const id of ["saved-shell", "saved-codex"]) expect(fixture.store.getTab(id)).toMatchObject({ status: "stopped", recovery: { state: "missing" } });
    const persisted = await new SessionStateStore(fixture.root).read();
    expect(persisted.sessions.map(session => session.initialInput)).toEqual(fixture.saved.sessions.map(session => session.initialInput));
    expect(fs.statSync(path.join(fixture.root, "sessions.json")).mode & 0o777).toBe(0o600);
  });

  it("preserves the saved profile across shutdown and another historical service start", async () => {
    const fixture = await savedWorkspace();
    await fixture.store.restore();
    await fixture.store.dispose();
    expect((await fixture.savedSessions.read()).sessions).toHaveLength(3);
    fixture.store = fixture.createStore();
    await fixture.store.restore();
    expect((await fixture.store.snapshot()).windows.find(window => window.id === fixture.window.id).layout).toEqual(fixture.layout);
    for (const plugin of fixture.plugins.slice(0, 2)) expect(plugin.createSession).not.toHaveBeenCalled();
  });

  it("requires an explicit matching action and never replays saved shell commands or Codex prompts", async () => {
    const fixture = await savedWorkspace();
    await fixture.store.restore();
    for (const [id, request] of [
      ["saved-shell", { action: "reconnect" }],
      ["saved-shell", { action: "new-shell", sessionId: conversationId }],
      ["saved-shell", { action: "resume-conversation", sessionId: conversationId }],
      ["saved-codex", { action: "new-shell" }],
      ["saved-codex", { action: "resume-conversation", sessionId: "last" }],
      ["saved-web", { action: "new-shell" }],
    ]) expect(() => fixture.store.recoverTab(id, request)).toThrow();
    await expect(fixture.store.restartTab("saved-codex")).rejects.toThrow("explicit terminal recovery");
    await fixture.store.recoverTab("saved-shell", { action: "new-shell" });
    await fixture.store.recoverTab("saved-codex", { action: "resume-conversation", sessionId: conversationId });
    expect(fixture.plugins[0].createSession.mock.calls[0][0].initialInput).toBeUndefined();
    expect(fixture.plugins[1].createSession.mock.calls[0][0].initialInput).toEqual({ model: "saved-model", resume: { mode: "session", sessionId: conversationId } });
    expect(fixture.store.getTab("saved-codex").recovery).toBeUndefined();
    expect(() => fixture.store.recoverTab("saved-codex", { action: "resume-conversation", sessionId: conversationId })).toThrow();
  });

  it("deduplicates the same recovery while rejecting a different conversation and closing during launch", async () => {
    const fixture = await savedWorkspace();
    await fixture.store.restore();
    const plugin = fixture.plugins[1];
    const createSession = plugin.createSession.getMockImplementation();
    let finish;
    plugin.createSession.mockImplementation(input => new Promise(resolve => { finish = async () => resolve(await createSession(input)); }));
    const request = { action: "resume-conversation", sessionId: conversationId };
    const first = fixture.store.recoverTab("saved-codex", request);
    expect(fixture.store.recoverTab("saved-codex", request)).toBe(first);
    let differentRequestRejected = false;
    try { fixture.store.recoverTab("saved-codex", { ...request, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }); }
    catch { differentRequestRejected = true; }
    expect(() => fixture.store.closeTab("saved-codex")).toThrow("recovery");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await finish();
    await first;
    expect(plugin.createSession).toHaveBeenCalledTimes(1);
    expect(differentRequestRejected).toBe(true);
  });

  it("persists new tabs, closed tabs, active tab selection and the latest local-web URL", async () => {
    const fixture = await savedWorkspace();
    await fixture.store.restore();
    const added = await fixture.store.createTab({ pluginId: "local-web", cwd: fixture.root, initialInput: { url: "http://localhost:4200/new" } });
    fixture.store.closeTab("saved-shell");
    fixture.store.setActiveTab(added.id);
    const web = fixture.sessions.get("saved-web");
    web.state.url = "http://localhost:4200/navigated?view=latest";
    web.controls.setTabIndicator({ color: "green", label: "Navigated" });
    await fixture.store.flush();
    const persisted = await new SessionStateStore(fixture.root).read();
    expect(persisted.activeTabId).toBe(added.id);
    expect(persisted.sessions.map(session => session.tab.id)).toEqual(["saved-codex", "saved-web", added.id]);
    expect(persisted.sessions.find(session => session.tab.id === "saved-web").initialInput).toEqual({ url: web.state.url });
    expect(persisted.sessions.find(session => session.tab.id === added.id).initialInput).toEqual({ url: "http://localhost:4200/new" });
  });

  it("copies restored input and ignores late callbacks after tab closure or service disposal", async () => {
    const fixture = await savedWorkspace();
    await fixture.store.restore();
    await fixture.store.recoverTab("saved-codex", { action: "resume-conversation", sessionId: conversationId });
    const controls = fixture.sessions.get("saved-codex").controls;
    const initialInput = { resume: { mode: "session", sessionId: conversationId } };
    await controls.setRestoreInput(initialInput);
    initialInput.resume.sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await fixture.store.flush();
    expect((await fixture.savedSessions.read()).sessions.find(session => session.tab.id === "saved-codex").initialInput)
      .toEqual({ resume: { mode: "session", sessionId: conversationId } });
    fixture.store.closeTab("saved-codex");
    await fixture.store.flush();
    const file = path.join(fixture.root, "sessions.json");
    const closed = fs.readFileSync(file);
    await expect(controls.setRestoreInput(initialInput)).resolves.toBeUndefined();
    expect(fs.readFileSync(file)).toEqual(closed);
    expect(fixture.store.listTabs().map(tab => tab.id)).toEqual(["saved-shell", "saved-web"]);
    const webControls = fixture.sessions.get("saved-web").controls;
    await fixture.store.dispose();
    const stopped = fs.readFileSync(file);
    await expect(webControls.setRestoreInput({ url: "http://localhost:4200/late" })).resolves.toBeUndefined();
    expect(fs.readFileSync(file)).toEqual(stopped);
    expect(fixture.store.listTabs()).toEqual([]);
  });

  it("does not launch a recovered terminal when the durable sessions write fails", async () => {
    const fixture = await savedWorkspace();
    await fixture.store.restore();
    const file = path.join(fixture.root, "sessions.json");
    const original = fs.readFileSync(file);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    try {
      await expect(fixture.store.recoverTab("saved-shell", { action: "new-shell" })).rejects.toThrow("regular file");
      expect(fixture.plugins[0].createSession).not.toHaveBeenCalled();
      await expect(fixture.savedSessions.flush()).rejects.toThrow("regular file");
    } finally {
      fs.rmdirSync(file);
      fs.writeFileSync(file, original, { mode: 0o600 });
    }
    await fixture.store.flush();
    expect(fixture.errors).toHaveBeenCalled();
  });

  it("validates the preserved Codex source, receipt and transcript before resuming without a prompt", async () => {
    const fixture = await preservedCodexConversation();
    const receipt = fs.readFileSync(fixture.receipt);
    await fixture.plugin.recoverSession(fixture.input);
    expect(fixture.createSession).toHaveBeenCalledExactlyOnceWith({ ...fixture.input,
      initialInput: { model: "saved-model", resume: { mode: "session", sessionId: conversationId } }, prepareCodexSession: undefined,
    });
    expect(fixture.input.prepareCodexSession).not.toHaveBeenCalled();
    expect(fs.readFileSync(fixture.receipt)).toEqual(receipt);
    expect((await fixture.savedSessions.read()).sessions[1].initialInput).toEqual(fixture.input.initialInput);
  });

  it("retains five-field historical binding recovery of the exact conversation", async () => {
    const fixture = await preservedCodexConversation();
    const file = path.join(fixture.view, ".cloudx-source.json");
    const binding = JSON.parse(fs.readFileSync(file, "utf8"));
    delete binding.durable;
    fs.writeFileSync(file, JSON.stringify(binding));
    expect(await fixture.plugin.describeRecovery(fixture.input)).toMatchObject({ conversationId, canResume: true });
    await fixture.plugin.recoverSession(fixture.input);
    expect(fixture.createSession).toHaveBeenCalledExactlyOnceWith({ ...fixture.input,
      initialInput: { model: "saved-model", resume: { mode: "session", sessionId: conversationId } }, prepareCodexSession: undefined,
    });
    expect(fixture.input.prepareCodexSession).not.toHaveBeenCalled();
  });

  it("matches current ownership validation when device numbering changes before historical recovery", async () => {
    const fixture = await preservedCodexConversation();
    const file = path.join(fixture.view, ".cloudx-source.json");
    const binding = JSON.parse(fs.readFileSync(file, "utf8"));
    binding.dev = (BigInt(binding.dev) + 1n).toString();
    fs.writeFileSync(file, JSON.stringify(binding));
    const sources = new CurrentCodexStateSources(fixture.root, { CODEX_HOME: binding.home });
    let current;
    try { current = await sources.readBinding(fixture.input.tab.id).catch(() => undefined); }
    finally { await sources.dispose(); }
    const description = await fixture.plugin.describeRecovery(fixture.input);
    expect(description.canResume).toBe(current !== undefined);
    if (current) {
      expect(description.conversationId).toBe(conversationId);
      await fixture.plugin.recoverSession(fixture.input);
      expect(fixture.createSession).toHaveBeenCalledExactlyOnceWith({ ...fixture.input,
        initialInput: { model: "saved-model", resume: { mode: "session", sessionId: conversationId } }, prepareCodexSession: undefined,
      });
    } else {
      expect(description.conversationId).toBeUndefined();
      await expect(fixture.plugin.recoverSession(fixture.input)).rejects.toThrow("stale");
      expect(fixture.createSession).not.toHaveBeenCalled();
    }
  });

  it("exposes the validated preserved conversation in the restored workspace without launching it", async () => {
    const fixture = await preservedCodexConversation();
    fixture.plugins[1] = fixture.plugin;
    await fixture.store.restore();
    const snapshot = await fixture.store.snapshot();
    expect(snapshot.tabs.find(tab => tab.id === "saved-codex").recovery).toMatchObject({ conversationId, canResume: true });
    expect((await fixture.savedSessions.read()).sessions[1].tab.recovery).toMatchObject({ conversationId, canResume: true });
    expect(fixture.createSession).not.toHaveBeenCalled();
    expect(fixture.factory.spawn).not.toHaveBeenCalled();
  });

  it.each(["before binding", "after binding", "clean early exit"])("permits explicit same-tab recovery after an exited Codex launch: %s", async timing => {
    const fixture = await preservedCodexConversation();
    fixture.createSession.mockRestore();
    fixture.plugins[1] = fixture.plugin;
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    vi.spyOn(load("apps/server/src/rulesSkills/CodexHomeOverlay.ts"), "materializeCodexHomeOverlay").mockImplementation(async input => ({
      codexHome: await input.sources.bind(input.tabId, input.source), rulesSkillsRoot: fixture.root, systemRules: [],
    }));
    const terminals = [];
    const exitConfirmation = Promise.withResolvers();
    fixture.factory.spawn.mockImplementation(async () => {
      const terminal = { onData: vi.fn(() => () => {}), write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
        terminate: vi.fn(() => exitConfirmation.promise),
        onExit: vi.fn(callback => {
          terminal.exit = callback;
          if (timing === "before binding" && terminals.length === 1) callback({ exitCode: 127 });
          return () => {};
        }) };
      terminals.push(terminal);
      return terminal;
    });
    await fixture.store.restore();
    const request = { action: "resume-conversation", sessionId: conversationId };
    await fixture.store.recoverTab("saved-codex", request);
    if (timing !== "before binding") terminals[0].exit({ exitCode: timing === "clean early exit" ? 0 : 127 });
    try {
      expect(fixture.store.getTab("saved-codex").recovery).toMatchObject({ state: "unavailable", canResume: false });
      expect(fixture.store.getSession("saved-codex")).toBeDefined();
      expect(() => fixture.store.recoverTab("saved-codex", request)).toThrow("no interrupted terminal");
      expect(fixture.factory.spawn).toHaveBeenCalledTimes(1);
      expect(terminals[0].terminate).toHaveBeenCalledTimes(1);
    } finally { exitConfirmation.resolve(); }
    await vi.waitFor(() => expect(fixture.store.getTab("saved-codex")).toMatchObject({
      status: timing === "clean early exit" ? "completed" : "failed", recovery: { conversationId, canResume: true },
    }));
    expect(() => fixture.store.getSession("saved-codex")).toThrow();
    await fixture.store.flush();
    expect((await fixture.savedSessions.read()).sessions[1].tab.recovery).toMatchObject({ conversationId, canResume: true });
    expect(fixture.factory.spawn).toHaveBeenCalledTimes(1);
    const recovery = fixture.store.recoverTab("saved-codex", request);
    expect(fixture.store.recoverTab("saved-codex", request)).toBe(recovery);
    await recovery;
    expect(fixture.factory.spawn).toHaveBeenCalledTimes(2);
    expect(fixture.store.getTab("saved-codex").recovery).toBeUndefined();
    const replacement = fixture.store.getSession("saved-codex");
    terminals[0].exit({ exitCode: 127 });
    expect(fixture.store.getSession("saved-codex")).toBe(replacement);
    expect(fixture.store.getTab("saved-codex").recovery).toBeUndefined();
    const snapshot = await fixture.store.snapshot();
    expect(snapshot.tabs.map(tab => tab.id)).toEqual(fixture.saved.sessions.map(session => session.tab.id));
    expect(snapshot.windows.find(window => window.id === fixture.window.id).layout).toEqual(fixture.layout);
    for (const terminal of terminals) expect(terminal.write).not.toHaveBeenCalled();
    for (const args of fixture.factory.spawn.mock.calls) {
      expect(JSON.stringify(args)).toContain(conversationId);
      expect(JSON.stringify(args)).not.toMatch(/DO_NOT_REPLAY_(PROMPT|COMMAND)/);
    }
    replacement.setStatus("failed", "Failure without an exit confirmation");
    expect(fixture.store.getSession("saved-codex")).toBe(replacement);
    expect(() => fixture.store.recoverTab("saved-codex", request)).toThrow();
  });

  it("keeps ownership when the historical supervisor cannot confirm that descendants stopped", async () => {
    const fixture = await preservedCodexConversation();
    fixture.createSession.mockRestore();
    fixture.plugins[1] = fixture.plugin;
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    vi.spyOn(load("apps/server/src/rulesSkills/CodexHomeOverlay.ts"), "materializeCodexHomeOverlay").mockImplementation(async input => ({
      codexHome: await input.sources.bind(input.tabId, input.source), rulesSkillsRoot: fixture.root, systemRules: [],
    }));
    const { NodePtyTerminalProcess } = load("apps/server/src/terminal/NodePtyTerminalProcess.ts");
    const { promise: completion, resolve: complete } = Promise.withResolvers();
    const error = new Error("Terminal supervisor exited without confirming its descendants stopped.");
    const supervisor = { completion, kill: vi.fn(), terminate: vi.fn(async () => { throw error; }) };
    const terminal = new NodePtyTerminalProcess({ onExit: vi.fn(), onData: vi.fn() }, supervisor);
    fixture.factory.spawn.mockResolvedValue(terminal);
    await fixture.store.restore();
    const request = { action: "resume-conversation", sessionId: conversationId };
    await fixture.store.recoverTab("saved-codex", request);
    const owned = fixture.store.getSession("saved-codex");
    complete({ event: { exitCode: 125 }, error });
    await vi.waitFor(() => expect(fixture.store.getTab("saved-codex")).toMatchObject({ status: "failed",
      recovery: { state: "unavailable", canResume: false, message: error.message } }));
    expect(supervisor.terminate).toHaveBeenCalledTimes(1);
    expect(fixture.store.getSession("saved-codex")).toBe(owned);
    expect(() => fixture.store.recoverTab("saved-codex", request)).toThrow();
    expect(fixture.factory.spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "exit"])("records native helper identity for a new Codex tab and removes its observer on %s", async ending => {
    const fixture = await preservedCodexConversation();
    fixture.createSession.mockRestore();
    await fixture.store.restore();
    fixture.plugins[1] = fixture.plugin;
    vi.spyOn(load("apps/server/src/rulesSkills/CodexHomeOverlay.ts"), "materializeCodexHomeOverlay").mockImplementation(async input => ({
      codexHome: await input.sources.bind(input.tabId, input.source), rulesSkillsRoot: fixture.root, systemRules: [],
    }));
    let exit;
    const terminal = { onData: vi.fn(() => () => {}), onExit: vi.fn(callback => { exit = callback; return () => {}; }), kill: vi.fn() };
    fixture.factory.spawn.mockResolvedValue(terminal);
    const unwatch = vi.spyOn(fs, "unwatchFile");
    const tab = await fixture.store.createTab({ pluginId: "codex-terminal", cwd: fixture.root, initialInput: { model: "saved-model" } });
    expect(fixture.factory.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fixture.factory.spawn.mock.calls[0])).toContain("codex-conversation-hook.mjs");
    await expect(fixture.store.restartTab(tab.id)).rejects.toThrow("replace the saved conversation");
    const receipt = path.join(fixture.sources.viewPath(tab.id), ".cloudx-conversation.json");
    const event = { hook_event_name: "SessionStart", session_id: conversationId, cwd: tab.cwd, transcript_path: fixture.transcript };
    execFileSync(process.execPath, [path.resolve("apps/server/helpers/codex-conversation-hook.mjs"), receipt], { input: JSON.stringify(event) });
    await vi.waitFor(async () => {
      const saved = (await fixture.savedSessions.read()).sessions.find(session => session.tab.id === tab.id);
      expect(saved.initialInput).toEqual({ model: "saved-model", resume: { mode: "session", sessionId: conversationId } });
    });
    expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toEqual({ sessionId: conversationId, cwd: tab.cwd, transcriptPath: fixture.transcript });
    expect(fs.statSync(receipt).mode & 0o777).toBe(0o600);
    await fixture.store.snapshot();
    expect(inspectTerminalRecovery({ dataDir: fixture.root })).toEqual({ legacySessionIdentitiesUnavailable: false, warnings: [] });
    if (ending === "stop") fixture.store.getSession(tab.id).stop();
    else exit({ exitCode: 0 });
    expect(unwatch).toHaveBeenCalledWith(receipt, expect.any(Function));
  });

  it.each([
    ["different selected conversation", fixture => { fixture.input.initialInput = { resume: { mode: "session", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }; }, "preserved conversation only"],
    ["implicit conversation selection", fixture => { fixture.input.initialInput = { resume: { mode: "last" } }; }, "exact preserved"],
    ["missing receipt", fixture => fs.unlinkSync(fixture.receipt), "preserved conversation only"],
    ["missing transcript", fixture => fs.unlinkSync(fixture.transcript), "unavailable"],
    ["conflicting transcript identity", fixture => fs.writeFileSync(fixture.transcript, JSON.stringify({ type: "session_meta", payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } })), "unavailable"],
    ["invalid transcript metadata", fixture => fs.writeFileSync(fixture.transcript, "not-json"), "invalid metadata"],
    ["stale source binding", fixture => {
      const file = path.join(fixture.view, ".cloudx-source.json");
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ino: "0" }));
    }, "stale"],
    ...["filesystemId", "filesystemType", "birthtimeNs", "uid"].map(field => [`changed source ${field}`, fixture => {
      const file = path.join(fixture.view, ".cloudx-source.json");
      const binding = JSON.parse(fs.readFileSync(file, "utf8"));
      binding.durable[field] = binding.durable[field] === "1" ? "2" : "1";
      fs.writeFileSync(file, JSON.stringify(binding));
    }, "stale"]),
    ["invalid durable source binding", fixture => {
      const file = path.join(fixture.view, ".cloudx-source.json");
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), durable: {} }));
    }, "Invalid Codex source binding"],
    ["replaced source directory", fixture => {
      const home = path.dirname(path.dirname(fixture.transcript));
      fs.renameSync(home, `${home}.original`);
      fs.cpSync(`${home}.original`, home, { recursive: true });
    }, "stale"],
  ])("rejects %s before launch without changing saved session inputs", async (_reason, corrupt, message) => {
    const fixture = await preservedCodexConversation();
    corrupt(fixture);
    // Stored recovery metadata alone cannot enable a resume after validation fails.
    fixture.saved.sessions[1].tab.recovery = { state: "missing", message: "Saved", conversationId, canResume: true };
    await fixture.savedSessions.save(fixture.saved);
    fixture.plugins[1] = fixture.plugin;
    if (_reason === "different selected conversation" || _reason === "implicit conversation selection") {
      // These request mutations leave the preserved receipt valid for discovery.
      expect(await fixture.plugin.describeRecovery(fixture.input)).toMatchObject({ conversationId, canResume: true });
    } else {
      await fixture.store.restore();
      expect(fixture.store.getTab("saved-codex").recovery).toMatchObject({ canResume: false });
      expect(fixture.store.getTab("saved-codex").recovery.conversationId).toBeUndefined();
    }
    const beforeRecovery = fs.readFileSync(path.join(fixture.root, "sessions.json"));
    await expect(fixture.plugin.recoverSession(fixture.input)).rejects.toThrow(message);
    expect(fixture.createSession).not.toHaveBeenCalled();
    expect(fixture.factory.spawn).not.toHaveBeenCalled();
    expect(fixture.input.prepareCodexSession).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(fixture.root, "sessions.json"))).toEqual(beforeRecovery);
  });
});
