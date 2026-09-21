import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../apps/server/src/config.ts";
import { buildServer, buildServices } from "../apps/server/src/server.ts";
import { PathPolicy } from "../apps/server/src/pathPolicy.ts";
import { WorkspaceLayoutStore } from "../apps/server/src/workspace/WorkspaceLayoutStore.ts";
import { persistWindowLayout, persistWorkspace, updateWindow } from "../apps/web/src/api.ts";
import { CloudxUpdatePanel, useCloudxUpdate } from "../apps/web/src/ui/CloudxUpdatePanel.tsx";
import { defaultLayout, splitPane } from "../apps/web/src/ui/layout.ts";
import { WorkspaceWriteCoordinator } from "../apps/web/src/ui/workspaceWriteCoordinator.ts";

describe("Settings update workspace durability", () => {
  let app, root, directory, coordinator, controller, services, current, windowId, dom;
  const reload = vi.fn();
  const start = vi.fn();
  const preview = {
    channel: "main",
    currentCommit: "a".repeat(40),
    checkedAt: "2026-09-15T00:00:00Z",
    state: "available",
    target: {
      commit: "b".repeat(40),
      name: "main",
      url: `https://github.com/davidomil/cloudx/commit/${"b".repeat(40)}`,
    },
    changelog: [],
    changelogComplete: true,
  };
  const running = { available: true, run: { id: "update-1", state: "running", message: "Updating.", startedAt: "2026-09-15T00:00:00Z" } };
  const requests = [];

  beforeEach(async () => {
    dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
    for (const name of ["window", "document", "navigator", "sessionStorage"]) vi.stubGlobal(name, dom.window[name]);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ documents: [] })));
    sessionStorage.clear();
    reload.mockReset();
    requests.length = 0;
    current = { available: true };
    start.mockReset().mockImplementation(async () => { current = running; return current; });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-update-persistence-"));
    const config = loadConfig({ CLOUDX_DATA_DIR: directory, CLOUDX_ALLOWED_ROOTS: directory, CLOUDX_LOG_LEVEL: "silent",
      CLOUDX_TRUSTED_ORIGINS: "http://localhost", CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9", CLOUDX_AUTOMATION_START_DISABLED: "true" });
    services = buildServices(config);
    services.updates = {
      status: async () => current,
      preview: async () => preview,
      selectChannel: async channel => ({ ...preview, channel }),
      start,
    };
    app = await buildServer(config, services);
    const window = await services.workspace.createWindow({ name: "Main", defaultCwd: directory });
    windowId = window.id;
    await services.workspace.updateWindow(windowId, { layout: defaultLayout() });
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      const response = await app.inject({ method: init.method ?? "GET", url, payload: init.body,
        headers: { ...init.headers, host: "localhost", origin: "http://localhost" } });
      requests.push({ url, status: response.statusCode, body: response.json() });
      return new Response(response.body, { status: response.statusCode });
    }));
    coordinator = new WorkspaceWriteCoordinator(persistWindowLayout, 60_000);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    coordinator?.dispose();
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
    document.body.replaceChildren();
    dom.window.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount() {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const saveWorkspace = () => coordinator.flushDurably(persistWorkspace);
    function Harness() {
      controller = useCloudxUpdate(true, saveWorkspace, reload);
      return createElement(CloudxUpdatePanel, { update: controller });
    }
    await act(async () => root.render(createElement(Harness)));
    await settle();
    return container;
  }

  async function settle() {
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      expect(controller.checking || controller.starting).toBe(false);
    });
  }

  const reopenedLayout = () => new WorkspaceLayoutStore(directory, new PathPolicy([directory])).getWindow(windowId).layout;

  for (const code of ["ENOSPC", "EDQUOT"]) {
    for (const boundary of ["launch", "reload"]) {
      it.each(["debounced change", "in-flight autosave", "degraded autosave", "earlier acknowledged autosave"])(`${code} blocks ${boundary} for %s until the layout reaches disk`, async scenario => {
        if (boundary === "reload") current = running;
        const container = await mount();
        const file = services.workspace.workspaceFile;
        const write = file.write.bind(file);
        const capacityError = Object.assign(new Error(`${code}: disk capacity exhausted`), { code });
        const diskWrite = vi.spyOn(file, "write").mockRejectedValue(capacityError);
        let rejectActiveSave;
        const layout = splitPane(defaultLayout(), "row", () => "pane-2", () => "split-1");
        if (scenario === "earlier acknowledged autosave") {
          await updateWindow(windowId, { layout });
          expect(coordinator.hasUnsettledLayoutWrite()).toBe(false);
        } else {
          coordinator.scheduleLayout(windowId, layout);
          if (scenario === "degraded autosave") await coordinator.flush().catch(() => undefined);
          if (scenario === "in-flight autosave") {
            diskWrite.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectActiveSave = reject; }));
            void coordinator.flush().catch(() => undefined);
            await vi.waitFor(() => expect(rejectActiveSave).toBeDefined());
          }
        }

        if (boundary === "launch") await act(async () => {
          const starting = controller.start();
          rejectActiveSave?.(capacityError);
          await starting;
        });
        else {
          current = { ...running, run: { ...running.run, state: "succeeded" } };
          await act(async () => controller.check());
          await act(async () => rejectActiveSave?.(capacityError));
        }
        await settle();

        expect(start).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(code);
        expect(reopenedLayout()).toEqual(defaultLayout());
        expect(services.workspace.getWindow(windowId).layout).toEqual(layout);
        if (scenario !== "earlier acknowledged autosave") expect(coordinator.hasUnsettledLayoutWrite()).toBe(true);
        expect(requests).toContainEqual(expect.objectContaining({ status: 200, body: expect.objectContaining({
          persistence: expect.arrayContaining([expect.objectContaining({ name: "Workspace layout", state: "degraded", code })])
        }) }));
        expect(sessionStorage.getItem("cloudx.update.reloadedRun")).toBeNull();
        if (boundary === "reload") expect(sessionStorage.getItem("cloudx.update.pendingRun")).toBe("update-1");
        const attempts = diskWrite.mock.calls.length;
        await settle();
        expect(diskWrite).toHaveBeenCalledTimes(attempts);

        diskWrite.mockImplementation(write);
        await act(async () => controller.check());
        await settle();
        if (boundary === "launch") {
          await act(async () => controller.start());
          await settle();
          expect(start).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledWith({ channel: "main", targetCommit: preview.target.commit });
        } else {
          expect(reload).toHaveBeenCalledOnce();
          await act(async () => controller.check());
          await settle();
          expect(reload).toHaveBeenCalledOnce();
        }
        expect(reopenedLayout()).toEqual(layout);
        expect(coordinator.hasUnsettledLayoutWrite()).toBe(false);
        expect(container.querySelector('[role="alert"]')).toBeNull();
      });
    }
  }
});
