import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PathPolicy } from "../../pathPolicy.js";
import { ManagedSshKeyStore } from "./ManagedSshKeyStore.js";
import { transportTestContext } from "./TransportTestContext.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-managed-ssh-"));
  roots.push(root);
  const directory = path.join(root, "keys");
  const context = transportTestContext();
  const store = new ManagedSshKeyStore({ directory, pathPolicy: new PathPolicy([root]) });
  const machineDirectory = path.join(directory, createHash("sha256").update("machine").digest("hex"));
  return { root, directory, context, store, machineDirectory };
}

describe("Managed SSH identities", () => {
  it("creates one private Ed25519 pair per machine and reuses it without replacing bytes", async () => {
    const f = await fixture();
    const first = await f.store.getOrCreate("machine", f.context, 3000);
    expect(first).toMatchObject({ state: "completed", value: { path: path.join(f.machineDirectory, "id_ed25519") } });
    if (first.state !== "completed") throw new Error(JSON.stringify(first));
    const privateBytes = await fs.readFile(first.value.path);
    const publicBytes = await fs.readFile(`${first.value.path}.pub`, "utf8");
    expect(publicBytes).toMatch(/^ssh-ed25519 /);
    for (const directory of [f.directory, f.machineDirectory]) expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(first.value.path)).mode & 0o777).toBe(0o600);
    expect(await f.store.getOrCreate("machine", f.context, 3000)).toEqual(first);
    expect(await fs.readFile(first.value.path)).toEqual(privateBytes);
    expect(await fs.readFile(`${first.value.path}.pub`, "utf8")).toBe(publicBytes);
    const other = await f.store.getOrCreate("other-machine", f.context, 3000);
    if (other.state !== "completed") throw new Error(JSON.stringify(other));
    expect(other.value.path).not.toBe(first.value.path);
    expect(await fs.readFile(`${other.value.path}.pub`, "utf8")).not.toBe(publicBytes);
    for (const cleanup of f.context.cleanups) expect(await cleanup(new AbortController().signal)).toEqual({ state: "completed", value: null });
  });

  it("requires an explicitly configured managed root admitted by the path policy", async () => {
    const f = await fixture();
    const missing = new ManagedSshKeyStore({ pathPolicy: new PathPolicy([f.root]) });
    expect(await missing.getOrCreate("machine", f.context, 1000)).toMatchObject({ state: "failed", error: { code: "SSH_KEY_STORE_UNAVAILABLE" } });
    const rejected = new ManagedSshKeyStore({ directory: f.directory, pathPolicy: new PathPolicy([path.join(f.root, "admitted")]) });
    expect(await rejected.getOrCreate("machine", f.context, 1000)).toMatchObject({ state: "failed", effects: "none", error: { code: "SSH_KEY_STORE_UNAVAILABLE" } });
    await expect(fs.stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not start another key generator when an identity is already being created", async () => {
    const f = await fixture();
    const executable = path.join(f.root, "keygen");
    const started = path.join(f.root, "started"), release = path.join(f.root, "release");
    await fs.writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'ready');const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);const result=require('node:child_process').spawnSync('/usr/bin/ssh-keygen',process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);},10);\n`, { mode: 0o700 });
    const store = new ManagedSshKeyStore({ directory: f.directory, pathPolicy: new PathPolicy([f.root]), sshKeygenExecutable: executable });
    const creating = store.getOrCreate("machine", f.context, 3000);
    try {
      await vi.waitFor(async () => expect(await fs.readFile(started, "utf8")).toBe("ready"));
      expect(await store.getOrCreate("machine", f.context, 1000)).toMatchObject({ state: "failed", effects: "none", error: { code: "SSH_KEY_STORE_UNAVAILABLE" } });
    } finally { await fs.writeFile(release, "continue"); }
    expect(await creating).toMatchObject({ state: "completed" });
    expect(await fs.readdir(f.machineDirectory)).toEqual(["id_ed25519", "id_ed25519.pub"]);
  });

  it("rejects a managed-root symlink before creating files outside allowed roots", async () => {
    const f = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-managed-ssh-outside-"));
    roots.push(outside);
    await fs.symlink(outside, f.directory);
    expect(await f.store.getOrCreate("machine", f.context, 1000)).toMatchObject({ state: "failed", effects: "none", error: { code: "SSH_KEY_STORE_UNAVAILABLE" } });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each(["incomplete", "symlink", "permissions", "hardlink"])("preserves an unsafe %s identity and fails instead of overwriting it", async scenario => {
    const f = await fixture();
    await fs.mkdir(f.machineDirectory, { recursive: true, mode: 0o700 });
    const identity = path.join(f.machineDirectory, "id_ed25519");
    const original = path.join(f.root, "original");
    await fs.writeFile(original, "must survive", { mode: 0o600 });
    if (scenario === "symlink") await fs.symlink(original, identity);
    else if (scenario === "hardlink") await fs.link(original, identity);
    else await fs.writeFile(identity, "must survive", { mode: scenario === "permissions" ? 0o644 : 0o600 });
    if (scenario !== "incomplete") await fs.writeFile(`${identity}.pub`, "ssh-ed25519 fixture\n");
    expect(await f.store.getOrCreate("machine", f.context, 1000)).toMatchObject({ state: "failed", effects: "none", error: { code: "SSH_KEY_STORE_UNAVAILABLE" } });
    expect(await fs.readFile(identity, "utf8")).toBe("must survive");
    expect(await fs.readFile(original, "utf8")).toBe("must survive");
  });

  it("bounds interrupted key generation and keeps its partial files for explicit recovery", async () => {
    const f = await fixture();
    const executable = path.join(f.root, "keygen");
    const started = path.join(f.root, "started");
    await fs.writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const key=process.argv[process.argv.indexOf('-f')+1];fs.writeFileSync(key,'partial',{mode:0o600});fs.writeFileSync(${JSON.stringify(started)},String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o700 });
    const store = new ManagedSshKeyStore({ directory: f.directory, pathPolicy: new PathPolicy([f.root]), sshKeygenExecutable: executable });
    const controller = new AbortController();
    const context = transportTestContext(controller.signal);
    const creating = store.getOrCreate("machine", context, 3000);
    await vi.waitFor(async () => expect(await fs.readFile(started, "utf8")).toMatch(/^\d+$/));
    controller.abort();
    expect(await creating).toMatchObject({ state: "failed", effects: "none", error: { code: "SSH_KEY_PREPARATION_FAILED" }, diagnostics: { interrupted: true } });
    expect(await fs.readFile(path.join(f.machineDirectory, "id_ed25519"), "utf8")).toBe("partial");
    const pid = Number(await fs.readFile(started, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    for (const cleanup of context.cleanups) expect(await cleanup(new AbortController().signal)).toEqual({ state: "completed", value: null });
  });

  it("does not generate an identity after the caller has cancelled", async () => {
    const f = await fixture();
    expect(await f.store.getOrCreate("machine", transportTestContext(AbortSignal.abort()), 1000)).toMatchObject({ state: "failed", effects: "none", error: { code: "CANCELLED" } });
    await expect(fs.stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
