import fs from "node:fs/promises";
import { constants } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { HardwareAccessContext, HardwareConnection, HardwareTypeProvider } from "@cloudx/plugin-api";
import type { HardwareAccessDescription, HardwareEndpointInspection, HardwareTypeDescriptor, JsonObject, ProviderOutcome, SshConfig } from "@cloudx/shared";
import type { PathPolicy } from "../../pathPolicy.js";
import { BoundedProcessSet, type ProcessCommand, type ProcessResult } from "./BoundedProcess.js";
import { byteLimitSchema, compileHardwareSchema, completed, deadlineSchema, failed, HardwareProviderError, MAX_HARDWARE_BYTES, objectSchema, unknown, validateHardwareValue } from "./HardwareValidation.js";

const absolutePathSchema = { type: "string", minLength: 1, maxLength: 4096, pattern: "^/[^\\u0000\\r\\n]*$" };
const transferPathSchema = { type: "string", minLength: 1, maxLength: 4096 };
const transferInput = objectSchema({ localPath: transferPathSchema, remotePath: transferPathSchema, timeoutMs: deadlineSchema, overwrite: { type: "boolean" } });
const transferOutput = objectSchema({ bytesTransferred: { type: "integer", minimum: 0 }, destination: { type: "string" }, completed: { const: true } });

export const sshHardwareDescriptor: HardwareTypeDescriptor = {
  id: "hardware.ssh", ownerPluginId: "hardware", apiVersion: 1, configVersion: 1,
  displayName: "SSH", description: "Run remote Bash scripts and transfer regular files through host OpenSSH with explicit authentication and strict host keys.",
  configSchema: objectSchema({
    host: { type: "string", minLength: 1, maxLength: 253 }, port: { type: "integer", minimum: 1, maximum: 65535 },
    username: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$" },
    auth: { oneOf: [objectSchema({ kind: { const: "agent" }, socketPath: absolutePathSchema }), objectSchema({ kind: { const: "identity_file" }, path: absolutePathSchema })] },
    knownHostsFile: absolutePathSchema, connectTimeoutMs: { type: "integer", minimum: 1, maximum: 120000 }
  }),
  operations: [
    { id: "ssh.exec", description: "Execute an explicit remote Bash script supplied through stdin.",
      inputSchema: objectSchema({ script: { type: "string", maxLength: MAX_HARDWARE_BYTES }, timeoutMs: deadlineSchema, maxOutputBytes: byteLimitSchema }),
      outputSchema: objectSchema({ exitCode: { type: "integer", minimum: 0, maximum: 254 }, stdout: { type: "string" }, stderr: { type: "string" }, truncated: { type: "boolean" }, durationMs: { type: "integer", minimum: 0 } }) },
    { id: "ssh.upload", description: "Upload one regular file using OpenSSH SFTP; publish the destination only after transfer completes.", inputSchema: transferInput, outputSchema: transferOutput },
    { id: "ssh.download", description: "Download one regular file using OpenSSH SFTP; publish the local destination only after transfer completes.", inputSchema: transferInput, outputSchema: transferOutput }
  ]
};

