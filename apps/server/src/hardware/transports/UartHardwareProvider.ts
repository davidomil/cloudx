import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
import type { HardwareAccessContext, HardwareConnection, HardwareTypeProvider } from "@cloudx/plugin-api";
import type { HardwareAccessDescription, HardwareEndpointInspection, HardwareTypeDescriptor, JsonObject, ProviderOutcome, UartConfig } from "@cloudx/shared";
import type { PathPolicy } from "../../pathPolicy.js";
import { BoundedProcessSet } from "./BoundedProcess.js";
import { SerialByteBuffer } from "./SerialByteBuffer.js";
import { byteLimitSchema, compileHardwareSchema, completed, deadlineSchema, failed, HardwareProviderError, MAX_HARDWARE_BYTES, objectSchema, unknown, validateHardwareValue } from "./HardwareValidation.js";

export const uartHardwareDescriptor: HardwareTypeDescriptor = {
  id: "hardware.uart", ownerPluginId: "hardware", apiVersion: 1, configVersion: 1,
  displayName: "UART", description: "Exchange exact serial bytes over one explicitly opened, exclusively locked serial port. Opening can change electrical control lines.",
  configSchema: objectSchema({
    devicePath: { type: "string", minLength: 1, maxLength: 4096, pattern: "^/[^\\u0000\\r\\n]*$" },
    baudRate: { type: "integer", minimum: 1, maximum: 4_000_000 }, dataBits: { enum: [5, 6, 7, 8] }, stopBits: { enum: [1, 2] },
    parity: { enum: ["none", "even", "odd"] }, flowControl: { enum: ["none", "rtscts"] }
  }),
  operations: [
    { id: "uart.read", description: "Read a bounded byte window, retaining unconsumed bytes for the next explicit read.",
      inputSchema: objectSchema({ durationMs: { type: "integer", minimum: 1, maximum: 60000 }, maxBytes: byteLimitSchema }),
      outputSchema: objectSchema({ dataBase64: { type: "string" }, bytesRead: { type: "integer", minimum: 0, maximum: MAX_HARDWARE_BYTES }, timedOut: { type: "boolean" }, truncated: { type: "boolean" }, startedAt: { type: "string" }, finishedAt: { type: "string" } }) },
    { id: "uart.write", description: "Write exact base64 bytes and confirm the OS drain; never append a newline.",
      inputSchema: objectSchema({ dataBase64: { type: "string", maxLength: Math.ceil(MAX_HARDWARE_BYTES / 3) * 4 }, timeoutMs: deadlineSchema }),
      outputSchema: objectSchema({ bytesWritten: { type: "integer", minimum: 0, maximum: MAX_HARDWARE_BYTES }, drained: { const: true } }) },
    { id: "uart.set-lines", description: "Set explicit RTS/DTR output values on Linux without changing unspecified lines. Requires Python 3 termios ioctl support.",
      inputSchema: { ...objectSchema({ rts: { type: "boolean" }, dtr: { type: "boolean" }, timeoutMs: deadlineSchema }, ["timeoutMs"]), anyOf: [{ properties: { rts: { type: "boolean" } }, required: ["rts"] }, { properties: { dtr: { type: "boolean" } }, required: ["dtr"] }] },
      outputSchema: objectSchema({ rts: { type: "boolean" }, dtr: { type: "boolean" } }) }
  ]
};

export interface HardwareSerialPort extends EventEmitter {
  readonly isOpen: boolean;
  readonly opening: boolean;
  readonly port?: unknown;
  open(callback: (error: Error | null) => void): void;
  close(callback: (error: Error | null) => void): void;
  write(data: Buffer, callback: (error?: Error | null) => void): boolean;
  drain(callback: (error: Error | null) => void): void;
}

export interface UartDeviceIdentity {
  path: string;
  resourceKeys: string[];
}

