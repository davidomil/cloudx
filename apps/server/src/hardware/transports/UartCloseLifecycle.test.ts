import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SerialPortMock } from "serialport";
import type { HardwareMutationResult, HardwareOwner, OperationReceipt, ProviderOutcome, UartConfig } from "@cloudx/shared";
import { PathPolicy } from "../../pathPolicy.js";
import { HardwareService } from "../HardwareService.js";
import { HardwareTypeRegistry } from "../HardwareTypeRegistry.js";
import { UartHardwareProvider } from "./UartHardwareProvider.js";
import { transportTestContext } from "./TransportTestContext.js";

const signal = () => new AbortController().signal;
const config: UartConfig = { devicePath: "/dev/cloudx-close-test", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" };
const user: HardwareOwner = { kind: "user", userId: "local" };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  SerialPortMock.binding.reset();
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function controlledUart(options: { pauseOpen?: boolean; failOpen?: boolean; bindingClosesEarly?: boolean } = {}) {
  SerialPortMock.binding.createPort(config.devicePath, { record: true });
  const read = deferred<{ buffer: Buffer; bytesRead: number }>();
  const closing = deferred<void>();
  const closeStarted = deferred<void>();
  const openStarted = deferred<void>();
  const opening = deferred<void>();
  const openBinding = SerialPortMock.binding.open.bind(SerialPortMock.binding);
  let binding!: NonNullable<SerialPortMock["port"]>;
  let bindingClose!: () => Promise<void>;
  vi.spyOn(SerialPortMock.binding, "open").mockImplementation(async openOptions => {
    openStarted.resolve();
    await opening.promise;
    binding = await openBinding(openOptions);
    bindingClose = binding.close.bind(binding);
    vi.spyOn(binding, "read").mockImplementation(() => read.promise);
    vi.spyOn(binding, "close").mockImplementation(async () => {
      if (options.bindingClosesEarly) await bindingClose();
      closeStarted.resolve();
      await closing.promise;
      if (!options.bindingClosesEarly) await bindingClose();
    });
    return binding;
  });
  if (options.failOpen) opening.reject(new Error("Controlled native open failure"));
  else if (!options.pauseOpen) opening.resolve();
  let serial!: SerialPortMock;
  const provider = new UartHardwareProvider({ pathPolicy: new PathPolicy(["/dev"]),
    inspectDevice: async () => ({ path: config.devicePath, resourceKeys: ["uart:device:review"] }),
    createPort: options => { serial = new SerialPortMock(options); return serial; },
    setLines: async () => ({ state: "completed", value: { rts: true, dtr: true } }) });
  cleanups.push(async () => { opening.resolve(); closing.resolve(); if (binding?.isOpen) await bindingClose(); });
  return { provider, serial: () => serial, binding: () => binding, closeStarted: closeStarted.promise,
    openStarted: openStarted.promise, completeOpen: () => opening.resolve(),
    disconnect: async () => { read.reject(new Error("Controlled serial disconnect")); await closeStarted.promise; },
    completeClose: () => closing.resolve(), failClose: () => closing.reject(new Error("Controlled native close failure")) };
}

async function openUart(options?: Parameters<typeof controlledUart>[0]) {
  const f = await controlledUart(options);
  const context = transportTestContext();
  const opened = await f.provider.connect(config, context);
  if (opened.state !== "completed") throw new Error(JSON.stringify(opened));
  return { ...f, connection: opened.value, context };
}

async function terminalReceipt(service: HardwareService, requestId: string): Promise<OperationReceipt> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await service.execute("hardware.receipt.get", { requestId }, user) as { receipt: OperationReceipt };
    if (result.receipt.state !== "running") return result.receipt;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Controlled UART service receipt did not settle.");
}

