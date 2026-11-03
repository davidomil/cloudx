import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HardwareConnection } from "@cloudx/plugin-api";
import type { SshConfig } from "@cloudx/shared";
import { PathPolicy } from "../../pathPolicy.js";
import { SshHardwareProvider, serializeSftpPath, sshArguments } from "./SshHardwareProvider.js";
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

  it("reports remote exit 255 and cancellation as unknown and does not infer remote termination from cleanup", async () => {
    await expect(connection.invoke("ssh.exec", { script: "exit 255", timeoutMs: 3000, maxOutputBytes: 100 }, signal())).resolves.toMatchObject({ state: "unknown", error: { code: "OUTCOME_UNKNOWN" } });
    const context = transportTestContext();
    const opened = await provider.connect(config, context);
    if (opened.state !== "completed") throw new Error(JSON.stringify(opened));
    const controller = new AbortController();
    const running = opened.value.invoke("ssh.exec", { script: "sleep 20", timeoutMs: 5000, maxOutputBytes: 100 }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await expect(running).resolves.toMatchObject({ state: "unknown" });
    await expect(context.cleanups[0]!(signal())).resolves.toEqual({ state: "completed", value: null });
    await expect(opened.value.invoke("ssh.exec", { script: "true", timeoutMs: 1000, maxOutputBytes: 100 }, signal())).resolves.toMatchObject({ state: "failed", error: { code: "ACCESS_CLOSED" } });
  });

  it("does not accept an unknown host key or use another authentication method", async () => {
    const emptyHosts = path.join(directory, "empty-known-hosts");
    await fs.writeFile(emptyHosts, "");
    const context = transportTestContext();
    await expect(provider.connect({ ...config, knownHostsFile: emptyHosts }, context)).resolves.toMatchObject({ state: "unknown", error: { code: "SSH_CONNECT_UNKNOWN" } });
    await context.cleanups[0]!(signal());
    expect(await fs.readFile(emptyHosts, "utf8")).toBe("");
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
