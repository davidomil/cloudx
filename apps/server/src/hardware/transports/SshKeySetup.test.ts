import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HardwareConnectionResult, JsonObject, ProviderOutcome, SshConfig } from "@cloudx/shared";
import { PathPolicy } from "../../pathPolicy.js";
import { SshHardwareProvider } from "./SshHardwareProvider.js";
import { transportTestContext } from "./TransportTestContext.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ssh-setup-"));
  roots.push(root);
  const provider = new SshHardwareProvider({ pathPolicy: new PathPolicy([root]), managedKeysDirectory: path.join(root, "keys"), environment: {} });
  const config: SshConfig = { host: "example.test", port: 22, username: "tester", auth: { kind: "password", credentialRefId: "old-password" }, connectTimeoutMs: 1000 };
  const context = { ...transportTestContext(), resolveCredential: vi.fn(async () => "one-time-password") };
  return { root, provider, config, context, input: { hardwareId: "machine", credentialRefId: "one-time-ref", timeoutMs: 3000 } };
}

describe("Password setup for managed SSH keys", () => {
  it("registers a dedicated key with the one-time credential and publishes settings only after key login and cleanup", async () => {
    const f = await fixture();
    const trace: string[] = [];
    const register = vi.spyOn(f.provider, "registerKey").mockImplementation(async (config, input, context) => {
      trace.push("register");
      expect(config.auth).toMatchObject({ kind: "identity_file" });
      expect(config).not.toHaveProperty("auth.credentialRefId");
      expect(input).toEqual({ timeoutMs: 3000, credentialRefId: "one-time-ref" });
      expect(await context.resolveCredential(input.credentialRefId as string)).toBe("one-time-password");
      context.registerCleanup(async () => { trace.push("registration closed"); return { state: "completed", value: null }; });
      return { state: "completed", value: { registered: true } };
    });
    const check = vi.spyOn(f.provider, "checkConnection").mockImplementation(async config => {
      trace.push("key login");
      expect(config.auth).toEqual(register.mock.calls[0]![0].auth);
      expect(config.auth.kind).toBe("identity_file");
      return { state: "completed", value: { online: true, diagnostics: { exitCode: 0 } } };
    });
    const result = await f.provider.setupKey(f.config, f.input, f.context);
    expect(result).toMatchObject({ state: "completed", value: { config: { ...f.config, auth: { kind: "identity_file", path: expect.stringContaining("/keys/") } }, connectionCheck: { online: true } } });
    expect(trace).toEqual(["register", "registration closed", "key login"]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/one-time-password|one-time-ref|old-password/);
    expect(f.context.resolveCredential).toHaveBeenCalledExactlyOnceWith("one-time-ref");
  });

  it.each(["known failure", "unknown effects"])("keeps the generated key and does not test or publish settings after registration has %s", async scenario => {
    const f = await fixture();
    let identity = "";
    vi.spyOn(f.provider, "registerKey").mockImplementation(async (config): Promise<ProviderOutcome<JsonObject>> => {
      identity = (config.auth as { path: string }).path;
      return scenario === "known failure" ? { state: "failed", effects: "none", error: { code: "SSH_AUTHENTICATION_FAILED", message: "Rejected" }, diagnostics: { clientLog: "Authentication failed" } } : { state: "unknown", error: { code: "SSH_KEY_REGISTRATION_UNKNOWN", message: "Disconnected" }, diagnostics: { interrupted: true } };
    });
    const check = vi.spyOn(f.provider, "checkConnection");
    const result = await f.provider.setupKey(f.config, f.input, f.context);
    expect(result).toMatchObject(scenario === "known failure" ? { state: "failed", error: { code: "SSH_AUTHENTICATION_FAILED" }, diagnostics: { clientLog: "Authentication failed" } } : { state: "unknown", diagnostics: { interrupted: true } });
    expect(result).not.toHaveProperty("value.config");
    expect(check).not.toHaveBeenCalled();
    expect((await fs.stat(identity)).isFile()).toBe(true);
  });

  it.each(["login rejected", "cleanup unknown"])("does not publish new settings when the post-registration check has %s", async scenario => {
    const f = await fixture();
    const register = vi.spyOn(f.provider, "registerKey").mockResolvedValue({ state: "completed", value: { registered: true } });
    const check: ProviderOutcome<HardwareConnectionResult> = scenario === "login rejected"
      ? { state: "completed", value: { online: false, error: { code: "SSH_AUTH_FAILED", message: "Key rejected" }, diagnostics: { exitCode: 255, stderr: "Permission denied" } } }
      : { state: "unknown", error: { code: "SSH_CHECK_CLEANUP_UNKNOWN", message: "Process exit unconfirmed" }, diagnostics: { interrupted: true } };
    vi.spyOn(f.provider, "checkConnection").mockResolvedValue(check);
    const result = await f.provider.setupKey(f.config, f.input, f.context);
    expect(result).toMatchObject(scenario === "login rejected" ? { state: "failed", effects: "settled", error: { code: "SSH_KEY_VERIFICATION_FAILED" }, diagnostics: { exitCode: 255, stderr: "Permission denied" } } : { state: "unknown", diagnostics: { interrupted: true } });
    expect(result).not.toHaveProperty("value.config");
    const identity = (register.mock.calls[0]![0].auth as { path: string }).path;
    expect((await fs.stat(identity)).isFile()).toBe(true);
  });

  it("keeps setup unknown when a registered cleanup cannot confirm process exit", async () => {
    const f = await fixture();
    vi.spyOn(f.provider, "registerKey").mockImplementation(async (_config, _input, context) => {
      context.registerCleanup(async () => ({ state: "unknown", error: { code: "CLEANUP_UNKNOWN", message: "Still running" } }));
      return { state: "completed", value: { registered: true } };
    });
    const check = vi.spyOn(f.provider, "checkConnection").mockResolvedValue({ state: "completed", value: { online: true } });
    expect(await f.provider.setupKey(f.config, f.input, f.context)).toMatchObject({ state: "unknown", error: { code: "SSH_KEY_SETUP_CLEANUP_UNKNOWN" } });
    expect(check).not.toHaveBeenCalled();
  });

  it("rejects plaintext or incomplete input before generating or registering any key", async () => {
    const f = await fixture();
    const register = vi.spyOn(f.provider, "registerKey");
    for (const input of [{ ...f.input, password: "plaintext" }, { hardwareId: "machine", timeoutMs: 1000 }, { ...f.input, hardwareId: "" }, { ...f.input, timeoutMs: 0 }]) {
      expect(await f.provider.setupKey(f.config, input as JsonObject, f.context)).toMatchObject({ state: "failed", effects: "none", error: { code: "INVALID_INPUT" } });
    }
    expect(register).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(f.root, "keys"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SSH key setup through bounded native processes", () => {
  it("keeps a first-use SSH directory traversable when ssh-copy-id masks owner execution", async () => {
    const f = await fixture();
    const ssh = path.join(f.root, "ssh-client");
    const copyId = path.join(f.root, "ssh-copy-id");
    const accountDirectory = path.join(f.root, "account-ssh");
    await fs.writeFile(copyId, "#!/bin/sh\numask 0177\nssh -- example.test install\n", { mode: 0o700 });
    await fs.writeFile(ssh, `#!${process.execPath}\nconst fs=require('node:fs');fs.mkdirSync(${JSON.stringify(accountDirectory)},{mode:0o700});fs.writeFileSync(process.argv[process.argv.indexOf('-E')+1],'Authenticated to example.test using password.\\ndebug1: Sending command: install\\ndebug1: Exit status 0\\n');\n`, { mode: 0o700 });
    const provider = new SshHardwareProvider({ pathPolicy: new PathPolicy([f.root]), managedKeysDirectory: path.join(f.root, "keys"), sshExecutable: ssh, sshCopyIdExecutable: copyId, environment: {} });
    vi.spyOn(provider, "checkConnection").mockResolvedValue({ state: "completed", value: { online: true } });
    expect(await provider.setupKey(f.config, f.input, f.context)).toMatchObject({ state: "completed" });
    expect((await fs.stat(accountDirectory)).mode & 0o777).toBe(0o700);
  });

  it.each(["success", "authentication rejected", "connection lost", "key rejected"])("keeps password setup and key-only verification separate when %s", async scenario => {
    const f = await fixture();
    const ssh = path.join(f.root, "ssh-client");
    const copyId = path.join(f.root, "ssh-copy-id");
    const capture = path.join(f.root, "registration.json");
    const selected = path.join(f.root, "selected-key");
    const installed = path.join(f.root, "installed-key");
    const probe = path.join(f.root, "probe.json");
    await fs.writeFile(copyId, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
const {execFileSync,spawnSync}=require('node:child_process');
const password=execFileSync(process.env.SSH_ASKPASS,["tester@example.test's password: "],{env:process.env}).toString().trim();
if(password!=='one-time-password') throw new Error('Unexpected test password');
const publicFile=process.argv[process.argv.indexOf('-i')+1];
fs.writeFileSync(SELECTED,publicFile);
fs.writeFileSync(CAPTURE,JSON.stringify({argv:process.argv.slice(2),environment:process.env}));
const result=spawnSync('ssh',['--','example.test','install'],{env:process.env,encoding:'utf8',stdio:['ignore','pipe','pipe','ignore',4]});
process.stdout.write(password);
process.stdout.write(result.stdout??'');
process.stderr.write(result.stderr??'');
process.exitCode=result.status??1;
`.replaceAll("SELECTED", JSON.stringify(selected)).replaceAll("CAPTURE", JSON.stringify(capture)), { mode: 0o700 });
    await fs.writeFile(ssh, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
const args=process.argv.slice(2);
const scenario=SCENARIO;
const log=args[args.indexOf('-E')+1];
if(args.includes('-E')) {
  if(scenario==='authentication rejected') { fs.writeFileSync(log,'tester@example.test: Permission denied (publickey,password).\n'); process.exitCode=255; }
  else {
    fs.writeFileSync(INSTALLED,fs.readFileSync(fs.readFileSync(SELECTED,'utf8')));
    fs.writeFileSync(log,'Authenticated to example.test using password.\ndebug1: Sending command: install\n'+(scenario==='connection lost'?'':'debug1: Exit status 0\n'));
    process.exitCode=scenario==='connection lost'?255:0;
  }
} else {
  fs.writeFileSync(PROBE,JSON.stringify({argv:args,environment:process.env}));
  const identity=args.find(value=>value.startsWith('IdentityFile=')).slice('IdentityFile='.length).replace(/^"|"$/g,'');
  if(!fs.readFileSync(INSTALLED).equals(fs.readFileSync(identity+'.pub'))) throw new Error('The login key differs from the installed key');
  if(scenario==='key rejected') { process.stderr.write('tester@example.test: Permission denied (publickey).'); process.exitCode=255; }
}
`.replaceAll("SCENARIO", JSON.stringify(scenario)).replaceAll("INSTALLED", JSON.stringify(installed)).replaceAll("SELECTED", JSON.stringify(selected)).replaceAll("PROBE", JSON.stringify(probe)), { mode: 0o700 });
    const provider = new SshHardwareProvider({ pathPolicy: new PathPolicy([f.root]), managedKeysDirectory: path.join(f.root, "keys"), sshExecutable: ssh, sshCopyIdExecutable: copyId, environment: {} });
    const result = await provider.setupKey(f.config, f.input, f.context);
    const registration = JSON.parse(await fs.readFile(capture, "utf8"));
    expect(registration.argv).toEqual(expect.arrayContaining(["PreferredAuthentications=password", "-i"]));
    expect(registration.environment).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(JSON.stringify(registration)).not.toContain("one-time-password");
    for (const file of [registration.environment.SSH_ASKPASS, registration.environment.CLOUDX_SSH_ASKPASS_SOCKET, registration.environment.HOME]) await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const publicFile = await fs.readFile(selected, "utf8");
    expect((await fs.stat(publicFile.slice(0, -4))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain("one-time-password");
    expect(f.context.resolveCredential).toHaveBeenCalledExactlyOnceWith("one-time-ref");
    if (scenario === "authentication rejected" || scenario === "connection lost") {
      expect(result).toMatchObject(scenario === "authentication rejected" ? { state: "failed", effects: "none", error: { code: "SSH_AUTHENTICATION_FAILED" }, diagnostics: { stdout: "[redacted]" } } : { state: "unknown", error: { code: "SSH_KEY_REGISTRATION_UNKNOWN" }, diagnostics: { stdout: "[redacted]" } });
      await expect(fs.stat(probe)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(result).toMatchObject(scenario === "success" ? { state: "completed", value: { config: { auth: { kind: "identity_file", path: publicFile.slice(0, -4) } }, connectionCheck: { online: true } } } : { state: "failed", effects: "settled", error: { code: "SSH_KEY_VERIFICATION_FAILED" }, diagnostics: { exitCode: 255 } });
      const checked = JSON.parse(await fs.readFile(probe, "utf8"));
      expect(checked.argv).toEqual(expect.arrayContaining(["IdentityAgent=none", "IdentitiesOnly=yes", "PasswordAuthentication=no", "PreferredAuthentications=publickey"]));
      expect(checked.environment).not.toHaveProperty("SSH_ASKPASS");
      expect(checked.environment).not.toHaveProperty("SSH_AUTH_SOCK");
    }
    for (const cleanup of f.context.cleanups) expect(await cleanup(new AbortController().signal)).toEqual({ state: "completed", value: null });
  });
});