async function reservedUart() {
  const f = await controlledUart();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-uart-close-service-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const service = new HardwareService({ dataDir: root, registry: new HardwareTypeRegistry([{ id: "hardware", hardwareTypes: [f.provider] }]), pathPolicy: new PathPolicy([root, "/dev"]) });
  cleanups.push(() => service.dispose());
  await service.init();
  let sequence = 0;
  const mutate = (action: string, input: Record<string, unknown>) => service.execute(action, { requestId: `uart-close-${++sequence}`, ...input }, user) as Promise<HardwareMutationResult>;
  await mutate("hardware.items.create", { newGroupName: "Shared board", item: { name: "UART board", description: "", enabled: true, typeId: "hardware.uart", configVersion: 1, config,
    tagIds: [], notes: "", statuses: [], hooks: { onRelease: { source: "printf released > released", cwd: root, timeoutMs: 1000, maxOutputBytes: 4096, credentialRefIds: [] } } } });
  const item = (await service.snapshot(user)).items[0]!.item;
  const reserved = await mutate("hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Validate pending serial close" });
  const ref = { reservationId: reserved.reservation!.reservationId, generation: reserved.reservation!.generation };
  const opened = await mutate("hardware.access.open", ref);
  expect((await terminalReceipt(service, opened.receipt.requestId)).state).toBe("succeeded");
  return { ...f, root, service, ref, mutate };
}

