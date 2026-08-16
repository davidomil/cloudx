import { describe, expect, it } from "vitest";

import type { TabLayoutState } from "@cloudx/shared";

import { WorkspaceWriteCoordinator } from "./workspaceWriteCoordinator.js";

describe("WorkspaceWriteCoordinator", () => {
  it("flushes the latest debounced layout write before a later workspace command", async () => {
    const layout = layoutFixture("tab-1");
    const layoutWrite = deferred<void>();
    const calls: string[] = [];
    const coordinator = new WorkspaceWriteCoordinator(async (windowId, persistedLayout) => {
      calls.push(`layout:${windowId}:${persistedLayout.root.type}`);
      await layoutWrite.promise;
    }, 60_000);
    coordinator.scheduleLayout("window-1", layout);

    const command = coordinator.run(async () => {
      calls.push("command");
      return "done";
    });
    await flushPromises();

    expect(calls).toEqual(["layout:window-1:pane"]);

    layoutWrite.resolve();
    await expect(command).resolves.toBe("done");
    expect(calls).toEqual(["layout:window-1:pane", "command"]);
    coordinator.dispose();
  });

  it("coalesces pending layouts while preserving serialized in-flight writes", async () => {
    const calls: string[] = [];
    const firstWrite = deferred<void>();
    const coordinator = new WorkspaceWriteCoordinator(async (_windowId, layout) => {
      const tabId = layout.root.type === "pane" ? layout.root.pane.tabIds[0] : undefined;
      calls.push(tabId ?? "empty");
      if (tabId === "tab-1") {
        await firstWrite.promise;
      }
    }, 60_000);
    coordinator.scheduleLayout("window-1", layoutFixture("tab-1"));
    const firstFlush = coordinator.flush();
    await flushPromises();
    coordinator.scheduleLayout("window-1", layoutFixture("tab-2"));
    coordinator.scheduleLayout("window-1", layoutFixture("tab-3"));
    const secondFlush = coordinator.flush();

    expect(calls).toEqual(["tab-1"]);

    firstWrite.resolve();
    await Promise.all([firstFlush, secondFlush]);
    expect(calls).toEqual(["tab-1", "tab-3"]);
    coordinator.dispose();
  });

  it("flushes a layout scheduled while a command is waiting for an earlier write", async () => {
    const calls: string[] = [];
    const firstWrite = deferred<void>();
    const coordinator = new WorkspaceWriteCoordinator(async (_windowId, layout) => {
      const tabId = layout.root.type === "pane" ? layout.root.pane.tabIds[0] : undefined;
      calls.push(tabId ?? "empty");
      if (tabId === "tab-1") {
        await firstWrite.promise;
      }
    }, 60_000);
    coordinator.scheduleLayout("window-1", layoutFixture("tab-1"));
    const firstFlush = coordinator.flush();
    await flushPromises();
    const command = coordinator.run(async () => {
      calls.push("command");
    });
    coordinator.scheduleLayout("window-1", layoutFixture("tab-2"));

    firstWrite.resolve();
    await Promise.all([firstFlush, command]);

    expect(calls).toEqual(["tab-1", "tab-2", "command"]);
    coordinator.dispose();
  });

  it("retains a failed layout and persists it before a later workspace command", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const coordinator = new WorkspaceWriteCoordinator(async (_windowId, layout) => {
      const tabId = layout.root.type === "pane" ? layout.root.pane.tabIds[0] : undefined;
      calls.push(`layout:${tabId}`);
      attempts += 1;
      if (attempts === 1) throw new Error("layout persistence failed");
    }, 60_000);
    coordinator.scheduleLayout("window-1", layoutFixture("tab-1"));

    await expect(coordinator.flush()).rejects.toThrow("layout persistence failed");
    await expect(coordinator.run(async () => {
      calls.push("command");
      return "done";
    })).resolves.toBe("done");

    expect(calls).toEqual(["layout:tab-1", "layout:tab-1", "command"]);
    coordinator.dispose();
  });

  it("retains only the newest coalesced layout across repeated persistence failures", async () => {
    const calls: string[] = [];
    const firstWrite = deferred<void>();
    let newestAttempts = 0;
    const coordinator = new WorkspaceWriteCoordinator(async (_windowId, layout) => {
      const tabId = layout.root.type === "pane" ? layout.root.pane.tabIds[0] : undefined;
      calls.push(`layout:${tabId}`);
      if (tabId === "tab-1") await firstWrite.promise;
      if (tabId === "tab-3" && newestAttempts++ === 0) {
        throw new Error("newest layout still unavailable");
      }
    }, 60_000);
    coordinator.scheduleLayout("window-1", layoutFixture("tab-1"));
    const firstFlush = coordinator.flush();
    await flushPromises();
    coordinator.scheduleLayout("window-1", layoutFixture("tab-2"));
    coordinator.scheduleLayout("window-1", layoutFixture("tab-3"));
    firstWrite.reject(new Error("old layout failed"));
    await expect(firstFlush).rejects.toThrow("old layout failed");

    await expect(coordinator.run(async () => calls.push("blocked-command"))).rejects.toThrow("newest layout still unavailable");
    await expect(coordinator.run(async () => calls.push("command"))).resolves.toBe(4);

    expect(calls).toEqual(["layout:tab-1", "layout:tab-3", "layout:tab-3", "command"]);
    coordinator.dispose();
  });
});

function layoutFixture(tabId: string): TabLayoutState {
  return {
    root: { type: "pane", pane: { id: "pane-1", tabIds: [tabId], activeTabId: tabId } },
    activePaneId: "pane-1"
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value?: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve as (value?: T) => void;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
