import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const TOKEN_ENV = "CLOUDX_CODEX_WORKER_TOKEN";

/** Observe the native protocol between the actual worker and its native TUI. */
export class CodexWorkerTurn {
  constructor(binding, save, saveFinal) {
    this.binding = binding;
    this.save = save;
    this.saveFinal = saveFinal;
    this.request = undefined;
    this.turn = undefined;
    this.earlyCompletions = [];
  }

  fromClient(message) {
    if (message.method !== "turn/start") return;
    const threadId = message.params?.threadId;
    if (typeof threadId !== "string" || !threadId || message.id == null)
      throw new Error("Native worker turn/start is missing its request or thread identity.");
    if (this.request) throw new Error("A Forge attempt cannot start another Codex turn.");
    if (this.binding.expectedThreadId && threadId !== this.binding.expectedThreadId)
      throw new Error("Native worker selected a different conversation than its prepared thread.");
    this.request = { id: message.id, threadId };
  }

  fromServer(message) {
    if (!this.request || this.turn?.status !== undefined && this.turn.status !== "running") return;
    if (!this.turn && message.id === this.request.id && !message.method) {
      const turnId = message.result?.turn?.id;
      if (typeof turnId !== "string" || !turnId)
        throw new Error(`Native worker turn/start failed: ${message.error?.message ?? "missing turn identity"}`);
      this.turn = {
        workerId: this.binding.workerId, attemptId: this.binding.attemptId,
        threadId: this.request.threadId, turnId, status: "running"
      };
      this.save(this.turn);
      for (const completion of this.earlyCompletions) this.complete(completion);
      this.earlyCompletions = [];
    }
    if (message.method === "item/completed" && message.params?.threadId === this.turn?.threadId && message.params?.turnId === this.turn?.turnId && message.params?.item?.phase === "final_answer")
      this.preserveFinal(message.params.item);
    if (message.method !== "turn/completed" || message.id != null) return;
    if (!this.turn) {
      if (message.params?.threadId === this.request.threadId) {
        if (this.earlyCompletions.length >= 32) throw new Error("Native worker completion queue exceeded its limit.");
        this.earlyCompletions.push(message.params);
      }
      return;
    }
    this.complete(message.params);
  }

  complete(params) {
    if (!this.turn || this.turn.status !== "running" || params?.threadId !== this.turn.threadId || params?.turn?.id !== this.turn.turnId) return;
    const status = params.turn.status;
    if (!["completed", "interrupted", "failed"].includes(status)) return;
    const error = params.turn.error?.message;
    // Native turn/completed contains only the final agent message summary.
    for (const item of params.turn.items ?? []) this.preserveFinal(item);
    this.turn = { ...this.turn, status, ...(typeof error === "string" ? { error } : {}) };
    this.save(this.turn);
  }

  preserveFinal(item) {
    if (!this.turn || item?.type !== "agentMessage" || item.phase === "commentary" || typeof item.text !== "string") return;
    if (Buffer.byteLength(item.text) > 1024 * 1024) throw new Error("Native final response exceeds the 1 MiB retention limit.");
    this.saveFinal?.({ ...this.turn, text: item.text });
  }
}

export function saveTurnReceipt(receiptPath, value) {
  const temporary = `${receiptPath}.${randomBytes(8).toString("hex")}.tmp`;
  const file = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(file, JSON.stringify(value));
    fsyncSync(file);
  } finally { closeSync(file); }
  renameSync(temporary, receiptPath);
  const directory = openSync(path.dirname(receiptPath), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** The enclosing terminal subreaper owns this bridge, both Codex processes, and every descendant. */
export async function runWorkerBridge(launch) {
  const token = randomBytes(32).toString("hex");
  let connected = false;
  const server = new WebSocketServer({
    host: "127.0.0.1", port: 0, maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: ({ req }) => !connected && !req.headers.origin && req.headers.authorization === `Bearer ${token}`
  });
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const turn = new CodexWorkerTurn(launch.binding,
    value => saveTurnReceipt(launch.binding.receiptPath, value),
    value => saveTurnReceipt(`${launch.binding.receiptPath}.final.json`, value));
  let finishing = false;
  const fail = error => {
    console.error(`CloudX native worker bridge: ${error.message}`);
    process.exit(1);
  };
  server.on("error", fail);
  server.on("connection", socket => {
    if (connected) { socket.close(); return; }
    connected = true;
    // The remote TUI has initialized its local state before connecting. Start
    // the backend here so their first SQLite migrations cannot race.
    const native = spawn(launch.command, launch.serverArgs, { stdio: ["pipe", "pipe", "inherit"] });
    let buffer = "";
    native.on("error", fail);
    native.stdin.on("error", fail);
    native.stdout.on("error", fail);
    native.on("exit", (code, signal) => {
      if (!finishing) fail(new Error(`Codex app-server exited before its visible worker (${signal ?? code}).`));
    });
    native.stdout.setEncoding("utf8");
    native.stdout.on("data", chunk => {
      try {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error("Native worker message exceeds the size limit.");
          const message = JSON.parse(line);
          if (socket.readyState !== WebSocket.OPEN) throw new Error("Native worker emitted a message without its visible client.");
          if (socket.bufferedAmount > MAX_MESSAGE_BYTES) throw new Error("Native worker client cannot keep up with output.");
          socket.send(line);
          turn.fromServer(message);
        }
        if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) throw new Error("Native worker message exceeds the size limit.");
      } catch (error) { fail(error); }
    });
    socket.on("error", fail);
    socket.on("message", data => {
      try {
        const message = JSON.parse(data.toString());
        turn.fromClient(message);
        const line = `${JSON.stringify(message)}\n`;
        if (native.stdin.writableLength + Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error("Native worker input exceeds the size limit.");
        native.stdin.write(line);
      } catch (error) { fail(error); }
    });
  });
  const tui = spawn(launch.command, [
    "--remote", `ws://127.0.0.1:${server.address().port}`,
    "--remote-auth-token-env", TOKEN_ENV, ...launch.tuiArgs
  ], { stdio: "inherit", env: { ...process.env, [TOKEN_ENV]: token } });
  tui.on("error", fail);
  tui.on("exit", (code, signal) => {
    finishing = true;
    // Exiting the bridge returns ownership to the terminal supervisor, which
    // reaps the app server and remaining tools before announcing terminal exit.
    process.exit(signal ? 1 : code ?? 1);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWorkerBridge(JSON.parse(process.argv[2])).catch(error => {
    console.error(`CloudX native worker bridge: ${error.message}`);
    process.exit(1);
  });
}
