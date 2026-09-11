import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Socket } from "node:net";

import type { TerminalSpawnOptions } from "./TerminalProcess.js";
import type { TerminalExit } from "./TerminalSupervisor.js";

export const MAX_TERMINAL_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TERMINAL_INPUT_BYTES = 256 * 1024;
export const TERMINAL_REPLAY_BYTES = 1024 * 1024;

export type TerminalRequest =
  | { type: "spawn"; sessionId: string; command: string; args: string[]; options: TerminalSpawnOptions }
  | { type: "attach"; sessionId: string }
  | { type: "write"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kill" | "terminate" };

export type TerminalResponse =
  | { type: "ready" | "terminated" | "missing" }
  | { type: "data"; data: string }
  | { type: "screen"; data: string; cols: number; rows: number; complete: boolean }
  | { type: "exit"; event: TerminalExit }
  | { type: "error"; message: string };

export function terminalSocketPath(dataDir: string): string {
  const identity = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
  return `/tmp/cloudx-terminals-${process.getuid!()}-${identity}/broker.sock`;
}

export async function validateTerminalSocketDirectory(socketPath: string): Promise<void> {
  const directory = await fs.lstat(path.dirname(socketPath));
  if (!directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o777) !== 0o700) {
    throw new Error("The terminal broker directory must be owned by the current user with mode 0700.");
  }
}

export async function validateTerminalSocket(socketPath: string): Promise<void> {
  await validateTerminalSocketDirectory(socketPath);
  const socket = await fs.lstat(socketPath);
  if (!socket.isSocket() || socket.uid !== process.getuid!() || (socket.mode & 0o777) !== 0o600) {
    throw new Error("The terminal broker socket must be owned by the current user with mode 0600.");
  }
}

export function readTerminalMessages(socket: Socket, receive: (value: unknown) => void): void {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_TERMINAL_MESSAGE_BYTES) return socket.destroy();
      try { receive(JSON.parse(line)); } catch { return socket.destroy(); }
      if (socket.destroyed) return;
    }
    if (Buffer.byteLength(pending) > MAX_TERMINAL_MESSAGE_BYTES) socket.destroy();
  });
}

export function sendTerminalMessage(socket: Socket, message: TerminalRequest | TerminalResponse): boolean {
  if (socket.destroyed) throw new Error("The terminal broker connection is closed.");
  const encoded = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(encoded) > MAX_TERMINAL_MESSAGE_BYTES || socket.writableLength + Buffer.byteLength(encoded) > 4 * MAX_TERMINAL_MESSAGE_BYTES) {
    socket.destroy();
    throw new Error("The terminal broker connection exceeded its message or output limit.");
  }
  return socket.write(encoded);
}

export function terminalReplay(output: string, bytes: number): string {
  const encoded = Buffer.from(output);
  if (encoded.length <= bytes) return output;
  let start = encoded.length - bytes;
  while ((encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

export function isTerminalRequest(value: unknown): value is TerminalRequest {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "attach": return isSessionId(value.sessionId);
    case "spawn": return isSessionId(value.sessionId) && isText(value.command, 16_384) && value.command.length > 0
      && Array.isArray(value.args) && value.args.length <= 4096 && value.args.every((arg) => isText(arg, 128 * 1024))
      && isRecord(value.options) && isText(value.options.cwd, 16_384) && path.isAbsolute(value.options.cwd)
      && isDimension(value.options.cols) && isDimension(value.options.rows)
      && isRecord(value.options.env) && Object.entries(value.options.env).every(([name, item]) => isText(name, 4096) && !name.includes("=") && isText(item, 128 * 1024));
    case "write": return typeof value.data === "string" && Buffer.byteLength(value.data) <= MAX_TERMINAL_INPUT_BYTES;
    case "resize": return isDimension(value.cols) && isDimension(value.rows);
    case "kill": case "terminate": return true;
    default: return false;
  }
}

export function isTerminalResponse(value: unknown): value is TerminalResponse {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "ready": case "terminated": case "missing": return true;
    case "data": return typeof value.data === "string";
    case "screen": return typeof value.data === "string" && isDimension(value.cols) && isDimension(value.rows) && typeof value.complete === "boolean";
    case "error": return typeof value.message === "string";
    case "exit": return isRecord(value.event) && Number.isInteger(value.event.exitCode)
      && Number(value.event.exitCode) >= 0 && Number(value.event.exitCode) <= 255
      && (value.event.signal === undefined || Number.isInteger(value.event.signal) && Number(value.event.signal) > 0 && Number(value.event.signal) <= 64);
    default: return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !value.includes("\0");
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function isDimension(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 10_000;
}
