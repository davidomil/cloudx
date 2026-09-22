import { execFileSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { MISSING_SETTINGS_FILES, prepareMissingSettingsIntegration } from "./managed-update-settings-integration.mjs";

const historicalCommit = "224a75ef7b3efced05b2c6b3b136250d9a532dc3";
const historical = Object.freeze(Object.fromEntries(MISSING_SETTINGS_FILES.map(file => [file,
  execFileSync("git", ["show", `${historicalCommit}:${file}`], { encoding: "utf8" })
])));
const migrated = () => prepareMissingSettingsIntegration(file => historical[file]);

function javascript(file, source) {
  const compiled = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  expect(compiled.diagnostics).toEqual([]);
  return compiled.outputText;
}

async function workspaceWrites() {
  const file = "apps/web/src/ui/workspaceWriteCoordinator.ts";
  const source = javascript(file, migrated()[file]);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).WorkspaceWriteCoordinator;
}

describe("managed Settings integration before the historical Settings updater", () => {
  it("prepares the actual pre-broker target with its trusted origins and durable workspace handoff", () => {
    const changes = migrated();
    expect(Object.keys(changes)).toEqual(MISSING_SETTINGS_FILES);
    for (const [file, source] of Object.entries(changes)) javascript(file, source);
    expect(changes["apps/server/src/server.ts"]).toContain("registerCloudxUpdateRoutes(app, services.updates ?? new CloudxUpdateService(config.dataDir), config.trustedOrigins)");
    expect(changes["apps/server/src/server.ts"]).toContain("await services.workspace!.persistDurably()");
    expect(changes["apps/server/src/workspace/WorkspaceLayoutStore.ts"]).toContain("return this.serializeWorkspaceAccess(() => this.persist(true))");
    expect(changes["packages/shared/src/index.ts"]).toContain('export * from "./cloudxUpdate.js"');
    expect(changes["apps/web/src/ui/App.tsx"]).toContain("workspaceWrites.flushDurably(persistWorkspace)");
    expect(changes["apps/web/src/ui/App.tsx"]).toContain("useCloudxUpdate(settingsOpen, saveWorkspace)");
    expect(changes["apps/web/src/ui/App.tsx"]).toContain("cloudxUpdate={cloudxUpdate}");
    expect(changes["apps/web/src/ui/SettingsDialog.tsx"]).toContain('label: "Updates"');
    expect(changes["apps/web/src/ui/SettingsDialog.tsx"]).toContain("<CloudxUpdatePanel update={cloudxUpdate} />");
    expect(changes["apps/web/src/api.ts"]).toContain('status?.state !== "available"');
    expect(historical["apps/web/src/ui/SettingsDialog.tsx"]).not.toContain("CloudxUpdate");
  });

  it.each([
    ["apps/server/src/server.ts", "  config?: ConfigService;\n"],
    ["apps/server/src/workspace/WorkspaceLayoutStore.ts", "        if (requireDurable) {\n          throw error;\n        }"],
    ["packages/shared/src/index.ts", 'export * from "./codexSettings.js";\n'],
    ["apps/web/src/ui/App.tsx", "  const workspaceWrites = workspaceWritesRef.current;\n"],
    ["apps/web/src/ui/SettingsDialog.tsx", "  config: CloudxConfigResponse;\n"],
    ["apps/web/src/api.ts", "  WorkspaceStateResponse,\n"],
    ["apps/web/src/ui/workspaceWriteCoordinator.ts", "      void this.flush().catch(this.reportError);"],
  ])("rejects missing or ambiguous anchors before returning changes: %s", (file, anchor) => {
    for (const replacement of ["", anchor + anchor]) {
      const sources = { ...historical, [file]: historical[file].replace(anchor, replacement) };
      const before = structuredClone(sources);
      expect(() => prepareMissingSettingsIntegration(relative => sources[relative])).toThrow(file);
      expect(sources).toEqual(before);
    }
  });

  it("rejects an existing or partial Settings migration", () => {
    const changed = migrated();
    expect(() => prepareMissingSettingsIntegration(file => changed[file])).toThrow("incomplete Settings migration");
  });

  it("waits for layouts queued while saving before allowing the update handoff", async () => {
    const Coordinator = await workspaceWrites();
    const events = [];
    const writes = new Coordinator(async (window, layout) => { events.push(`layout:${window}:${layout.revision}`); }, 10_000);
    writes.scheduleLayout("original-window", { revision: 1 });
    const persist = vi.fn(async () => {
      events.push("durable");
      if (persist.mock.calls.length === 1) writes.scheduleLayout("original-window", { revision: 2 });
    });
    await writes.flushDurably(persist);
    expect(events).toEqual(["layout:original-window:1", "durable", "layout:original-window:2", "durable"]);
    expect(writes.hasUnsettledLayoutWrite()).toBe(false);
    writes.dispose();
  });

  it("does not continue the handoff after a layout or durable snapshot failure", async () => {
    const Coordinator = await workspaceWrites();
    const failure = new Error("ENOSPC");
    const report = vi.fn(), persist = vi.fn(async () => {});
    const writes = new Coordinator(async () => { throw failure; }, 10_000, report);
    writes.scheduleLayout("original-window", {});
    await expect(writes.flushDurably(persist)).rejects.toThrow("ENOSPC");
    expect(persist).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(writes.hasUnsettledLayoutWrite()).toBe(true);
    writes.dispose();
    const durable = new Coordinator(async () => {}, 10_000);
    await expect(durable.flushDurably(async () => { throw failure; })).rejects.toThrow("ENOSPC");
    durable.dispose();
  });
});
