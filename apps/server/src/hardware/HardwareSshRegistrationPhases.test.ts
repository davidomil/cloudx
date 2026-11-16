import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HardwareMutationResult, HardwareOwner, OperationReceipt, SshConfig } from "@cloudx/shared";
import { PathPolicy } from "../pathPolicy.js";
import { HardwareService } from "./HardwareService.js";
import { BoundedProcessSet } from "./transports/BoundedProcess.js";
import { SshHardwareProvider } from "./transports/SshHardwareProvider.js";

const exec = promisify(execFile);
const user: HardwareOwner = { kind: "user", userId: "local" };
const services: HardwareService[] = [];
let root: string;
let identity: string;
let sequence = 0;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-managed-ssh-phases-"));
  identity = path.join(root, "identity");
  await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
});
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.dispose()));
  vi.restoreAllMocks();
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function executable(file: string, source: string) {
  await fs.writeFile(file, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
}

const mutate = (service: HardwareService, action: string, input: Record<string, unknown>) => service.execute(action, { requestId: `ssh-phase-${++sequence}`, ...input }, user) as Promise<HardwareMutationResult>;

async function receipt(service: HardwareService, admitted: HardwareMutationResult) {
  return vi.waitFor(async () => {
    const result = await service.execute("hardware.receipt.get", { requestId: admitted.receipt.requestId }, user) as { receipt: OperationReceipt };
    expect(result.receipt.state).not.toBe("running");
    return result.receipt;
  }, { timeout: 8000, interval: 20 });
}

async function fixture(phase: "key inspection" | "registration") {
  const directory = await fs.mkdtemp(path.join(root, "case-"));
  const keygen = path.join(directory, "ssh-keygen");
  const ssh = path.join(directory, "ssh-client");
  const copyId = path.join(directory, "ssh-copy-id");
  const hosts = path.join(directory, "known-hosts");
  const inspecting = path.join(directory, "inspecting-key");
  const dispatched = path.join(directory, "registration-dispatched");
  const remoteStarted = path.join(directory, "remote-command-started");
  await fs.writeFile(hosts, "");
  // The ready file acknowledges a synchronous write to the captured pipe.
  await executable(keygen, `const fs=require('node:fs');fs.writeSync(1,'inspecting key');fs.writeFileSync(${JSON.stringify(inspecting)},String(process.pid));setInterval(()=>{},1000);`);
  await executable(ssh, `const fs=require('node:fs');const log=process.argv[process.argv.indexOf('-E')+1];fs.writeFileSync(log,'Authenticated to example.test using publickey.\\ndebug1: Sending command: install\\n');` + (phase === "registration"
    ? `fs.writeFileSync(${JSON.stringify(remoteStarted)},String(process.pid));setInterval(()=>{},1000);`
    : "fs.appendFileSync(log,'debug1: Exit status 0\\n');process.stdout.write('usable');"));
  await executable(copyId, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(dispatched)},'started');const result=require('node:child_process').spawnSync('ssh',['install'],{stdio:[0,1,2,'ignore',4],env:process.env});process.exitCode=result.status??255;`);
  const config: SshConfig = { host: "example.test", port: 22, username: "tester", auth: { kind: "identity_file", path: identity }, knownHostsFile: hosts, connectTimeoutMs: 1000 };
  const pathPolicy = new PathPolicy([root]);
  const provider = new SshHardwareProvider({ pathPolicy, sshExecutable: ssh, sftpExecutable: process.execPath, sshCopyIdExecutable: copyId, sshKeygenExecutable: phase === "key inspection" ? keygen : "/usr/bin/ssh-keygen", environment: {} });
  const registry = { values: () => [provider], get: () => provider };
  const service = new HardwareService({ dataDir: directory, registry, pathPolicy, ownerState: () => "active" });
  services.push(service);
  await service.init();
  await mutate(service, "hardware.groups.create", { name: "SSH phase fixture" });
  const group = (await service.snapshot(user)).groups[0];
  await mutate(service, "hardware.items.create", { item: { name: "Controlled SSH", description: "", enabled: true, physicalResourceId: group.id, typeId: "hardware.ssh", configVersion: 1, config: JSON.parse(JSON.stringify(config)), tagIds: [], notes: "", statuses: [], hooks: {} } });
  const item = (await service.snapshot(user)).items[0].item;
  const reservation = (await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Verify registration execution phases" })).reservation!;
  const ref = { reservationId: reservation.reservationId, generation: reservation.generation };
  return { service, ref, inspecting, dispatched, remoteStarted };
}

describe("managed SSH key-registration deadlines", () => {
  it("retains a no-effects key-inspection failure and diagnostics when the registration deadline expires", async () => {
    const f = await fixture("key inspection");
    const admitted = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1500 });
    await vi.waitFor(async () => { expect(Number(await fs.readFile(f.inspecting, "utf8"))).toBeGreaterThan(0); }, { timeout: 1500 });
    expect(await receipt(f.service, admitted)).toMatchObject({ state: "failed", error: { code: "SSH_KEY_UNAVAILABLE" }, result: { diagnostics: { stdout: "inspecting key", interrupted: true, state: "exited" } } });
    await expect(fs.stat(f.dispatched)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.service.ownerClaims()[0]).toMatchObject({ ...f.ref, state: "active", accessState: "closed" });
    expect((await receipt(f.service, await mutate(f.service, "hardware.access.open", f.ref))).state).toBe("succeeded");
    expect(await receipt(f.service, await mutate(f.service, "hardware.access.invoke", { ...f.ref, operationId: "ssh.exec", input: { script: "printf usable", timeoutMs: 1000, maxOutputBytes: 100 } }))).toMatchObject({ state: "succeeded", result: { exitCode: 0, stdout: "usable" } });
  });

  it("keeps the reservation held if local inspection ends but managed cleanup is unconfirmed", async () => {
    const f = await fixture("key inspection");
    const close = BoundedProcessSet.prototype.close;
    vi.spyOn(BoundedProcessSet.prototype, "close").mockImplementation(async function(this: BoundedProcessSet, signal: AbortSignal) {
      await close.call(this, signal);
      return { state: "unknown", error: { code: "CLEANUP_UNKNOWN", message: "Controlled cleanup confirmation failure." } };
    });
    const admitted = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1500 });
    await vi.waitFor(async () => { expect(Number(await fs.readFile(f.inspecting, "utf8"))).toBeGreaterThan(0); }, { timeout: 1500 });
    expect(await receipt(f.service, admitted)).toMatchObject({ state: "unknown", error: { code: "CLEANUP_UNCONFIRMED" } });
    await expect(fs.stat(f.dispatched)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.service.ownerClaims()[0]).toMatchObject({ ...f.ref, state: "recovery_required", accessState: "unknown" });
  });

  it("retains unknown remote effects after registration dispatch even when local cleanup completes", async () => {
    const f = await fixture("registration");
    const admitted = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1500 });
    await vi.waitFor(async () => { expect(Number(await fs.readFile(f.remoteStarted, "utf8"))).toBeGreaterThan(0); }, { timeout: 1500 });
    expect(await receipt(f.service, admitted)).toMatchObject({ state: "unknown", error: { code: "OUTCOME_UNKNOWN" }, result: { diagnostics: { clientLog: expect.stringContaining("Authenticated to example.test"), interrupted: true } } });
    expect(await fs.readFile(f.dispatched, "utf8")).toBe("started");
    expect(f.service.ownerClaims()[0]).toMatchObject({ ...f.ref, state: "recovery_required", accessState: "closed" });
  });
});