export interface UartHardwareOptions {
  pathPolicy: Pick<PathPolicy, "resolve" | "isAllowed">;
  createPort?: (options: ConstructorParameters<typeof SerialPort>[0]) => HardwareSerialPort;
  inspectDevice?: (config: UartConfig) => Promise<UartDeviceIdentity>;
  setLines?: (port: HardwareSerialPort, lines: { rts?: boolean; dtr?: boolean }, timeoutMs: number, signal: AbortSignal) => Promise<ProviderOutcome<JsonObject>>;
  pythonExecutable?: string;
}

export class UartHardwareProvider implements HardwareTypeProvider<UartConfig> {
  readonly descriptor = uartHardwareDescriptor;
  private readonly configValidator = compileHardwareSchema(this.descriptor.configSchema, "UART configuration");
  private readonly operationValidators = new Map(this.descriptor.operations.map((operation) => [operation.id, compileHardwareSchema(operation.inputSchema, operation.id)]));

  constructor(private readonly options: UartHardwareOptions) {}

  parseConfig(value: unknown): UartConfig {
    validateHardwareValue(this.configValidator, value, "UART configuration");
    const config = structuredClone(value) as unknown as UartConfig;
    this.options.pathPolicy.resolve(config.devicePath);
    return config;
  }

  async inspectEndpoint(config: UartConfig): Promise<HardwareEndpointInspection> {
    const resourceKeys = [`uart:path:${path.resolve(config.devicePath)}`];
    try {
      const device = await this.device(config);
      if (!this.options.setLines) {
        if (process.platform !== "linux") throw new Error("UART control lines require Linux.");
        await fs.access(this.options.pythonExecutable ?? "/usr/bin/python3", constants.X_OK);
      }
      return { resourceKeys: [...new Set([...resourceKeys, ...device.resourceKeys])], ready: true, blockers: [] };
    } catch (error) {
      return { resourceKeys, ready: false, blockers: [error instanceof Error ? error.message : "UART device is unavailable."] };
    }
  }

  describeAccess(config: UartConfig): HardwareAccessDescription {
    return { summary: `${config.devicePath} · ${config.baudRate} baud · ${config.dataBits}${config.parity[0]!.toUpperCase()}${config.stopBits}`, details: { devicePath: config.devicePath, baudRate: config.baudRate, dataBits: config.dataBits, stopBits: config.stopBits, parity: config.parity, flowControl: config.flowControl, openingMayChangeControlLines: true, controlLineRequirement: "Linux and Python 3 termios ioctl support; the port is never reopened to set lines." } };
  }

  async connect(config: UartConfig, context: HardwareAccessContext): Promise<ProviderOutcome<HardwareConnection>> {
    const connection = new UartConnection(config, this.options, this.operationValidators, () => this.device(config));
    context.registerCleanup((signal) => connection.close(signal));
    if (context.signal.aborted) return failed("CANCELLED", "UART open was cancelled before dispatch.");
    return connection.open(context.signal);
  }

  private async device(config: UartConfig): Promise<UartDeviceIdentity> {
    if (this.options.inspectDevice) return this.options.inspectDevice(config);
    const admitted = this.options.pathPolicy.resolve(config.devicePath);
    const resolved = await fs.realpath(admitted);
    if (!this.options.pathPolicy.isAllowed(resolved)) throw new HardwareProviderError("ENDPOINT_UNAVAILABLE", "UART device resolves outside allowed roots.");
    const stat = await fs.stat(resolved);
    if (!stat.isCharacterDevice()) throw new HardwareProviderError("ENDPOINT_UNAVAILABLE", "UART path must resolve to a character device.");
    await fs.access(resolved, constants.R_OK | constants.W_OK);
    return { path: resolved, resourceKeys: [`uart:path:${resolved}`, `uart:device:${stat.rdev}`] };
  }
}