export interface SshHardwareOptions {
  pathPolicy: Pick<PathPolicy, "resolve" | "isAllowed">;
  sshExecutable?: string;
  sftpExecutable?: string;
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
    for (const filePath of [config.knownHostsFile, config.auth.kind === "agent" ? config.auth.socketPath : config.auth.path]) {
      if (/[%$\u0000\r\n]/.test(filePath)) throw new HardwareProviderError("INVALID_INPUT", "SSH file paths cannot contain OpenSSH expansion tokens or line breaks.");
      this.options.pathPolicy.resolve(filePath);
    }
    return config;
  }

  async inspectEndpoint(config: SshConfig): Promise<HardwareEndpointInspection> {
    const blockers: string[] = [];
    const files = [{ path: config.knownHostsFile, socket: false }, { path: config.auth.kind === "agent" ? config.auth.socketPath : config.auth.path, socket: config.auth.kind === "agent" }];
    for (const file of files) {
      try {
        const admitted = await this.localPath(file.path);
        const stat = await fs.stat(admitted);
        if (file.socket ? !stat.isSocket() : !stat.isFile()) blockers.push(`SSH configuration path has the wrong file type: ${file.path}`);
        await fs.access(admitted, constants.R_OK);
      } catch { blockers.push(`SSH configuration path is unavailable or outside allowed roots: ${file.path}`); }
    }
    for (const executable of [this.options.sshExecutable ?? "/usr/bin/ssh", this.options.sftpExecutable ?? "/usr/bin/sftp"]) {
      try { await fs.access(executable, constants.X_OK); } catch { blockers.push(`Required OpenSSH executable is unavailable: ${executable}`); }
    }
    return { resourceKeys: [`ssh:${normalizedHost(config.host)}:${config.port}`], ready: blockers.length === 0, blockers };
  }

  describeAccess(config: SshConfig): HardwareAccessDescription {
    return { summary: `${config.username}@${config.host}:${config.port}`, details: { host: config.host, port: config.port, username: config.username, authentication: config.auth.kind, remoteShell: "/bin/bash", fileTransfer: "OpenSSH SFTP, regular files only", noOverwriteUploadRequirement: "The server and destination filesystem must support the hardlink@openssh.com SFTP extension." } };
  }

  async connect(config: SshConfig, context: HardwareAccessContext): Promise<ProviderOutcome<HardwareConnection>> {
    const processes = new BoundedProcessSet();
    const connection = new SshConnection(config, this.options, processes, this.operationValidators);
    context.registerCleanup((signal) => connection.close(signal));
    if (context.signal.aborted) return failed("CANCELLED", "SSH connection was cancelled before dispatch.");
    const inspection = await this.inspectEndpoint(config);
    if (!inspection.ready) return failed("ENDPOINT_UNAVAILABLE", inspection.blockers.join("; "));
    const result = await processes.run({ executable: this.options.sshExecutable ?? "/usr/bin/ssh", args: [...sshArguments(config), "--", config.host, "/bin/bash --noprofile --norc -s --"], stdin: "exit 0\n", timeoutMs: config.connectTimeoutMs + 1000, maxOutputBytes: 64 * 1024, signal: context.signal });
    if (result.state === "not_started") return failed("SSH_NOT_STARTED", "The OpenSSH client could not start.");
    if (result.interrupted || result.state !== "exited" || result.exitCode === 255 || result.exitCode === null) return unknown("SSH_CONNECT_UNKNOWN", "SSH connection completion could not be confirmed.");
    if (result.exitCode !== 0) return failed("SSH_CONNECT_FAILED", "The configured remote Bash entrypoint failed.", "settled");
    return completed(connection);
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
  constructor(private readonly config: SshConfig, private readonly options: SshHardwareOptions, private readonly processes: BoundedProcessSet, private readonly validators: Map<string, ReturnType<typeof compileHardwareSchema>>) {}

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
    const result = await this.processes.run({ executable: this.options.sshExecutable ?? "/usr/bin/ssh", args: [...sshArguments(this.config), "--", this.config.host, "/bin/bash --noprofile --norc -s --"], stdin: input.script as string, timeoutMs: input.timeoutMs as number, maxOutputBytes: input.maxOutputBytes as number, signal });
    const failure = processFailure(result, "SSH command");
    if (failure) return failure;
    return completed({ exitCode: result.exitCode!, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated, durationMs: result.durationMs });
  }

  private async transfer(operationId: string, input: JsonObject, signal: AbortSignal): Promise<ProviderOutcome<JsonObject>> {
    let localStage: string | undefined;
    let sourceHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let dispatched = false;
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
      const command: ProcessCommand = { executable: this.options.sftpExecutable ?? "/usr/bin/sftp", args: ["-b", "-", ...sshArguments(this.config, true), "--", isIP(this.config.host) === 6 ? `[${this.config.host}]` : this.config.host], stdin: batch, timeoutMs: input.timeoutMs as number, maxOutputBytes: 64 * 1024, signal, inheritedFd: sourceHandle?.fd };
      const result = await this.processes.run(command);
      const failure = processFailure(result, "SFTP transfer");
      if (failure) return failure;
      if (result.exitCode !== 0) return failed("SFTP_FAILED", isUpload && !input.overwrite ? "SFTP no-overwrite upload failed. The destination must support SFTP hard links. A remote staging directory can remain." : "The SFTP batch reported a completed transfer error; a remote staging directory can remain.", "settled");
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
      return unknown("SFTP_OUTCOME_UNKNOWN", "File transfer completion could not be confirmed.");
    } finally {
      await sourceHandle?.close();
      if (localStage) await fs.rm(localStage, { recursive: true, force: true });
    }
  }
}

function processFailure(result: ProcessResult, label: string): ProviderOutcome<JsonObject> | null {
  if (result.state === "not_started") return failed("TRANSPORT_NOT_STARTED", `${label} could not start.`);
  if (result.interrupted || result.state !== "exited" || result.exitCode === null || result.exitCode === 255) return unknown("OUTCOME_UNKNOWN", `${label} may still have remote effects; completion could not be confirmed.`);
  return null;
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
  const options = [
    "BatchMode=yes", "StrictHostKeyChecking=yes", `UserKnownHostsFile=${quoteSshConfigPath(config.knownHostsFile)}`, "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no",
    "PreferredAuthentications=publickey", "PubkeyAuthentication=yes", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "GSSAPIAuthentication=no", "HostbasedAuthentication=no",
    "NumberOfPasswordPrompts=0", "ConnectionAttempts=1", `ConnectTimeout=${Math.max(1, Math.ceil(config.connectTimeoutMs / 1000))}`, "ControlMaster=no", "ControlPath=none", "ControlPersist=no",
    "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no", "PermitLocalCommand=no", "ProxyCommand=none", "ProxyJump=none", "RemoteCommand=none", "RequestTTY=no", "EscapeChar=none",
    "CanonicalizeHostname=no", `User=${config.username}`, `Port=${config.port}`,
    ...(config.auth.kind === "identity_file" ? ["IdentitiesOnly=yes", "IdentityAgent=none", `IdentityFile=${quoteSshConfigPath(config.auth.path)}`] : ["IdentitiesOnly=no", "IdentityFile=none", `IdentityAgent=${quoteSshConfigPath(config.auth.socketPath)}`])
  ];
  return ["-F", "/dev/null", ...(sftp ? [] : ["-T"]), ...options.flatMap((option) => ["-o", option])];
}

export function normalizeTransferPath(value: string): string {
  if (!value || Buffer.byteLength(value) > 4096 || /[\u0000\r\n*?\[\]{}]/.test(value)) throw new HardwareProviderError("INVALID_INPUT", "Transfer paths cannot contain NUL, line breaks, or glob metacharacters.");
  return value.startsWith("/") ? value : `./${value}`;
}

export function serializeSftpPath(value: string): string {
  const safe = normalizeTransferPath(value);
  return `"${safe.replace(/[\\"]/g, "\\$&")}"`;
}
