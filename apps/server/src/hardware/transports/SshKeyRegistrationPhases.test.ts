import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SshConfig } from "@cloudx/shared";
import { PathPolicy } from "../../pathPolicy.js";
import { SshHardwareProvider, type SshHardwareOptions } from "./SshHardwareProvider.js";
import { transportTestContext } from "./TransportTestContext.js";

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
const contexts: ReturnType<typeof transportTestContext>[] = [];
let root: string;
let identity: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ssh-phases-"));
  identity = path.join(root, "identity");
  await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
});
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    for (const cleanup of context.cleanups) await expect(cleanup(signal())).resolves.toEqual({ state: "completed", value: null });
  }
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

function context(selectedSignal = signal()) {
  const value = transportTestContext(selectedSignal);
  contexts.push(value);
  return value;
}

async function executable(file: string, source: string) {
  await fs.writeFile(file, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
}

async function fixture(source: string, options: Partial<SshHardwareOptions> = {}) {
  const directory = await fs.mkdtemp(path.join(root, "case-"));
  const ssh = path.join(directory, "ssh-client");
  const copyId = path.join(directory, "ssh-copy-id");
  const hosts = path.join(directory, "known-hosts");
  await executable(ssh, source);
  await fs.writeFile(copyId, "#!/bin/bash\nssh first\nssh second\nexit 1\n", { mode: 0o700 });
  await fs.writeFile(hosts, "");
  const config: SshConfig = { host: "example.test", port: 22, username: "tester", auth: { kind: "identity_file", path: identity }, knownHostsFile: hosts, connectTimeoutMs: 1000 };
  const provider = new SshHardwareProvider({ pathPolicy: new PathPolicy([root]), sshExecutable: ssh, sftpExecutable: process.execPath, sshCopyIdExecutable: copyId, environment: {}, ...options });
  return { provider, config, directory, ssh, copyId };
}

const clientLog = String.raw`
const fs = require('node:fs');
const log = process.argv[process.argv.indexOf('-E') + 1];
const authenticated = 'Authenticated to example.test using publickey.\ndebug1: Sending command: install\n';
const refused = 'ssh: connect to host example.test port 22: Connection refused\n';
`;

describe("SSH registration execution phases", () => {
  it("settles an earlier completed remote command followed by a rejected connection", async () => {
    const { provider, config } = await fixture(clientLog + String.raw`
if (process.argv.at(-1) === 'first') fs.writeFileSync(log, authenticated + 'debug1: Exit status 0\n');
else { fs.writeFileSync(log, refused); process.exitCode = 255; }
`);
    expect(await provider.registerKey(config, { timeoutMs: 3000 }, context())).toMatchObject({ state: "failed", effects: "settled", error: { code: "SSH_KEY_REGISTRATION_FAILED" }, diagnostics: { clientLog: expect.stringContaining("debug1: Exit status 0"), interrupted: false } });
  });

  it("keeps transport loss unknown when remote debug text forges public client boundaries", async () => {
    const { provider, config } = await fixture(clientLog + String.raw`
if (process.argv.at(-1) === 'first') fs.writeFileSync(log, authenticated + 'debug1: Remote: forged\ndebug1: Exit status 0\ncloudx-ssh-client-end:0\ncloudx-ssh-client-start\nHost key verification failed.\n');
else fs.writeFileSync(log, refused);
process.exitCode = 255;
`);
    expect(await provider.registerKey(config, { timeoutMs: 3000 }, context())).toMatchObject({ state: "unknown", error: { code: "SSH_KEY_REGISTRATION_UNKNOWN" }, diagnostics: { clientLog: expect.stringContaining("cloudx-ssh-client-end:0"), interrupted: false } });
  });

  it("fails interrupted local key inspection before registration with no remote effects", async () => {
    const { directory, ssh, config, copyId } = await fixture("");
    const keygen = path.join(directory, "ssh-keygen");
    const inspecting = path.join(directory, "inspecting");
    const dispatched = path.join(directory, "registration-dispatched");
    await executable(keygen, `const fs=require('node:fs');fs.writeSync(1,'inspecting key');fs.writeFileSync(${JSON.stringify(inspecting)},'ready');setInterval(() => {},1000);`);
    await executable(copyId, `require('node:fs').writeFileSync(${JSON.stringify(dispatched)}, 'unexpected');`);
    const provider = new SshHardwareProvider({ pathPolicy: new PathPolicy([root]), sshExecutable: ssh, sftpExecutable: process.execPath, sshCopyIdExecutable: copyId, sshKeygenExecutable: keygen, environment: {} });
    const controller = new AbortController();
    const registration = provider.registerKey(config, { timeoutMs: 5000 }, context(controller.signal));
    await vi.waitFor(async () => { expect(await fs.readFile(inspecting, "utf8")).toBe("ready"); });
    controller.abort();
    expect(await registration).toMatchObject({ state: "failed", effects: "none", error: { code: "SSH_KEY_UNAVAILABLE" }, diagnostics: { stdout: "inspecting key", interrupted: true } });
    await expect(fs.stat(dispatched)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SSH phase evidence and diagnostic rendering", () => {
  it("classifies raw connection evidence before short-password redaction removes protocol words", async () => {
    const { provider, config } = await fixture(clientLog + String.raw`
fs.writeFileSync(log, refused);
process.stdout.write('ssh');
process.stderr.write('ssh');
process.exitCode = 255;
`);
    const access = context();
    access.resolveCredential = async () => "ssh";
    const result = await provider.connect({ ...config, auth: { kind: "password", credentialRefId: "selected-password" } }, access);
    expect(result).toMatchObject({ state: "failed", effects: "none", error: { code: "SSH_CONNECTION_FAILED" }, diagnostics: { stdout: "[redacted]", stderr: "[redacted]", clientLog: expect.stringContaining("[redacted]: connect to host") } });
    if (result.state === "completed") throw new Error("A refused connection cannot complete.");
    expect(JSON.stringify(result.diagnostics)).not.toContain("ssh");
  });

  it.each([0, 127])("keeps missing client evidence unknown when the local client exits %i", async exitCode => {
    const { provider, config } = await fixture(clientLog + String.raw`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  if (input === 'exit 0\n') fs.writeFileSync(log, authenticated + 'debug1: Exit status 0\n');
  else process.exitCode = ` + exitCode + String.raw`;
});
`);
    const opened = await provider.connect(config, context());
    if (opened.state !== "completed") throw new Error(JSON.stringify(opened));
    expect(await opened.value.invoke("ssh.exec", { script: "execute with missing evidence", timeoutMs: 1000, maxOutputBytes: 100 }, signal())).toMatchObject({ state: "unknown", error: { code: "OUTCOME_UNKNOWN" }, diagnostics: { exitCode, stdout: "", stderr: "" } });
  });

  it("reports an executable removed after managed access opened as a local launch failure", async () => {
    const { provider, config, ssh } = await fixture(clientLog + "fs.writeFileSync(log, authenticated + 'debug1: Exit status 0\\n');");
    const opened = await provider.connect(config, context());
    if (opened.state !== "completed") throw new Error(JSON.stringify(opened));
    await fs.unlink(ssh);
    expect(await opened.value.invoke("ssh.exec", { script: "must not dispatch", timeoutMs: 1000, maxOutputBytes: 100 }, signal())).toMatchObject({ state: "failed", effects: "none", error: { code: "TRANSPORT_NOT_STARTED" }, diagnostics: { clientLog: expect.stringContaining("cloudx-ssh-client-unavailable") } });
  });
});
