import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { filesystemCapacity } from "./managed-update-store.mjs";

// Only parsed control records are buffered. Retained histories are streamed.
const STATE_LIMIT = 16 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]+$/u;
const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const FORGE_STATE = `plugin-data/forge-${createHash("sha256").update("forge").digest("hex")}.json`;
const WORKER_GUIDANCE = "Stop or recover the worker through CloudX first. Resolve missing ownership evidence explicitly; service restarts do not prove a worker ended. Local resources were preserved.";
const LEGACY_RECOVERY = "Legacy workspace has no saved session identities. Its exact layout will be backed up, but in-memory tabs and terminal processes cannot be restored. Record working directories and exact Codex conversation IDs before confirming interruption. No commands or prompts will be replayed.";

export class ForgeUpdateBlockedError extends Error {
  constructor(message, worker) {
    super(message);
    const changeNumber = worker?.changeNumber ?? (worker?.kind === "review" ? worker.number : undefined);
    this.component = "forge";
    this.publicMessage = message.replace(` ${WORKER_GUIDANCE}`, "");
    this.forgeBlocker = { kind: "forge", message: this.publicMessage, recoveryAction: WORKER_GUIDANCE,
      ...(typeof worker?.id === "string" && worker.id.length <= 128 && SAFE_ID.test(worker.id) ? { workerId: worker.id } : {}),
      ...(worker?.kind === "issue" && Number.isSafeInteger(worker.number) && worker.number > 0 ? { issueNumber: worker.number } : {}),
      ...(Number.isSafeInteger(changeNumber) && changeNumber > 0 ? { changeNumber } : {}),
    };
  }
}

/** Check Forge ownership without scanning unrelated retained history. */
export function assertTerminalMigrationSafe(options) {
  const snapshot = new RecoverySnapshot(options);
  snapshot.readForgeState({ includeHistory: false });
}

/** Inspect all recovery data and destination capacity before interrupting services. */
export function inspectTerminalRecovery(options) {
  const snapshot = new RecoverySnapshot(options);
  snapshot.readForgeState();
  snapshot.readSessions();
  snapshot.assertCapacity();
  return { legacySessionIdentitiesUnavailable: snapshot.legacySessions, warnings: snapshot.warnings() };
}

/** The caller must stop the web service before this runs, and stop the broker only after it returns. */
export function snapshotTerminalRecovery({ log = console.warn, ...options }) {
  const snapshot = new RecoverySnapshot({ ...options, log });
  snapshot.readForgeState();
  snapshot.readSessions();
  if (!snapshot.files.size) return undefined;
  const backup = snapshot.save(log);
  for (const warning of snapshot.warnings()) log(warning);
  log(`Verified terminal recovery snapshot: ${backup}. Broker replacement interrupts processes. Reopen shells explicitly and select an exact saved Codex conversation in each existing tab; no commands or prompts are replayed.`);
  return backup;
}

class RecoverySnapshot {
  files = new Map();
  conversations = [];
  transcriptBindings = [];
  unavailableConversations = [];
  sources = [];
  legacySessions = false;

  constructor({ dataDir, allowLegacyState = false, inspectCapacity = filesystemCapacity, signal, log = () => {} }) {
    this.dataDir = path.resolve(dataDir);
    this.present = safeDirectory(this.dataDir, true);
    this.allowLegacyState = allowLegacyState;
    this.inspectCapacity = inspectCapacity;
    this.signal = signal;
    this.log = log;
  }

  capture(relative, optional = false, source = path.join(this.dataDir, relative)) {
    if (this.files.has(relative)) return this.files.get(relative);
    let reported = 0;
    const captured = scanFile(source, { optional, signal: this.signal, chunk: (_bytes, position) => {
      if (position - reported >= 64 * COPY_CHUNK_BYTES) {
        this.log(`Terminal recovery: ${position} bytes inspected (${relative}).`);
        reported = position;
      }
    } });
    if (captured === undefined) return undefined;
    const file = { source, ...captured };
    this.files.set(relative, file);
    return file;
  }

