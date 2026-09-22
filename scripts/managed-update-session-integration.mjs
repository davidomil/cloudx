const STORE = "apps/server/src/sessionStore.ts";
const SERVER = "apps/server/src/server.ts";
const SHARED = "packages/shared/src/index.ts";
const PANEL = "apps/web/src/ui/TerminalPanel.tsx";
const API = "apps/web/src/api.ts";
const CODEX = "apps/server/src/plugins/CodexTerminalPlugin.ts";
const PLUGINS = "packages/plugin-api/src/index.ts";

export const SESSION_INTEGRATION_FILES = [STORE, SERVER, SHARED, PANEL, API, CODEX, PLUGINS];
export const SESSION_PERSISTENCE_FILES = ["apps/server/src/workspace/SessionStateStore.ts", "apps/server/src/jsonStateFile.ts",
  "apps/server/src/plugins/CodexConversationRecovery.ts", "apps/server/helpers/codex-conversation-hook.mjs"];

// Give the recognized in-memory release one session authority, using the same
// saved format as the source and next release. Terminal creation stays explicit.
export function prepareSessionIntegration(readSource) {
  const changes = Object.fromEntries(SESSION_INTEGRATION_FILES.map(file => [file, readSource(file)]));
  function replace(file, before, after) {
    if (changes[file].split(before).length !== 2)
      throw new Error(`Managed session recovery does not recognize the target contract in ${file}.`);
    changes[file] = changes[file].replace(before, after);
  }
  function before(file, anchor, addition) { replace(file, anchor, addition + anchor); }
  function after(file, anchor, addition) { replace(file, anchor, anchor + addition); }

  after(STORE, 'import type { ConfigValue } from "@cloudx/shared";\n', 'import type { RecoverTabRequest } from "@cloudx/shared";\nimport type { SessionStateStore } from "./workspace/SessionStateStore.js";\n');
  before(STORE, '  constructor(\n', `  private readonly initialInputs = new Map<string, Record<string, unknown> | undefined>();
  private readonly recoveries = new Map<string, { request: RecoverTabRequest; promise: Promise<WorkspaceTab> }>();
  private preservingSessions = false;

`);
  replace(STORE, '    private readonly backgroundErrorReporter: SessionBackgroundErrorReporter = reportSessionBackgroundError\n',
    '    private readonly backgroundErrorReporter: SessionBackgroundErrorReporter = reportSessionBackgroundError,\n    private readonly savedSessions?: SessionStateStore\n');
  before(STORE, '  setHookRegistry(hooks: HookRegistry): void {\n', `  async restore(afterSetup?: Promise<unknown>): Promise<void> {
    if (this.tabs.size) return;
    const saved = await this.savedSessions?.read();
    if (!saved) return;
    await afterSetup;
    this.preservingSessions = true;
    try {
      for (const { tab, initialInput } of saved.sessions) {
        this.tabs.set(tab.id, { ...tab });
        this.initialInputs.set(tab.id, initialInput);
      }
      this.activeTabId = saved.activeTabId;
      for (const { tab, initialInput } of saved.sessions) {
        try {
          const plugin = this.plugins.get(tab.pluginId);
          if (plugin.panelKind === "terminal") {
            const message = "The previous terminal was interrupted. Start a new shell or select an exact saved Codex conversation. Saved commands and prompts will not be replayed.";
            this.updateTab(tab.id, { status: "stopped", statusMessage: message,
              recovery: { ...tab.recovery, state: "missing", message }, indicator: indicatorForStatus("stopped", message) });
            continue;
          }
          const cwd = await this.pathPolicy.ensureDirectory(tab.cwd, false);
          this.bindSession(tab.id, await plugin.createSession({
            tab: this.getTab(tab.id), cwd, initialInput,
            runtimeContext: await this.runtimeContextResolver?.runtimeContextFor(tab, this.workspace?.findWindowForTab(tab.id)),
            app: this.createAppContext(plugin.id, tab.id), controls: this.createControls(tab.id),
            config: this.configProvider.getPluginConfig(plugin.id), getConfig: () => this.configProvider.getPluginConfig(plugin.id)
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.updateTab(tab.id, { status: "failed", statusMessage: message, indicator: indicatorForStatus("failed", message) });
        }
      }
    } finally { this.preservingSessions = false; }
    this.emitTabsChange();
    await this.savedSessions?.flush();
  }

  async flush(): Promise<void> {
    this.persistSessions();
    await this.savedSessions?.flush();
  }

  recoverTab(tabId: string, request: RecoverTabRequest): Promise<WorkspaceTab> {
    const tab = this.getTab(tabId);
    if (tab.ownerPluginId || !tab.recovery || this.sessions.has(tabId)) throw new Error("This tab has no interrupted terminal to recover.");
    if (!(request.action === "new-shell" && tab.pluginId === "standard-terminal" && request.sessionId === undefined ||
        request.action === "resume-conversation" && tab.pluginId === "codex-terminal" &&
        typeof request.sessionId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(request.sessionId)))
      throw new Error("Choose a new shell or an exact Codex conversation ID for this tab.");
    const pending = this.recoveries.get(tabId);
    if (pending) {
      if (pending.request.action !== request.action || pending.request.sessionId !== request.sessionId)
        throw new Error("A different recovery request is already pending for this tab.");
      return pending.promise;
    }
    const recovery = this.admitAction(undefined, async signal => {
      const plugin = this.plugins.get(tab.pluginId);
      const cwd = await this.pathPolicy.ensureDirectory(tab.cwd, false);
      const runtimeContext = await this.runtimeContextResolver?.runtimeContextFor(tab, this.workspace?.findWindowForTab(tabId));
      this.updateTab(tabId, { status: "starting" });
      await this.flush();
      signal.throwIfAborted();
      const { prompt: _prompt, ...savedInput } = this.initialInputs.get(tabId) ?? {};
      const createSession = request.action === "resume-conversation" ? plugin.recoverSession : plugin.createSession;
      if (!createSession) throw new Error("This plugin cannot recover a saved conversation.");
      const session = await createSession.call(plugin, {
        tab: this.getTab(tabId), cwd, runtimeContext,
        initialInput: request.action === "resume-conversation" ? { ...savedInput, resume: { mode: "session", sessionId: request.sessionId } } : undefined,
        app: this.createAppContext(plugin.id, tabId), controls: this.createControls(tabId),
        config: this.configProvider.getPluginConfig(plugin.id), getConfig: () => this.configProvider.getPluginConfig(plugin.id)
      });
      if (request.action === "resume-conversation") this.initialInputs.set(tabId, {
        ...this.initialInputs.get(tabId), resume: { mode: "session", sessionId: request.sessionId }
      });
      this.bindSession(tabId, session);
      await this.flush();
      return this.getTab(tabId);
    });
    this.recoveries.set(tabId, { request: { ...request }, promise: recovery });
    void recovery.then(() => this.recoveries.delete(tabId), error => {
      this.recoveries.delete(tabId);
      if (this.tabs.has(tabId)) this.updateTab(tabId, { status: "failed", statusMessage: error instanceof Error ? error.message : String(error) });
    });
    return recovery;
  }

  private persistSessions(): void {
    if (!this.savedSessions || this.preservingSessions) return;
    const tabs = this.listTabs().filter(tab => !tab.ownerPluginId);
    void this.savedSessions.save({ version: 1,
      activeTabId: tabs.some(tab => tab.id === this.activeTabId) ? this.activeTabId : undefined,
      sessions: tabs.map(tab => {
        let initialInput = this.initialInputs.get(tab.id);
        const session = this.sessions.get(tab.id);
        if (tab.pluginId === "local-web" && session) initialInput = { ...initialInput, url: session.snapshot().state?.url };
        return { tab, initialInput };
      })
    }).catch(error => this.reportBackgroundError(error, "persist open tabs", "workspace"));
  }

`);
  after(STORE, '      this.tabs.set(id, tab);\n', '      this.initialInputs.set(id, request.initialInput);\n');
  after(STORE, '  closeTab(tabId: string, options: { stopSession?: boolean } = {}): void {\n',
    '    if (this.recoveries.has(tabId)) throw new Error("Wait for terminal recovery before closing this tab.");\n');
  after(STORE, '    this.tabs.delete(tabId);\n', '    this.initialInputs.delete(tabId);\n');
  replace(STORE, '    const errors = this.stopSessions();\n', `    const errors: unknown[] = [];
    if (this.savedSessions) {
      try { await this.flush(); } catch (error) { errors.push(error); }
      this.preservingSessions = true;
    }
    errors.push(...this.stopSessions());
`);
  after(STORE, '  async restartTab(tabId: string, reason = "Restarting tab."): Promise<WorkspaceTab> {\n',
    '    if (this.getTab(tabId).pluginId === "codex-terminal" || this.getTab(tabId).recovery || this.recoveries.has(tabId)) throw new Error("Use the explicit terminal recovery action or open a new tab; restarting would replace the saved conversation.");\n');
  after(STORE, '  private createControls(tabId: string): PluginTabControls {\n    return {\n', `      setRestoreInput: async initialInput => {
        if (!this.tabs.has(tabId) || this.preservingSessions) return;
        this.initialInputs.set(tabId, structuredClone(initialInput));
        await this.flush();
      },
`);
  after(STORE, '  private bindSession(tabId: string, session: PluginSession, templateIndicator?: TabIndicatorUpdate): void {\n',
    '    this.tabs.set(tabId, { ...this.getTab(tabId), recovery: undefined });\n');
  after(STORE, '  private emitTabsChange(): void {\n', '    if (this.preservingSessions) return;\n    this.persistSessions();\n');

  after(SERVER, 'import { SessionStore } from "./sessionStore.js";\n', 'import { SessionStateStore } from "./workspace/SessionStateStore.js";\n');
  after(SERVER, '  services.sessions.setTriggerRegistry?.(services.triggers);\n', '  await services.sessions.restore?.(services.pluginContributionsReady);\n  services.jiraPolling?.start?.();\n  services.forge?.start?.();\n');
  replace(SERVER, '    logger?.error({ err: serializeError(error), ...details }, "session background operation failed");\n  });',
    '    logger?.error({ err: serializeError(error), ...details }, "session background operation failed");\n  }, new SessionStateStore(config.dataDir));');
  replace(SERVER, '  jiraPolling.start();\n  forge.start();\n', '');
  after(SERVER, '  app.post("/api/workspace/persist", async () => {\n', '    await services.sessions.flush();\n');
  before(SERVER, '  app.post<{ Params: { tabId: string }; Body: unknown }>("/api/tabs/:tabId/files/download",', `  app.post<{ Params: { tabId: string }; Body: unknown }>("/api/tabs/:tabId/recover", async request => {
    const body = optionalRequestBody(request.body);
    if (Object.keys(body).some(key => key !== "action" && key !== "sessionId")) throwBadRequest("Unknown recovery field.");
    if (body.action !== "new-shell" && body.action !== "resume-conversation") throwBadRequest("Unknown recovery action.");
    const sessionId = body.sessionId === undefined ? undefined : requiredTrimmedBodyString(body.sessionId, "sessionId");
    return services.sessions.recoverTab(request.params.tabId, { action: body.action, sessionId });
  });

`);
  after(PLUGINS, '  createSession(input: CreatePluginSessionInput): Promise<PluginSession> | PluginSession;\n',
    '  recoverSession?(input: CreatePluginSessionInput): Promise<PluginSession> | PluginSession;\n');
  after(PLUGINS, 'export interface PluginTabControls {\n',
    '  setRestoreInput?(initialInput: Record<string, unknown>): Promise<void>;\n');
  after(CODEX, 'import { CodexStateSources } from "./CodexStateSources.js";\n',
    'import { CodexConversationRecovery } from "./CodexConversationRecovery.js";\n');
  before(CODEX, '  async createSession(input: CreatePluginSessionInput): Promise<PluginSession> {\n', `  async recoverSession(input: CreatePluginSessionInput): Promise<PluginSession> {
    const resume = codexResumeInput(input.initialInput);
    if (resume?.mode !== "session" || !resume.sessionId || !this.sources)
      throw new Error("Select the exact preserved Codex conversation ID.");
    const binding = await this.sources.readBinding(input.tab.id);
    if (!binding) throw new Error("The saved Codex source ownership is unavailable.");
    await this.sources.assertCurrent(binding);
    const conversation = new CodexConversationRecovery(this.sources.viewPath(input.tab.id));
    if (conversation.read()?.sessionId !== resume.sessionId)
      throw new Error("This historical release can recover the preserved conversation only. Open another conversation explicitly in a new tab.");
    await conversation.requireTranscript(resume.sessionId, binding.home);
    const { prompt: _prompt, ...initialInput } = input.initialInput ?? {};
    return this.createSession({ ...input, initialInput, prepareCodexSession: undefined });
  }

`);
  before(CODEX, '    if (input.prepareCodexSession) {\n', '    let restoredInput = { ...input.initialInput };\n');
  after(CODEX, '      initialArgs = buildCodexLaunchArgs([], { ...input.initialInput, resume: { mode: "session", sessionId } });\n',
    '      restoredInput = { ...restoredInput, resume: { mode: "session", sessionId } };\n');
  before(CODEX, '    const command = launchTemplate.command;\n', `    const conversation = launchTemplate.overlay ? new CodexConversationRecovery(launchTemplate.overlay.codexHome) : undefined;
    await input.controls.setRestoreInput?.(restoredInput);
`);
  replace(CODEX, '    const launchArgs = [...launchTemplate.args, ...initialArgs];\n',
    '    const launchArgs = [...launchTemplate.args, ...conversation?.launchArgs() ?? [], ...initialArgs];\n');
  after(CODEX, '      templateName: launchTemplate.templateName,\n', `      observeConversation: () => conversation?.observe(identity => {
        restoredInput = { ...restoredInput, resume: { mode: "session", sessionId: identity.sessionId } };
        return input.controls.setRestoreInput?.(restoredInput);
      }, error => input.controls.setTabIndicator({ color: "red", label: "Conversation identity unavailable",
        message: error instanceof Error ? error.message : String(error) })),
`);
  after(CODEX, 'interface TerminalSessionOptions {\n', '  observeConversation?(): (() => void) | undefined;\n');
  after(CODEX, '  private terminalClosed = false;\n', '  private readonly stopObservingConversation: (() => void) | undefined;\n');
  after(CODEX, '    this.replayBytes = options.replayBytes ?? DEFAULT_TERMINAL_REPLAY_BYTES;\n',
    '    this.stopObservingConversation = options.observeConversation?.();\n');
  after(CODEX, '    this.terminalProcess.onExit((event) => {\n', '      this.stopObservingConversation?.();\n');
  after(CODEX, '  stop(): void {\n', '    this.stopObservingConversation?.();\n');
  replace(SHARED, 'function isCompleteWorkspaceTab(value: unknown): value is WorkspaceTab {', 'export function isCompleteWorkspaceTab(value: unknown): value is WorkspaceTab {');
  before(SHARED, 'export interface WorkspaceTab {\n', `export interface TabRecovery {
  state: "missing" | "unavailable" | "retired";
  message: string;
  conversationId?: string;
  canResume?: boolean;
}
export interface RecoverTabRequest {
  action: "reconnect" | "new-shell" | "resume-conversation";
  sessionId?: string;
}

`);
  after(SHARED, 'export interface WorkspaceTab {\n', '  recovery?: TabRecovery;\n');
  replace(SHARED, '    (value.statusMessage === undefined || typeof value.statusMessage === "string")\n', `    (value.statusMessage === undefined || typeof value.statusMessage === "string") &&
    (value.recovery === undefined || isRecord(value.recovery) &&
      ["missing", "unavailable", "retired"].includes(value.recovery.state as string) && typeof value.recovery.message === "string" &&
      (value.recovery.conversationId === undefined || typeof value.recovery.conversationId === "string") &&
      (value.recovery.canResume === undefined || typeof value.recovery.canResume === "boolean"))
`);
  changes[API] += `\nexport async function recoverTab(tabId: string, request: import("@cloudx/shared").RecoverTabRequest): Promise<WorkspaceTab> {
  return fetchJson(\x60/api/tabs/\x24{encodeURIComponent(tabId)}/recover\x60, { method: "POST", body: JSON.stringify(request) });
}\n`;
  replace(PANEL, 'import { useEffect, useRef } from "react";', 'import { useEffect, useRef, useState } from "react";');
  after(PANEL, 'import { uploadFileBrowserFile } from "../api.js";\n', 'import { recoverTab } from "../api.js";\n');
  replace(PANEL, 'export function TerminalPanel({ tab, active, uiScale }: { tab: WorkspaceTab; active: boolean; uiScale: number }) {', `export function TerminalPanel(props: { tab: WorkspaceTab; active: boolean; uiScale: number }) {
  return props.tab.recovery ? <SavedTerminalRecovery key={props.tab.id} tab={props.tab} /> : <LiveTerminalPanel {...props} />;
}

function SavedTerminalRecovery({ tab }: { tab: WorkspaceTab }) {
  const [sessionId, setSessionId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return <div className="empty-pane" role="region" aria-label="Saved terminal recovery">
    <p>{tab.recovery?.message}</p>
    <p>Directory: <code>{tab.cwd}</code></p>
    {tab.pluginId === "codex-terminal" && <label>Exact Codex conversation ID<input aria-label="Exact Codex conversation ID" value={sessionId} onChange={event => setSessionId(event.target.value)} /></label>}
    {["standard-terminal", "codex-terminal"].includes(tab.pluginId) && <button disabled={pending || tab.pluginId === "codex-terminal" && !sessionId.trim()} onClick={async () => {
      setPending(true); setError("");
      try { await recoverTab(tab.id, tab.pluginId === "standard-terminal" ? { action: "new-shell" } : { action: "resume-conversation", sessionId: sessionId.trim() }); }
      catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { setPending(false); }
    }}>{tab.pluginId === "standard-terminal" ? "Start a new shell" : "Resume selected conversation"}</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

function LiveTerminalPanel({ tab, active, uiScale }: { tab: WorkspaceTab; active: boolean; uiScale: number }) {`);
  return changes;
}
