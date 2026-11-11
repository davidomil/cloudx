import { expect, it, vi } from "vitest";
import type { AgentOwner, HardwareReservation, WorkspaceTab, WorkspaceTabsUpdate } from "@cloudx/shared";
import { HardwareOwnerMonitor } from "./HardwareOwnerMonitor.js";

function fixture(managed = false) {
  const tab = { id: "agent-1", pluginId: "codex-terminal", status: "running", ...(managed ? { ownerPluginId: "forge" } : {}) } as WorkspaceTab;
  let owner: AgentOwner = { kind: "agent", tabId: tab.id, providerId: "codex", executionId: "execution-1" };
  let removed: (tab: WorkspaceTab) => void | Promise<void> = () => {};
  let changed: (update: WorkspaceTabsUpdate) => void = () => {};
  const claim = { owner, lastOwnerObservation: "active" } as HardwareReservation;
  let claims = [claim];
  let hardwareChanged = () => {};
  const hardware = { ownerClaims: vi.fn(() => claims as HardwareReservation[]), ownerEnded: vi.fn(async () => {}), nativeTabClosed: vi.fn(async (_tabId: string) => {}), ownerUnknown: vi.fn(async () => {}),
    onChange: (listener: () => void) => { hardwareChanged = listener; return () => { hardwareChanged = () => {}; }; } };
  const contexts = { owner: vi.fn(async (): Promise<AgentOwner | undefined> => owner), prepare: vi.fn(async () => undefined), revoke: vi.fn(async () => {}) };
  const sessions = { listTabs: () => [tab], onTabRemoved: (listener: typeof removed) => { removed = listener; return () => { removed = () => {}; }; },
    onTabsChange: (listener: typeof changed) => { changed = listener; return () => { changed = () => {}; }; } };
  const monitor = new HardwareOwnerMonitor({ hardware, contexts, sessions, report: error => { throw error; } });
  const notify = () => changed({ type: "tabs", tabs: [tab] });
  return { monitor, owner: () => owner, change: (next: Partial<AgentOwner>) => { owner = { ...owner, ...next }; notify(); }, hardware, contexts, remove: () => removed(tab), changed: notify,
    setClaims: (next: HardwareReservation[]) => { claims = next; hardwareChanged(); } };
}

it("keeps idle, completed-turn, and unchanged observations from releasing a claim", async () => {
  const f = fixture();
  await f.monitor.start();
  f.changed(); f.changed();
  await f.monitor.dispose();
  expect(f.hardware.ownerEnded).not.toHaveBeenCalled();
  expect(f.hardware.ownerUnknown).not.toHaveBeenCalled();
  expect(f.contexts.prepare).toHaveBeenCalledTimes(1);
});

it("holds the original execution when a replacement native client or worker attempt appears", async () => {
  const f = fixture();
  await f.monitor.start();
  const original = f.owner();
  f.change({ executionId: "execution-2" });
  await vi.waitFor(() => expect(f.hardware.ownerUnknown).toHaveBeenCalledWith(original, expect.stringContaining("not been confirmed")));
  expect(f.hardware.ownerEnded).not.toHaveBeenCalled();
  await f.monitor.dispose();
});

it("releases only the exact owner supplied by confirmed termination", async () => {
  const f = fixture();
  await f.monitor.start();
  const original = f.owner();
  await f.monitor.confirmedEnded(original);
  expect(f.hardware.ownerEnded).toHaveBeenCalledExactlyOnceWith(original);
  await f.monitor.dispose();
});

it("revokes the native context before requesting cleanup for an explicitly removed tab", async () => {
  const f = fixture();
  await f.monitor.start();
  f.hardware.nativeTabClosed.mockImplementation(async tabId => {
    expect(f.contexts.revoke).toHaveBeenCalledExactlyOnceWith(tabId);
  });
  await f.remove();
  expect(f.hardware.nativeTabClosed).toHaveBeenCalledExactlyOnceWith("agent-1");
  expect(f.hardware.ownerEnded).not.toHaveBeenCalled();
  expect(f.hardware.ownerUnknown).not.toHaveBeenCalled();
  await f.monitor.dispose();
  await f.remove();
  expect(f.hardware.nativeTabClosed).toHaveBeenCalledTimes(1);
});

it("requests native cleanup even when there is no current observed execution", async () => {
  const f = fixture();
  f.contexts.owner.mockResolvedValueOnce(undefined);
  await f.monitor.start();
  await f.remove();
  expect(f.hardware.nativeTabClosed).toHaveBeenCalledExactlyOnceWith("agent-1");
  await f.monitor.dispose();
});

it("keeps Forge removal unknown until its runtime confirms exact-attempt quiescence", async () => {
  const f = fixture(true);
  await f.monitor.start();
  await f.remove();
  expect(f.hardware.ownerUnknown).toHaveBeenCalledExactlyOnceWith(f.owner(), expect.stringContaining("without a matching confirmed"));
  expect(f.hardware.ownerEnded).not.toHaveBeenCalled();
  expect(f.hardware.nativeTabClosed).not.toHaveBeenCalled();
  expect(f.contexts.revoke).toHaveBeenCalledWith("agent-1");
  await f.monitor.dispose();
  await f.remove();
  expect(f.hardware.ownerUnknown).toHaveBeenCalledTimes(1);
});

it("prepares a launch before storage starts without treating it as a restored owner", async () => {
  const f = fixture();
  await f.monitor.executionChanged("agent-1");
  expect(f.contexts.prepare).toHaveBeenCalledWith("agent-1");
  expect(f.hardware.ownerClaims).not.toHaveBeenCalled();
  await f.monitor.dispose();
});

it("reconciles a stale claim that becomes visible after the replacement binding was already observed", async () => {
  const f = fixture();
  await f.monitor.start();
  const original = f.owner();
  f.setClaims([]);
  f.change({ executionId: "replacement" });
  await vi.waitFor(() => expect(f.contexts.prepare).toHaveBeenCalledTimes(2));
  expect(f.hardware.ownerUnknown).not.toHaveBeenCalled();
  f.setClaims([{ owner: original, lastOwnerObservation: "active" } as HardwareReservation]);
  await vi.waitFor(() => expect(f.hardware.ownerUnknown).toHaveBeenCalledWith(original, expect.stringContaining("durable claim became visible")));
  expect(f.hardware.ownerEnded).not.toHaveBeenCalled();
  await f.monitor.dispose();
});

it("lets confirmed-owner release cleanup finish after its replacement execution appears", async () => {
  const f = fixture();
  await f.monitor.start();
  f.setClaims([{ owner: f.owner(), state: "releasing", lastOwnerObservation: "confirmed_ended" } as HardwareReservation]);
  f.change({ executionId: "replacement" });
  await vi.waitFor(() => expect(f.contexts.prepare).toHaveBeenCalledTimes(2));
  expect(f.hardware.ownerUnknown).not.toHaveBeenCalled();
  await f.monitor.dispose();
});

it("drains an initial observation and detaches subscriptions when shutdown races startup", async () => {
  const f = fixture();
  let finish!: () => void;
  const observed = new Promise<void>(resolve => { finish = resolve; });
  f.contexts.owner.mockImplementationOnce(async () => { await observed; return f.owner(); });
  const started = f.monitor.start();
  let disposed = false;
  const stopping = f.monitor.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  expect(disposed).toBe(false);
  finish();
  await Promise.all([started, stopping]);
  expect(f.contexts.prepare).not.toHaveBeenCalled();
  await f.remove();
  expect(f.hardware.ownerEnded).not.toHaveBeenCalled();
  expect(f.hardware.ownerUnknown).not.toHaveBeenCalled();
});
