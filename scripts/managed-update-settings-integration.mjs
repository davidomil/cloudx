const SERVER = "apps/server/src/server.ts";
const WORKSPACE = "apps/server/src/workspace/WorkspaceLayoutStore.ts";
const SHARED = "packages/shared/src/index.ts";
const APP = "apps/web/src/ui/App.tsx";
const SETTINGS = "apps/web/src/ui/SettingsDialog.tsx";
const API = "apps/web/src/api.ts";
const WRITES = "apps/web/src/ui/workspaceWriteCoordinator.ts";

export const MISSING_SETTINGS_FILES = [SERVER, WORKSPACE, SHARED, APP, SETTINGS, API, WRITES];

// Prepare the whole recognized historical integration before any source is written.
export function prepareMissingSettingsIntegration(readSource) {
  const changes = Object.fromEntries(MISSING_SETTINGS_FILES.map(file => [file, readSource(file)]));
  function requireAnchor(file, anchor) {
    if (changes[file].split(anchor).length !== 2)
      throw new Error(`Managed updater integration does not recognize the target's missing Settings contract in ${file}.`);
  }
  function replace(file, before, after) {
    requireAnchor(file, before);
    changes[file] = changes[file].replace(before, after);
  }
  function insertBefore(file, anchor, addition) { replace(file, anchor, addition + anchor); }
  function insertAfter(file, anchor, addition) { replace(file, anchor, anchor + addition); }

  for (const file of MISSING_SETTINGS_FILES) {
    if (/CloudxUpdate|cloudxUpdate|persistDurably\(|flushDurably\(|persistWorkspace\(/.test(changes[file]))
      throw new Error(`Managed updater integration found an incomplete Settings migration in ${file}.`);
  }

  insertAfter(SERVER, 'import { SessionStore } from "./sessionStore.js";\n',
    'import { CloudxUpdateService } from "./system/CloudxUpdateService.js";\nimport { registerCloudxUpdateRoutes } from "./system/CloudxUpdateRoutes.js";\n');
  insertAfter(SERVER, '  config?: ConfigService;\n', '  updates?: Pick<CloudxUpdateService, "status" | "start" | "preview" | "selectChannel">;\n');
  insertAfter(SERVER, '  if (services.forgeConnections) registerForgeConnectionRoutes(app, services.forgeConnections, config.trustedOrigins);\n',
    '  registerCloudxUpdateRoutes(app, services.updates ?? new CloudxUpdateService(config.dataDir), config.trustedOrigins);\n');
  insertAfter(SERVER, '  app.get("/api/workspace", async () => workspaceState(services));\n', `
  app.post("/api/workspace/persist", async () => {
    await services.workspace!.persistDurably();
    return { ok: true };
  });
`);
  insertBefore(WORKSPACE, '  async state(tabs: WorkspaceTab[], activeTabId?: string): Promise<WorkspaceStateResponse> {\n', `  async persistDurably(): Promise<void> {
    return this.serializeWorkspaceAccess(() => this.persist(true));
  }

`);
  // These are the existing serialized persistence and capacity-error contracts.
  requireAnchor(WORKSPACE, '  private async persist(requireDurable = false, state: WorkspacePersistenceState = this.persistenceState()): Promise<void> {');
  requireAnchor(WORKSPACE, '        if (requireDurable) {\n          throw error;\n        }');
  insertAfter(SHARED, 'export * from "./forgeConnections.js";\n', 'export * from "./cloudxUpdate.js";\n');

  insertAfter(APP, 'import { SettingsDialog } from "./SettingsDialog.js";\n', 'import { useCloudxUpdate } from "./CloudxUpdatePanel.js";\n');
  insertAfter(APP, '  getWorkspace,\n', '  persistWorkspace,\n  persistWindowLayout,\n');
  replace(APP, '      await updateWindow(windowId, { layout: persistedLayout });', '      await persistWindowLayout(windowId, persistedLayout);');
  insertAfter(APP, '  const workspaceWrites = workspaceWritesRef.current;\n',
    '  const saveWorkspace = useCallback(() => workspaceWrites.flushDurably(persistWorkspace), [workspaceWrites]);\n  const cloudxUpdate = useCloudxUpdate(settingsOpen, saveWorkspace);\n');
  insertAfter(APP, '        <SettingsDialog\n          config={config}\n', '          cloudxUpdate={cloudxUpdate}\n');

  insertAfter(SETTINGS, 'import { ControlButton } from "./Control.js";\n', 'import { CloudxUpdatePanel, type CloudxUpdateController } from "./CloudxUpdatePanel.js";\n');
  insertAfter(SETTINGS, 'export function SettingsDialog({\n  config,\n', '  cloudxUpdate,\n');
  insertAfter(SETTINGS, '  config: CloudxConfigResponse;\n', '  cloudxUpdate?: CloudxUpdateController;\n');
  const categories = '  const categories: SettingsCategory[] = [{\n';
  const sections = '  const globalFields = config.globalFields.filter(isUserVisibleConfigField);\n';
  if (changes[SETTINGS].includes(categories) === changes[SETTINGS].includes(sections))
    throw new Error("Managed updater integration does not recognize the target's Settings layout.");
  if (changes[SETTINGS].includes(categories)) {
    requireAnchor(SETTINGS, categories);
    insertBefore(SETTINGS, '  const searchWords = query.trim().toLowerCase().split(/\\s+/).filter(Boolean);', `  if (cloudxUpdate) categories.push({
    id: "updates",
    label: "Updates",
    description: "Update CloudX and the tools managed by its installer.",
    entries: [{
      id: "cloudx-update",
      searchText: "Updates CloudX Codex dependencies installer upgrade restart sessions layout release channel cycle main changelog pull requests",
      content: <CloudxUpdatePanel update={cloudxUpdate} />
    }]
  });

`);
  } else {
    requireAnchor(SETTINGS, sections);
    insertAfter(SETTINGS, '        {children}\n', `        {cloudxUpdate ? (
          <section className="settings-section" aria-label="Updates">
            <h3>Updates</h3>
            <CloudxUpdatePanel update={cloudxUpdate} />
          </section>
        ) : null}
`);
  }

  if (!changes[API].includes("export class HttpError extends Error {")) {
    insertBefore(API, 'export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {\n', `export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

`);
    replace(API, '    throw new Error(errorMessageFromResponse(text, response.status));',
      '    throw new HttpError(response.status, errorMessageFromResponse(text, response.status));');
  }
  insertAfter(API, '  WorkspaceStateResponse,\n', '  TabLayoutState,\n');
  insertAfter(API, 'export async function getWorkspace(): Promise<WorkspaceStateResponse> {\n  return fetchJson("/api/workspace");\n}\n', `
export async function persistWorkspace(): Promise<void> {
  await fetchJson("/api/workspace/persist", { method: "POST", body: "{}" });
}

export async function persistWindowLayout(windowId: string, layout: TabLayoutState): Promise<void> {
  const state = await updateWindow(windowId, { layout });
  const status = state.persistence?.find(status => status.name === "Workspace layout");
  if (status?.state !== "available") {
    throw new Error(\`Workspace layout could not be saved to disk: \${status?.code ?? "persistence unconfirmed"}\${status?.message ? ": " + status.message : ""}\`);
  }
}
`);

  insertAfter(WRITES, '  layout: TabLayoutState;\n', '  failed?: boolean;\n');
  insertAfter(WRITES, '  private tail: Promise<void> = Promise.resolve();\n', '  private outstanding = new Set<Promise<unknown>>();\n');
  replace(WRITES, '      void this.flush().catch(this.reportError);', `      void this.enqueue(async () => {
        if (!this.pendingLayout?.failed) await this.flushPendingLayouts();
      }).catch(() => undefined);`);
  replace(WRITES, `  flush(): Promise<void> {
    this.clearTimer();
    return this.pendingLayout ? this.enqueue(() => this.flushPendingLayouts()) : this.tail;
  }`, `  async flush(): Promise<void> {
    this.clearTimer();
    while (this.outstanding.size || this.pendingLayout) {
      if (this.outstanding.size) await Promise.all(this.outstanding);
      else await this.enqueue(() => this.flushPendingLayouts());
    }
  }

  async flushDurably(persistWorkspace: () => Promise<void>): Promise<void> {
    do {
      await this.flush();
      await Promise.all([...this.outstanding, this.enqueue(persistWorkspace)]);
    } while (this.outstanding.size || this.pendingLayout);
  }`);
  replace(WRITES, '    this.tail = run.then(() => undefined, () => undefined);', `    this.outstanding.add(run);
    const settled = () => { this.outstanding.delete(run); };
    this.tail = run.then(settled, settled);`);
  insertAfter(WRITES, '      } catch (error) {\n', '        pending.failed = true;\n');
  insertAfter(WRITES, '        this.pendingLayout ??= pending;\n', '        this.reportError(error);\n');
  return changes;
}
