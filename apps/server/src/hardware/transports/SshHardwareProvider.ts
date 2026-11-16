import fs from "node:fs/promises";
import { constants } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { HardwareAccessContext, HardwareConnection, HardwareConnectionCheckContext, HardwareTypeProvider } from "@cloudx/plugin-api";
import { DEFAULT_SSH_ONLINE_CHECK_INTERVAL_MS, type HardwareAccessDescription, type HardwareConnectionResult, type HardwareEndpointInspection, type HardwareTypeDescriptor, type JsonObject, type ProviderOutcome, type SshConfig } from "@cloudx/shared";
import type { PathPolicy } from "../../pathPolicy.js";
import { BoundedProcessSet, type ProcessCommand, type ProcessResult } from "./BoundedProcess.js";
import { SshAskpass } from "./SshAskpass.js";
import { SshExecutionEvidence } from "./SshExecutionEvidence.js";
import { ManagedSshKeyStore } from "./ManagedSshKeyStore.js";
import { byteLimitSchema, compileHardwareSchema, completed, deadlineSchema, failed, HardwareProviderError, MAX_HARDWARE_BYTES, objectSchema, unknown, validateHardwareValue } from "./HardwareValidation.js";

const absolutePathSchema = { type: "string", minLength: 1, maxLength: 4096, pattern: "^/[^\\u0000\\r\\n]*$" };
const transferPathSchema = { type: "string", minLength: 1, maxLength: 4096 };
const transferInput = objectSchema({ localPath: transferPathSchema, remotePath: transferPathSchema, timeoutMs: deadlineSchema, overwrite: { type: "boolean" } });
const transferOutput = objectSchema({ bytesTransferred: { type: "integer", minimum: 0 }, destination: { type: "string" }, completed: { const: true } });
const credentialRefSchema = { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$" };
const registerKeyValidator = compileHardwareSchema(objectSchema({ credentialRefId: credentialRefSchema, timeoutMs: deadlineSchema }, ["timeoutMs"]), "SSH key registration");
const setupKeyValidator = compileHardwareSchema(objectSchema({ hardwareId: credentialRefSchema, credentialRefId: credentialRefSchema, timeoutMs: deadlineSchema }), "SSH key setup");

export const sshHardwareDescriptor: HardwareTypeDescriptor = {
  id: "hardware.ssh", ownerPluginId: "hardware", apiVersion: 1, configVersion: 1,
  displayName: "SSH", description: "Run remote Bash scripts and transfer regular files through host OpenSSH with selected authentication and verified host keys.",
  configSchema: objectSchema({
    host: { type: "string", minLength: 1, maxLength: 253 }, port: { type: "integer", minimum: 1, maximum: 65535 },
    username: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$" },
    auth: { oneOf: [objectSchema({ kind: { const: "agent" }, socketPath: absolutePathSchema }, ["kind"]), objectSchema({ kind: { const: "identity_file" }, path: absolutePathSchema }), objectSchema({ kind: { const: "password" }, credentialRefId: credentialRefSchema })] },
    knownHostsFile: absolutePathSchema, connectTimeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
    onlineCheckIntervalMs: { anyOf: [{ type: "integer", minimum: 1000, maximum: 86_400_000 }, { type: "null" }] }
  }, ["host", "port", "username", "auth", "connectTimeoutMs"]),
  operations: [
    { id: "ssh.exec", description: "Execute an explicit remote Bash script supplied through stdin.",
      inputSchema: objectSchema({ script: { type: "string", maxLength: MAX_HARDWARE_BYTES }, timeoutMs: deadlineSchema, maxOutputBytes: byteLimitSchema }),
      outputSchema: objectSchema({ exitCode: { type: "integer", minimum: 0, maximum: 255 }, stdout: { type: "string" }, stderr: { type: "string" }, truncated: { type: "boolean" }, durationMs: { type: "integer", minimum: 0 } }) },
    { id: "ssh.upload", description: "Upload one regular file using OpenSSH SFTP; publish the destination only after transfer completes.", inputSchema: transferInput, outputSchema: transferOutput },
    { id: "ssh.download", description: "Download one regular file using OpenSSH SFTP; publish the local destination only after transfer completes.", inputSchema: transferInput, outputSchema: transferOutput }
  ]
};

export interface SshHardwareOptions {
  pathPolicy: Pick<PathPolicy, "resolve" | "isAllowed">;
  sshExecutable?: string;
  sftpExecutable?: string;
  sshCopyIdExecutable?: string;
  sshAddExecutable?: string;
  sshKeygenExecutable?: string;
  managedKeysDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

export class SshHardwareProvider implements HardwareTypeProvider<SshConfig> {
  readonly descriptor = sshHardwareDescriptor;
  private readonly configValidator = compileHardwareSchema(this.descriptor.configSchema, "SSH configuration");
  private readonly operationValidators = new Map(this.descriptor.operations.map((operation) => [operation.id, compileHardwareSchema(operation.inputSchema, operation.id)]));

  constructor(private readonly options: SshHardwareOptions) {}

  parseConfig(value: unknown): SshConfig {
    validateHardwareValue(this.configValidator, value, "SSH configuration");
    const config = structuredClone(value) as unknown as SshConfig;
    if (!validSshHost(config.host)) throw new HardwareProviderError("INVALID_INPUT", "SSH configuration /host must be a DNS name or IP literal.");
    for (const filePath of configuredPaths(config)) {
      if (/[%$\u0000\r\n]/.test(filePath)) throw new HardwareProviderError("INVALID_INPUT", "SSH file paths cannot contain OpenSSH expansion tokens or line breaks.");
      this.options.pathPolicy.resolve(filePath);
    }
    return config;
  }

  async inspectEndpoint(config: SshConfig): Promise<HardwareEndpointInspection> {
    const blockers: string[] = [];
    const files = [
      ...(config.knownHostsFile ? [{ path: config.knownHostsFile, socket: false }] : []),
      ...(config.auth.kind === "identity_file" ? [{ path: config.auth.path, socket: false }] : []),
      ...(config.auth.kind === "agent" && config.auth.socketPath ? [{ path: config.auth.socketPath, socket: true }] : [])
    ];
    for (const file of files) {
      try {
        const admitted = await this.localPath(file.path);
        const stat = await fs.stat(admitted);
        if (file.socket ? !stat.isSocket() : !stat.isFile()) blockers.push(`SSH configuration path has the wrong file type: ${file.path}`);
        await fs.access(admitted, file.socket ? constants.W_OK : constants.R_OK);
      } catch { blockers.push(`SSH configuration path is unavailable or outside allowed roots: ${file.path}`); }
    }
    if (config.auth.kind === "agent" && !config.auth.socketPath) {
      const available = async (file: string, socket: boolean) => {
        try { const stat = await fs.stat(file); await fs.access(file, socket ? constants.W_OK : constants.R_OK); return socket ? stat.isSocket() : stat.isFile(); }
        catch { return false; }
      };
      const agent = this.agentSocket(config);
      const home = this.options.environment?.HOME ?? os.homedir();
      const identities = ["id_rsa", "id_ecdsa", "id_ecdsa_sk", "id_ed25519", "id_ed25519_sk", "id_xmss", "id_dsa"];
      if (!(agent && await available(agent, true)) && !(await Promise.all(identities.map(name => available(path.join(home, ".ssh", name), false)))).some(Boolean)) blockers.push("The server account has no accessible SSH agent or default identity file.");
    }
    for (const executable of [this.options.sshExecutable ?? "/usr/bin/ssh", this.options.sftpExecutable ?? "/usr/bin/sftp"]) {
      try { await fs.access(executable, constants.X_OK); } catch { blockers.push(`Required OpenSSH executable is unavailable: ${executable}`); }
    }
    return { resourceKeys: [`ssh:${normalizedHost(config.host)}:${config.port}`], ready: blockers.length === 0, blockers };
  }

  describeAccess(config: SshConfig): HardwareAccessDescription {
    return { summary: `${config.username}@${config.host}:${config.port}`, details: { host: config.host, port: config.port, username: config.username, authentication: config.auth.kind, hostTrust: config.knownHostsFile ? "Strict verification against the selected file" : "OpenSSH default known_hosts; accept new hosts and reject changed keys", remoteShell: "/bin/bash", fileTransfer: "OpenSSH SFTP, regular files only", onlineCheckIntervalMs: config.onlineCheckIntervalMs === undefined ? DEFAULT_SSH_ONLINE_CHECK_INTERVAL_MS : config.onlineCheckIntervalMs, noOverwriteUploadRequirement: "The server and destination filesystem must support the hardlink@openssh.com SFTP extension." } };
  }

  async checkConnection(config: SshConfig, context: HardwareConnectionCheckContext): Promise<ProviderOutcome<HardwareConnectionResult>> {
    const processes = new SshProcesses(config, this.options, context.resolveCredential);
    context.registerCleanup(signal => processes.close(signal));
    let result: HardwareConnectionResult;
    try {
      if (context.signal.aborted) result = { online: false, error: { code: "CANCELLED", message: "SSH connection check was cancelled before dispatch." } };
      else {
        const inspection = await this.inspectEndpoint(config);
        if (!inspection.ready) result = { online: false, error: { code: "ENDPOINT_UNAVAILABLE", message: diagnosticText(inspection.blockers.join("; "), 4096) } };
        else {
          const checked = await processes.run({ executable: this.options.sshExecutable ?? "/usr/bin/ssh", args: [...sshArguments(config), "--", config.host, "exit 0"], timeoutMs: config.connectTimeoutMs + 1000, maxOutputBytes: 64 * 1024, signal: context.signal }, passwordReference(config));
          result = connectionCheckResult(checked, context.signal.aborted || processes.cancelled);
        }
      }
    } catch (error) {
      result = { online: false, error: error instanceof HardwareProviderError ? { code: error.code, message: error.message } : { code: "SSH_CHECK_FAILED", message: "The SSH connection check could not complete." } };
    }
    try {
      if ((await processes.close(context.signal)).state === "completed") return completed(result);
    } catch { /* An unconfirmed local process cannot complete the check. */ }
    return unknown("SSH_CHECK_CLEANUP_UNKNOWN", "SSH connection check could not confirm that its local processes ended.", result.diagnostics);
  }

  async connect(config: SshConfig, context: HardwareAccessContext): Promise<ProviderOutcome<HardwareConnection>> {
    const processes = new SshProcesses(config, this.options, context.resolveCredential);
    const connection = new SshConnection(config, this.options, processes, this.operationValidators);
    context.registerCleanup((signal) => connection.close(signal));
    if (context.signal.aborted) return failed("CANCELLED", "SSH connection was cancelled before dispatch.");
    try {
      const inspection = await this.inspectEndpoint(config);
      if (!inspection.ready) return failed("ENDPOINT_UNAVAILABLE", inspection.blockers.join("; "));
      const result = await processes.runTransport("ssh", { executable: this.options.sshExecutable ?? "/usr/bin/ssh", args: [...sshArguments(config), "--", config.host, "/bin/bash --noprofile --norc -s --"], stdin: "exit 0\n", timeoutMs: config.connectTimeoutMs + 1000, maxOutputBytes: 64 * 1024, signal: context.signal }, passwordReference(config));
      if (result.state === "not_started") return failed("SSH_NOT_STARTED", "The OpenSSH client could not start.");
      const rejected = result.connectionFailure;
      if (rejected) return failed(rejected.code, rejected.message, "none", processDiagnostics(result));
      if (result.interrupted || result.state !== "exited" || result.exitCode === 255 || result.exitCode === null || !result.remoteCompleted) return unknown("SSH_CONNECT_UNKNOWN", "SSH connection completion could not be confirmed.", processDiagnostics(result));
      if (result.exitCode !== 0) return failed("SSH_CONNECT_FAILED", "The configured remote Bash entrypoint failed.", "settled", processDiagnostics(result));
      return completed(connection);
    } catch (error) { return error instanceof HardwareProviderError ? failed(error.code, error.message) : unknown("SSH_CONNECT_UNKNOWN", "SSH connection completion could not be confirmed."); }
  }

  async setupKey(config: SshConfig, input: JsonObject, context: HardwareConnectionCheckContext): Promise<ProviderOutcome<JsonObject>> {
    const cleanups: Parameters<HardwareConnectionCheckContext["registerCleanup"]>[0][] = [];
    let diagnostics: JsonObject | undefined;
    let registrationStarted = false;
    const finish = async (result: ProviderOutcome<JsonObject>): Promise<ProviderOutcome<JsonObject>> => {
      const settled = await Promise.allSettled(cleanups.splice(0).map(async close => close(context.signal)));
      return settled.every(outcome => outcome.status === "fulfilled" && outcome.value.state === "completed") ? result
        : unknown("SSH_KEY_SETUP_CLEANUP_UNKNOWN", "SSH key setup could not confirm that all local processes ended.", result.state === "completed" ? diagnostics : result.diagnostics);
    };
    try {
      validateHardwareValue(setupKeyValidator, input, "SSH key setup");
      const setupContext: HardwareConnectionCheckContext = { ...context, signal: AbortSignal.any([context.signal, AbortSignal.timeout(input.timeoutMs as number)]), registerCleanup: close => { cleanups.push(close); context.registerCleanup(close); } };
      const keys = new ManagedSshKeyStore({ directory: this.options.managedKeysDirectory, pathPolicy: this.options.pathPolicy, sshKeygenExecutable: this.options.sshKeygenExecutable });
      const identity = await keys.getOrCreate(input.hardwareId as string, setupContext, input.timeoutMs as number);
      if (identity.state !== "completed") return await finish(identity);
      const keyConfig = this.parseConfig({ ...config, auth: { kind: "identity_file", path: identity.value.path } });
      registrationStarted = true;
      const registered = await finish(await this.registerKey(keyConfig, { credentialRefId: input.credentialRefId, timeoutMs: input.timeoutMs }, setupContext));
      if (registered.state !== "completed") return registered;
      const checked = await this.checkConnection(keyConfig, setupContext);
      if (checked.state !== "completed") return await finish(checked);
      diagnostics = checked.value.diagnostics;
      if (!checked.value.online) return await finish(failed("SSH_KEY_VERIFICATION_FAILED", "The installed SSH key could not complete a key-only login. The machine settings were not changed.", "settled", diagnostics));
      return await finish(completed({ config: keyConfig as unknown as JsonObject, connectionCheck: checked.value as unknown as JsonObject }));
    } catch (error) {
      return finish(registrationStarted ? unknown("SSH_KEY_SETUP_UNKNOWN", "SSH key setup could not confirm its registration and verification outcome.", diagnostics)
        : failed(error instanceof HardwareProviderError ? error.code : "SSH_KEY_SETUP_FAILED", error instanceof HardwareProviderError ? error.message : "SSH key setup failed before registration."));
    }
  }

  async registerKey(config: SshConfig, input: JsonObject, context: HardwareConnectionCheckContext): Promise<ProviderOutcome<JsonObject>> {
    const processes = new SshProcesses(config, this.options, context.resolveCredential);
    context.registerCleanup(signal => processes.close(signal));
    let directory: string | undefined;
    let dispatched = false;
    try {
      validateHardwareValue(registerKeyValidator, input, "SSH key registration");
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(input.timeoutMs as number)]);
      if (signal.aborted) return failed("CANCELLED", "SSH key registration was cancelled before dispatch.");
      const inspection = await this.inspectEndpoint(config);
      if (!inspection.ready) return failed("ENDPOINT_UNAVAILABLE", inspection.blockers.join("; "));
      await fs.access(this.options.sshCopyIdExecutable ?? "/usr/bin/ssh-copy-id", constants.X_OK);
      const keyArgs: string[] = [];
      if (config.auth.kind === "identity_file") {
        const privateKey = await this.localPath(config.auth.path);
        const publicKey = await this.localPath(`${config.auth.path}.pub`);
        if (/["`$\\\r\n\0]/.test(config.auth.path)) return failed("INVALID_INPUT", "SSH key registration does not support quoting characters in identity paths.");
        const stat = await fs.stat(publicKey);
        if (!stat.isFile() || stat.size > 64 * 1024) return failed("INVALID_INPUT", "SSH public identity must be a bounded regular file.");
        const publicText = await fs.readFile(publicKey, "utf8");
        const derived = await processes.run({ executable: this.options.sshKeygenExecutable ?? "/usr/bin/ssh-keygen", args: ["-y", "-P", "", "-f", privateKey], timeoutMs: input.timeoutMs as number, maxOutputBytes: 64 * 1024, signal });
        if (derived.state !== "exited" || derived.interrupted) return failed("SSH_KEY_UNAVAILABLE", "The local key inspection did not complete before registration.", "none", processDiagnostics(derived));
        if (derived.exitCode !== 0 || derived.truncated || keyMaterial(derived.stdout) !== keyMaterial(publicText) || !keyMaterial(publicText)) return failed("SSH_KEY_UNAVAILABLE", "Key registration requires a matching readable public/private pair without a passphrase.");
        keyArgs.push("-i", `${config.auth.path}.pub`);
      } else {
        const agent = this.agentSocket(config);
        if (!agent || !(await fs.stat(agent)).isSocket()) return failed("SSH_AGENT_UNAVAILABLE", "The server has no current SSH agent socket.");
        const keys = await processes.run({ executable: this.options.sshAddExecutable ?? "/usr/bin/ssh-add", args: ["-L"], timeoutMs: input.timeoutMs as number, maxOutputBytes: 64 * 1024, signal });
        if (keys.state !== "exited" || keys.interrupted) return failed("SSH_AGENT_UNAVAILABLE", "The SSH agent inspection did not complete before registration.", "none", processDiagnostics(keys));
        if (keys.exitCode !== 0 || keys.truncated || !keys.stdout.trim() || !keys.stdout.trim().split("\n").every(key => keyMaterial(key))) return failed("SSH_AGENT_UNAVAILABLE", "The current SSH agent has no usable public identities.");
      }
      // A private empty HOME also prevents ssh-copy-id selecting a disk key if the agent disappears.
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ssh-register-"));
      await fs.mkdir(path.join(directory, ".ssh"), { mode: 0o700 });
      const credentialRefId = typeof input.credentialRefId === "string" ? input.credentialRefId : passwordReference(config);
      if (signal.aborted) return failed("CANCELLED", "SSH key registration was cancelled before dispatch.");
      dispatched = true;
      const result = await processes.runTransport("registration", { executable: this.options.sshCopyIdExecutable ?? "/usr/bin/ssh-copy-id", args: ["-F", "/dev/null", ...registrationOptions(config, !!credentialRefId).flatMap(option => ["-o", option]), ...keyArgs, "--", config.host], environment: { HOME: directory }, timeoutMs: input.timeoutMs as number, maxOutputBytes: 64 * 1024, signal }, credentialRefId);
      if (result.state === "not_started") return failed("SSH_NOT_STARTED", "The SSH key registration client could not start.");
      const rejected = result.connectionFailure;
      if (rejected) return failed(rejected.code, rejected.message, "none", processDiagnostics(result));
      if (result.exitCode !== 0 && result.remoteCompleted) return failed("SSH_KEY_REGISTRATION_FAILED", "SSH key registration failed after all remote commands confirmed completion. Inspect the target for partial key changes.", "settled", processDiagnostics(result));
      if (result.state !== "exited" || result.interrupted || result.exitCode !== 0 || !result.remoteCompleted) return unknown("SSH_KEY_REGISTRATION_UNKNOWN", "SSH key registration could not be confirmed. Inspect the target before another explicit attempt.", processDiagnostics(result));
      return completed({ registered: true });
    } catch (error) {
      if (error instanceof HardwareProviderError) return failed(error.code, error.message);
      return dispatched ? unknown("SSH_KEY_REGISTRATION_UNKNOWN", "SSH key registration completion could not be confirmed.") : failed("SSH_KEY_UNAVAILABLE", "The configured SSH key registration prerequisites are unavailable.");
    } finally { await processes.close(context.signal); if (directory) await fs.rm(directory, { recursive: true, force: true }); }
  }

  private agentSocket(config: SshConfig): string | undefined {
    return config.auth.kind === "agent" && config.auth.socketPath ? config.auth.socketPath : (this.options.environment ?? process.env).SSH_AUTH_SOCK;
  }

  private async localPath(candidate: string): Promise<string> {
    const configured = this.options.pathPolicy.resolve(candidate);
    const resolved = await fs.realpath(configured);
    if (!this.options.pathPolicy.isAllowed(resolved)) throw new HardwareProviderError("INVALID_INPUT", "SSH path resolves outside allowed roots.");
    return resolved;
  }
}

class SshConnection implements HardwareConnection {
  private closed = false;
  constructor(private readonly config: SshConfig, private readonly options: SshHardwareOptions, private readonly processes: SshProcesses, private readonly validators: Map<string, ReturnType<typeof compileHardwareSchema>>) {}

  async invoke(operationId: string, input: JsonObject, signal: AbortSignal): Promise<ProviderOutcome<JsonObject>> {
    if (this.closed) return failed("ACCESS_CLOSED", "SSH access is closed.");
    const validate = this.validators.get(operationId);
    if (!validate) return failed("INVALID_INPUT", `Unsupported SSH operation ${operationId}.`);
    try {
      validateHardwareValue(validate, input, `${operationId} input`);
      if (signal.aborted) return failed("CANCELLED", "SSH operation was cancelled before dispatch.");
      if (operationId === "ssh.exec") return await this.exec(input, signal);
      return await this.transfer(operationId, input, signal);
    } catch (error) {
      if (error instanceof HardwareProviderError) return failed(error.code, error.message);
      return unknown("SSH_OPERATION_UNKNOWN", "SSH operation failed without a confirmed effect outcome.");
    }
  }

  async close(signal: AbortSignal): Promise<ProviderOutcome<null>> {
    this.closed = true;
    return this.processes.close(signal);
  }

  private async exec(input: JsonObject, signal: AbortSignal): Promise<ProviderOutcome<JsonObject>> {
    if (Buffer.byteLength(input.script as string) > MAX_HARDWARE_BYTES) return failed("INVALID_INPUT", "SSH script exceeds the byte limit.");
    const marker = `\ncloudx-ssh-exit-255:${randomUUID()}\n`;
    // Keep the supplied script in its own Bash. Its exit, traps and redirections
    // must not bypass the parent's confirmation or change the script's stdin.
    const wrapper = `/bin/bash --noprofile --norc -s --; status=$?; if [ "$status" -eq 255 ]; then printf "${marker}" >&2 || exit 255; exit 0; fi; exit "$status"`;
    const result = await this.processes.runTransport("ssh", { executable: this.options.sshExecutable ?? "/usr/bin/ssh", args: [...sshArguments(this.config), "--", this.config.host, `/bin/bash --noprofile --norc -c '${wrapper}'`], stdin: input.script as string, timeoutMs: input.timeoutMs as number, maxOutputBytes: input.maxOutputBytes as number, stderrMarker: marker, signal }, passwordReference(this.config));
    const failure = processFailure(result, "SSH command");
    if (failure) return failure;
    if (!result.remoteCompleted) return unknown("OUTCOME_UNKNOWN", "SSH remote command completion could not be confirmed.", processDiagnostics(result));
    return completed({ exitCode: result.exitCode === 0 && result.stderrMarkerSeen ? 255 : result.exitCode!, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated, durationMs: result.durationMs });
  }

  private async transfer(operationId: string, input: JsonObject, signal: AbortSignal): Promise<ProviderOutcome<JsonObject>> {
    let localStage: string | undefined;
    let sourceHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let dispatched = false;
    let transferCompleted = false;
    try {
      const local = this.options.pathPolicy.resolve(input.localPath as string);
      const remote = normalizeTransferPath(input.remotePath as string);
      serializeSftpPath(local);
      const directory = await fs.realpath(path.dirname(local));
      if (!this.options.pathPolicy.isAllowed(directory)) return failed("INVALID_INPUT", "Transfer path resolves outside allowed roots.");
      const destination = path.join(directory, path.basename(local));
      const isUpload = operationId === "ssh.upload";
      let batch: string;
      let bytesTransferred: number;
      if (isUpload) {
        const resolved = await fs.realpath(local);
        if (!this.options.pathPolicy.isAllowed(resolved)) return failed("INVALID_INPUT", "Upload source resolves outside allowed roots.");
        sourceHandle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await sourceHandle.stat();
        if (!stat.isFile()) return failed("INVALID_INPUT", "Upload source must be a regular file.");
        bytesTransferred = stat.size;
        const stage = path.posix.join(path.posix.dirname(remote), `.cloudx-upload-${randomUUID()}`);
        const payload = `${stage}/payload`;
        const publish = input.overwrite
          ? `rename ${serializeSftpPath(payload)} ${serializeSftpPath(remote)}\n`
          : `ln ${serializeSftpPath(payload)} ${serializeSftpPath(remote)}\nrm ${serializeSftpPath(payload)}\n`;
        batch = `mkdir ${serializeSftpPath(stage)}\nput /proc/self/fd/3 ${serializeSftpPath(payload)}\n${publish}rmdir ${serializeSftpPath(stage)}\n`;
      } else {
        const existing = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (existing && (!input.overwrite || !existing.isFile())) return failed("DESTINATION_EXISTS", "Download destination exists or is not a regular file.");
        localStage = await fs.mkdtemp(path.join(directory, ".cloudx-download-"));
        batch = `get ${serializeSftpPath(remote)} ${serializeSftpPath(path.join(localStage, "payload"))}\n`;
        bytesTransferred = 0;
      }
      if (signal.aborted) return failed("CANCELLED", "SFTP transfer was cancelled before dispatch.");
      dispatched = true;
      const command: ProcessCommand = { executable: this.options.sftpExecutable ?? "/usr/bin/sftp", args: [...sshArguments(this.config, true), "-b", "-", "--", isIP(this.config.host) === 6 ? `[${this.config.host}]` : this.config.host], stdin: batch, timeoutMs: input.timeoutMs as number, maxOutputBytes: 64 * 1024, signal, inheritedFd: sourceHandle?.fd };
      const result = await this.processes.runTransport("sftp", command, passwordReference(this.config));
      const failure = processFailure(result, "SFTP transfer");
      if (failure) return failure;
      if (result.exitCode !== 0) return failed("SFTP_FAILED", isUpload && !input.overwrite ? "SFTP no-overwrite upload failed. The destination must support SFTP hard links. A remote staging directory can remain." : "The SFTP batch reported a completed transfer error; a remote staging directory can remain.", "settled");
      transferCompleted = true;
      if (!isUpload) {
        const payload = path.join(localStage!, "payload");
        const stat = await fs.lstat(payload);
        if (!stat.isFile()) return failed("SFTP_INVALID_RESULT", "SFTP did not produce a regular file.", "settled");
        bytesTransferred = stat.size;
        if (input.overwrite) await fs.rename(payload, destination);
        else { await fs.link(payload, destination); await fs.unlink(payload); }
      }
      return completed({ bytesTransferred, destination: isUpload ? remote : destination, completed: true });
    } catch (error) {
      if (error instanceof HardwareProviderError) return failed(error.code, error.message);
      const code = (error as NodeJS.ErrnoException).code;
      if (!dispatched || code === "EEXIST") return failed(code === "EEXIST" ? "DESTINATION_EXISTS" : "LOCAL_PATH_UNAVAILABLE", "The local transfer path cannot be used.", dispatched ? "settled" : "none");
      if (transferCompleted) return failed("LOCAL_PATH_UNAVAILABLE", "The SFTP transfer completed, but the local download could not be published.", "settled");
      return unknown("SFTP_OUTCOME_UNKNOWN", "File transfer completion could not be confirmed.");
    } finally {
      await sourceHandle?.close();
      if (localStage) await fs.rm(localStage, { recursive: true, force: true });
    }
  }
}

function connectionCheckResult(result: ProcessResult, cancelled: boolean): HardwareConnectionResult {
  const diagnostics = processDiagnostics(result);
  if (result.state === "exited" && result.exitCode === 0 && !result.interrupted) return { online: true, diagnostics };
  let error = { code: "SSH_CHECK_FAILED", message: "The fixed SSH login check did not complete successfully." };
  if (result.interrupted) error = cancelled
    ? { code: "CANCELLED", message: "SSH connection check was cancelled." }
    : { code: "TIMEOUT", message: "SSH connection check exceeded its deadline." };
  else if (result.state === "not_started") error = { code: "SSH_NOT_STARTED", message: "The OpenSSH client could not start." };
  else if (result.exitCode === 255) {
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(result.stderr)) error = { code: "SSH_HOST_KEY_FAILED", message: "The SSH server host key was rejected. Inspect the configured host and trusted keys." };
    else if (/ssh: (?:connect to host|Could not resolve hostname)/i.test(result.stderr)) error = { code: "SSH_NETWORK_FAILED", message: "The configured SSH server could not be reached." };
    else if (/Permission denied|Authentication failed|Too many authentication failures/i.test(result.stderr)) error = { code: "SSH_AUTH_FAILED", message: "The SSH server rejected the configured authentication." };
  }
  return { online: false, error, diagnostics };
}

function processFailure(result: SshProcessResult, label: string): ProviderOutcome<JsonObject> | null {
  if (result.state === "not_started") return failed("TRANSPORT_NOT_STARTED", `${label} could not start.`);
  const rejected = result.connectionFailure;
  if (rejected) return failed(rejected.code, rejected.message, "none", processDiagnostics(result));
  if (result.interrupted || result.state !== "exited" || result.exitCode === null || result.exitCode === 255) return unknown("OUTCOME_UNKNOWN", `${label} may still have remote effects; completion could not be confirmed.`, processDiagnostics(result));
  return null;
}

function processDiagnostics(result: ProcessResult): JsonObject {
  // Leave room for JSON escaping and receipt metadata within the persisted JSON limit.
  const limit = 64 * 1024;
  const stdout = diagnosticText(result.stdout, limit);
  const stderr = diagnosticText(result.stderr, limit - Buffer.byteLength(stdout));
  const clientLog = diagnosticText(result.diagnosticOutput ?? "", limit - Buffer.byteLength(stdout) - Buffer.byteLength(stderr));
  return { state: result.state, exitCode: result.exitCode, signal: result.signal, stdout, stderr, ...(result.diagnosticOutput !== undefined ? { clientLog } : {}), truncated: result.truncated || !!result.diagnosticsTruncated || stdout !== result.stdout || stderr !== result.stderr || clientLog !== (result.diagnosticOutput ?? ""), durationMs: result.durationMs, interrupted: result.interrupted };
}

function diagnosticText(value: string, maxBytes: number): string {
  const text = Buffer.from(value).subarray(0, maxBytes).toString("utf8");
  return Buffer.byteLength(text) > maxBytes ? text.slice(0, -1) : text;
}

function validSshHost(host: string): boolean {
  if (isIP(host)) return true;
  return host.length <= 253 && host.split(".").every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

function normalizedHost(host: string): string {
  return isIP(host) === 6 ? new URL(`http://[${host}]/`).hostname : host.toLowerCase();
}

function quoteSshConfigPath(value: string): string { return `"${value.replace(/[\\"]/g, "\\$&")}"`; }

export function sshArguments(config: SshConfig, sftp = false): string[] {
  const password = config.auth.kind === "password";
  const options = [
    ...baseOptions(config), `BatchMode=${password ? "no" : "yes"}`, `PreferredAuthentications=${password ? "password" : "publickey"}`, `PubkeyAuthentication=${password ? "no" : "yes"}`, `PasswordAuthentication=${password ? "yes" : "no"}`, `NumberOfPasswordPrompts=${password ? 1 : 0}`,
    ...(config.auth.kind === "identity_file" ? ["IdentitiesOnly=yes", "IdentityAgent=none", `IdentityFile=${quoteSshConfigPath(config.auth.path)}`] : config.auth.kind === "agent" ? ["IdentitiesOnly=no", ...(config.auth.socketPath ? ["IdentityFile=none", `IdentityAgent=${quoteSshConfigPath(config.auth.socketPath)}`] : [])] : ["IdentityAgent=none", "IdentityFile=none"])
  ];
  return ["-F", "/dev/null", ...(sftp ? [] : ["-T"]), ...options.flatMap((option) => ["-o", option])];
}

function baseOptions(config: SshConfig): string[] {
  return [
    ...(config.knownHostsFile ? ["StrictHostKeyChecking=yes", `UserKnownHostsFile=${quoteSshConfigPath(config.knownHostsFile)}`, "GlobalKnownHostsFile=/dev/null"] : ["StrictHostKeyChecking=accept-new"]), "UpdateHostKeys=no",
    "KbdInteractiveAuthentication=no", "GSSAPIAuthentication=no", "HostbasedAuthentication=no", "ConnectionAttempts=1", `ConnectTimeout=${Math.max(1, Math.ceil(config.connectTimeoutMs / 1000))}`, "ControlMaster=no", "ControlPath=none", "ControlPersist=no",
    "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no", "PermitLocalCommand=no", "ProxyCommand=none", "ProxyJump=none", "RemoteCommand=none", "RequestTTY=no", "EscapeChar=none",
    "CanonicalizeHostname=no", `User=${config.username}`, `Port=${config.port}`
  ];
}

function registrationOptions(config: SshConfig, password: boolean): string[] {
  return [...baseOptions(config), `BatchMode=${password ? "no" : "yes"}`, `PreferredAuthentications=${password ? "password" : "publickey"}`, "PubkeyAuthentication=yes", `PasswordAuthentication=${password ? "yes" : "no"}`, `NumberOfPasswordPrompts=${password ? 1 : 0}`,
    ...(config.auth.kind === "identity_file" ? ["IdentityAgent=none", `IdentityFile=${quoteSshConfigPath(config.auth.path)}`] : config.auth.kind === "agent" && config.auth.socketPath ? [`IdentityAgent=${quoteSshConfigPath(config.auth.socketPath)}`] : [])];
}

function configuredPaths(config: SshConfig): string[] {
  return [config.knownHostsFile, config.auth.kind === "identity_file" ? config.auth.path : config.auth.kind === "agent" ? config.auth.socketPath : undefined].filter((value): value is string => value !== undefined);
}

function passwordReference(config: SshConfig): string | undefined { return config.auth.kind === "password" ? config.auth.credentialRefId : undefined; }

function keyMaterial(value: string): string | undefined {
  if (value.trim().includes("\n")) return undefined;
  const fields = value.trim().split(/\s+/);
  return /^[a-zA-Z0-9@._+-]+$/.test(fields[0] ?? "") && /^[a-zA-Z0-9+/]+=*$/.test(fields[1] ?? "") ? `${fields[0]} ${fields[1]}` : undefined;
}

interface SshProcessResult extends ProcessResult {
  connectionFailure?: ReturnType<SshExecutionEvidence["connectionFailure"]>;
  remoteCompleted?: boolean;
}

class SshProcesses {
  private readonly processes = new BoundedProcessSet();
  private readonly runs = new Set<Promise<ProcessResult>>();
  private readonly controller = new AbortController();
  private readonly environment: Record<string, string>;
  private closing?: Promise<ProviderOutcome<null>>;

  constructor(private readonly config: SshConfig, private readonly options: SshHardwareOptions, private readonly resolveCredential: HardwareAccessContext["resolveCredential"]) {
    const socket = config.auth.kind === "agent" && config.auth.socketPath ? config.auth.socketPath : (options.environment ?? process.env).SSH_AUTH_SOCK;
    this.environment = { SSH_ASKPASS_REQUIRE: "never", ...(config.auth.kind !== "identity_file" && socket ? { SSH_AUTH_SOCK: socket } : {}) };
  }

  get cancelled(): boolean { return this.controller.signal.aborted; }

  run(command: ProcessCommand, credentialRefId?: string): Promise<ProcessResult> {
    const work = this.execute(command, credentialRefId);
    this.runs.add(work);
    void work.then(() => this.runs.delete(work), () => this.runs.delete(work));
    return work;
  }

  runTransport(kind: "ssh" | "sftp" | "registration", command: ProcessCommand, credentialRefId?: string): Promise<SshProcessResult> {
    const work = this.executeTransport(kind, command, credentialRefId);
    this.runs.add(work);
    void work.then(() => this.runs.delete(work), () => this.runs.delete(work));
    return work;
  }

  private async executeTransport(kind: "ssh" | "sftp" | "registration", command: ProcessCommand, credentialRefId?: string): Promise<SshProcessResult> {
    let directory: string | undefined;
    let prepared = false;
    try {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ssh-client-"));
      const wrapper = path.join(directory, "ssh");
      const evidence = new SshExecutionEvidence();
      const executable = (this.options.sshExecutable ?? "/usr/bin/ssh").replace(/'/g, "'\\''");
      const relay = kind === "registration" ? `while IFS= read -r line; do printf '%s\\n' "$line" >&4; printf '%s\\n' "$line" >&2; done` : "/bin/cat >&4";
      // OpenSSH closes inherited descriptors before opening -E. The parent
      // keeps a real pipe open; the relay drains it into the bounded fd 4.
      // Neither remote stderr nor authentication banners enter this channel.
      await fs.writeFile(wrapper, `#!/bin/bash\numask 077\ntrap ':' TERM INT\nprintf '${evidence.start}' >&4\nif [ ! -x '${executable}' ]; then\n  printf 'cloudx-ssh-client-unavailable\\n${evidence.end}255\\n' >&4\n  exit 255\nfi\nexec 5> >(${relay})\n'${executable}' -v -E "/proc/$$/fd/5" "$@"\nstatus=$?\nexec 5>&-\nwait\nprintf '${evidence.end}%s\\n' "$status" >&4\nexit "$status"\n`, { mode: 0o700 });
      prepared = true;
      let rejected: ReturnType<SshExecutionEvidence["connectionFailure"]>;
      let remoteCompleted = false;
      const result = await this.execute({ ...command, executable: kind === "ssh" ? wrapper : command.executable, args: kind === "sftp" ? ["-S", wrapper, ...command.args] : command.args, captureDiagnostics: true, inspectDiagnostics: (result, text, truncated) => {
        const observed = { ...result, diagnosticOutput: text, diagnosticsTruncated: truncated };
        rejected = evidence.connectionFailure(observed);
        remoteCompleted = evidence.remoteCompletionConfirmed(observed);
      }, environment: { ...command.environment, ...(kind === "registration" ? { PATH: `${directory}:/usr/bin:/bin` } : {}) } }, credentialRefId);
      return { ...result, connectionFailure: rejected, remoteCompleted };
    } catch (error) {
      if (!prepared) throw new HardwareProviderError("SSH_CLIENT_PREPARATION_FAILED", "Local SSH client preparation failed before remote command dispatch.");
      throw error;
    } finally {
      if (directory) {
        try { await fs.rm(directory, { recursive: true, force: true }); }
        catch (error) {
          if (!prepared) throw new HardwareProviderError("SSH_CLIENT_PREPARATION_FAILED", "Local SSH client preparation failed before remote command dispatch. Temporary client files require local cleanup.");
          throw error;
        }
      }
    }
  }

  close(signal: AbortSignal): Promise<ProviderOutcome<null>> {
    return this.closing ??= (async () => {
      this.controller.abort();
      const outcome = await this.processes.close(signal);
      await Promise.allSettled([...this.runs]);
      return outcome;
    })();
  }

  private async execute(command: ProcessCommand, credentialRefId?: string): Promise<ProcessResult> {
    const signal = AbortSignal.any([command.signal, this.controller.signal]);
    if (signal.aborted) return this.processes.run({ ...command, signal });
    let askpass: SshAskpass | undefined;
    let secret: string | undefined;
    if (credentialRefId) {
      try { secret = await this.resolveCredential(credentialRefId); }
      catch { throw new HardwareProviderError("CREDENTIAL_UNAVAILABLE", "The configured SSH password reference is unavailable."); }
      if (signal.aborted) return this.processes.run({ ...command, signal });
      askpass = await SshAskpass.create(secret, this.config.username, this.config.host);
    }
    try { return await this.processes.run({ ...command, signal, environment: { ...this.environment, ...command.environment, ...askpass?.environment }, secrets: secret ? [secret] : [] }); }
    finally { await askpass?.close(); }
  }
}

export function normalizeTransferPath(value: string): string {
  if (!value || Buffer.byteLength(value) > 4096 || /[\u0000\r\n*?\[\]{}]/.test(value)) throw new HardwareProviderError("INVALID_INPUT", "Transfer paths cannot contain NUL, line breaks, or glob metacharacters.");
  return value.startsWith("/") ? value : `./${value}`;
}

export function serializeSftpPath(value: string): string {
  const safe = normalizeTransferPath(value);
  return `"${safe.replace(/[\\"]/g, "\\$&")}"`;
}