class UartConnection implements HardwareConnection {
  private serial?: HardwareSerialPort;
  private identity?: UartDeviceIdentity;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private readonly dataReady = new EventEmitter();
  private readonly receivedBytes = new SerialByteBuffer(MAX_HARDWARE_BYTES);
  private closed = false;
  private failure?: string;
  private busy = false;
  private opening?: Promise<Error | null>;
  private readonly processes = new BoundedProcessSet();
  private closePromise?: Promise<ProviderOutcome<null>>;

  constructor(private readonly config: UartConfig, private readonly options: UartHardwareOptions, private readonly validators: Map<string, ReturnType<typeof compileHardwareSchema>>, private readonly inspectDevice: () => Promise<UartDeviceIdentity>) {}

  async open(signal: AbortSignal): Promise<ProviderOutcome<HardwareConnection>> {
    try { this.identity = await this.inspectDevice(); } catch (error) { return failed("ENDPOINT_UNAVAILABLE", error instanceof Error ? error.message : "UART endpoint is unavailable."); }
    if (signal.aborted || this.closed) return failed("CANCELLED", "UART open was cancelled before dispatch.");
    try {
      this.serial = (this.options.createPort ?? ((options) => new SerialPort(options)))({
        path: this.identity.path, baudRate: this.config.baudRate, dataBits: this.config.dataBits, stopBits: this.config.stopBits, parity: this.config.parity,
        rtscts: this.config.flowControl === "rtscts", xon: false, xoff: false, xany: false, lock: true, autoOpen: false, highWaterMark: 65536
      });
    } catch { return failed("UART_INVALID_CONFIGURATION", "The serial port could not be constructed."); }
    this.serial!.on("error", (error: Error) => { this.failure = error.message; this.dataReady.emit("changed"); });
    this.serial!.on("close", () => { if (!this.closed) this.failure = "The serial port disconnected."; this.dataReady.emit("changed"); });
    this.serial!.on("data", (data: Buffer) => {
      this.receivedBytes.append(data);
      this.dataReady.emit("changed");
    });
    this.opening = new Promise((resolve) => this.serial!.open(resolve));
    const result = await boundedSerial(this.opening, 10_000, signal);
    if (!result.completed) return unknown("UART_OPEN_UNKNOWN", "UART open did not confirm its outcome; cleanup remains registered.");
    if (result.value) return failed("UART_OPEN_FAILED", "UART open failed after the serial binding settled.", "settled");
    try {
      if (!sameIdentity(this.identity, await this.inspectDevice())) return unknown("UART_ENDPOINT_CHANGED", "The UART endpoint changed during open.");
    } catch { return unknown("UART_ENDPOINT_CHANGED", "The UART endpoint disappeared during open."); }
    return completed(this);
  }

  async invoke(operationId: string, input: JsonObject, signal: AbortSignal): Promise<ProviderOutcome<JsonObject>> {
    if (this.closed) return failed("ACCESS_CLOSED", "UART access is closed.");
    if (this.failure) return unknown("UART_DISCONNECTED", "UART access lost its connection; explicit reconciliation is required.");
    if (!this.serial?.isOpen) return unknown("UART_DISCONNECTED", "The UART port closed without managed cleanup; explicit reconciliation is required.");
    if (this.busy) return failed("OPERATION_IN_PROGRESS", "A UART operation is already running.");
    const validator = this.validators.get(operationId);
    if (!validator) return failed("INVALID_INPUT", `Unsupported UART operation ${operationId}.`);
    try { validateHardwareValue(validator, input, `${operationId} input`); } catch (error) { return failed("INVALID_INPUT", (error as Error).message); }
    if (signal.aborted) return failed("CANCELLED", "UART operation was cancelled before dispatch.");
    try {
      if (!sameIdentity(this.identity!, await this.inspectDevice())) return unknown("UART_ENDPOINT_CHANGED", "The configured UART path resolves to a different device.");
    } catch { return unknown("UART_ENDPOINT_CHANGED", "The configured UART endpoint is no longer available."); }
    this.busy = true;
    const operationSignal = AbortSignal.any([signal, this.lifetime.signal]);
    const work = operationId === "uart.read" ? this.read(input, operationSignal) : operationId === "uart.write" ? this.write(input, operationSignal) : this.setLines(input, operationSignal);
    this.pending.add(work);
    try { return await work; } catch { return unknown("UART_OPERATION_UNKNOWN", "UART operation failed without a confirmed effect outcome."); }
    finally { this.pending.delete(work); this.busy = false; }
  }

