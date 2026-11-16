import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HardwareConnection } from "@cloudx/plugin-api";
import type { HardwareMutationResult, JsonObject, OperationReceipt, SshConfig } from "@cloudx/shared";
import { PathPolicy } from "../../pathPolicy.js";
import { HardwareService } from "../HardwareService.js";
import { SshHardwareProvider, serializeSftpPath, sshArguments } from "./SshHardwareProvider.js";
import { BoundedProcessSet } from "./BoundedProcess.js";
import { ManagedSshKeyStore } from "./ManagedSshKeyStore.js";
import { transportTestContext } from "./TransportTestContext.js";

const exec = promisify(execFile);
const signal = () => new AbortController().signal;

describe("SSH configuration and batch boundaries", () => {
  const provider = new SshHardwareProvider({ pathPolicy: new PathPolicy(["/tmp"]) });
  const config: SshConfig = { host: "example.test", port: 22, username: "tester", auth: { kind: "identity_file", path: "/tmp/key" }, knownHostsFile: "/tmp/known hosts", connectTimeoutMs: 5000 };

  it("accepts explicit DNS/IP targets and rejects options, shell content, malformed auth and expansion tokens", () => {
    for (const host of ["example.test", "127.0.0.1", "::1", "2001:db8::1"]) expect(provider.parseConfig({ ...config, host }).host).toBe(host);
    for (const host of ["-oProxyCommand=id", "host;id", "a@host", "host\nother", "a..b", "::invalid"]) expect(() => provider.parseConfig({ ...config, host })).toThrow();
    expect(() => provider.parseConfig({ ...config, port: 0 })).toThrow();
    expect(() => provider.parseConfig({ ...config, username: "root -oX" })).toThrow();
    expect(() => provider.parseConfig({ ...config, knownHostsFile: "/etc/ssh/known_hosts" })).toThrow();
    expect(() => provider.parseConfig({ ...config, auth: { kind: "identity_file", path: "/tmp/%h" } })).toThrow();
    expect(() => provider.parseConfig({ ...config, auth: { kind: "password", value: "secret" } })).toThrow();
  });

  it("makes noninteractive strict host-key and single-method authentication explicit", () => {
    const args = sshArguments(config);
    expect(args).toEqual(expect.arrayContaining(["-F", "/dev/null", "BatchMode=yes", "StrictHostKeyChecking=yes", "ControlMaster=no", "ControlPath=none", "IdentityAgent=none", "IdentitiesOnly=yes", "PreferredAuthentications=publickey", "ConnectionAttempts=1", "ClearAllForwardings=yes", "ProxyCommand=none", "RemoteCommand=none"]));
    const agentArgs = sshArguments({ ...config, auth: { kind: "agent", socketPath: "/tmp/socket" } });
    expect(agentArgs).toEqual(expect.arrayContaining(["IdentityFile=none", "IdentitiesOnly=no", 'IdentityAgent="/tmp/socket"']));
    expect(provider.describeAccess(config).details).not.toHaveProperty("auth");
  });

  it("accepts inherited agent, default host trust and password references without accepting plaintext", async () => {
    const defaults = { host: "example.test", port: 22, username: "tester", auth: { kind: "agent" }, connectTimeoutMs: 5000 };
    expect(provider.parseConfig(defaults)).toEqual(defaults);
    const args = sshArguments(provider.parseConfig(defaults));
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args).not.toContain("IdentityFile=none");
    const effectiveDefault = await exec("/usr/bin/ssh", [...args, "-G", "--", defaults.host]);
    expect(effectiveDefault.stdout).toContain("identityfile ~/.ssh/id_ed25519\n");
    expect(args.some(value => value.startsWith("IdentityAgent=") || value.startsWith("UserKnownHostsFile="))).toBe(false);
    const password = provider.parseConfig({ ...defaults, auth: { kind: "password", credentialRefId: "hardware-password" } });
    const effective = await exec("/usr/bin/ssh", [...sshArguments(password), "-G", "--", password.host]);
    expect(effective.stdout).toContain("batchmode no\n");
    expect(effective.stdout).toContain("passwordauthentication yes\n");
    expect(effective.stdout).toContain("pubkeyauthentication false\n");
    expect(effective.stdout).toContain("numberofpasswordprompts 1\n");
    expect(effective.stdout).toContain("preferredauthentications password\n");
    expect(effective.stdout).toContain("identityagent none\n");
    expect(() => provider.parseConfig({ ...defaults, auth: { kind: "password", value: "plaintext" } })).toThrow();
  });

  it("accepts the default periodic SSH check, a bounded interval, or an explicit disabled check", () => {
    expect(provider.describeAccess(config).details.onlineCheckIntervalMs).toBe(60_000);
    for (const onlineCheckIntervalMs of [null, 1000, 60_000, 86_400_000]) {
      const parsed = provider.parseConfig({ ...config, onlineCheckIntervalMs });
      expect(parsed.onlineCheckIntervalMs).toBe(onlineCheckIntervalMs);
      expect(provider.describeAccess(parsed).details.onlineCheckIntervalMs).toBe(onlineCheckIntervalMs);
    }
    for (const onlineCheckIntervalMs of [0, 999, 86_400_001, 1000.5, "60000", false])
      expect(() => provider.parseConfig({ ...config, onlineCheckIntervalMs })).toThrow();
  });

  it("has the expected effective host OpenSSH configuration without opening a connection", async () => {
    const effective = await exec("/usr/bin/ssh", [...sshArguments(config), "-G", "--", config.host]);
    expect(effective.stdout).toContain("batchmode yes\n");
    expect(effective.stdout).toContain("stricthostkeychecking true\n");
    expect(effective.stdout).toContain("identityagent none\n");
    expect(effective.stdout).toContain("identitiesonly yes\n");
    expect(effective.stdout).toContain("controlmaster false\n");
    expect(effective.stdout).toContain("passwordauthentication no\n");
    expect(effective.stdout).toContain("userknownhostsfile /tmp/known hosts\n");
  });

  it("serializes one batch path and rejects embedded commands or glob expansion", () => {
    expect(serializeSftpPath("/tmp/a b\"c")).toBe('"/tmp/a b\\"c"');
    expect(serializeSftpPath("-option")).toBe('"./-option"');
    for (const value of ["/tmp/a\n!id", "/tmp/a\rget x", "/tmp/a\0b", "/tmp/*", "/tmp/?", "/tmp/[a]", "/tmp/{a,b}"]) expect(() => serializeSftpPath(value)).toThrow();
  });

  it("reports configured conflict keys without probing the network and retains them when auth files are absent", async () => {
    await expect(provider.inspectEndpoint(config)).resolves.toMatchObject({ resourceKeys: ["ssh:example.test:22"], ready: false });
    await expect(provider.inspectEndpoint({ ...config, host: "2001:db8:0:0:0:0:0:1" })).resolves.toMatchObject({ resourceKeys: ["ssh:[2001:db8::1]:22"] });
    const context = transportTestContext(AbortSignal.abort());
    await expect(provider.connect(config, context)).resolves.toMatchObject({ state: "failed", effects: "none", error: { code: "CANCELLED" } });
    expect(context.cleanups).toHaveLength(1);
  });

  it("requires a regular known-hosts file even when its path equals the configured agent socket", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ssh-socket-"));
    const socketPath = path.join(root, "agent.sock");
    const agent = net.createServer();
    try {
      await new Promise<void>(resolve => agent.listen(socketPath, resolve));
      const type = new SshHardwareProvider({ pathPolicy: new PathPolicy([root]) });
      const result = await type.inspectEndpoint({ ...config, knownHostsFile: socketPath, auth: { kind: "agent", socketPath } });
      expect(result.ready).toBe(false);
      expect(result.blockers.join("\n")).toContain(`SSH configuration path has the wrong file type: ${socketPath}`);
    } finally {
      await new Promise<void>((resolve, reject) => agent.close(error => error ? reject(error) : resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the account's default disk identity even when SSH environment HOME points elsewhere", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ssh-default-identity-"));
    const accountHome = path.join(root, "account");
    const environmentHome = path.join(root, "environment");
    const account = vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: accountHome });
    const processHome = vi.spyOn(os, "homedir").mockReturnValue(environmentHome);
    try {
      await fs.mkdir(path.join(accountHome, ".ssh"), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(environmentHome, ".ssh"), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(accountHome, ".ssh/id_ed25519"), "private fixture", { mode: 0o600 });
      const type = new SshHardwareProvider({ pathPolicy: new PathPolicy([root]), environment: { HOME: environmentHome, SSH_AUTH_SOCK: "" } });
      const defaults = { ...config, knownHostsFile: undefined, auth: { kind: "agent" as const } };
      expect(await type.inspectEndpoint(defaults)).toMatchObject({ ready: true, blockers: [] });
      const explicit = { ...defaults, auth: { kind: "agent" as const, socketPath: path.join(root, "missing-agent") } };
      expect(await type.inspectEndpoint(explicit)).toMatchObject({ ready: false });
      expect(sshArguments(explicit)).toContain("IdentityFile=none");
      await fs.rm(path.join(accountHome, ".ssh/id_ed25519"));
      await fs.writeFile(path.join(environmentHome, ".ssh/id_ed25519"), "unrelated fixture", { mode: 0o600 });
      expect(await type.inspectEndpoint(defaults)).toMatchObject({ ready: false, blockers: [expect.stringContaining("SSH agent or default identity")] });
    } finally { account.mockRestore(); processHome.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe("SSH login connection checks", () => {
  let directory: string;
  let capture: string;
  let executable: string;
  let provider: SshHardwareProvider;
  const config: SshConfig = { host: "online.test", port: 22, username: "tester", auth: { kind: "password", credentialRefId: "check-password" }, connectTimeoutMs: 1000 };
  const context = (signal = new AbortController().signal) => ({ ...transportTestContext(signal), resolveCredential: async () => "private-password" });

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ssh-check-"));
    capture = path.join(directory, "capture.json");
    executable = path.join(directory, "ssh");
    await fs.writeFile(executable, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
  const host=process.argv.at(-2);
  const answer=execFileSync(process.env.SSH_ASKPASS,["tester@"+host+"'s password: "],{env:process.env}).toString().trim();
  fs.writeFileSync(process.env.CLOUDX_CHECK_CAPTURE,JSON.stringify({argv:process.argv.slice(2),environment:process.env,input,pid:process.pid}));
  if(host==='waiting.test') { process.stdout.write('probe-started'); setInterval(()=>{},1000); return; }
  if(host==='bounded.test') { process.stdout.write(answer+'\0'.repeat(100000)); process.exitCode=255; return; }
  const failures={
    'auth.test': 'tester@auth.test: Permission denied (password).',
    'hostkey.test': 'Host key verification failed.',
    'network.test': 'ssh: connect to host network.test port 22: Connection refused',
    'blocked.example': 'ssh: connect to host blocked.example port 22: Permission denied',
    'dns.test': 'ssh: Could not resolve hostname dns.test: Name or service not known',
    'command.test': 'Login command not found',
    'permission.test': 'Login command: Permission denied'
  };
  if(failures[host]) { process.stdout.write(answer); process.stderr.write(failures[host]); process.exitCode=host==='command.test'?127:host==='permission.test'?126:255; }
});
`.replace("process.env.CLOUDX_CHECK_CAPTURE", JSON.stringify(capture)), { mode: 0o700 });
    provider = new SshHardwareProvider({ pathPolicy: new PathPolicy([directory]), sshExecutable: executable, environment: {} });
  });
  afterAll(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

  const check = async (host = config.host, checkContext = context(), interval?: number) => {
    return provider.checkConnection({ ...config, host, ...(interval === undefined ? {} : { connectTimeoutMs: interval }) }, checkContext);
  };

  it("uses a fixed login command and closes its private password channel before reporting online", async () => {
    const result = await check();
    expect(result).toMatchObject({ state: "completed", value: { online: true, diagnostics: { exitCode: 0, interrupted: false } } });
    const captured = JSON.parse(await fs.readFile(capture, "utf8"));
    expect(captured.input).toBe("");
    expect(captured.argv.at(-1)).toBe("exit 0");
    expect(captured.argv).toEqual(expect.arrayContaining(["ConnectionAttempts=1", "StrictHostKeyChecking=accept-new", "ControlMaster=no", "PasswordAuthentication=yes", "KbdInteractiveAuthentication=no"]));
    expect(JSON.stringify(captured)).not.toContain("private-password");
    await expect(fs.stat(captured.environment.CLOUDX_SSH_ASKPASS_SOCKET)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(captured.environment.SSH_ASKPASS)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["auth.test", "SSH_AUTH_FAILED", "Permission denied"], ["hostkey.test", "SSH_HOST_KEY_FAILED", "Host key verification failed"],
    ["network.test", "SSH_NETWORK_FAILED", "Connection refused"], ["dns.test", "SSH_NETWORK_FAILED", "Could not resolve hostname"],
    ["command.test", "SSH_CHECK_FAILED", "not found"], ["permission.test", "SSH_CHECK_FAILED", "Permission denied"]
  ])("reports %s as a completed negative check with bounded redacted diagnostics", async (host, code, message) => {
    const result = await check(host);
    expect(result).toMatchObject({ state: "completed", value: { online: false, error: { code }, diagnostics: { stdout: "[redacted]", stderr: expect.stringContaining(message), interrupted: false } } });
    expect(JSON.stringify(result)).not.toContain("private-password");
  });

  it("reports a socket permission error as a network failure after confirmed cleanup", async () => {
    const result = await check("blocked.example");
    expect(result).toMatchObject({ state: "completed", value: { online: false, error: { code: "SSH_NETWORK_FAILED" }, diagnostics: { exitCode: 255, stdout: "[redacted]", stderr: "ssh: connect to host blocked.example port 22: Permission denied", interrupted: false } } });
    const captured = JSON.parse(await fs.readFile(capture, "utf8"));
    expect(() => process.kill(captured.pid, 0)).toThrow();
    await expect(fs.stat(captured.environment.CLOUDX_SSH_ASKPASS_SOCKET)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(captured.environment.SSH_ASKPASS)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(result)).not.toContain("private-password");
  });

  it("bounds diagnostic output independently of how much the SSH peer writes", async () => {
    const result = await check("bounded.test");
    expect(result).toMatchObject({ state: "completed", value: { online: false, diagnostics: { truncated: true } } });
    if (result.state !== "completed") throw new Error(JSON.stringify(result));
    const diagnostics = result.value.diagnostics!;
    expect(Buffer.byteLength(diagnostics.stdout as string) + Buffer.byteLength(diagnostics.stderr as string)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.stringify(result)).not.toContain("private-password");
  });

  it.each(["cancelled", "deadline"])("reports a %s fixed probe only after its local process has closed", async mode => {
    await fs.rm(capture, { force: true });
    const controller = new AbortController();
    const checking = check("waiting.test", context(controller.signal), mode === "deadline" ? 1 : 1000);
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(capture, "utf8")).pid).toBeGreaterThan(0));
    const captured = JSON.parse(await fs.readFile(capture, "utf8"));
    if (mode === "cancelled") controller.abort();
    await expect(checking).resolves.toMatchObject({ state: "completed", value: { online: false, error: { code: mode === "cancelled" ? "CANCELLED" : "TIMEOUT" }, diagnostics: { interrupted: true } } });
    expect(() => process.kill(captured.pid, 0)).toThrow();
    await expect(fs.stat(captured.environment.CLOUDX_SSH_ASKPASS_SOCKET)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("registers cancellation cleanup before credentials resolve and never spawns after cancellation", async () => {
    await fs.rm(capture, { force: true });
    let supply!: (password: string) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const checkContext = { ...context(), resolveCredential: () => { expect(checkContext.cleanups).toHaveLength(1); entered(); return new Promise<string>(resolve => { supply = resolve; }); } };
    const checking = check(config.host, checkContext);
    await started;
    const closing = checkContext.cleanups[0]!(signal());
    supply("private-password");
    await expect(checking).resolves.toMatchObject({ state: "completed", value: { online: false, error: { code: "CANCELLED" } } });
    await expect(closing).resolves.toMatchObject({ state: "completed" });
    await expect(fs.stat(capture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns unknown only when native cleanup cannot be confirmed", async () => {
    const close = vi.spyOn(BoundedProcessSet.prototype, "close").mockResolvedValue({ state: "unknown", error: { code: "CLEANUP_UNKNOWN", message: "Controlled native cleanup failure." } });
    try { await expect(check()).resolves.toMatchObject({ state: "unknown", error: { code: "SSH_CHECK_CLEANUP_UNKNOWN" }, diagnostics: { exitCode: 0 } }); }
    finally { close.mockRestore(); }
  });

  it("keeps missing credentials and a pre-cancelled check out of the native process", async () => {
    await fs.rm(capture, { force: true });
    await expect(check(config.host, { ...context(), resolveCredential: async () => { throw new Error("private-password"); } })).resolves.toMatchObject({ state: "completed", value: { online: false, error: { code: "CREDENTIAL_UNAVAILABLE" } } });
    await expect(check(config.host, context(AbortSignal.abort()))).resolves.toMatchObject({ state: "completed", value: { online: false, error: { code: "CANCELLED" } } });
    await expect(fs.stat(capture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports local endpoint and spawn failures as completed negative checks", async () => {
    const unavailable = new SshHardwareProvider({ pathPolicy: new PathPolicy([directory]), sshExecutable: path.join(directory, "missing-ssh") });
    await expect(unavailable.checkConnection(config, context())).resolves.toMatchObject({ state: "completed", value: { online: false, error: { code: "ENDPOINT_UNAVAILABLE" } } });
    const notExecutable = new SshHardwareProvider({ pathPolicy: new PathPolicy([directory]), sshExecutable: directory });
    await expect(notExecutable.checkConnection(config, context())).resolves.toMatchObject({ state: "completed", value: { online: false, error: { code: "SSH_NOT_STARTED" }, diagnostics: { state: "not_started" } } });
  });
});

describe("SSH password process ownership", () => {
  let directory: string;
  let capture: string;
  let provider: SshHardwareProvider;
  const config: SshConfig = { host: "example.test", port: 22, username: "tester", auth: { kind: "password", credentialRefId: "test-password" }, connectTimeoutMs: 1000 };

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ssh-password-"));
    capture = path.join(directory, "capture.json");
    const executable = path.join(directory, "ssh");
    await fs.writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const {execFileSync}=require('node:child_process');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(process.argv[process.argv.indexOf('-E')+1],'Authenticated to example.test using password.\\n'+'debug1: Exit status 0\\n');const answer=execFileSync(process.env.SSH_ASKPASS,["tester@example.test's password: "],{env:process.env});fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),environment:process.env,input}));process.stdout.write(answer);});\n`, { mode: 0o700 });
    provider = new SshHardwareProvider({ pathPolicy: new PathPolicy([directory]), sshExecutable: executable, environment: {} });
  });
  afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it("keeps password values out of argv and environment and removes each completed password channel", async () => {
    const context = { ...transportTestContext(), resolveCredential: async () => "private-password" };
    const opened = await provider.connect(config, context);
    expect(opened.state).toBe("completed");
    if (opened.state !== "completed") throw new Error(JSON.stringify(opened));
    try {
      const probe = JSON.parse(await fs.readFile(capture, "utf8"));
      expect(JSON.stringify(probe)).not.toContain("private-password");
      expect(probe.input).toBe("exit 0\n");
      await expect(fs.stat(probe.environment.CLOUDX_SSH_ASKPASS_SOCKET)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(opened.value.invoke("ssh.exec", { script: "printf safe", timeoutMs: 1000, maxOutputBytes: 100 }, signal())).resolves.toMatchObject({ state: "completed", value: { stdout: "[redacted]\n" } });
      const command = JSON.parse(await fs.readFile(capture, "utf8"));
      expect(command.input).toBe("printf safe");
      expect(JSON.stringify(command)).not.toContain("private-password");
      await expect(fs.stat(command.environment.SSH_ASKPASS)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null }); }
  });

  it("confirms cleanup after a pending credential lookup and never starts a cancelled SSH process", async () => {
    await fs.rm(capture, { force: true });
    let supply!: (password: string) => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>(resolve => { lookupStarted = resolve; });
    const context = { ...transportTestContext(), resolveCredential: () => { lookupStarted(); return new Promise<string>(resolve => { supply = resolve; }); } };
    const opening = provider.connect(config, context);
    await started;
    let closed = false;
    const closing = context.cleanups[0]!(signal()).then(result => { closed = true; return result; });
    await Promise.resolve();
    expect(closed).toBe(false);
    supply("private-password");
    await expect(opening).resolves.toMatchObject({ state: "failed", effects: "none" });
    await expect(closing).resolves.toEqual({ state: "completed", value: null });
    await expect(fs.stat(capture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps client exit 255 unknown even with a confirmation and preserves bounded redacted diagnostics", async () => {
    const executable = path.join(directory, "lost-ssh");
    await fs.writeFile(executable, `#!${process.execPath}\n` + String.raw`
const {execFileSync}=require('node:child_process');
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
  if(input==='exit 0\n') { require('fs').writeFileSync(process.argv[process.argv.indexOf('-E')+1],'Authenticated to example.test using password.\n'+'debug1: Exit status 0\n'); return; }
  if(input==='control-output') { process.stdout.write(Buffer.alloc(1024*1024)); process.exitCode=255; return; }
  if(input==='unicode-output') { process.stdout.write('x'.repeat(64*1024-1)); process.stderr.write('€'); process.exitCode=255; return; }
  const password=execFileSync(process.env.SSH_ASKPASS,["tester@example.test's password: "],{env:process.env}).toString().trim();
  process.stdout.write(password);
  process.stderr.write(password);
  const marker=process.argv.at(-1).match(/\ncloudx-ssh-exit-255:[a-f0-9-]+\n/)[0];
  process.stderr.write(marker);
  process.exitCode=255;
});
`, { mode: 0o700 });
    const type = new SshHardwareProvider({ pathPolicy: new PathPolicy([directory]), sshExecutable: executable, environment: {} });
    const context = { ...transportTestContext(), resolveCredential: async () => "private-password" };
    const opened = await type.connect(config, context);
    if (opened.state !== "completed") throw new Error(JSON.stringify(opened));
    try {
      const result = await opened.value.invoke("ssh.exec", { script: "exit 255", timeoutMs: 1000, maxOutputBytes: 100 }, signal());
      expect(result).toMatchObject({ state: "unknown", diagnostics: { state: "exited", exitCode: 255, signal: null, stdout: "[redacted]", stderr: "[redacted]", durationMs: expect.any(Number), truncated: false, interrupted: false } });
      expect(JSON.stringify(result)).not.toContain("private-password");
      const truncated = await opened.value.invoke("ssh.exec", { script: "exit 255", timeoutMs: 1000, maxOutputBytes: 4 }, signal());
      expect(truncated).toMatchObject({ state: "unknown", diagnostics: { exitCode: 255, truncated: true } });
      if (truncated.state !== "unknown") throw new Error(JSON.stringify(truncated));
      expect(JSON.stringify(truncated)).not.toContain("priv");
      expect(Buffer.byteLength(truncated.diagnostics!.stdout as string) + Buffer.byteLength(truncated.diagnostics!.stderr as string)).toBeLessThanOrEqual(4);
      const controls = await opened.value.invoke("ssh.exec", { script: "control-output", timeoutMs: 1000, maxOutputBytes: 1024 * 1024 }, signal());
      expect(controls).toMatchObject({ state: "unknown", diagnostics: { stdout: "\0".repeat(64 * 1024), stderr: "", truncated: true } });
      expect(Buffer.byteLength(JSON.stringify(controls))).toBeLessThan(2 * 1024 * 1024);
      const unicode = await opened.value.invoke("ssh.exec", { script: "unicode-output", timeoutMs: 1000, maxOutputBytes: 1024 * 1024 }, signal());
      expect(unicode).toMatchObject({ state: "unknown", diagnostics: { stdout: "x".repeat(64 * 1024 - 1), stderr: "", truncated: true } });
    } finally { await context.cleanups[0]!(signal()); }
  });

  it("fails credential validation before any native process starts and hides resolver errors", async () => {
    await fs.rm(capture, { force: true });
    for (const resolveCredential of [async () => "a\nb", async () => "a".repeat(1024), async () => { throw new Error("private-password"); }]) {
      const context = { ...transportTestContext(), resolveCredential };
      const result = await provider.connect(config, context);
      expect(result).toMatchObject({ state: "failed", effects: "none", error: { code: "CREDENTIAL_UNAVAILABLE" } });
      expect(JSON.stringify(result)).not.toContain("private-password");
      await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
    }
    await expect(fs.stat(capture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires usable agent keys for explicit registration and rejects plaintext action input", async () => {
    const context = { ...transportTestContext(), resolveCredential: async () => "private-password" };
    await expect(provider.registerKey(config, { timeoutMs: 1000 }, context)).resolves.toMatchObject({ state: "failed", effects: "none", error: { code: "SSH_AGENT_UNAVAILABLE" } });
    await expect(provider.registerKey(config, { timeoutMs: 1000, password: "private-password" }, context)).resolves.toMatchObject({ state: "failed", effects: "none", error: { code: "INVALID_INPUT" } });
    for (const cleanup of context.cleanups) await expect(cleanup(signal())).resolves.toEqual({ state: "completed", value: null });
  });
});

describe.skipIf(!existsSync("/usr/sbin/sshd") || !existsSync("/usr/lib/openssh/sftp-server"))("SSH provider through isolated loopback OpenSSH server", () => {
  let directory: string;
  let sshd: ChildProcess;
  let config: SshConfig;
  let provider: SshHardwareProvider;
  let connection: HardwareConnection;
  let sshdErrors = "";

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ssh-"));
    const hostKey = path.join(directory, "host-key");
    const identity = path.join(directory, "client-key");
    await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
    await fs.copyFile(`${identity}.pub`, path.join(directory, "authorized_keys"));
    const username = os.userInfo().username;
    const port = await unusedPort();
    const sshdConfig = path.join(directory, "sshd_config");
    await fs.writeFile(sshdConfig, [
      `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${hostKey}`, `PidFile ${directory}/sshd.pid`, `AuthorizedKeysFile ${directory}/authorized_keys`,
      "StrictModes no", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "UsePAM no", "PermitRootLogin yes", `AllowUsers ${username}`, "Subsystem sftp /usr/lib/openssh/sftp-server", "LogLevel ERROR"
    ].join("\n") + "\n");
    await exec("/usr/sbin/sshd", ["-t", "-f", sshdConfig]);
    sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", sshdConfig], { stdio: ["ignore", "ignore", "pipe"] });
    sshd.stderr!.on("data", (chunk) => { sshdErrors += chunk.toString(); });
    await waitForPort(port, () => sshd.exitCode !== null, () => sshdErrors);
    const publicKey = (await fs.readFile(`${hostKey}.pub`, "utf8")).trim().split(" ").slice(0, 2).join(" ");
    const knownHostsFile = path.join(directory, "known hosts");
    await fs.writeFile(knownHostsFile, `[127.0.0.1]:${port} ${publicKey}\n`, { mode: 0o600 });
    config = { host: "127.0.0.1", port, username, auth: { kind: "identity_file", path: identity }, knownHostsFile, connectTimeoutMs: 3000 };
    provider = new SshHardwareProvider({ pathPolicy: new PathPolicy([directory]) });
    const context = transportTestContext();
    const result = await provider.connect(config, context);
    if (result.state !== "completed") throw new Error(`SSH emulation failed: ${JSON.stringify(result)} ${sshdErrors}`);
    connection = result.value;
  }, 15_000);

  afterAll(async () => {
    await connection?.close(signal());
    if (sshd?.exitCode === null) { sshd.kill("SIGTERM"); await new Promise((resolve) => sshd.once("exit", resolve)); }
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it("executes stdin script bytes and treats an observed remote failure as a completed result", async () => {
    const result = await connection.invoke("ssh.exec", { script: 'printf "%s" "literal $(printf command)"; printf error >&2; exit 7', timeoutMs: 3000, maxOutputBytes: 1024 }, signal());
    expect(result).toMatchObject({ state: "completed", value: { exitCode: 7, stdout: "literal command", stderr: "error", truncated: false } });
    const marker = path.join(directory, "path is data; touch SHOULD_NOT_EXIST");
    const escaped = marker.replace(/'/g, "'\\''");
    await expect(connection.invoke("ssh.exec", { script: `printf '%s' '${escaped}'`, timeoutMs: 3000, maxOutputBytes: 1024 }, signal())).resolves.toMatchObject({ state: "completed", value: { stdout: marker } });
  });

  it("checks native SSH login and reports authentication, host-key, and network failures without an effect hold", async () => {
    await expect(provider.checkConnection(config, transportTestContext())).resolves.toMatchObject({ state: "completed", value: { online: true, diagnostics: { exitCode: 0 } } });
    const untrustedKey = path.join(directory, "untrusted-key");
    await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", untrustedKey]);
    await expect(provider.checkConnection({ ...config, auth: { kind: "identity_file", path: untrustedKey } }, transportTestContext())).resolves.toMatchObject({ state: "completed", value: { online: false, error: { code: "SSH_AUTH_FAILED" }, diagnostics: { exitCode: 255, stderr: expect.stringContaining("Permission denied") } } });
    const publicKey = (await fs.readFile(`${untrustedKey}.pub`, "utf8")).trim().split(" ").slice(0, 2).join(" ");
    const changedHosts = path.join(directory, "changed-hosts");
    await fs.writeFile(changedHosts, `[${config.host}]:${config.port} ${publicKey}\n`);
    await expect(provider.checkConnection({ ...config, knownHostsFile: changedHosts }, transportTestContext())).resolves.toMatchObject({ state: "completed", value: { online: false, error: { code: "SSH_HOST_KEY_FAILED" }, diagnostics: { exitCode: 255 } } });
    await expect(provider.checkConnection({ ...config, port: await unusedPort() }, transportTestContext())).resolves.toMatchObject({ state: "completed", value: { online: false, error: { code: "SSH_NETWORK_FAILED" }, diagnostics: { exitCode: 255 } } });
  });

  it("bounds combined stdout and stderr while draining both streams", async () => {
    const result = await connection.invoke("ssh.exec", { script: "head -c 200000 /dev/zero; head -c 200000 /dev/zero >&2", timeoutMs: 3000, maxOutputBytes: 101 }, signal());
    expect(result.state).toBe("completed");
    if (result.state === "completed") {
      expect(Buffer.byteLength(result.value.stdout as string) + Buffer.byteLength(result.value.stderr as string)).toBe(101);
      expect(result.value.truncated).toBe(true);
    }
  });

  it("uploads and downloads exact regular-file bytes with spaces, quotes and shell punctuation in paths", async () => {
    const source = path.join(directory, 'source "quoted"; harmless.bin');
    const remote = path.join(directory, 'remote "quoted"; harmless.bin');
    const destination = path.join(directory, 'download "quoted"; harmless.bin');
    const contents = Buffer.from([0, 1, 13, 10, 255, 42]);
    await fs.writeFile(source, contents);
    await expect(connection.invoke("ssh.upload", { localPath: source, remotePath: remote, timeoutMs: 3000, overwrite: false }, signal())).resolves.toEqual({ state: "completed", value: { bytesTransferred: contents.length, destination: remote, completed: true } });
    expect(await fs.readFile(remote)).toEqual(contents);
    await expect(connection.invoke("ssh.download", { localPath: destination, remotePath: remote, timeoutMs: 3000, overwrite: false }, signal())).resolves.toEqual({ state: "completed", value: { bytesTransferred: contents.length, destination, completed: true } });
    expect(await fs.readFile(destination)).toEqual(contents);
    expect(await fs.readdir(directory)).not.toEqual(expect.arrayContaining(["SHOULD_NOT_EXIST"]));
  });

  it("preserves existing destinations when overwrite is false and supports explicit replacement", async () => {
    const source = path.join(directory, "new-data");
    const remote = path.join(directory, "existing-remote");
    const local = path.join(directory, "existing-local");
    await fs.writeFile(source, "new"); await fs.writeFile(remote, "old"); await fs.writeFile(local, "old-local");
    await expect(connection.invoke("ssh.upload", { localPath: source, remotePath: remote, timeoutMs: 3000, overwrite: false }, signal())).resolves.toMatchObject({ state: "failed", effects: "settled", error: { code: "SFTP_FAILED" } });
    expect(await fs.readFile(remote, "utf8")).toBe("old");
    await expect(connection.invoke("ssh.download", { localPath: local, remotePath: remote, timeoutMs: 3000, overwrite: false }, signal())).resolves.toMatchObject({ state: "failed", effects: "none", error: { code: "DESTINATION_EXISTS" } });
    await expect(connection.invoke("ssh.upload", { localPath: source, remotePath: remote, timeoutMs: 3000, overwrite: true }, signal())).resolves.toMatchObject({ state: "completed" });
    await expect(connection.invoke("ssh.download", { localPath: local, remotePath: remote, timeoutMs: 3000, overwrite: true }, signal())).resolves.toMatchObject({ state: "completed" });
    expect(await fs.readFile(local, "utf8")).toBe("new");
  });

  it("preserves literal backslashes in both SFTP source and destination paths", async () => {
    const source = path.join(directory, "back\\slash-source");
    const remote = path.join(directory, "back\\slash-remote");
    const local = path.join(directory, "back\\slash-download");
    await fs.writeFile(source, "literal backslash");
    await expect(connection.invoke("ssh.upload", { localPath: source, remotePath: remote, timeoutMs: 3000, overwrite: false }, signal())).resolves.toMatchObject({ state: "completed" });
    await expect(connection.invoke("ssh.download", { localPath: local, remotePath: remote, timeoutMs: 3000, overwrite: false }, signal())).resolves.toMatchObject({ state: "completed" });
    expect(await fs.readFile(local, "utf8")).toBe("literal backslash");
  });

  it("rejects local escapes, symlink escapes and directory transfers before dispatch", async () => {
    const source = path.join(directory, "outside-link");
    await fs.symlink("/etc/passwd", source);
    for (const localPath of ["/etc/passwd", source, directory]) {
      await expect(connection.invoke("ssh.upload", { localPath, remotePath: "/tmp/not-written", timeoutMs: 1000, overwrite: false }, signal())).resolves.toMatchObject({ state: "failed", effects: "none" });
    }
    await expect(connection.invoke("ssh.download", { localPath: path.join(directory, "no-directory-copy"), remotePath: directory, timeoutMs: 3000, overwrite: false }, signal())).resolves.toMatchObject({ state: "failed", effects: "settled", error: { code: "SFTP_FAILED" } });
    expect(existsSync(path.join(directory, "no-directory-copy"))).toBe(false);
  });

  it.each([0, 7, 254, 255])("returns confirmed remote exit %i with exact diagnostics", async (exitCode) => {
    await expect(connection.invoke("ssh.exec", { script: `printf output; printf error >&2; exit ${exitCode}`, timeoutMs: 3000, maxOutputBytes: 100 }, signal())).resolves.toMatchObject({ state: "completed", value: { exitCode, stdout: "output", stderr: "error", truncated: false } });
  });

  it("persists confirmed exit 255 and interrupted diagnostics through managed access without clearing recovery", async () => {
    const owner = { kind: "user" as const, userId: "local" };
    const service = new HardwareService({ dataDir: path.join(directory, "managed-state"), pathPolicy: new PathPolicy([directory]), registry: { values: () => [provider], get: () => provider } });
    let sequence = 0;
    const mutate = (action: string, input: JsonObject) => service.execute(action, { requestId: `ssh-managed-${++sequence}`, ...input }, owner) as Promise<HardwareMutationResult>;
    const receipt = (result: HardwareMutationResult) => vi.waitFor(async () => {
      const saved = await service.execute("hardware.receipt.get", { requestId: result.receipt.requestId }, owner) as { receipt: OperationReceipt };
      expect(saved.receipt.state).not.toBe("running");
      return saved.receipt;
    }, { timeout: 4000 });
    try {
      await service.init();
      await mutate("hardware.groups.create", { name: "Loopback" });
      const group = (await service.snapshot(owner)).groups[0];
      await mutate("hardware.items.create", { item: { name: "Loopback SSH", description: "", enabled: true, physicalResourceId: group.id, typeId: "hardware.ssh", configVersion: 1, config: JSON.parse(JSON.stringify(config)), tagIds: [], notes: "", statuses: [], hooks: {} } });
      const item = (await service.snapshot(owner)).items[0].item;
      const claim = (await mutate("hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Verify SSH receipts" })).reservation!;
      const ref = { reservationId: claim.reservationId, generation: claim.generation };
      expect((await receipt(await mutate("hardware.access.open", ref))).state).toBe("succeeded");
      expect(await receipt(await mutate("hardware.access.invoke", { ...ref, operationId: "ssh.exec", input: { script: "exit 255", timeoutMs: 3000, maxOutputBytes: 100 } }))).toMatchObject({ state: "succeeded", result: { exitCode: 255, truncated: false } });
      expect(service.ownerClaims()[0].state).toBe("active");
      expect(await receipt(await mutate("hardware.access.invoke", { ...ref, operationId: "ssh.exec", input: { script: "printf diagnostic; sleep 20", timeoutMs: 1000, maxOutputBytes: 100 } }))).toMatchObject({ state: "unknown", result: { diagnostics: { stdout: "diagnostic", exitCode: 255, signal: null, interrupted: true } } });
      expect((await receipt(await mutate("hardware.access.close", ref))).state).toBe("succeeded");
      expect(service.ownerClaims()[0]).toMatchObject({ state: "recovery_required", accessState: "closed" });
    } finally { await service.dispose(); }
  });

  it("confirms exit 255 after full output and preserves Bash errexit, exit traps and exec", async () => {
    await expect(connection.invoke("ssh.exec", { script: "head -c 200000 /dev/zero; exit 255", timeoutMs: 3000, maxOutputBytes: 10 }, signal())).resolves.toMatchObject({ state: "completed", value: { exitCode: 255, stdout: "\0".repeat(10), stderr: "", truncated: true } });
    for (const script of ["set -e; /bin/bash -c 'exit 255'; printf unreachable", "trap 'printf trapped >&2' EXIT; exit 255", "exec /bin/bash -c 'exit 255'"]) {
      await expect(connection.invoke("ssh.exec", { script, timeoutMs: 3000, maxOutputBytes: 100 }, signal())).resolves.toMatchObject({ state: "completed", value: { exitCode: 255, stdout: "" } });
    }
    await expect(connection.invoke("ssh.exec", { script: "trap 'printf trapped >&2' EXIT; exit 255", timeoutMs: 3000, maxOutputBytes: 100 }, signal())).resolves.toMatchObject({ state: "completed", value: { exitCode: 255, stderr: "trapped", truncated: false } });
  });

  it("preserves exit 255 and later stderr from background descendants", async () => {
    await expect(connection.invoke("ssh.exec", { script: "(sleep 0.1; printf late >&2) & exit 255", timeoutMs: 3000, maxOutputBytes: 100 }, signal())).resolves.toMatchObject({ state: "completed", value: { exitCode: 255, stdout: "", stderr: "late", truncated: false } });
  });

  it("settles a local publication failure after the SFTP download completes", async () => {
    const source = path.join(directory, "publication-source");
    const destination = path.join(directory, "publication-destination");
    await fs.writeFile(source, "payload");
    const rename = fs.rename.bind(fs);
    const publish = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === destination) throw Object.assign(new Error("Publication denied"), { code: "EACCES" });
      return rename(from, to);
    });
    try {
      expect(await connection.invoke("ssh.download", { localPath: destination, remotePath: source, timeoutMs: 3000, overwrite: true }, signal())).toMatchObject({ state: "failed", effects: "settled", error: { code: "LOCAL_PATH_UNAVAILABLE" } });
      expect(existsSync(destination)).toBe(false);
      expect(await fs.readFile(source, "utf8")).toBe("payload");
    } finally { publish.mockRestore(); }
  });

  it("returns a nested SSH changed-host-key rejection as a confirmed command failure without modifying trust", async () => {
    const changedKey = path.join(directory, "changed-host-key");
    await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", changedKey]);
    const wrongKey = (await fs.readFile(`${changedKey}.pub`, "utf8")).trim().split(" ").slice(0, 2).join(" ");
    const nestedHosts = path.join(directory, "nested-known-hosts");
    const trust = `[127.0.0.1]:${config.port} ${wrongKey}\n`;
    await fs.writeFile(nestedHosts, trust);
    const script = `set -euo pipefail\n/usr/bin/ssh -F /dev/null -T -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='${nestedHosts}' -o GlobalKnownHostsFile=/dev/null -p ${config.port} ${config.username}@127.0.0.1 'printf MUST_NOT_RUN'`;
    const result = await connection.invoke("ssh.exec", { script, timeoutMs: 3000, maxOutputBytes: 4096 }, signal());
    expect(result).toMatchObject({ state: "completed", value: { exitCode: 255, stdout: "", truncated: false } });
    if (result.state !== "completed") throw new Error(JSON.stringify(result));
    expect(result.value.stderr).toContain("REMOTE HOST IDENTIFICATION HAS CHANGED!");
    expect(await fs.readFile(nestedHosts, "utf8")).toBe(trust);
  });

  it("retains cancellation diagnostics and does not infer remote termination from cleanup", async () => {
    const context = transportTestContext();
    const opened = await provider.connect(config, context);
    if (opened.state !== "completed") throw new Error(JSON.stringify(opened));
    const controller = new AbortController();
    const ready = path.join(directory, "cancel-ready");
    const running = opened.value.invoke("ssh.exec", { script: `printf output; printf error >&2; touch '${ready}'; sleep 20`, timeoutMs: 5000, maxOutputBytes: 100 }, controller.signal);
    await waitForFile(ready);
    controller.abort();
    await expect(running).resolves.toMatchObject({ state: "unknown", diagnostics: { stdout: "output", stderr: "error", exitCode: 255, signal: null, durationMs: expect.any(Number), truncated: false, interrupted: true } });
    await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
    await expect(opened.value.invoke("ssh.exec", { script: "true", timeoutMs: 1000, maxOutputBytes: 100 }, signal())).resolves.toMatchObject({ state: "failed", error: { code: "ACCESS_CLOSED" } });
  });

  it("retains bounded diagnostics when the remote command exceeds its deadline", async () => {
    await expect(connection.invoke("ssh.exec", { script: "printf output; printf error >&2; sleep 20", timeoutMs: 1000, maxOutputBytes: 100 }, signal())).resolves.toMatchObject({ state: "unknown", diagnostics: { stdout: "output", stderr: "error", exitCode: 255, signal: null, durationMs: expect.any(Number), truncated: false, interrupted: true } });
  });

  it("keeps outer transport loss unknown with captured diagnostics", async () => {
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer(client => {
      const upstream = net.connect(config.port, "127.0.0.1");
      for (const socket of [client, upstream]) { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); }
      client.pipe(upstream); upstream.pipe(client);
    });
    const context = transportTestContext();
    try {
      await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
      const port = (proxy.address() as net.AddressInfo).port;
      const knownHostsFile = path.join(directory, "proxy-known-hosts");
      await fs.writeFile(knownHostsFile, (await fs.readFile(config.knownHostsFile!, "utf8")).replace(`]:${config.port}`, `]:${port}`));
      const opened = await provider.connect({ ...config, port, knownHostsFile }, context);
      if (opened.state !== "completed") throw new Error(JSON.stringify(opened));
      const ready = path.join(directory, "transport-ready");
      const running = opened.value.invoke("ssh.exec", { script: `printf output; printf error >&2; touch '${ready}'; sleep 20`, timeoutMs: 3000, maxOutputBytes: 1024 }, signal());
      await waitForFile(ready);
      for (const socket of sockets) socket.destroy();
      const result = await running;
      expect(result).toMatchObject({ state: "unknown", diagnostics: { exitCode: 255, stdout: "output", stderr: expect.stringContaining("error"), interrupted: false, truncated: false, durationMs: expect.any(Number) } });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      for (const cleanup of context.cleanups) await cleanup(signal());
    }
  });

  it("does not accept an unknown host key or use another authentication method", async () => {
    const emptyHosts = path.join(directory, "empty-known-hosts");
    await fs.writeFile(emptyHosts, "");
    const context = transportTestContext();
    await expect(provider.connect({ ...config, knownHostsFile: emptyHosts }, context)).resolves.toMatchObject({ state: "failed", effects: "none", error: { code: "SSH_HOST_KEY_REJECTED" }, diagnostics: { clientLog: expect.stringContaining("Host key verification failed.") } });
    await context.cleanups[0]!(signal());
    expect(await fs.readFile(emptyHosts, "utf8")).toBe("");
  });

  it.each(["refusal", "timeout"])("keeps managed access usable after a post-boot connection %s", async mode => {
    const sockets = new Set<net.Socket>();
    let available = true;
    const proxy = net.createServer(client => {
      sockets.add(client); client.on("error", () => {}); client.on("close", () => sockets.delete(client));
      if (!available) return;
      const upstream = net.connect(config.port, "127.0.0.1");
      sockets.add(upstream); upstream.on("error", () => {}); upstream.on("close", () => sockets.delete(upstream));
      client.pipe(upstream); upstream.pipe(client);
      client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
    });
    const owner = { kind: "user" as const, userId: "local" };
    const service = new HardwareService({ dataDir: path.join(directory, `post-boot-${mode}`), pathPolicy: new PathPolicy([directory]), registry: { values: () => [provider], get: () => provider } });
    let sequence = 0;
    const mutate = (action: string, input: JsonObject) => service.execute(action, { requestId: `post-boot-${mode}-${++sequence}`, ...input }, owner) as Promise<HardwareMutationResult>;
    const receipt = (result: HardwareMutationResult) => vi.waitFor(async () => {
      const saved = await service.execute("hardware.receipt.get", { requestId: result.receipt.requestId }, owner) as { receipt: OperationReceipt };
      expect(saved.receipt.state).not.toBe("running"); return saved.receipt;
    }, { timeout: 5000 });
    try {
      await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
      const port = (proxy.address() as net.AddressInfo).port;
      const knownHostsFile = path.join(directory, `post-boot-${mode}-known-hosts`);
      await fs.writeFile(knownHostsFile, (await fs.readFile(config.knownHostsFile!, "utf8")).replace(`]:${config.port}`, `]:${port}`));
      const endpoint = { ...config, port, knownHostsFile, connectTimeoutMs: 1000 };
      await service.init();
      await mutate("hardware.groups.create", { name: "Post-boot loopback" });
      const group = (await service.snapshot(owner)).groups[0];
      await mutate("hardware.items.create", { item: { name: "Post-boot SSH", description: "", enabled: true, physicalResourceId: group.id, typeId: "hardware.ssh", configVersion: 1, config: JSON.parse(JSON.stringify(endpoint)), tagIds: [], notes: "", statuses: [], hooks: {} } });
      const item = (await service.snapshot(owner)).items[0].item;
      const claim = (await mutate("hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Verify pre-dispatch failure" })).reservation!;
      const ref = { reservationId: claim.reservationId, generation: claim.generation };
      expect((await receipt(await mutate("hardware.access.open", ref))).state).toBe("succeeded");
      available = false;
      for (const socket of sockets) socket.destroy();
      if (mode === "refusal") await new Promise<void>(resolve => proxy.close(() => resolve()));
      const invoke = () => mutate("hardware.access.invoke", { ...ref, operationId: "ssh.exec", input: { script: "printf booted", timeoutMs: 3000, maxOutputBytes: 1 } });
      expect(await receipt(await invoke())).toMatchObject({ state: "failed", error: { code: "SSH_CONNECTION_FAILED", message: expect.stringContaining("before remote command dispatch") }, result: { diagnostics: { stdout: "", interrupted: false, clientLog: expect.stringContaining(mode === "timeout" ? "Connection timed out during banner exchange" : "Connection refused") } } });
      expect(service.ownerClaims()[0]).toMatchObject({ state: "active", accessState: "open", generation: ref.generation });
      available = true;
      for (const socket of sockets) socket.destroy();
      if (mode === "refusal") await new Promise<void>(resolve => proxy.listen(port, "127.0.0.1", resolve));
      expect(await receipt(await invoke())).toMatchObject({ state: "succeeded", result: { exitCode: 0, stdout: "b", truncated: true } });
      expect((await receipt(await mutate("hardware.access.close", ref))).state).toBe("succeeded");
      expect(service.ownerClaims()[0]).toMatchObject({ state: "active", accessState: "closed" });
    } finally {
      await service.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }, 15_000);

  it.each(["authentication", "host-key"])("fails before dispatch for %s rejection in connect, exec, SFTP and registration", async mode => {
    const hosts = path.join(directory, `rejected-${mode}-known-hosts`);
    const identity = path.join(directory, `rejected-${mode}-identity`);
    await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
    await fs.copyFile(config.knownHostsFile!, hosts);
    const endpoint = { ...config, knownHostsFile: hosts, auth: { kind: "identity_file" as const, path: identity } };
    // First open with the accepted key, then reject new handshakes.
    const goodIdentity = await fs.readFile((config.auth as { path: string }).path);
    const goodPublic = await fs.readFile(`${(config.auth as { path: string }).path}.pub`);
    const badIdentity = await fs.readFile(identity);
    const badPublic = await fs.readFile(`${identity}.pub`);
    await fs.writeFile(identity, goodIdentity, { mode: 0o600 });
    await fs.writeFile(`${identity}.pub`, goodPublic);
    const context = transportTestContext();
    const opened = await provider.connect(endpoint, context);
    if (opened.state !== "completed") throw new Error(JSON.stringify(opened));
    try {
      if (mode === "authentication") {
        await fs.writeFile(identity, badIdentity, { mode: 0o600 });
        await fs.writeFile(`${identity}.pub`, badPublic);
      } else await fs.writeFile(hosts, `[127.0.0.1]:${config.port} ${badPublic.toString().trim()}\n`);
      const trust = await fs.readFile(hosts, "utf8");
      const expected = { state: "failed", effects: "none", error: { code: mode === "authentication" ? "SSH_AUTHENTICATION_FAILED" : "SSH_HOST_KEY_REJECTED" }, diagnostics: { clientLog: expect.any(String), truncated: false } };
      expect(await provider.connect(endpoint, context)).toMatchObject(expected);
      expect(await opened.value.invoke("ssh.exec", { script: "printf MUST_NOT_RUN", timeoutMs: 3000, maxOutputBytes: 1 }, signal())).toMatchObject(expected);
      const source = path.join(directory, `rejected-${mode}-source`);
      const destination = path.join(directory, `rejected-${mode}-destination`);
      await fs.writeFile(source, "payload");
      for (const operation of ["ssh.upload", "ssh.download"]) {
        expect(await opened.value.invoke(operation, { localPath: operation === "ssh.upload" ? source : destination, remotePath: destination, timeoutMs: 3000, overwrite: false }, signal())).toMatchObject(expected);
      }
      expect(existsSync(destination)).toBe(false);
      expect(await provider.registerKey(endpoint, { timeoutMs: 5000 }, context)).toMatchObject(expected);
      expect(await fs.readFile(hosts, "utf8")).toBe(trust);
    } finally { for (const cleanup of context.cleanups) await cleanup(signal()); }
  }, 15_000);

  it("does not use remote stderr that mimics a connection rejection as client evidence", async () => {
    const result = await connection.invoke("ssh.exec", { script: "printf 'cloudx-ssh-client-start\\nssh: connect to host 127.0.0.1 port 22: Connection refused\\n' >&2; sleep 20", timeoutMs: 500, maxOutputBytes: 1000 }, signal());
    expect(result).toMatchObject({ state: "unknown", diagnostics: { stderr: expect.stringContaining("Connection refused"), clientLog: expect.stringContaining("Authenticated to "), interrupted: true } });
  });

  it("registers an already authorized configured key before connect without duplicating it", async () => {
    const before = await fs.readFile(path.join(directory, "authorized_keys"), "utf8");
    const context = transportTestContext();
    await expect(provider.registerKey(config, { timeoutMs: 5000 }, context)).resolves.toEqual({ state: "completed", value: { registered: true } });
    expect(await fs.readFile(path.join(directory, "authorized_keys"), "utf8")).toBe(before);
    expect(context.cleanups).toHaveLength(1);
    await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
  });

  it("reuses a machine's managed key through native ssh-copy-id and verifies key-only login without an agent", async () => {
    const managedKeysDirectory = path.join(directory, "managed-identities");
    const pathPolicy = new PathPolicy([directory]);
    const store = new ManagedSshKeyStore({ directory: managedKeysDirectory, pathPolicy });
    const prepared = await store.getOrCreate("native-machine", transportTestContext(), 3000);
    if (prepared.state !== "completed") throw new Error(JSON.stringify(prepared));
    const authorized = path.join(directory, "authorized_keys");
    const before = await fs.readFile(authorized);
    const installed = await fs.readFile(`${prepared.value.path}.pub`);
    await fs.appendFile(authorized, installed);
    const type = new SshHardwareProvider({ pathPolicy, managedKeysDirectory, environment: {} });
    const context = { ...transportTestContext(), resolveCredential: vi.fn(async () => "unused-bootstrap-password") };
    try {
      const result = await type.setupKey(config, { hardwareId: "native-machine", credentialRefId: "bootstrap", timeoutMs: 5000 }, context);
      expect(result).toMatchObject({ state: "completed", value: { config: { auth: { kind: "identity_file", path: prepared.value.path } }, connectionCheck: { online: true, diagnostics: { exitCode: 0 } } } });
      expect(await fs.readFile(authorized)).toEqual(Buffer.concat([before, installed]));
      expect(context.resolveCredential).toHaveBeenCalledExactlyOnceWith("bootstrap");
      expect(JSON.stringify(result)).not.toContain("unused-bootstrap-password");
      for (const cleanup of context.cleanups) expect(await cleanup(signal())).toEqual({ state: "completed", value: null });
    } finally { await fs.writeFile(authorized, before); }
  });

  it("preserves the configured private/public pair when its public key is a symlink to another basename", async () => {
    const privateKey = (config.auth as { path: string }).path;
    const alias = path.join(directory, "alias-key");
    const publicTarget = path.join(directory, "public-only.pub");
    await fs.symlink(privateKey, alias);
    await fs.copyFile(`${privateKey}.pub`, publicTarget);
    await fs.symlink(publicTarget, `${alias}.pub`);
    const context = transportTestContext();
    await expect(provider.registerKey({ ...config, auth: { kind: "identity_file", path: alias } }, { timeoutMs: 5000 }, context)).resolves.toEqual({ state: "completed", value: { registered: true } });
    await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
  });

  it("rejects mismatched and encrypted identity pairs and shell-active key paths before registration", async () => {
    const identity = path.join(directory, "other-key");
    await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
    await fs.copyFile(`${(config.auth as { path: string }).path}.pub`, `${identity}.pub`);
    const encrypted = path.join(directory, "encrypted-key");
    await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "test-passphrase", "-f", encrypted]);
    const unsafe = path.join(directory, 'quoted"key');
    await fs.copyFile(identity, unsafe);
    await fs.copyFile(`${identity}.pub`, `${unsafe}.pub`);
    for (const key of [identity, encrypted, unsafe]) {
      const context = transportTestContext();
      await expect(provider.registerKey({ ...config, auth: { kind: "identity_file", path: key } }, { timeoutMs: 5000 }, context)).resolves.toMatchObject({ state: "failed", effects: "none" });
      await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
    }
  });

  it("keeps interrupted key registration unknown while cleanup confirms process exit and removes password channels", async () => {
    const executable = path.join(directory, "pending-copy-id");
    const marker = path.join(directory, "pending-registration.json");
    await fs.writeFile(executable, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,askpass:process.env.SSH_ASKPASS,socket:process.env.CLOUDX_SSH_ASKPASS_SOCKET,home:process.env.HOME,argv:process.argv.slice(2)}));setInterval(()=>{},1000);\n`, { mode: 0o700 });
    const type = new SshHardwareProvider({ pathPolicy: new PathPolicy([directory]), sshCopyIdExecutable: executable });
    const context = { ...transportTestContext(), resolveCredential: async () => "private-password" };
    const registration = type.registerKey(config, { timeoutMs: 10000, credentialRefId: "registration-password" }, context);
    const deadline = Date.now() + 3000;
    while (!existsSync(marker)) { if (Date.now() > deadline) throw new Error("Registration did not start."); await new Promise(resolve => setTimeout(resolve, 10)); }
    const active = JSON.parse(await fs.readFile(marker, "utf8"));
    expect(JSON.stringify(active)).not.toContain("private-password");
    expect(await fs.readdir(path.join(active.home, ".ssh"))).toEqual([]);
    expect(active.argv).toEqual(expect.arrayContaining(["PubkeyAuthentication=yes", "PreferredAuthentications=password", "BatchMode=no"]));
    expect(active.argv).not.toContain("-f");
    await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
    await expect(registration).resolves.toMatchObject({ state: "unknown", error: { code: "SSH_KEY_REGISTRATION_UNKNOWN" } });
    expect(() => process.kill(active.pid, 0)).toThrow();
    for (const location of [active.askpass, active.socket, active.home]) await expect(fs.stat(location)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not interpret a failed ssh-copy-id wrapper as a confirmed remote failure", async () => {
    const executable = path.join(directory, "failed-copy-id");
    await fs.writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const type = new SshHardwareProvider({ pathPolicy: new PathPolicy([directory]), sshCopyIdExecutable: executable });
    const context = transportTestContext();
    await expect(type.registerKey(config, { timeoutMs: 5000 }, context)).resolves.toMatchObject({ state: "unknown", error: { code: "SSH_KEY_REGISTRATION_UNKNOWN" } });
    await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
  });
});

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForPort(port: number, ended: () => boolean, errors: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ended()) throw new Error(`Emulated sshd ended: ${errors()}`);
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Emulated sshd did not listen: ${errors()}`);
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Remote command did not signal readiness.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