  json(relative, optional = false) {
    const bytes = readFile(path.join(this.dataDir, relative), STATE_LIMIT, optional);
    if (bytes === undefined) return undefined;
    const captured = this.capture(relative);
    if (createHash("sha256").update(bytes).digest("hex") !== captured.sha256)
      throw new Error(`Recovery source changed during snapshot: ${relative}`);
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error(`Invalid recovery state: ${relative}. Repair the original state before replacing the broker.`); }
  }

  readForgeState({ includeHistory = true } = {}) {
    try {
      this.readForgeRecords();
      if (includeHistory)
        for (const directory of ["executions", "turns", "history"])
          for (const relative of this.stateFiles(`forge-workers/${directory}`)) this.capture(relative);
    }
    catch (error) {
      if (error instanceof ForgeUpdateBlockedError) throw error;
      throw new ForgeUpdateBlockedError(`Forge recovery evidence could not be verified. ${error.message}`);
    }
  }

  readForgeRecords() {
    if (!this.present) return;
    const workers = this.json(FORGE_STATE, true) ?? [];
    if (!Array.isArray(workers) || new Set(workers.map(worker => worker?.id)).size !== workers.length)
      throw new Error(`Invalid Forge worker state. ${WORKER_GUIDANCE}`);
    const ownership = new Map();
    for (const relative of this.stateFiles("forge-workers/workspaces")) {
      const owned = this.json(relative);
      if (!owned || typeof owned.id !== "string" || !SAFE_ID.test(owned.id) || ownership.has(owned.id) || path.basename(relative) !== `${owned.id}.json` ||
          typeof owned.launchPending !== "boolean" || typeof owned.gitPending !== "boolean" || typeof owned.cleaned !== "boolean")
        throw new Error(`Invalid Forge ownership: ${relative}. ${WORKER_GUIDANCE}`);
      if (owned.launchPending || owned.gitPending)
        throw new ForgeUpdateBlockedError(`Forge worker ${owned.id} has a pending launch or Git operation. ${WORKER_GUIDANCE}`, workers.find(worker => worker?.id === owned.id) ?? owned);
      ownership.set(owned.id, owned);
    }
    for (const worker of workers) {
      if (!worker || typeof worker.id !== "string" || !SAFE_ID.test(worker.id) ||
          !["paused", "awaiting_review", "stopped", "completed", "failed"].includes(worker.status) ||
          worker.pendingPublication || worker.mergeAttempted || ["creating", "uncertain"].includes(worker.publicationState) || ["posting", "post_failed"].includes(worker.draft?.status))
        throw new ForgeUpdateBlockedError(`Forge worker ${worker?.id ?? "unknown"} is active or has unresolved work. ${WORKER_GUIDANCE}`, worker);
      if ((worker.worktreePath || worker.retainedWorkspace || worker.tabId || worker.attemptId) && !ownership.has(worker.id))
        throw new ForgeUpdateBlockedError(`Forge worker ${worker.id} has missing workspace ownership. ${WORKER_GUIDANCE}`, worker);
    }
    const tabs = new Map();
    for (const relative of this.stateFiles("forge-workers/tabs")) {
      const tab = this.json(relative);
      if (!tab || typeof tab.tabId !== "string" || !SAFE_ID.test(tab.tabId) || path.basename(relative) !== `${tab.tabId}.json` ||
          tabs.has(tab.tabId) || !ownership.has(tab.workerId) || typeof tab.closed !== "boolean" || typeof tab.quiescent !== "boolean" || !tab.closed && !tab.quiescent)
        throw new Error(`Forge terminal ownership is active or unresolved: ${relative}. ${WORKER_GUIDANCE}`);
      tabs.set(tab.tabId, tab);
    }
    for (const worker of workers) {
      if (worker.tabId === undefined) continue;
      const tab = tabs.get(worker.tabId);
      if (!tab || tab.workerId !== worker.id || tab.attemptId !== undefined && tab.attemptId !== worker.attemptId && !this.completedAttempt(worker, tab))
        throw new ForgeUpdateBlockedError(`Forge worker ${worker.id} has missing or conflicting terminal ownership. ${WORKER_GUIDANCE}`, worker);
    }
  }

  completedAttempt(worker, tab) {
    const completion = worker.completion;
    const turn = completion?.turn;
    if (worker.attemptId !== undefined || typeof tab.attemptId !== "string" || !SAFE_ID.test(tab.attemptId) || completion?.attemptId !== tab.attemptId ||
        turn?.status !== "completed" || turn.workerId !== worker.id || turn.attemptId !== tab.attemptId ||
        ![turn.threadId, turn.turnId].every(value => typeof value === "string" && value.length > 0)) return false;
    const saved = this.json(`forge-workers/turns/${worker.id}/${tab.attemptId}.json`, true);
    if (!saved || ["workerId", "attemptId", "threadId", "turnId", "status", "error"].some(key => saved[key] !== turn[key])) return false;
    const execution = tab.execution;
    if (!execution || !CONVERSATION_ID.test(execution.executionId) || !CONVERSATION_ID.test(execution.bootId) ||
        !/^pid:\[\d+\]$/u.test(execution.pidNamespace) || execution.directory !== path.join(this.dataDir, "forge-workers/executions", execution.executionId) ||
        execution.receiptDirectory?.path !== execution.directory) return false;
    try {
      assertSourceIdentity({ ...execution.receiptDirectory, home: execution.directory });
      const ready = this.json(`forge-workers/executions/${execution.executionId}/ready.json`, true);
      const complete = this.json(`forge-workers/executions/${execution.executionId}/complete.json`, true);
      return [ready, complete].every(receipt => receipt && ["executionId", "bootId", "pidNamespace"].every(key => receipt[key] === execution[key]) &&
        Number.isSafeInteger(receipt.pid) && receipt.pid > 0 && typeof receipt.started === "string" && /^\d+$/u.test(receipt.started)) &&
        complete.pid === ready.pid && complete.started === ready.started && Number.isInteger(complete.exitCode) && complete.exitCode >= 0 && complete.exitCode <= 255 &&
        (complete.signal === undefined || complete.exitCode === 0 && Number.isInteger(complete.signal) && complete.signal > 0 && complete.signal <= 64);
    } catch { return false; }
  }

  stateFiles(relative) {
    const files = [];
    const pending = [relative];
    while (pending.length) {
      this.signal?.throwIfAborted();
      const current = pending.pop();
      const directory = path.join(this.dataDir, current);
      if (!safeDirectory(directory, current === relative)) continue;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(candidate);
        else if (entry.isFile() && entry.name.endsWith(".json")) files.push(candidate);
        else throw new Error(`Unsafe or unexpected recovery state: ${candidate}`);
      }
    }
    return files;
  }

  readSessions() {
    if (!this.present) return;
    const workspace = this.json("workspace.json", true);
    const saved = this.json("sessions.json", true);
    if (workspace !== undefined && saved === undefined && (!validWorkspace(workspace) || workspace.windows.some(window => layoutTabIds(window.layout).length))) {
      if (!this.allowLegacyState) throw new Error(LEGACY_RECOVERY);
      this.legacySessions = true;
    }
    if (saved === undefined) return;
    if (!saved || saved.version !== 1 || !Array.isArray(saved.sessions) ||
        saved.sessions.some(session => !session || !validSession(session)))
      throw new Error("Invalid saved tab identities; broker replacement stopped.");
    const ids = saved.sessions.map(({ tab }) => tab.id);
    const savedIds = new Set(ids);
    if (savedIds.size !== ids.length || saved.activeTabId !== undefined && !savedIds.has(saved.activeTabId))
      throw new Error("Duplicate or unknown active tab identity; broker replacement stopped.");
    if ((workspace !== undefined || ids.length) && !validWorkspace(workspace))
      throw new Error("Saved tabs have no recoverable workspace layout; broker replacement stopped.");
    if (workspace)
      for (const window of workspace.windows)
        for (const tabId of layoutTabIds(window.layout))
          if (!savedIds.has(tabId))
            throw new Error(`Workspace tab ${tabId} has no saved session identity; broker replacement stopped. Preserve and close the tab manually, or repair sessions.json before migration.`);
    for (const session of saved.sessions)
      if (session.tab.pluginId === "codex-terminal") this.readConversation(session);
  }

  readConversation({ tab, initialInput }) {
    const view = `codex-launches/${tab.id}`;
    const binding = this.json(`${view}/.cloudx-source.json`, true);
    const receiptPath = `${view}/.cloudx-conversation.json`;
    const receipt = this.json(receiptPath, true);
    const unavailable = receipt === undefined && tab.status === "failed" && tab.recovery?.state === "missing" && tab.recovery.canResume === false &&
      initialInput?.codexExecutionId === undefined;
    if (binding !== undefined || !unavailable) {
      if (!isRecord(binding) || Object.keys(binding).some(key => !["dev", "home", "ino", "sourceId", "version", "durable"].includes(key)) ||
        binding.durable !== undefined && !validDurableIdentity(binding.durable) ||
        binding.version !== 1 || binding.sourceId !== "shared" ||
        ![binding.home, binding.sourceId, binding.dev, binding.ino].every(value => typeof value === "string") || !path.isAbsolute(binding.home))
        throw new Error(`Codex tab ${tab.id} has invalid source ownership.`);
      assertSourceIdentity(binding);
      this.sources.push(binding);
    }
    if (unavailable) {
      this.unavailableConversations.push({ tabId: tab.id, receiptPath, message:
        `Codex tab ${tab.id} has an ended legacy process without a saved conversation receipt and remains unavailable. In CloudX, select an exact saved session in Terminal recovery or close the tab. No conversation ID was inferred.` });
      return;
    }
    const launchId = initialInput?.resume?.mode === "session" ? initialInput.resume.sessionId : undefined;
    if (!isRecord(receipt) || typeof receipt.sessionId !== "string" || !CONVERSATION_ID.test(receipt.sessionId) ||
        typeof receipt.cwd !== "string" || !path.isAbsolute(receipt.cwd) ||
        typeof receipt.transcriptPath !== "string" || !path.isAbsolute(receipt.transcriptPath) ||
        launchId !== undefined && launchId !== receipt.sessionId)
      throw new Error(`Codex tab ${tab.id} has missing or conflicting conversation identity. In CloudX, recover its exact saved conversation or close the tab before replacement; do not infer a conversation ID.`);
    const selected = receipt.version === 2 && receipt.authority === "selected";
    if ((receipt.version !== undefined || receipt.authority !== undefined) && !selected ||
        selected && (typeof receipt.tabId !== "string" || !receipt.tabId || typeof receipt.executionId !== "string" || !CONVERSATION_ID.test(receipt.executionId)))
      throw new Error(`Codex tab ${tab.id} has an invalid conversation selection binding.`);
    if (selected && (receipt.tabId !== tab.id || receipt.executionId !== initialInput?.codexExecutionId))
      throw new Error(`Codex tab ${tab.id} conversation belongs to a different tab or execution. Select and save its exact conversation before replacement.`);
    const transcriptBinding = { tabId: tab.id, view: path.join(this.dataDir, view), binding, receipt };
    const { transcriptPath, storeIdentity } = resolveBoundTranscript(transcriptBinding);
    this.transcriptBindings.push({ ...transcriptBinding, transcriptPath, storeIdentity });
    const destination = `transcripts/${tab.id}.jsonl`;
    this.capture(destination, false, transcriptPath);
    const header = transcriptHeader(transcriptPath);
    let metadata;
    try { if (header.length <= 1024 * 1024) metadata = JSON.parse(header.toString("utf8")); } catch {}
    if (metadata?.type !== "session_meta" || metadata.payload?.id !== receipt.sessionId || metadata.payload?.cwd !== receipt.cwd)
      throw new Error(`Codex tab ${tab.id} transcript metadata does not match its conversation receipt.`);
    this.conversations.push({ tabId: tab.id, lastObservedSessionId: receipt.sessionId, transcriptPath, snapshot: destination });
  }

  warnings() {
    return [...(this.legacySessions ? [LEGACY_RECOVERY] : []), ...this.unavailableConversations.map(({ message }) => message)];
  }

  assertCapacity() {
    if (!this.files.size) return;
    const capacity = this.inspectCapacity(this.dataDir);
    const block = capacity.blockSize;
    const rounded = bytes => Math.ceil(bytes / block) * block;
    const directories = new Set(["."]);
    let requiredBytes = 0;
    let manifestBytes = 4096 + Buffer.byteLength(JSON.stringify({ conversations: this.conversations,
      unavailableConversations: this.unavailableConversations, warnings: this.warnings() }));
    for (const [relative, file] of this.files) {
      requiredBytes += rounded(file.size);
      // JSON escapes can expand each path character to six bytes.
      manifestBytes += 512 + 6 * Buffer.byteLength(file.source + relative);
      for (let parent = path.dirname(relative); parent !== "."; parent = path.dirname(parent)) directories.add(parent);
    }
    const requiredInodes = this.files.size + directories.size + 1;
    requiredBytes += directories.size * block + rounded(manifestBytes);
    if (!Number.isSafeInteger(requiredBytes)) throw new Error("Terminal recovery capacity exceeds the supported integer range.");
    if (requiredBytes > capacity.availableBytes || requiredInodes > capacity.availableInodes)
      throw new Error(`Terminal recovery destination ${this.dataDir} requires ${requiredBytes} bytes and ${requiredInodes} inodes; ` +
        `${capacity.availableBytes} bytes and ${capacity.availableInodes} inodes available (${capacity.quotaStatus}). ` +
        "Free destination space or quota before interrupting services. Original recovery data was preserved.");
  }

  assertSources() {
    for (const source of this.sources) assertSourceIdentity(source);
    for (const transcript of this.transcriptBindings) {
      const current = resolveBoundTranscript(transcript);
      if (current.transcriptPath !== transcript.transcriptPath ||
          ["dev", "ino", "uid", "birthtimeNs"].some(key => current.storeIdentity[key] !== transcript.storeIdentity[key]))
        throw new Error(`Codex tab ${transcript.tabId} session store changed during snapshot.`);
    }
  }

  save(log) {
    this.assertCapacity();
    const backup = fs.mkdtempSync(path.join(this.dataDir, "terminal-recovery-"));
    try {
      const files = [];
      let copied = 0;
      const total = [...this.files.values()].reduce((bytes, file) => bytes + file.size, 0);
      for (const [relative, file] of this.files) {
        const { source, sha256 } = file;
        const target = path.join(backup, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        let reported = 0;
        try {
          const saved = scanFile(source, { signal: this.signal, chunk: (bytes, position) => {
            let offset = 0;
            while (offset < bytes.length) {
              const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
              if (!written) throw new Error(`Recovery destination stopped accepting data: ${relative}`);
              offset += written;
            }
            if (position - reported >= 64 * COPY_CHUNK_BYTES) {
              log(`Terminal recovery: ${copied + position}/${total} bytes copied (${relative}).`);
              reported = position;
            }
          } });
          if (!sameFile(file, saved)) throw new Error(`Recovery source changed during snapshot: ${source}`);
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        if (scanFile(target, { signal: this.signal }).sha256 !== sha256) throw new Error(`Backup verification failed: ${relative}`);
        copied += file.size;
        log(`Terminal recovery: ${copied}/${total} bytes copied (${relative}).`);
        files.push({ source, snapshot: relative, sha256 });
      }
      // Detect state or transcript changes across the whole snapshot, including ongoing Codex writes.
      this.assertSources();
      for (const file of this.files.values())
        if (!sameFile(file, scanFile(file.source, { signal: this.signal }))) throw new Error(`Recovery source changed during snapshot: ${file.source}`);
      for (const { receiptPath } of this.unavailableConversations)
        if (readFile(path.join(this.dataDir, receiptPath), STATE_LIMIT, true) !== undefined)
          throw new Error(`Recovery source changed during snapshot: ${receiptPath}`);
      fs.writeFileSync(path.join(backup, "manifest.json"), `${JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), files, conversations: this.conversations,
        unavailableConversations: this.unavailableConversations.map(({ tabId, message }) => ({ tabId, message })),
        legacySessionIdentitiesUnavailable: this.legacySessions,
        warnings: this.warnings(),
        recovery: "Keep existing tabs and layouts. Start shells explicitly. Select an exact saved Codex session in its existing tab; lastObservedSessionId is not proof of the current native selection. Never replay saved shell commands or AI prompts. Forge ownership records remain unchanged." }, null, 2)}\n`,
      { flag: "wx", mode: 0o600, flush: true });
      syncDirectories(backup);
      syncDirectory(this.dataDir);
      return backup;
    } catch (error) {
      fs.rmSync(backup, { recursive: true, force: true });
      throw new Error(`Terminal recovery backup failed; do not stop the broker. Original state was preserved. ${error.message}`, { cause: error });
    }
  }
}

function validSession({ tab, initialInput }) {
  return isRecord(tab) && typeof tab.id === "string" && SAFE_ID.test(tab.id) &&
    ["pluginId", "title", "cwd", "createdAt", "updatedAt"].every(key => typeof tab[key] === "string") &&
    ["idle", "starting", "running", "waiting_approval", "failed", "completed", "stopped"].includes(tab.status) &&
    isRecord(tab.indicator) && ["green", "yellow", "red"].includes(tab.indicator.color) &&
    typeof tab.indicator.label === "string" && typeof tab.indicator.updatedAt === "string" &&
    optionalText(tab.indicator.message) && optionalText(tab.contextPath) && optionalText(tab.statusMessage) &&
    (tab.pluginMetadata === undefined || validPluginMetadata(tab.pluginMetadata)) &&
    (tab.recovery === undefined || isRecord(tab.recovery) && ["missing", "unavailable", "retired"].includes(tab.recovery.state) &&
      typeof tab.recovery.message === "string" && optionalText(tab.recovery.conversationId) &&
      (tab.recovery.canResume === undefined || typeof tab.recovery.canResume === "boolean")) &&
    tab.ownerPluginId === undefined &&
    (initialInput === undefined || isRecord(initialInput));
}

// This updater is staged without node_modules or built packages; keep these checks aligned
// with SessionStateStore, readWindow, and isUsableTabLayoutState (covered by production-validator tests).
function validWorkspace(workspace) {
  return isRecord(workspace) && Array.isArray(workspace.windows) && workspace.windows.length > 0 &&
    uniqueIds(workspace.windows.map(window => window?.id)) &&
    (workspace.activeWindowId === undefined || workspace.windows.some(window => window.id === workspace.activeWindowId)) &&
    workspace.windows.every(window => isRecord(window) && ["id", "name", "defaultCwd"].every(key => typeof window[key] === "string") &&
      validLayout(window.layout));
}

function validLayout(layout) {
  if (!isRecord(layout) || typeof layout.activePaneId !== "string") return false;
  const pending = [layout.root];
  const panes = [], splits = [], tabs = [];
  while (pending.length) {
    const node = pending.pop();
    if (!isRecord(node)) return false;
    if (node.type === "pane") {
      const pane = node.pane;
      if (!isRecord(pane) || !Array.isArray(pane.tabIds) || !uniqueIds(pane.tabIds) ||
          pane.activeTabId !== undefined && !pane.tabIds.includes(pane.activeTabId)) return false;
      panes.push(pane.id);
      tabs.push(...pane.tabIds);
    } else if (node.type === "split") {
      if (!["row", "column"].includes(node.direction) || !Array.isArray(node.sizes) || node.sizes.length !== 2 ||
          !node.sizes.every(size => typeof size === "number" && Number.isFinite(size) && size > 0) ||
          Math.abs(node.sizes[0] + node.sizes[1] - 100) > 0.001 || !Array.isArray(node.children) || node.children.length !== 2) return false;
      splits.push(node.id);
      pending.push(...node.children);
    } else return false;
  }
  return uniqueIds(panes) && uniqueIds(splits) && uniqueIds(tabs) && panes.includes(layout.activePaneId);
}

function uniqueIds(ids) {
  return ids.every(id => typeof id === "string" && id.length > 0) && new Set(ids).size === ids.length;
}

function layoutTabIds(layout) {
  const nodes = [layout.root];
  const tabs = [];
  while (nodes.length) {
    const node = nodes.pop();
    if (node.type === "pane") tabs.push(...node.pane.tabIds);
    else nodes.push(...node.children);
  }
  return tabs;
}

function validPluginMetadata(metadata) {
  return isRecord(metadata) && Object.values(metadata).every(isRecord);
}

function optionalText(value) {
  return value === undefined || typeof value === "string";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveBoundTranscript({ tabId, view, binding, receipt }) {
  const store = path.join(binding.home, "sessions");
  safeDirectory(store);
  const storeIdentity = fs.lstatSync(store, { bigint: true });
  const supplied = path.resolve(receipt.transcriptPath);
  const link = path.join(view, "sessions");
  let transcriptPath = supplied;
  const invalid = () => new Error(`Codex tab ${tabId} transcript is outside its bound session store or has a different identity.`);
  if (!isWithin(store, supplied)) {
    if (!isWithin(link, supplied)) throw invalid();
    safeDirectory(view);
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink() || stat.uid !== process.getuid() ||
        path.resolve(view, fs.readlinkSync(link)) !== store || fs.realpathSync.native(link) !== store)
      throw invalid();
    transcriptPath = path.join(store, path.relative(link, supplied));
  }
  // Only the owned launch-view link may be traversed; nested and external aliases stay invalid.
  if (!path.basename(transcriptPath).endsWith(`-${receipt.sessionId}.jsonl`) || fs.realpathSync.native(receipt.transcriptPath) !== transcriptPath)
    throw invalid();
  return { transcriptPath, storeIdentity };
}

function assertSourceIdentity(binding) {
  safeDirectory(binding.home);
  const fd = fs.openSync(binding.home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const home = fs.fstatSync(fd, { bigint: true });
    let sameDevice = home.dev.toString() === binding.dev;
    if (binding.durable) {
      const { filesystemId, filesystemType, birthtimeNs, uid } = binding.durable;
      // Match directoryIdentity.ts and filesystemIdentity.ts without depending on a built server.
      const filesystem = execFileSync("/usr/bin/stat", ["--file-system", "--format=%t:%i", "--", "/proc/self/fd/3"], {
        stdio: ["ignore", "pipe", "ignore", fd], env: { LC_ALL: "C" }, timeout: 3_000, maxBuffer: 256, encoding: "utf8",
      });
      if (filesystem !== `${filesystemType}:${filesystemId}\n` || home.birthtimeNs.toString() !== birthtimeNs || home.uid.toString() !== uid)
        throw new Error(`Codex source ownership changed: ${binding.home}`);
      sameDevice ||= ["ef53", "9123683e"].includes(filesystemType) && birthtimeNs !== "0";
    }
    const current = fs.lstatSync(binding.home, { bigint: true });
    if (!home.isDirectory() || home.uid !== BigInt(process.getuid()) || home.ino.toString() !== binding.ino || !sameDevice ||
        !current.isDirectory() || ["dev", "ino", "uid", "birthtimeNs"].some(key => home[key] !== current[key]) ||
        fs.realpathSync(binding.home) !== path.resolve(binding.home))
      throw new Error(`Codex source ownership changed: ${binding.home}`);
  } finally { fs.closeSync(fd); }
}

function validDurableIdentity(value) {
  return isRecord(value) && typeof value.filesystemId === "string" && /^[a-f0-9]{1,32}$/u.test(value.filesystemId) && !/^0+$/u.test(value.filesystemId) &&
    typeof value.filesystemType === "string" && /^[a-f0-9]+$/u.test(value.filesystemType) &&
    typeof value.birthtimeNs === "string" && /^\d+$/u.test(value.birthtimeNs) && typeof value.uid === "string" && /^\d+$/u.test(value.uid);
}

function safeDirectory(directory, optional = false) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat && optional) return false;
  if (!stat?.isDirectory() || stat.uid !== process.getuid() || fs.realpathSync(directory) !== path.resolve(directory))
    throw new Error(`Recovery path must be an owned real directory without symlinks: ${directory}`);
  return true;
}

