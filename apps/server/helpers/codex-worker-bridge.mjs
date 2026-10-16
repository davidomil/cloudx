import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { WebSocketServer, WebSocket } from "ws";
import { CodexConversationSelection } from "./codex-conversation-selection.mjs";
import { CodexConversationForks } from "./codex-conversation-forks.mjs";
import { CodexWorkspaceScope } from "./codex-workspace-scope.mjs";
import { CodexRemotePermissions } from "./codex-remote-permissions.mjs";
import { forwardNativeOutput } from "./codex-worker-output.mjs";
import { CodexCommandDetailsCapture, saveCommandDetails } from "./codex-command-details.mjs";
import { CodexNativeWorkObservation } from "./codex-native-work.mjs";
import { CodexBackendDiagnostics } from "./codex-backend-diagnostics.mjs";
import { CodexResumeTimings } from "./codex-resume-timings.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_AUXILIARY_THREADS = 32;
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
    this.auxiliaryThreadRequests = new Set();
    this.auxiliaryThreads = new Set();
  }

  fromClient(message) {
    if (message.method === "thread/start" && ["system", "thread_title"].includes(message.params?.threadSource) && message.params?.ephemeral === true) {
      if (message.id == null) throw new Error("Native auxiliary thread/start is missing its request identity.");
      if (this.auxiliaryThreadRequests.size + this.auxiliaryThreads.size >= MAX_AUXILIARY_THREADS)
        throw new Error("Native auxiliary thread tracking exceeded its limit.");
      this.auxiliaryThreadRequests.add(message.id);
      return;
    }
    if (message.method === "thread/unsubscribe") {
      this.auxiliaryThreads.delete(message.params?.threadId);
      return;
    }
    if (message.method !== "turn/start") return;
    const threadId = message.params?.threadId;
    if (typeof threadId !== "string" || !threadId || message.id == null)
      throw new Error("Native worker turn/start is missing its request or thread identity.");
    if (this.auxiliaryThreads.has(threadId)) return;
    if (this.request) throw new Error("A Forge attempt cannot start another Codex turn.");
    if (this.binding.expectedThreadId && threadId !== this.binding.expectedThreadId)
      throw new Error("Native worker selected a different conversation than its prepared thread.");
    this.request = { id: message.id, threadId };
  }

  fromServer(message) {
    // Only the reply to an observed ephemeral system-thread request can admit
    // auxiliary turns. Request-ID prefixes and thread notifications are not proof.
    if (!message.method && this.auxiliaryThreadRequests.delete(message.id)) {
      const threadId = message.result?.thread?.id;
      if (!message.error && typeof threadId === "string" && threadId) {
        if (threadId === this.request?.threadId || threadId === this.binding.expectedThreadId)
          throw new Error("Native auxiliary creation returned the worker thread.");
        this.auxiliaryThreads.add(threadId);
      }
      return;
    }
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

/** Records whether any turn is running, for switching a tab to another agent. */
export class CodexTurnActivity {
  constructor(save) {
    this.save = save;
    this.requests = new Set();
    this.running = new Set();
    this.lastStatus = undefined;
  }

  fromClient(message) {
    if (message.method === "turn/start" && message.id != null) this.requests.add(message.id);
  }

  fromServer(message) {
    if (!message.method && this.requests.delete(message.id)) {
      const turnId = message.result?.turn?.id;
      if (!message.error && typeof turnId === "string" && turnId) this.running.add(turnId);
    } else if (message.method === "turn/completed" && message.id == null) {
      this.running.delete(message.params?.turn?.id);
    } else return;
    const status = this.running.size ? "running" : "idle";
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.save({ version: 1, status, updatedAt: new Date().toISOString() });
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
  if (!launch.binding && !launch.selection) throw new Error("A native bridge execution binding is required.");
  const diagnostics = new CodexBackendDiagnostics((launch.selection ?? launch.binding).receiptPath);
  diagnostics.append(`\nCloudX native bridge started ${new Date().toISOString()}\n`);
  process.once("exit", () => diagnostics.close());
  let diagnosticsFailed = false;
  const recordDiagnostic = chunk => {
    if (diagnosticsFailed) return;
    try { diagnostics.append(chunk); }
    catch {
      diagnosticsFailed = true;
      fail(new Error("Private Codex backend diagnostics could not be saved."));
    }
  };
  const timings = new CodexResumeTimings(recordDiagnostic, launch.preparationMs);
  if (launch.configurationNotice) process.stderr.write(`${launch.configurationNotice}\n`);
  const token = randomBytes(32).toString("hex");
  let frontend;
  let phase = launch.startupPicker ? "picker" : "conversation";
  let retiredBackend = Promise.resolve();
  let handoffTimer;
  const server = new WebSocketServer({
    host: "127.0.0.1", port: 0, maxPayload: MAX_INPUT_BYTES,
    verifyClient: ({ req }) => !frontend && phase !== "finishing" && !req.headers.origin && req.headers.authorization === `Bearer ${token}`
  });
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const turn = launch.binding ? new CodexWorkerTurn(launch.binding,
    value => saveTurnReceipt(launch.binding.receiptPath, value),
    value => saveTurnReceipt(`${launch.binding.receiptPath}.final.json`, value)) : undefined;
  const workspace = launch.workspace ? new CodexWorkspaceScope(launch.workspace) : undefined;
  const selection = launch.selection ? new CodexConversationSelection(launch.selection,
    (value, origin) => {
      workspace?.recordSelection(value, origin);
      saveTurnReceipt(launch.selection.receiptPath, value);
    }) : undefined;
  const forks = launch.forks ? new CodexConversationForks(launch.forks, selection,
    value => saveTurnReceipt(launch.forks.receiptPath, value)) : undefined;
  if (forks && turn) throw new Error("Owned Codex workers cannot hand off interactive forks.");
  let permissions = launch.permissions ? new CodexRemotePermissions(launch.permissions) : undefined;
  const commands = launch.commandDetails ? new CodexCommandDetailsCapture(launch.commandDetails,
    value => saveCommandDetails(launch.commandDetails.receiptPath, value),
    { onError: error => recordDiagnostic(`CloudX command details: ${error.message}\n`) }) : undefined;
  // Activity only informs agent switching. A failed write must not end the session.
  const activity = launch.activity ? new CodexTurnActivity(value => {
    try { saveTurnReceipt(launch.activity.receiptPath, value); }
    catch (error) { recordDiagnostic(`CloudX turn activity: ${error.message}\n`); }
  }) : undefined;
  const workHealth = launch.workHealth ? new CodexNativeWorkObservation(launch.workHealth, value => {
    try { saveTurnReceipt(launch.workHealth.receiptPath, value); }
    catch (error) { recordDiagnostic(`CloudX native work health: ${error.message}\n`); }
  }, selection) : undefined;
  if (!turn && !selection) throw new Error("A native bridge execution binding is required.");
  let finishing = false;
  let failure;
  let failureTimer;
  let tui;
  const retiringTuis = new Set();
  const showFailure = () => {
    clearTimeout(failureTimer);
    const message = stripVTControlCharacters(failure.message).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512);
    const diagnosticPath = stripVTControlCharacters(diagnostics.path).replace(/[\x00-\x1f\x7f]/g, " ");
    process.stderr.write(`\r\nCloudX native worker bridge: ${message}\r\n${diagnosticsFailed ? "Backend diagnostics could not be saved; inspect retained file" : "Private backend diagnostics"}: ${diagnosticPath}\r\n`, () => process.exit(1));
  };
  const fail = error => {
    if (failure) return;
    failure = error;
    recordDiagnostic(`CloudX native worker bridge: ${error.message}\n`);
    if (!tui?.pid || tui.exitCode !== null || tui.signalCode !== null) showFailure();
    else {
      tui.kill("SIGTERM");
      failureTimer = setTimeout(() => tui.kill("SIGKILL"), 1_000);
    }
  };
  const awaitVisibleExit = () => {
    if (finishing) return;
    if (turn && turn.turn?.status !== "completed")
      throw new Error("Native visible client disconnected before its owned turn completed.");
    finishing = true;
    phase = "finishing";
    setTimeout(() => fail(new Error("Native visible client disconnected without exiting.")), 5_000);
  };
  server.on("error", fail);
  server.on("connection", socket => {
    if (frontend || phase === "finishing") { socket.close(); return; }
    frontend = socket;
    const picker = phase === "picker";
    if (phase === "handoff") phase = "conversation";
    let native;
    let retiring = false;
    let queuedBytes = 0;
    const queued = [];
    const forward = line => {
      if (finishing || retiring) return;
      if (native.stdin.writableLength + Buffer.byteLength(line) > MAX_INPUT_BYTES) throw new Error("Native worker input exceeds the size limit.");
      native.stdin.write(line);
    };
    socket.on("error", error => {
      if (["EPIPE", "ECONNRESET"].includes(error.code) && socket.readyState === WebSocket.CLOSING) return;
      fail(error);
    });
    socket.on("message", data => {
      if (finishing || retiring) return;
      try {
        const message = JSON.parse(data.toString());
        const fork = forks?.fromClient(message);
        if (fork?.error) { socket.send(JSON.stringify({ id: message.id, error: fork.error })); return; }
        workspace?.fromClient(message);
        timings.fromClient(message);
        permissions?.fromClient(message);
        if (!fork) selection?.fromClient(message);
        workHealth?.fromClient(message);
        turn?.fromClient(message);
        activity?.fromClient(message);
        commands?.fromClient(message);
        const line = `${JSON.stringify(message)}\n`;
        if (native) forward(line);
        else {
          queuedBytes += Buffer.byteLength(line);
          if (queuedBytes > MAX_INPUT_BYTES) throw new Error("Native picker handoff input exceeds the size limit.");
          queued.push(line);
        }
      } catch (error) { fail(error); }
    });
    socket.on("close", () => {
      timings.disconnected();
      workspace?.listings.clear();
      if (retiring) return;
      try {
        if (picker && !selection?.selectedThreadId && !selection?.pending.size && !turn?.request) {
          workspace?.pending.clear();
          phase = "handoff";
          frontend = undefined;
          retiring = true;
          // The picker owns this initialized stdio connection. Its successor
          // needs a fresh initialization, after the old backend has been reaped.
          retiredBackend = native ? new Promise(resolve => {
            native.once("close", resolve);
            native.stdin.end();
          }) : Promise.resolve();
          handoffTimer = setTimeout(() => fail(new Error("Native picker did not hand off to a conversation or exit within 5 seconds.")), 5_000);
        } else awaitVisibleExit();
      } catch (error) { fail(error); }
    });
    void retiredBackend.then(() => {
      if (finishing || socket.readyState !== WebSocket.OPEN) return;
      clearTimeout(handoffTimer);
      // The remote TUI has initialized its local state before connecting. Start
      // the backend here so their first SQLite migrations cannot race.
      native = spawn(launch.command, launch.serverArgs, { stdio: ["pipe", "pipe", "pipe"] });
      timings.record("native_spawned");
      native.stderr.on("data", recordDiagnostic);
      native.stderr.on("error", fail);
      native.on("error", fail);
      native.stdin.on("error", error => {
        // Pending writes can outlive the client's close handshake. Its visible
        // exit still decides completion; a closed pipe cannot override it.
        if (error.code === "EPIPE" && (finishing || retiring)) return;
        fail(error);
      });
      native.stdout.on("error", fail);
      let backendExitTimer;
      native.on("exit", (code, signal) => {
        if (!finishing && !retiring)
          backendExitTimer = setTimeout(() => fail(new Error(`Codex app-server exited before its visible worker (${signal ?? code}).`)), 250);
      });
      native.on("close", (code, signal) => {
        clearTimeout(backendExitTimer);
        if (!finishing && !retiring) fail(new Error(`Codex app-server exited before its visible worker (${signal ?? code}).`));
      });
      const handOffFork = async fork => {
        retiring = true;
        phase = "fork-handoff";
        const oldTui = tui;
        retiringTuis.add(oldTui);
        const stoppedTui = new Promise(resolve => oldTui.once("close", resolve));
        const stoppedBackend = new Promise(resolve => native.once("close", (code, signal) => resolve({ code, signal })));
        const deadline = setTimeout(() => fail(new Error("Native fork source did not stop within 5 seconds.")), 5_000);
        try {
          // Hold the successful reply: the old TUI must never adopt the child.
          oldTui.kill("SIGTERM");
          native.stdin.end();
          socket.close();
          const [, backendExit] = await Promise.all([stoppedTui, stoppedBackend]);
          if (failure) return;
          if (backendExit.signal || backendExit.code !== 0)
            throw new Error(`Native fork backend failed during retirement (${backendExit.signal ?? backendExit.code}).`);
          // Backend close flushes the actual native fork and releases ownership
          // before another tab can resume it. The journal is durable and bounded.
          workspace?.recordSelection({ authority: "selected", ...fork }, { created: true });
          forks.publish(fork);
          workspace?.pending.clear();
          selection.pending.clear();
          selection.subscribedSelections.clear();
          forks.pending.clear();
          workHealth?.pending.clear();
          activity?.requests.clear();
          activity?.running.clear();
          commands?.resumeRequests.clear();
          commands?.historyRequests.clear();
          permissions = launch.permissions ? new CodexRemotePermissions(launch.permissions) : undefined;
          frontend = undefined;
          phase = "conversation";
          startTui([...launch.forks.resumeArgs, "--cd", fork.sourceCwd, "resume", fork.sourceId]);
        } finally { clearTimeout(deadline); retiringTuis.delete(oldTui); }
      };
      void forwardNativeOutput(native.stdout, socket, message => {
        if (retiring) return false;
        const fork = forks?.fromServer(message);
        if (fork === false) return false;
        if (fork) { void handOffFork(fork).catch(fail); return false; }
        const delivered = workspace?.fromServer(message, next => forward(`${JSON.stringify(next)}\n`)) !== false;
        timings.fromServer(message, delivered);
        if (!delivered) return false;
        permissions?.fromServer(message);
        selection?.fromServer(message);
        workHealth?.fromServer(message);
        turn?.fromServer(message);
        activity?.fromServer(message);
        commands?.fromServer(message);
      }).catch(fail);
      for (const line of queued) forward(line);
      queued.length = 0;
    }).catch(fail);
  });
  const startTui = args => {
    const child = spawn(launch.command, [
      "--remote", `ws://127.0.0.1:${server.address().port}`,
      "--remote-auth-token-env", TOKEN_ENV, ...args
    ], { stdio: "inherit", env: { ...process.env, [TOKEN_ENV]: token } });
    tui = child;
    child.on("error", fail);
    child.on("exit", async (code, signal) => {
      if (retiringTuis.has(child) && !failure) return;
      if (failure) { showFailure(); return; }
      finishing = true;
      // Exiting the bridge returns ownership to the terminal supervisor, which
      // reaps the app server and remaining tools before announcing terminal exit.
      await commands?.close();
      process.exit(signal ? 1 : code ?? 1);
    });
  };
  startTui(launch.tuiArgs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWorkerBridge(JSON.parse(process.argv[2])).catch(error => {
    console.error(`CloudX native worker bridge: ${error.message}`);
    process.exit(1);
  });
}
