import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SerialPortMock } from "serialport";
import type { HardwareConnection } from "@cloudx/plugin-api";
import type { UartConfig } from "@cloudx/shared";
import { PathPolicy } from "../../pathPolicy.js";
import { UartHardwareProvider, type UartHardwareOptions } from "./UartHardwareProvider.js";
import { transportTestContext } from "./TransportTestContext.js";

const config: UartConfig = { devicePath: "/dev/cloudx-test", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" };
const signal = () => new AbortController().signal;

describe("UART provider with SerialPort 13 mock binding", () => {
  let port: SerialPortMock;
  let connection: HardwareConnection;
  let deviceKey: string;
  let createPort: Mock<NonNullable<UartHardwareOptions["createPort"]>>;
  let setLines: Mock<NonNullable<UartHardwareOptions["setLines"]>>;
  const cleanups: (() => Promise<unknown>)[] = [];

  function provider(extra: Partial<UartHardwareOptions> = {}) {
    return new UartHardwareProvider({
      pathPolicy: new PathPolicy(["/dev"]),
      inspectDevice: async () => ({ path: config.devicePath, resourceKeys: [deviceKey] }),
      createPort,
      setLines,
      ...extra
    });
  }

  beforeEach(() => {
    SerialPortMock.binding.reset();
    SerialPortMock.binding.createPort(config.devicePath, { record: true, maxReadSize: 2 });
    deviceKey = "uart:device:42";
    createPort = vi.fn((options) => { port = new SerialPortMock(options); return port; });
    setLines = vi.fn(async (_port, lines) => ({ state: "completed", value: { rts: lines.rts ?? true, dtr: lines.dtr ?? true } }));
  });

  afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

  async function open() {
    const context = transportTestContext();
    const result = await provider().connect(config, context);
    expect(result.state).toBe("completed");
    if (result.state !== "completed") throw new Error(JSON.stringify(result));
    connection = result.value;
    cleanups.push(() => connection.close(signal()));
    return context;
  }

  it("does not open hardware during parse, inspection, or description and registers cleanup before explicit open", async () => {
    const type = provider();
    expect(type.parseConfig(config)).toEqual(config);
    await expect(type.inspectEndpoint(config)).resolves.toMatchObject({ ready: true, resourceKeys: ["uart:path:/dev/cloudx-test", "uart:device:42"] });
    expect(type.describeAccess(config).details.openingMayChangeControlLines).toBe(true);
    expect(createPort).not.toHaveBeenCalled();
    const context = transportTestContext();
    createPort.mockImplementation((options) => { expect(context.cleanups).toHaveLength(1); port = new SerialPortMock(options); return port; });
    const result = await type.connect(config, context);
    expect(result.state).toBe("completed");
    expect(createPort).toHaveBeenCalledWith(expect.objectContaining({ autoOpen: false, lock: true, baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", rtscts: false, xon: false, xoff: false, xany: false }));
    cleanups.push(() => context.cleanups[0]!(signal()));
  });

  it("writes exact binary bytes, waits for drain, and rejects noncanonical base64", async () => {
    await open();
    const bytes = Buffer.from([0, 13, 10, 255, 65]);
    const drain = vi.spyOn(port, "drain");
    await expect(connection.invoke("uart.write", { dataBase64: bytes.toString("base64"), timeoutMs: 500 }, signal())).resolves.toEqual({ state: "completed", value: { bytesWritten: 5, drained: true } });
    expect(port.port!.recording).toEqual(bytes);
    expect(drain).toHaveBeenCalledTimes(1);
    for (const dataBase64 of ["a", "YWJj\n", "YQ", "YR==", "**=="]) {
      await expect(connection.invoke("uart.write", { dataBase64, timeoutMs: 500 }, signal())).resolves.toMatchObject({ state: "failed", effects: "none", error: { code: "INVALID_INPUT" } });
    }
    expect(port.port!.recording).toEqual(bytes);
  });

  it("combines arbitrary serial chunks and retains bytes beyond each bounded read", async () => {
    await open();
    const reading = connection.invoke("uart.read", { durationMs: 100, maxBytes: 3 }, signal());
    port.port!.emitData(Buffer.from([0, 1, 2, 3, 4]));
    await expect(reading).resolves.toMatchObject({ state: "completed", value: { dataBase64: "AAEC", bytesRead: 3, timedOut: false } });
    await expect(connection.invoke("uart.read", { durationMs: 20, maxBytes: 10 }, signal())).resolves.toMatchObject({ state: "completed", value: { dataBase64: "AwQ=", bytesRead: 2, timedOut: true, truncated: false } });
    await expect(connection.invoke("uart.read", { durationMs: 5, maxBytes: 10 }, signal())).resolves.toMatchObject({ state: "completed", value: { dataBase64: "", bytesRead: 0, timedOut: true } });
  });

  it("bounds unread bytes and reports truncation rather than flushing or allocating without limit", async () => {
    await open();
    port.emit("data", Buffer.alloc(1024 * 1024 + 50, 7));
    await expect(connection.invoke("uart.read", { durationMs: 20, maxBytes: 3 }, signal())).resolves.toMatchObject({ state: "completed", value: { bytesRead: 3, truncated: true } });
    await expect(connection.invoke("uart.read", { durationMs: 20, maxBytes: 1024 * 1024 }, signal())).resolves.toMatchObject({ state: "completed", value: { bytesRead: 1024 * 1024 - 3, timedOut: true } });
  });

  it("sets only requested RTS/DTR values and never exposes CTS or DSR mutation", async () => {
    await open();
    await expect(connection.invoke("uart.set-lines", { rts: false, timeoutMs: 100 }, signal())).resolves.toEqual({ state: "completed", value: { rts: false, dtr: true } });
    expect(setLines).toHaveBeenCalledWith(port, { rts: false }, 100, expect.any(AbortSignal));
    await expect(connection.invoke("uart.set-lines", { cts: false, timeoutMs: 100 }, signal())).resolves.toMatchObject({ state: "failed", error: { code: "INVALID_INPUT" } });
    await expect(connection.invoke("uart.set-lines", { timeoutMs: 100 }, signal())).resolves.toMatchObject({ state: "failed", error: { code: "INVALID_INPUT" } });
    expect(setLines).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after an endpoint identity change or disconnect", async () => {
    await open();
    deviceKey = "uart:device:43";
    await expect(connection.invoke("uart.write", { dataBase64: "YQ==", timeoutMs: 100 }, signal())).resolves.toMatchObject({ state: "unknown", error: { code: "UART_ENDPOINT_CHANGED" } });
    expect(port.port!.recording).toEqual(Buffer.alloc(0));
    deviceKey = "uart:device:42";
    const reading = connection.invoke("uart.read", { durationMs: 1000, maxBytes: 20 }, signal());
    await new Promise((resolve) => setImmediate(resolve));
    port.emit("error", new Error("Emulated serial cable disconnect"));
    await expect(reading).resolves.toMatchObject({ state: "unknown", error: { code: "UART_DISCONNECTED" } });
    expect(createPort).toHaveBeenCalledTimes(1);
  });

  it("enforces exclusive opens and closes the existing port exactly once", async () => {
    const context = await open();
    const first = port;
    const secondContext = transportTestContext();
    const second = await provider().connect(config, secondContext);
    expect(second).toMatchObject({ state: "failed", effects: "settled", error: { code: "UART_OPEN_FAILED" } });
    await secondContext.cleanups[0]!(signal());
    const close = vi.spyOn(first, "close");
    await context.cleanups[0]!(signal());
    await connection.close(signal());
    expect(first.isOpen).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(connection.invoke("uart.read", { durationMs: 1, maxBytes: 1 }, signal())).resolves.toMatchObject({ state: "failed", error: { code: "ACCESS_CLOSED" } });
  });

  it("retains an unexpected native close as uncertain instead of reporting an ordinary closed session", async () => {
    await open();
    await new Promise<void>((resolve, reject) => port.close((error) => error ? reject(error) : resolve()));
    await expect(connection.invoke("uart.read", { durationMs: 1, maxBytes: 1 }, signal())).resolves.toMatchObject({ state: "unknown", error: { code: "UART_DISCONNECTED" } });
    expect(createPort).toHaveBeenCalledTimes(1);
  });

  it("distinguishes cancelled read from an uncertain dispatched write and keeps cleanup callable", async () => {
    const context = await open();
    const controller = new AbortController();
    const reading = connection.invoke("uart.read", { durationMs: 1000, maxBytes: 20 }, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(reading).resolves.toMatchObject({ state: "failed", effects: "none", error: { code: "CANCELLED" } });
    vi.spyOn(port, "drain").mockImplementation(() => {});
    await expect(connection.invoke("uart.write", { dataBase64: "YQ==", timeoutMs: 5 }, signal())).resolves.toMatchObject({ state: "unknown", error: { code: "UART_WRITE_UNKNOWN" } });
    expect(port.port!.recording).toEqual(Buffer.from("a"));
    await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
  });

  it("rejects unsupported config, oversized operations and unknown operations before device writes", async () => {
    expect(() => provider().parseConfig({ ...config, dataBits: 9 })).toThrow();
    expect(() => provider().parseConfig({ ...config, devicePath: "/tmp/outside" })).toThrow("outside");
    await open();
    await expect(connection.invoke("uart.read", { durationMs: 60001, maxBytes: 1 }, signal())).resolves.toMatchObject({ state: "failed" });
    await expect(connection.invoke("uart.write", { dataBase64: "A".repeat(1398104), timeoutMs: 10 }, signal())).resolves.toMatchObject({ state: "failed" });
    await expect(connection.invoke("ssh.exec", {}, signal())).resolves.toMatchObject({ state: "failed" });
    expect(port.port!.recording.length).toBe(0);
  });
});