  close(signal: AbortSignal): Promise<ProviderOutcome<null>> {
    this.closePromise ??= this.closePort(signal);
    return this.closePromise;
  }

  private async closePort(signal: AbortSignal): Promise<ProviderOutcome<null>> {
    this.closed = true;
    this.lifetime.abort();
    this.dataReady.emit("changed");
    const processResult = await this.processes.close(signal);
    await Promise.allSettled([...this.pending]);
    if (this.opening) {
      const opening = await boundedSerial(this.opening, 10_000, new AbortController().signal);
      if (!opening.completed) {
        void this.opening.then(() => { if (this.serial?.isOpen) this.serial.close(() => {}); });
        return unknown("UART_CLEANUP_UNKNOWN", "UART open is still unresolved; late-open cleanup is retained.");
      }
    }
    if (this.serial?.isOpen) {
      const closing = new Promise<Error | null>((resolve) => this.serial!.close(resolve));
      const result = await boundedSerial(closing, 10_000, new AbortController().signal);
      if (!result.completed || result.value || this.serial.isOpen) return unknown("UART_CLEANUP_UNKNOWN", "UART close did not confirm its outcome.");
    }
    this.receivedBytes.clear();
    return processResult.state === "completed" ? completed(null) : processResult;
  }

  private async read(input: JsonObject, signal: AbortSignal): Promise<ProviderOutcome<JsonObject>> {
    const startedAt = new Date().toISOString();
    const maxBytes = input.maxBytes as number;
    const ended = await new Promise<"limit" | "timeout" | "interrupted">((resolve) => {
      let settled = false;
      const finish = (reason: "limit" | "timeout" | "interrupted") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.dataReady.removeListener("changed", changed);
        signal.removeEventListener("abort", aborted);
        resolve(reason);
      };
      const changed = () => { if (this.failure || this.closed) finish("interrupted"); else if (this.receivedBytes.size >= maxBytes) finish("limit"); };
      const aborted = () => finish("interrupted");
      const timer = setTimeout(() => finish("timeout"), input.durationMs as number);
      this.dataReady.on("changed", changed);
      signal.addEventListener("abort", aborted, { once: true });
      changed();
      if (signal.aborted) aborted();
    });
    if (ended === "interrupted") return this.failure ? unknown("UART_DISCONNECTED", "The UART connection was lost during the read.") : failed("CANCELLED", "UART read was cancelled before consuming buffered bytes.");
    const { data, truncated } = this.receivedBytes.read(maxBytes);
    return completed({ dataBase64: data.toString("base64"), bytesRead: data.length, timedOut: ended === "timeout", truncated, startedAt, finishedAt: new Date().toISOString() });
  }

  private async write(input: JsonObject, signal: AbortSignal): Promise<ProviderOutcome<JsonObject>> {
    const encoded = input.dataBase64 as string;
    if (encoded.length > Math.ceil(MAX_HARDWARE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return failed("INVALID_INPUT", "UART dataBase64 must contain canonical base64 bytes.");
    const data = Buffer.from(encoded, "base64");
    if (data.length > MAX_HARDWARE_BYTES || data.toString("base64") !== encoded) return failed("INVALID_INPUT", "UART dataBase64 exceeds the byte limit or is not canonical base64.");
    if (signal.aborted) return failed("CANCELLED", "UART write was cancelled before dispatch.");
    const completion = new Promise<Error | null>((resolve) => {
      this.serial!.write(data, (error) => {
        if (error) return resolve(error);
        this.serial!.drain(resolve);
      });
    });
    const result = await boundedSerial(completion, input.timeoutMs as number, signal);
    if (!result.completed || result.value || this.failure) return unknown("UART_WRITE_UNKNOWN", "UART write or drain did not confirm completion.");
    return completed({ bytesWritten: data.length, drained: true });
  }

  private setLines(input: JsonObject, signal: AbortSignal): Promise<ProviderOutcome<JsonObject>> {
    const lines = { ...(typeof input.rts === "boolean" ? { rts: input.rts } : {}), ...(typeof input.dtr === "boolean" ? { dtr: input.dtr } : {}) };
    if (this.options.setLines) return this.options.setLines(this.serial!, lines, input.timeoutMs as number, signal);
    return linuxSetLines(this.serial!, lines, input.timeoutMs as number, signal, this.processes, this.options.pythonExecutable ?? "/usr/bin/python3");
  }
}

function sameIdentity(before: UartDeviceIdentity, after: UartDeviceIdentity): boolean {
  return before.path === after.path && JSON.stringify([...before.resourceKeys].sort()) === JSON.stringify([...after.resourceKeys].sort());
}

async function boundedSerial<T>(work: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<{ completed: true; value: T } | { completed: false }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { completed: true; value: T } | { completed: false }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish({ completed: false });
    const timer = setTimeout(abort, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    void work.then((value) => finish({ completed: true, value }), () => finish({ completed: false }));
    if (signal.aborted) abort();
  });
}