function fileIdentity(stat) {
  return ["dev", "ino", "uid", "birthtimeNs", "size", "mtimeNs", "ctimeNs"].map(key => stat[key].toString()).join(":");
}

function sameFile(expected, current) {
  return expected.identity === current.identity && expected.sha256 === current.sha256;
}

function scanFile(filePath, { optional = false, signal, chunk = () => {} } = {}) {
  signal?.throwIfAborted();
  if (!safeDirectory(path.dirname(filePath), optional)) return undefined;
  const named = fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
  if (!named && optional) return undefined;
  if (!named?.isFile() || named.uid !== BigInt(process.getuid()))
    throw new Error(`Recovery file must be an owned regular file: ${filePath}`);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || fileIdentity(before) !== fileIdentity(named))
      throw new Error(`Recovery file changed before reading: ${filePath}`);
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) throw new Error(`Recovery file exceeds the supported integer range: ${filePath}`);
    const bytes = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, size));
    const hash = createHash("sha256");
    let position = 0;
    while (position < size) {
      signal?.throwIfAborted();
      const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, size - position), position);
      if (!count) break;
      const part = bytes.subarray(0, count);
      hash.update(part);
      position += count;
      chunk(part, position);
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(filePath, { bigint: true });
    if (position !== size || !current.isFile() || fileIdentity(before) !== fileIdentity(after) || fileIdentity(before) !== fileIdentity(current))
      throw new Error(`Recovery file changed during reading: ${filePath}`);
    return { size, identity: fileIdentity(before), sha256: hash.digest("hex") };
  } finally { fs.closeSync(fd); }
}

function transcriptHeader(filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    // Metadata is a single protocol record. History after it has no size limit.
    const bytes = Buffer.alloc(COPY_CHUNK_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
      const end = bytes.subarray(0, length).indexOf(10);
      if (end !== -1) return bytes.subarray(0, end);
    }
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

function readFile(filePath, limit, optional = false) {
  if (!safeDirectory(path.dirname(filePath), optional)) return undefined;
  const named = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!named && optional) return undefined;
  if (!named?.isFile() || named.uid !== process.getuid() || named.size > limit)
    throw new Error(`Recovery file must be an owned regular file within its size limit: ${filePath}`);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.ino !== named.ino || before.dev !== named.dev || before.size > limit)
      throw new Error(`Recovery file changed before reading: ${filePath}`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(filePath);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.ino !== current.ino || before.dev !== current.dev || !current.isFile())
      throw new Error(`Recovery file changed during reading: ${filePath}`);
    return bytes;
  } finally { fs.closeSync(fd); }
}

function syncDirectories(directory) {
  const pending = [directory], directories = [];
  while (pending.length) {
    const current = pending.pop();
    directories.push(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true }))
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
  }
  for (const current of directories.reverse()) syncDirectory(current);
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
