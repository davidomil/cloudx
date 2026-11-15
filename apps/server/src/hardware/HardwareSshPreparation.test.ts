import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HardwareMutationResult, JsonObject, OperationReceipt, SshConfig } from "@cloudx/shared";
import { HardwareService } from "./HardwareService.js";
import { SshHardwareProvider } from "./transports/SshHardwareProvider.js";
import { PathPolicy } from "../pathPolicy.js";

const exec = promisify(execFile);
const owner = { kind: "user" as const, userId: "local" };
const roots: string[] = [];
const services: HardwareService[] = [];
let sequence = 0;
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map(service => service.dispose()));
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-ssh-preparation-"));
  roots.push(root);
  const dispatch = path.join(root, "remote-dispatch");
  const ssh = path.join(root, "ssh");
  const copyId = path.join(root, "ssh-copy-id");
  const sftp = path.join(root, "sftp");
  const identity = path.join(root, "identity");
  await exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
  await fs.writeFile(ssh, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(dispatch)},'ssh\\n');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(process.argv[process.argv.indexOf('-E')+1],'Authenticated to example.test using publickey.\\ndebug1: Exit status 0\\n');if(input!=='exit 0\\n')process.stdout.write('executed');});\n`, { mode: 0o700 });
  await fs.writeFile(copyId, `#!/bin/bash\nprintf 'copy-id\\n' >> '${dispatch}'\nssh example.test true\n`, { mode: 0o700 });
  await fs.writeFile(sftp, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(dispatch)},'sftp\\n');\n`, { mode: 0o700 });
  const config: SshConfig = { host: "example.test", port: 22, username: "tester", auth: { kind: "identity_file", path: identity }, connectTimeoutMs: 1000 };
  const provider = new SshHardwareProvider({ pathPolicy: new PathPolicy([root]), sshExecutable: ssh, sftpExecutable: sftp, sshCopyIdExecutable: copyId, environment: {} });
  const service = new HardwareService({ dataDir: path.join(root, "state"), pathPolicy: new PathPolicy([root]), registry: { values: () => [provider], get: () => provider } });
  services.push(service);
  await service.init();
  const mutate = (action: string, input: JsonObject) => service.execute(action, { requestId: `preparation-${++sequence}`, ...input }, owner) as Promise<HardwareMutationResult>;
  const receipt = (result: HardwareMutationResult) => vi.waitFor(async () => {
    const saved = await service.execute("hardware.receipt.get", { requestId: result.receipt.requestId }, owner) as { receipt: OperationReceipt };
    expect(saved.receipt.state).not.toBe("running");
    return saved.receipt;
  }, { timeout: 4000 });
  await mutate("hardware.groups.create", { name: "Controlled SSH target" });
  const group = (await service.snapshot(owner)).groups[0];
  await mutate("hardware.items.create", { item: { name: "SSH target", description: "", enabled: true, physicalResourceId: group.id, typeId: "hardware.ssh", configVersion: 1, config: JSON.parse(JSON.stringify(config)), tagIds: [], notes: "", statuses: [], hooks: {} } });
  const item = (await service.snapshot(owner)).items[0].item;
  const claim = (await mutate("hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Check local SSH preparation" })).reservation!;
  const ref = { reservationId: claim.reservationId, generation: claim.generation };
  const recordedDispatch = () => fs.readFile(dispatch, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  return { root, service, mutate, receipt, ref, recordedDispatch };
}

describe.each(["directory", "wrapper", "wrapper cleanup"])("local SSH %s preparation failure", stage => {
  it.each(["connect", "ssh.exec", "ssh.upload", "ssh.download", "registration"])("keeps %s usable without remote dispatch", async operation => {
    const f = await fixture();
    if (["ssh.exec", "ssh.upload", "ssh.download"].includes(operation)) expect((await f.receipt(await f.mutate("hardware.access.open", f.ref))).state).toBe("succeeded");
    const before = await f.recordedDispatch();
    const localPath = path.join(f.root, "payload");
    await fs.writeFile(localPath, "payload");
    const created: string[] = [];
    const mkdtemp = fs.mkdtemp.bind(fs);
    const writeFile = fs.writeFile.bind(fs);
    const rm = fs.rm.bind(fs);
    const localError = () => Object.assign(new Error("ENOSPC with private fixture details"), { code: "ENOSPC" });
    vi.spyOn(fs, "mkdtemp").mockImplementation(async prefix => {
      if (!String(prefix).includes("cloudx-ssh-client-")) return mkdtemp(prefix);
      if (stage === "directory") throw localError();
      const directory = await mkdtemp(prefix);
      created.push(directory);
      roots.push(directory);
      return directory;
    });
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (stage !== "directory" && created.includes(path.dirname(String(args[0])))) throw localError();
      return writeFile(...args);
    });
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (stage === "wrapper cleanup" && created.includes(String(args[0]))) throw localError();
      return rm(...args);
    });
    const result = operation === "connect" ? await f.mutate("hardware.access.open", f.ref)
      : operation === "registration" ? await f.mutate("hardware.ssh.registerKey", { ...f.ref, timeoutMs: 3000 })
      : await f.mutate("hardware.access.invoke", { ...f.ref, operationId: operation, input: operation === "ssh.exec" ? { script: "printf should-not-run", timeoutMs: 3000, maxOutputBytes: 100 } : { localPath, remotePath: "/remote/payload", timeoutMs: 3000, overwrite: true } });
    const saved = await f.receipt(result);
    expect(saved).toMatchObject({ state: "failed", error: { code: "SSH_CLIENT_PREPARATION_FAILED", message: expect.stringContaining("before remote command dispatch") } });
    expect(JSON.stringify(saved)).not.toContain("private fixture details");
    expect(await f.recordedDispatch()).toBe(before);
    for (const directory of created) {
      if (stage === "wrapper cleanup") {
        expect(saved.error?.message).toContain("Temporary client files require local cleanup");
        expect((await fs.stat(directory)).isDirectory()).toBe(true);
      } else await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(f.service.ownerClaims()[0]).toMatchObject({ state: "active", generation: f.ref.generation });
    vi.restoreAllMocks();
    expect((await f.receipt(await f.mutate("hardware.access.open", f.ref))).state).toBe("succeeded");
    expect(await f.receipt(await f.mutate("hardware.access.invoke", { ...f.ref, operationId: "ssh.exec", input: { script: "printf executed", timeoutMs: 3000, maxOutputBytes: 100 } }))).toMatchObject({ state: "succeeded", result: { stdout: "executed", exitCode: 0 } });
    expect((await f.receipt(await f.mutate("hardware.access.close", f.ref))).state).toBe("succeeded");
    expect(f.service.ownerClaims()[0]).toMatchObject({ state: "active", accessState: "closed" });
  });
});