const setLinesProgram = `import array, fcntl, json, sys, termios
bits = array.array('i', [0])
try:
    fcntl.ioctl(3, termios.TIOCMGET, bits, True)
except OSError:
    sys.exit(2)
for value, mask in [(sys.argv[1], termios.TIOCM_RTS), (sys.argv[2], termios.TIOCM_DTR)]:
    if value != 'keep':
        bits[0] = bits[0] | mask if value == '1' else bits[0] & ~mask
try:
    fcntl.ioctl(3, termios.TIOCMSET, bits)
except OSError:
    sys.exit(3)
print(json.dumps({'rts': bool(bits[0] & termios.TIOCM_RTS), 'dtr': bool(bits[0] & termios.TIOCM_DTR)}))
`;

async function linuxSetLines(port: HardwareSerialPort, lines: { rts?: boolean; dtr?: boolean }, timeoutMs: number, signal: AbortSignal, processes: BoundedProcessSet, pythonExecutable: string): Promise<ProviderOutcome<JsonObject>> {
  const fd = (port.port as { fd?: number | null } | undefined)?.fd;
  if (process.platform !== "linux" || typeof fd !== "number") return failed("UART_LINES_UNAVAILABLE", "UART control lines require Linux and an open native serial descriptor.");
  const result = await processes.run({ executable: pythonExecutable, args: ["-c", setLinesProgram, lines.rts === undefined ? "keep" : lines.rts ? "1" : "0", lines.dtr === undefined ? "keep" : lines.dtr ? "1" : "0"], timeoutMs, maxOutputBytes: 4096, signal, inheritedFd: fd });
  if (result.state === "not_started") return failed("UART_LINES_UNAVAILABLE", "The Python 3 ioctl helper could not start.");
  if (result.interrupted || result.state !== "exited") return unknown("UART_LINES_UNKNOWN", "UART control-line completion could not be confirmed.");
  if (result.exitCode === 2) return failed("UART_LINES_UNSUPPORTED", "The serial device does not support modem-line inspection.");
  if (result.exitCode !== 0) return unknown("UART_LINES_UNKNOWN", "UART control-line ioctl did not confirm completion.");
  try { return completed(JSON.parse(result.stdout) as JsonObject); } catch { return unknown("UART_LINES_UNKNOWN", "The ioctl helper returned invalid output."); }
}
