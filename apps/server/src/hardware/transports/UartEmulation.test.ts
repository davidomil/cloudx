import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HardwareConnection } from "@cloudx/plugin-api";
import { PathPolicy } from "../../pathPolicy.js";
import { UartHardwareProvider } from "./UartHardwareProvider.js";
import { transportTestContext } from "./TransportTestContext.js";

const signal = () => new AbortController().signal;

describe.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/python3"))("UART provider through native SerialPort 13 and a Linux PTY", () => {
  let emulator: ChildProcessWithoutNullStreams;
  let devicePath: string;
  let connection: HardwareConnection;
  let provider: UartHardwareProvider;
  let readLine: () => Promise<Record<string, string>>;

  beforeAll(async () => {
    emulator = spawn("/usr/bin/python3", ["-u", "-c", `import base64, json, os, pty, select, sys, tty
master, slave = pty.openpty()
tty.setraw(master)
print(json.dumps({'devicePath': os.ttyname(slave)}), flush=True)
while True:
    ready, _, _ = select.select([master, sys.stdin], [], [])
    if sys.stdin in ready:
        line = sys.stdin.readline()
        if not line:
            break
        os.write(master, base64.b64decode(json.loads(line)['send']))
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            continue
        print(json.dumps({'received': base64.b64encode(data).decode('ascii')}), flush=True)
os.close(master)
os.close(slave)
`], { stdio: ["pipe", "pipe", "pipe"] });
    const messages: Record<string, string>[] = [];
    const changed = new EventEmitter();
    let buffer = "";
    emulator.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        messages.push(JSON.parse(buffer.slice(0, end)) as Record<string, string>);
        buffer = buffer.slice(end + 1);
        changed.emit("message");
      }
    });
    readLine = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { changed.removeListener("message", available); reject(new Error("PTY emulator response timed out.")); }, 2000);
      const available = () => {
        const message = messages.shift();
        if (message) { clearTimeout(timer); changed.removeListener("message", available); resolve(message); }
      };
      changed.on("message", available);
      available();
    });
    devicePath = (await readLine()).devicePath!;
    provider = new UartHardwareProvider({ pathPolicy: new PathPolicy(["/dev/pts"]) });
    const result = await provider.connect({ devicePath, baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" }, transportTestContext());
    if (result.state !== "completed") throw new Error(`Native PTY open failed: ${JSON.stringify(result)}`);
    connection = result.value;
  }, 5000);

  afterAll(async () => {
    await connection?.close(signal());
    if (emulator?.exitCode === null) {
      emulator.stdin.end();
      await new Promise((resolve) => emulator.once("exit", resolve));
    }
  });

  it("inspects an actual character device and observes its resolved OS conflict identity without opening again", async () => {
    const inspected = await provider.inspectEndpoint({ devicePath, baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    expect(inspected.ready).toBe(true);
    expect(inspected.resourceKeys).toContain(`uart:path:${devicePath}`);
    expect(inspected.resourceKeys.some((key) => key.startsWith("uart:device:"))).toBe(true);
  });

  it("receives arbitrary binary bytes from the emulator and drains exact bytes back to it", async () => {
    const incoming = Buffer.from([0, 1, 10, 13, 255, 65]);
    const reading = connection.invoke("uart.read", { maxBytes: incoming.length, durationMs: 1000 }, signal());
    emulator.stdin.write(JSON.stringify({ send: incoming.toString("base64") }) + "\n");
    await expect(reading).resolves.toMatchObject({ state: "completed", value: { dataBase64: incoming.toString("base64"), bytesRead: incoming.length, timedOut: false } });
    const outgoing = Buffer.from([66, 0, 255, 13]);
    await expect(connection.invoke("uart.write", { dataBase64: outgoing.toString("base64"), timeoutMs: 1000 }, signal())).resolves.toEqual({ state: "completed", value: { bytesWritten: outgoing.length, drained: true } });
    const response = await readLine();
    expect(Buffer.from(response.received!, "base64")).toEqual(outgoing);
  });

  it("enforces native OS exclusive access and fails unsupported PTY modem ioctls clearly", async () => {
    const context = transportTestContext();
    await expect(provider.connect({ devicePath, baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" }, context)).resolves.toMatchObject({ state: "failed", effects: "settled", error: { code: "UART_OPEN_FAILED" } });
    await context.cleanups[0]!(signal());
    await expect(connection.invoke("uart.set-lines", { rts: false, timeoutMs: 1000 }, signal())).resolves.toMatchObject({ state: "failed", effects: "none", error: { code: "UART_LINES_UNSUPPORTED" } });
  });

  it("closes managed access and requires a new explicit open for any further byte operation", async () => {
    await expect(connection.close(signal())).resolves.toEqual({ state: "completed", value: null });
    await expect(connection.invoke("uart.write", { dataBase64: "YQ==", timeoutMs: 1000 }, signal())).resolves.toMatchObject({ state: "failed", error: { code: "ACCESS_CLOSED" } });
  });
});