describe("UART native close confirmation", () => {
  it.each([false, true])("awaits automatic disconnect close while isOpen is false (binding closes early=%s)", async bindingClosesEarly => {
    const f = await openUart({ bindingClosesEarly });
    await f.disconnect();
    expect({ isOpen: f.serial().isOpen, closing: f.serial().closing, bindingOpen: f.binding().isOpen }).toEqual({ isOpen: false, closing: true, bindingOpen: !bindingClosesEarly });
    await expect(new Promise(resolve => f.serial().close(resolve))).resolves.toEqual(new Error("Port is not open"));
    let outcome: ProviderOutcome<null> | undefined;
    const closing = f.connection.close(signal()).then(value => { outcome = value; return value; });
    await new Promise(resolve => setImmediate(resolve));
    try { expect(outcome).toBeUndefined(); }
    finally { f.completeClose(); await closing; }
    await expect(closing).resolves.toEqual({ state: "completed", value: null });
    expect(f.binding().close).toHaveBeenCalledTimes(1);
  });

  it("awaits ordinary explicit close and shares one cleanup result across callers", async () => {
    const f = await openUart();
    let outcome: ProviderOutcome<null> | undefined;
    const closing = f.connection.close(signal());
    void closing.then(value => { outcome = value; });
    expect(f.context.cleanups[0]!(signal())).toBe(closing);
    await f.closeStarted;
    try {
      expect(outcome).toBeUndefined();
      expect(f.serial().closing).toBe(true);
      expect(f.binding().isOpen).toBe(true);
    } finally { f.completeClose(); await closing; }
    await expect(closing).resolves.toEqual({ state: "completed", value: null });
    expect(f.binding().close).toHaveBeenCalledTimes(1);
  });

  it("does not confuse a Duplex close event with native close confirmation", async () => {
    const f = await openUart();
    await f.disconnect();
    const streamClosed = new Promise(resolve => f.serial().once("close", resolve));
    f.serial().destroy();
    await streamClosed;
    let outcome: ProviderOutcome<null> | undefined;
    const closing = f.connection.close(signal()).then(value => { outcome = value; return value; });
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(outcome).toBeUndefined();
      expect(f.serial().closing).toBe(true);
      expect(f.binding().isOpen).toBe(true);
    } finally { f.completeClose(); await closing; }
    await expect(closing).resolves.toEqual({ state: "completed", value: null });
    expect(f.binding().close).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("retains failed automatic close without retrying (binding closes early=%s)", async bindingClosesEarly => {
    const f = await openUart({ bindingClosesEarly });
    const error = new Promise(resolve => f.serial().once("error", resolve));
    await f.disconnect();
    f.failClose();
    await expect(error).resolves.toEqual(new Error("Controlled native close failure"));
    expect(f.serial().isOpen).toBe(!bindingClosesEarly);
    expect(f.serial().closing).toBe(false);
    await expect(f.connection.close(signal())).resolves.toMatchObject({ state: "unknown", error: { code: "UART_CLEANUP_UNKNOWN" } });
    await f.context.cleanups[0]!(signal());
    expect(f.binding().close).toHaveBeenCalledTimes(1);
  });

  it("reports automatic close failure during cleanup and preserves the native error event", async () => {
    const f = await openUart();
    const errors: Error[] = [];
    f.serial().on("error", error => errors.push(error));
    await f.disconnect();
    const closing = f.connection.close(signal());
    f.failClose();
    await expect(closing).resolves.toMatchObject({ state: "unknown", error: { code: "UART_CLEANUP_UNKNOWN" } });
    expect(errors).toEqual([new Error("Controlled native close failure")]);
    expect(f.binding().close).toHaveBeenCalledTimes(1);
  });

  it("retains uncertainty when native close never confirms and removes the deadline wait", async () => {
    const f = await openUart();
    await f.disconnect();
    vi.useFakeTimers();
    const listeners = [f.serial().listenerCount("close"), f.serial().listenerCount("error")];
    const closing = f.connection.close(signal());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(closing).resolves.toMatchObject({ state: "unknown", error: { code: "UART_CLEANUP_UNKNOWN" } });
    expect(f.serial().closing).toBe(true);
    expect(f.binding().close).toHaveBeenCalledTimes(1);
    expect([f.serial().listenerCount("close"), f.serial().listenerCount("error")]).toEqual(listeners);
    expect(vi.getTimerCount()).toBe(0);
    f.completeClose();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.serial().closing).toBe(false);
  });

  it.each(["automatic", "explicit"])("cancels waiting for %s close without cancelling or repeating native cleanup", async kind => {
    const f = await openUart();
    if (kind === "automatic") await f.disconnect();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    vi.useFakeTimers();
    let outcome: ProviderOutcome<null> | undefined;
    const closing = f.connection.close(controller.signal).then(value => { outcome = value; return value; });
    await f.closeStarted;
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(outcome).toMatchObject({ state: "unknown", error: { code: "UART_CLEANUP_UNKNOWN" } });
      expect(f.binding().close).toHaveBeenCalledTimes(1);
      expect(f.serial().closing).toBe(true);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally { f.completeClose(); await closing; }
    await vi.advanceTimersByTimeAsync(0);
    expect(f.serial().isOpen).toBe(false);
    expect(f.serial().closing).toBe(false);
    expect(f.binding().close).toHaveBeenCalledTimes(1);
  });

  it("handles a late native failure after cleanup cancellation without retrying close", async () => {
    const f = await openUart();
    await f.disconnect();
    const controller = new AbortController();
    const closing = f.connection.close(controller.signal);
    controller.abort();
    await expect(closing).resolves.toMatchObject({ state: "unknown" });
    const error = new Promise(resolve => f.serial().once("error", resolve));
    f.failClose();
    await expect(error).resolves.toEqual(new Error("Controlled native close failure"));
    await expect(f.context.cleanups[0]!(signal())).resolves.toMatchObject({ state: "unknown" });
    expect(f.binding().close).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("preserves native close callback identity and error semantics (failure=%s)", async fail => {
    const f = await openUart();
    const callback = vi.fn(function(this: SerialPortMock, error: Error | null) { expect(this).toBe(f.serial()); return error; });
    const called = new Promise<void>(resolve => f.serial().close(function(this: SerialPortMock, error) { callback.call(this, error); resolve(); }));
    await f.closeStarted;
    if (fail) f.failClose(); else f.completeClose();
    await called;
    expect(callback).toHaveBeenCalledExactlyOnceWith(fail ? new Error("Controlled native close failure") : null);
    await expect(f.connection.close(signal())).resolves.toMatchObject({ state: fail ? "unknown" : "completed" });
    expect(f.binding().close).toHaveBeenCalledTimes(1);
  });

  it("cancels an unresolved open and retains one late native close", async () => {
    const f = await controlledUart({ pauseOpen: true });
    const openingController = new AbortController();
    const context = transportTestContext(openingController.signal);
    const opened = f.provider.connect(config, context);
    await f.openStarted;
    openingController.abort();
    await expect(opened).resolves.toMatchObject({ state: "unknown", error: { code: "UART_OPEN_UNKNOWN" } });
    const cleanupController = new AbortController();
    vi.useFakeTimers();
    let outcome: ProviderOutcome<null> | undefined;
    const cleanup = context.cleanups[0]!(cleanupController.signal).then(value => { outcome = value; return value; });
    cleanupController.abort();
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(outcome).toMatchObject({ state: "unknown", error: { code: "UART_CLEANUP_UNKNOWN" } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { f.completeOpen(); await f.closeStarted; f.completeClose(); await cleanup; }
    await vi.advanceTimersByTimeAsync(0);
    expect(SerialPortMock.binding.open).toHaveBeenCalledTimes(1);
    expect(f.binding().close).toHaveBeenCalledTimes(1);
    expect(f.serial().isOpen).toBe(false);
  });

  it("confirms cleanup after a native open failure without dispatching close", async () => {
    const f = await controlledUart({ failOpen: true });
    const context = transportTestContext();
    await expect(f.provider.connect(config, context)).resolves.toMatchObject({ state: "failed", effects: "settled", error: { code: "UART_OPEN_FAILED" } });
    const close = vi.spyOn(f.serial(), "close");
    await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
    expect(close).not.toHaveBeenCalled();
  });

  it("confirms cleanup when open is cancelled before native dispatch", async () => {
    const f = await controlledUart();
    const controller = new AbortController();
    controller.abort();
    const context = transportTestContext(controller.signal);
    await expect(f.provider.connect(config, context)).resolves.toMatchObject({ state: "failed", effects: "none", error: { code: "CANCELLED" } });
    await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
    expect(SerialPortMock.binding.open).not.toHaveBeenCalled();
    expect(f.serial()).toBeUndefined();
  });

  it("keeps the physical resource held and does not run On release until native close succeeds", async () => {
    const f = await reservedUart();
    const { root, service, ref, mutate } = f;
    await f.disconnect();
    const released = await mutate("hardware.release", ref);
    const settled = terminalReceipt(service, released.receipt.requestId);
    await Promise.race([settled, new Promise(resolve => setTimeout(resolve, 100))]);
    const pending = await service.snapshot(user);
    const hookRan = await fs.access(path.join(root, "released")).then(() => true, () => false);
    try {
      expect({ claims: pending.reservations.length, availability: pending.items[0]!.availability, hookRan, closing: f.serial().closing, bindingOpen: f.binding().isOpen })
        .toEqual({ claims: 1, availability: "held", hookRan: false, closing: true, bindingOpen: true });
    } finally { f.completeClose(); await settled; }
    expect((await settled).state).toBe("succeeded");
    expect((await service.snapshot(user)).reservations).toHaveLength(0);
    expect(await fs.readFile(path.join(root, "released"), "utf8")).toBe("released");
  });

  it("retains the recovery claim and skips On release after automatic native close fails", async () => {
    const f = await reservedUart();
    await f.disconnect();
    const released = await f.mutate("hardware.release", f.ref);
    f.failClose();
    expect((await terminalReceipt(f.service, released.receipt.requestId)).state).toBe("unknown");
    const held = await f.service.snapshot(user);
    expect(held.reservations).toHaveLength(1);
    expect(held.reservations[0]!.state).toBe("recovery_required");
    expect(held.items[0]!.availability).toBe("held");
    await expect(fs.access(path.join(f.root, "released"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.binding().close).toHaveBeenCalledTimes(1);
  });
});
