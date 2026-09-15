import { describe, expect, it, vi } from "vitest";

import type { TabLayoutState } from "@cloudx/shared";

import { closeTab, updateWindow } from "../api.js";
import { defaultLayout, splitPane } from "./layout.js";
import { WorkspaceWriteCoordinator } from "./workspaceWriteCoordinator.js";

describe("WorkspaceWriteCoordinator", () => {
  it("checks durability with an empty layout queue and propagates failure without retrying", async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error("EDQUOT")).mockResolvedValue(undefined);
    const coordinator = new WorkspaceWriteCoordinator(async () => undefined, 200);
    try {
      await expect(coordinator.flushDurably(persist)).rejects.toThrow("EDQUOT");
      expect(persist).toHaveBeenCalledOnce();
      await coordinator.flushDurably(persist);
      expect(persist).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.dispose();
    }
  });

  it("persists changes queued during the durable checkpoint before releasing the barrier", async () => {
    const held = deferred<void>();
    const persist = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(undefined);
    const persistLayout = vi.fn(async () => undefined);
    const coordinator = new WorkspaceWriteCoordinator(persistLayout, 60_000);
    try {
      const barrier = coordinator.flushDurably(persist);
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
      const layout = defaultLayout();
      coordinator.scheduleLayout("window-1", layout);
      held.resolve();
      await barrier;
      expect(persistLayout).toHaveBeenCalledExactlyOnceWith("window-1", layout);
      expect(persist).toHaveBeenCalledTimes(2);
      expect(persist.mock.invocationCallOrder[0]).toBeLessThan(persistLayout.mock.invocationCallOrder[0]!);
      expect(persistLayout.mock.invocationCallOrder[0]).toBeLessThan(persist.mock.invocationCallOrder[1]!);
    } finally {
      coordinator.dispose();
    }
  });

  it("propagates a failed in-flight layout before attempting a durable checkpoint", async () => {
    const held = deferred<void>();
    const persist = vi.fn(async () => undefined);
    const coordinator = new WorkspaceWriteCoordinator(() => held.promise, 60_000);
    try {
      coordinator.scheduleLayout("window-1", defaultLayout());
      const autosave = expect(coordinator.flush()).rejects.toThrow("ENOSPC");
      const barrier = expect(coordinator.flushDurably(persist)).rejects.toThrow("ENOSPC");
      held.reject(new Error("ENOSPC"));
      await Promise.all([autosave, barrier]);
      expect(persist).not.toHaveBeenCalled();
      expect(coordinator.hasUnsettledLayoutWrite()).toBe(true);
    } finally {
      coordinator.dispose();
    }
  });

  it("propagates a command queued as the durable barrier begins", async () => {
    const coordinator = new WorkspaceWriteCoordinator(async () => undefined, 200);
    try {
      const barrier = coordinator.flushDurably(async () => undefined);
      const command = coordinator.run(async () => { throw new Error("Tab close failed"); });
      const outcomes = await Promise.allSettled([barrier, command]);
      expect(outcomes).toEqual([
        { status: "rejected", reason: expect.objectContaining({ message: "Tab close failed" }) },
        { status: "rejected", reason: expect.objectContaining({ message: "Tab close failed" }) }
      ]);
    } finally {
      coordinator.dispose();
    }
  });

  it.each(["saved", "failed"])("continues a debounced layout PATCH after a tab close fails: layout %s", async (saveOutcome) => {
    vi.useFakeTimers();
    const close = deferred<Response>();
    const reportError = vi.fn();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tabs/tab-1" && init?.method === "DELETE") return close.promise;
      if (url === "/api/windows/window-1" && init?.method === "PATCH") {
        return new Response(JSON.stringify(saveOutcome === "saved" ? {} : { message: "Layout save failed" }), {
          status: saveOutcome === "saved" ? 200 : 503
        });
      }
      throw new Error(`Unexpected request: ${init?.method} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const coordinator = new WorkspaceWriteCoordinator(async (windowId, layout) => {
      await updateWindow(windowId, { layout });
    }, 200, reportError);
    try {
      const closing = coordinator.run(() => closeTab("tab-1"));
      const closeFailed = expect(closing).rejects.toThrow("Tab close failed");
      await vi.advanceTimersByTimeAsync(0);
      const layout = splitPane(defaultLayout(), "row", () => "pane-2", () => "split-1");
      coordinator.scheduleLayout("window-1", layout);
      await vi.advanceTimersByTimeAsync(200);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(coordinator.hasUnsettledLayoutWrite()).toBe(true);

      close.resolve(new Response(JSON.stringify({ message: "Tab close failed" }), { status: 503 }));
      await closeFailed;
      await vi.advanceTimersByTimeAsync(0);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenLastCalledWith("/api/windows/window-1", {
        method: "PATCH", body: JSON.stringify({ layout }), headers: { "content-type": "application/json" }
      });
      expect(coordinator.hasUnsettledLayoutWrite()).toBe(saveOutcome === "failed");
      if (saveOutcome === "failed") expect(reportError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "Layout save failed" }));
      else expect(reportError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.dispose();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each(["active layout save", "queued command"])("does not retry a debounced layout already failed by preceding work: %s", async (precedingWrite) => {
    vi.useFakeTimers();
    const held = deferred<void>();
    const error = new Error("Layout save failed");
    const reportError = vi.fn();
    const initial = layoutFixture("tab-1");
    const latest = layoutFixture("tab-2");
    const persistLayout = vi.fn(async (_windowId: string, layout: TabLayoutState) => {
      if (layout === initial) await held.promise;
      else throw error;
    });
    const coordinator = new WorkspaceWriteCoordinator(persistLayout, 200, reportError);
    try {
      if (precedingWrite === "active layout save") coordinator.scheduleLayout("window-1", initial);
      else void coordinator.run(() => held.promise);
      await vi.advanceTimersByTimeAsync(200);
      const command = precedingWrite === "queued command" ? coordinator.run(async () => undefined) : undefined;
      const commandOutcome = Promise.allSettled(command ? [command] : []);
      coordinator.scheduleLayout("window-1", latest);
      await vi.advanceTimersByTimeAsync(200);
      const barrier = expect(coordinator.flush()).rejects.toBe(error);
      held.resolve();
      await barrier;
      await commandOutcome;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(persistLayout.mock.calls.filter(([, layout]) => layout === latest)).toHaveLength(1);
      expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
      expect(coordinator.hasUnsettledLayoutWrite()).toBe(true);
    } finally {
      coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["explicit flush", "workspace command", "debounce timer"])("reports layout save errors once for %s", async (trigger) => {
    vi.useFakeTimers();
    const error = new Error("Layout could not be saved");
    const reportError = vi.fn();
    const coordinator = new WorkspaceWriteCoordinator(async () => { throw error; }, 200, reportError);
    try {
      coordinator.scheduleLayout("window-1", layoutFixture("tab-1"));
      if (trigger === "debounce timer") await vi.advanceTimersByTimeAsync(200);
      else await expect(trigger === "explicit flush" ? coordinator.flush() : coordinator.run(async () => undefined)).rejects.toBe(error);
      expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
      expect(coordinator.hasUnsettledLayoutWrite()).toBe(true);
    } finally {
      coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it("propagates an ongoing save failure to every waiting flush without retrying it", async () => {
    const save = deferred<void>();
    let attempts = 0;
    const coordinator = new WorkspaceWriteCoordinator(async () => {
      attempts += 1;
      await save.promise;
    }, 60_000);
    coordinator.scheduleLayout("window-1", layoutFixture("tab-1"));
    const first = coordinator.flush();
    await flushPromises();
    const waiting = coordinator.flush();
    const outcomes = Promise.allSettled([first, waiting]);
    const error = new Error("Layout save failed");
    save.reject(error);

    expect(await outcomes).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error }
    ]);
    expect(attempts).toBe(1);
    expect(coordinator.hasUnsettledLayoutWrite()).toBe(true);
    coordinator.dispose();
  });

  it("waits for workspace commands and flushes layouts scheduled while they run", async () => {
    const command = deferred<void>();
    const calls: string[] = [];
    const coordinator = new WorkspaceWriteCoordinator(async () => { calls.push("saved"); }, 60_000);
    void coordinator.run(() => command.promise);
    const saved = coordinator.flush().then(() => calls.push("ready"));
    await flushPromises();
    coordinator.scheduleLayout("window-1", layoutFixture("tab-1"));
    expect(calls).toEqual([]);
    command.resolve();
    await saved;
    expect(calls).toEqual(["saved", "ready"]);
    coordinator.dispose();
  });

  it("propagates an outstanding command failure without poisoning later flushes", async () => {
    const command = deferred<void>();
    const coordinator = new WorkspaceWriteCoordinator(async () => undefined, 60_000);
    const operation = coordinator.run(() => command.promise);
    const barrier = coordinator.flush();
    const outcomes = Promise.allSettled([operation, barrier]);
    const error = new Error("Workspace command failed");
    command.reject(error);
    expect(await outcomes).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error }
    ]);
    await expect(coordinator.flush()).resolves.toBeUndefined();
    coordinator.dispose();
  });

  it("preserves a concurrent explicit flush failure while the debounced layout is saved", async () => {
    vi.useFakeTimers();
    const command = deferred<void>();
    const persistLayout = vi.fn(async () => undefined);
    const coordinator = new WorkspaceWriteCoordinator(persistLayout, 200);
    try {
      const operation = coordinator.run(() => command.promise);
      await vi.advanceTimersByTimeAsync(0);
      const layout = layoutFixture("tab-1");
      coordinator.scheduleLayout("window-1", layout);
      await vi.advanceTimersByTimeAsync(200);
      const barrier = coordinator.flush();
      const outcomes = Promise.allSettled([operation, barrier]);
      const error = new Error("Tab close failed");
      command.reject(error);

      expect(await outcomes).toEqual([
        { status: "rejected", reason: error },
        { status: "rejected", reason: error }
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(persistLayout).toHaveBeenCalledExactlyOnceWith("window-1", layout);
      expect(coordinator.hasUnsettledLayoutWrite()).toBe(false);
    } finally {
      coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it("saves a newer debounced layout after an older layout save fails", async () => {
    vi.useFakeTimers();
    const oldSave = deferred<void>();
    const initial = layoutFixture("tab-1");
    const latest = layoutFixture("tab-2");
    const reportError = vi.fn();
    const persistLayout = vi.fn(async (_windowId: string, layout: TabLayoutState) => {
      if (layout === initial) await oldSave.promise;
    });
    const coordinator = new WorkspaceWriteCoordinator(persistLayout, 200, reportError);
    try {
      coordinator.scheduleLayout("window-1", initial);
      await vi.advanceTimersByTimeAsync(200);
      coordinator.scheduleLayout("window-1", latest);
      await vi.advanceTimersByTimeAsync(200);
      const error = new Error("Old layout save failed");
      oldSave.reject(error);
      await vi.advanceTimersByTimeAsync(0);

      expect(persistLayout.mock.calls).toEqual([["window-1", initial], ["window-1", latest]]);
      expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
      expect(coordinator.hasUnsettledLayoutWrite()).toBe(false);
    } finally {
      coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it("waits for commands queued during a layout save before completing the flush", async () => {
    const save = deferred<void>();
    const command = deferred<void>();
    const commandStarted = deferred<void>();
    const calls: string[] = [];
    const coordinator = new WorkspaceWriteCoordinator(() => save.promise, 60_000);
    coordinator.scheduleLayout("window-1", layoutFixture("tab-1"));
    const barrier = coordinator.flush().then(() => calls.push("ready"));
    await flushPromises();
    const operation = coordinator.run(async () => {
      calls.push("command");
      commandStarted.resolve();
      await command.promise;
    });
    save.resolve();
    await commandStarted.promise;
    expect(calls).toEqual(["command"]);
    command.resolve();
    await Promise.all([operation, barrier]);
    expect(calls).toEqual(["command", "ready"]);
    coordinator.dispose();
  });

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
