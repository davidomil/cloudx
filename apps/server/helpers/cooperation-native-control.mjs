import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const MAX_REQUEST_BYTES = 128 * 1024;

/** A private control endpoint owned by the already-running native provider. */
export class CooperationNativeControl {
  constructor(binding, deliver) {
    this.binding = binding;
    this.deliver = deliver;
    this.deliveries = new Map();
    this.connections = new Set();
    this.publication = Promise.resolve();
    this.boundaryEpoch = 0;
    this.turnObservations = Promise.resolve();
  }

  async start() {
    // AF_UNIX paths are bounded independently of filesystem paths. The fixed
    // private Linux runtime directory keeps long CloudX data roots out of it.
    const directory = path.join("/tmp", `cloudx-cooperation-${process.getuid?.() ?? "user"}`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new Error("Native cooperation control requires a private owned directory.");
    this.socketPath = path.join(directory, `${randomBytes(16).toString("hex")}.sock`);
    this.server = net.createServer(socket => this.accept(socket));
    this.server.maxConnections = 16;
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.socketPath, resolve); });
    await fs.chmod(this.socketPath, 0o600);
    await this.publish(true);
    return this;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.connections) socket.destroy();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    if (this.socketPath) await fs.rm(this.socketPath, { force: true });
    await this.turnObservations;
    await this.publish();
  }

  mark(eventIds, state, details = {}) {
    for (const eventId of eventIds) {
      const entry = this.deliveries.get(eventId);
      if (entry && !(entry.state === "nativeAccepted" && state === "unknown")) this.deliveries.set(eventId, { ...entry, ...details, state });
    }
    return this.publish();
  }

  boundary() {
    this.boundaryEpoch += 1;
    return this.publish();
  }

  turn(value) {
    this.turnObservations = this.turnObservations.catch(() => undefined).then(async () => {
      const context = await readPrivateJson(this.binding.contextPath, 16384).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
      if (!context || !this.ownsContext(context)) return;
      if (!value.providerTurnId || !["running", "completed", "failed", "interrupted"].includes(value.status)) return;
      const previous = this.currentTurn?.providerTurnId === value.providerTurnId ? this.currentTurn : undefined;
      if (previous && previous.status !== "running" && value.status === "running") return;
      this.currentTurn = {
        ...previous, ...value, boardId: previous?.boardId ?? context.boardId,
        assignmentGeneration: previous?.assignmentGeneration ?? context.assignmentGeneration,
        startedAt: previous?.startedAt ?? new Date().toISOString(),
        ...(value.status !== "running" ? { completedAt: new Date().toISOString() } : {})
      };
      await this.publish();
    });
    return this.turnObservations;
  }

  publish(replace = false) {
    this.publication = this.publication.catch(() => undefined).then(async () => {
      if (!replace) {
        const current = await readPrivateJson(`${this.binding.contextPath}.native.json`).catch(error => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (current?.socketPath !== this.socketPath) return;
      }
      await writePrivateJson(`${this.binding.contextPath}.native.json`, {
      version: 1, providerId: this.binding.providerId, tabId: this.binding.tabId,
      executionId: this.binding.executionId, socketPath: this.socketPath,
      status: this.closed ? "closed" : "ready", boundaryEpoch: this.boundaryEpoch, currentTurn: this.currentTurn,
      deliveries: [...this.deliveries.values()]
      });
    });
    return this.publication;
  }

  accept(socket) {
    this.connections.add(socket);
    socket.once("close", () => this.connections.delete(socket));
    socket.on("error", () => undefined);
    socket.setTimeout(15000, () => socket.destroy());
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      const line = input.indexOf("\n");
      if (line < 0) return;
      socket.removeAllListeners("data");
      void Promise.resolve().then(() => this.request(JSON.parse(input.slice(0, line)))).then(result => socket.end(`${JSON.stringify(result)}\n`)).catch(error => {
        socket.end(`${JSON.stringify({ state: "unavailable", reason: error.message })}\n`);
      });
    });
  }

  async request(request) {
    if (this.closed) return { state: "unavailable", reason: "The original native session has closed." };
    const context = await readPrivateJson(this.binding.contextPath, 16384);
    if (typeof request.capability !== "string" || !/^[a-f0-9]{64}$/.test(request.capability) ||
      typeof context.capability !== "string" || !/^[a-f0-9]{64}$/.test(context.capability) ||
      !timingSafeEqual(Buffer.from(request.capability, "hex"), Buffer.from(context.capability, "hex"))) throw new Error("The native cooperation capability is revoked.");
    if (context.tabId !== this.binding.tabId || request.recipientTabId !== context.tabId ||
      request.assignmentGeneration !== context.assignmentGeneration || request.boardId !== context.boardId)
      throw new Error("The blackboard assignment changed before native delivery.");
    if (!this.ownsContext(context)) throw new Error("The original native execution has been replaced.");
    if (!Array.isArray(request.eventIds) || request.eventIds.length === 0 || request.eventIds.length > 100 || new Set(request.eventIds).size !== request.eventIds.length ||
      request.eventIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) ||
      typeof request.text !== "string" || request.text.length === 0 || Buffer.byteLength(request.text) > 64000)
      throw new Error("The native cooperation envelope is invalid.");
    const fingerprint = createHash("sha256").update(JSON.stringify({ boardId: request.boardId, assignmentGeneration: request.assignmentGeneration, eventIds: request.eventIds, text: request.text })).digest("hex");
    const previous = request.eventIds.map(id => this.deliveries.get(id)).filter(Boolean);
    if (previous.length) {
      if (previous.length !== request.eventIds.length || previous.some(entry => entry.fingerprint !== fingerprint))
        throw new Error("Native feedback identity was reused for different content.");
      return previous[0].state === "submitting" ? { state: "unknown", reason: "The original native submission has no acknowledgment yet." } : previous[0];
    }
    if (this.deliveries.size + request.eventIds.length > 4096) throw new Error("The native feedback receipt limit was reached. Read retained receipts before continuing.");
    const entry = { eventIds: request.eventIds, boardId: request.boardId, assignmentGeneration: request.assignmentGeneration, fingerprint, state: "submitting" };
    for (const id of request.eventIds) this.deliveries.set(id, entry);
    await this.publish();
    let result;
    try { result = await this.deliver(request); }
    catch (error) { result = { state: "unknown", reason: error.message }; }
    if (["queued", "unavailable"].includes(result.state)) {
      // Admission did not submit native work. A later boundary can try the
      // same durable inbox event, after revalidating its assignment.
      for (const id of request.eventIds) this.deliveries.delete(id);
      await this.publish();
    } else await this.mark(request.eventIds, result.state, result);
    const retained = this.deliveries.get(request.eventIds[0]);
    return retained?.state === "nativeAccepted" ? retained : result;
  }

  ownsContext(context) {
    return context.tabId === this.binding.tabId && (!context.providerId || context.providerId === this.binding.providerId) &&
      (!context.executionId || context.executionId === this.binding.executionId);
  }
}

export async function readPrivateJson(filePath, maxBytes = 1024 * 1024) {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Native cooperation state must be a bounded regular file.");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

export async function writePrivateJson(filePath, value) {
  const temporary = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, filePath);
}
