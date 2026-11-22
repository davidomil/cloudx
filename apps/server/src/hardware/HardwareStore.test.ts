import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyHardwareState, HardwareStore, validateHardwareState } from "./HardwareStore.js";
import { HardwareWriterLease } from "./HardwareWriterLease.js";

const roots: string[] = [], stores: HardwareStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.dispose(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-store-")); roots.push(root); const store = new HardwareStore(root); stores.push(store); await store.init(); return { root, store }; }

describe("durable Hardware authority", () => {
  it("accepts an explicit SSH connection hold without custom status bindings and rejects ambiguous holds", () => {
    const state = emptyHardwareState();
    state.nextGeneration = 2;
    state.groups.push({ id: "lab", revision: 1, name: "Lab" });
    state.items.push({ id: "ssh", revision: 1, name: "SSH", description: "", enabled: true, physicalResourceId: "lab", typeId: "hardware.ssh", configVersion: 1, config: {}, tagIds: [], notes: "", notesRevision: 1, statuses: [], hooks: {} });
    state.checkHolds.push({ kind: "system_check", runId: "connection-check", generation: 1, revision: 1, hardwareId: "ssh", resourceKeys: ["physical:lab"], state: "checking", bindingRevisions: [], connectionCheck: { itemRevision: 1 }, startedAt: new Date().toISOString() });
    expect(validateHardwareState(state)).toEqual(state);
    const uncertain = structuredClone(state); uncertain.checkHolds[0].state = "recovery_required"; uncertain.checkHolds[0].connectionCheck!.diagnostics = { exitCode: null, stderr: "[redacted]" };
    expect(validateHardwareState(uncertain)).toEqual(uncertain);
    const missingPurpose = structuredClone(state); delete missingPurpose.checkHolds[0].connectionCheck;
    expect(() => validateHardwareState(missingPurpose)).toThrow();
    const invalidRevision = structuredClone(state); invalidRevision.checkHolds[0].connectionCheck!.itemRevision = 0;
    expect(() => validateHardwareState(invalidRevision)).toThrow();
    const mixedPurpose = structuredClone(state); mixedPurpose.checkHolds[0].bindingRevisions.push({ definitionId: "ready", revision: 1 });
    expect(() => validateHardwareState(mixedPurpose)).toThrow();
    const wrongProvider = structuredClone(state); wrongProvider.items[0].typeId = "hardware.uart";
    expect(() => validateHardwareState(wrongProvider)).toThrow();
    for (const value of [null, false, 0, "", { itemRevision: 1, extra: true }, { itemRevision: 1, diagnostics: "invalid" }, { itemRevision: 1, diagnostics: { stdout: "x".repeat(64 * 1024) } }]) {
      const malformed = structuredClone(state);
      (malformed.checkHolds[0] as unknown as Record<string, unknown>).connectionCheck = value;
      expect(() => validateHardwareState(malformed)).toThrow();
    }
  });

  it("holds one process writer and permits reacquisition only after release", async () => {
    const { root, store } = await fixture();
    const contender = new HardwareStore(root); stores.push(contender);
    await expect(contender.init()).rejects.toMatchObject({ code: "WRITER_LOST" });
    await store.dispose();
    await expect(contender.init()).resolves.toEqual(emptyHardwareState());
  });

  it("atomically restores a private snapshot and leaves no temporary authority", async () => {
    const { root, store } = await fixture();
    const state = emptyHardwareState(); state.revision = 17; state.groups.push({ id: "group-lab", revision: 1, name: "Lab" });
    await store.write(state);
    expect(await store.read()).toEqual(state);
    expect((await fs.stat(path.join(root, "hardware/state.json"))).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.join(root, "hardware"))).sort()).toEqual([".writer-lock", "state.json"]);
    await store.dispose();
    const restored = new HardwareStore(root); stores.push(restored);
    expect(await restored.init()).toEqual(state);
  });

  it("preserves the prior snapshot if replacement fails and reports the failure", async () => {
    const { root, store } = await fixture();
    const before = emptyHardwareState(); before.revision = 1; await store.write(before);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("Injected replacement failure"));
    await expect(store.write({ ...before, revision: 2 })).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", details: { authorityReplaced: false } });
    expect(JSON.parse(await fs.readFile(path.join(root, "hardware/state.json"), "utf8"))).toEqual(before);
    expect((await fs.readdir(path.join(root, "hardware"))).some(name => name.endsWith(".tmp"))).toBe(false);
  });

  it("reports an uncertain durability boundary when directory sync fails after rename", async () => {
    const { store } = await fixture();
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await original(...args);
      if (typeof args[0] === "string" && args[0].endsWith("/hardware")) vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("Injected directory durability failure"));
      return file;
    });
    const state = emptyHardwareState(); state.revision = 2;
    await expect(store.write(state)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", details: { authorityReplaced: true } });
    expect(await store.read()).toEqual(state);
  });

  it.each([
    ["directory_open", "EACCES"],
    ["temporary_open", "ENOSPC"],
    ["temporary_write", "ENOSPC"],
    ["temporary_sync", "EIO"],
    ["temporary_close", "EIO"],
    ["state_rename", "ENOSPC"],
    ["directory_sync", "EIO"],
    ["directory_close", "EIO"]
  ])("reports %s failures without exposing source paths or messages", async (phase, errno) => {
    const { root, store } = await fixture();
    const before = emptyHardwareState(); before.revision = 1; await store.write(before);
    const failure = Object.assign(new Error(`secret diagnostic ${root}/state.json`), { code: errno, path: root });
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const directory = typeof args[0] === "string" && args[0].endsWith("/hardware");
      const temporary = typeof args[0] === "string" && args[0].endsWith(".tmp");
      if ((phase === "directory_open" && directory) || (phase === "temporary_open" && temporary)) throw failure;
      const file = await original(...args);
      if ((phase === "temporary_write" && temporary)) vi.spyOn(file, "writeFile").mockRejectedValueOnce(failure);
      if ((phase === "temporary_sync" && temporary) || (phase === "directory_sync" && directory)) vi.spyOn(file, "sync").mockRejectedValueOnce(failure);
      if ((phase === "temporary_close" && temporary) || (phase === "directory_close" && directory)) {
        const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementationOnce(async () => { await close(); throw failure; });
      }
      return file;
    });
    if (phase === "state_rename") vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
    const afterRename = phase === "directory_sync" || phase === "directory_close";
    const error = await store.write({ ...before, revision: 2 }).catch(error => error);
    expect(error).toMatchObject({ code: "STORE_UNAVAILABLE", details: { errno, phase, durability: phase === "directory_close" ? "confirmed" : afterRename ? "unconfirmed" : "unchanged", authorityReplaced: afterRename } });
    expect(JSON.stringify(error)).not.toContain(root);
    expect(error.message).not.toContain("secret diagnostic");
    expect(JSON.parse(await fs.readFile(path.join(root, "hardware/state.json"), "utf8"))).toEqual({ ...before, revision: afterRename ? 2 : 1 });
  });

  it("keeps the original write failure when file close and temporary cleanup also fail", async () => {
    const { root, store } = await fixture();
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await original(...args);
      if (typeof args[0] === "string" && args[0].endsWith(".tmp")) {
        vi.spyOn(file, "writeFile").mockRejectedValueOnce(Object.assign(new Error("private write details"), { code: "ENOSPC" }));
        const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementationOnce(async () => { await close(); throw Object.assign(new Error("private close details"), { code: "EIO" }); });
      }
      return file;
    });
    vi.spyOn(fs, "rm").mockRejectedValueOnce(Object.assign(new Error("private cleanup details"), { code: "EACCES" }));
    await expect(store.write(emptyHardwareState())).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", details: { errno: "ENOSPC", phase: "temporary_write", durability: "unchanged", authorityReplaced: false } });
    expect((await fs.readdir(path.join(root, "hardware"))).some(name => name.endsWith(".tmp"))).toBe(true);
  });

  it("reports read and validation failures without including snapshot content", async () => {
    const { root, store } = await fixture();
    const stateFile = path.join(root, "hardware/state.json");
    await fs.writeFile(stateFile, "private snapshot secret");
    const error = await store.reconcile().catch(error => error);
    expect(error).toMatchObject({ code: "STORE_UNAVAILABLE", details: { phase: "state_validate", durability: "unchanged", authorityReplaced: false } });
    expect(error.message).not.toContain("private snapshot secret");
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].endsWith("/state.json")) throw Object.assign(new Error(`private path ${root}`), { code: "EACCES" });
      return original(...args);
    });
    await expect(store.reconcile()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", details: { errno: "EACCES", phase: "state_read", durability: "unchanged", authorityReplaced: false } });
  });

  it("reports writer acquisition errno and refuses reconciliation while another writer owns the snapshot", async () => {
    const { root, store } = await fixture();
    await store.write(emptyHardwareState());
    const contender = new HardwareStore(root); stores.push(contender);
    await expect(contender.reconcile()).rejects.toMatchObject({ code: "WRITER_LOST", details: { phase: "writer_acquire", durability: "unchanged", authorityReplaced: false } });
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].endsWith("/.writer-lock")) throw Object.assign(new Error(`private path ${root}`), { code: "EACCES" });
      return original(...args);
    });
    await expect(contender.reconcile()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", details: { errno: "EACCES", phase: "writer_acquire", durability: "unchanged", authorityReplaced: false } });
  });

  it("does not initialize a missing snapshot during explicit reconciliation", async () => {
    const { root, store } = await fixture();
    const lock = path.join(root, "hardware/.writer-lock");
    const identity = (await fs.stat(lock)).ino;
    await expect(store.reconcile()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", details: { errno: "ENOENT", phase: "state_read" } });
    expect(await fs.readdir(path.join(root, "hardware"))).toEqual([".writer-lock"]);
    expect((await fs.stat(lock)).ino).toBe(identity);
  });

  it("reconciles the saved snapshot after writer loss without replacing the writer lock", async () => {
    const { root, store } = await fixture();
    const state = emptyHardwareState(); state.revision = 23; await store.write(state);
    const lock = path.join(root, "hardware/.writer-lock");
    const identity = (await fs.stat(lock)).ino;
    const writer = (store as unknown as { writer: HardwareWriterLease }).writer;
    const acquire = vi.spyOn(writer, "acquire");
    const child = (writer as unknown as { child: { pid: number; once: (event: string, callback: () => void) => void } }).child;
    const ended = new Promise<void>(resolve => child.once("exit", resolve));
    process.kill(child.pid, "SIGKILL"); await ended;
    expect(() => store.assertHeld()).toThrow(expect.objectContaining({ code: "WRITER_LOST", details: { phase: "writer_assert", durability: "unchanged", authorityReplaced: false } }));
    expect(await store.reconcile()).toEqual(state);
    store.assertHeld();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect((await fs.stat(lock)).ino).toBe(identity);
    expect(await store.read()).toEqual(state);
  });

  it("rejects corrupted snapshots and symlink authority without erasing evidence", async () => {
    const { root, store } = await fixture();
    await store.dispose();
    const stateFile = path.join(root, "hardware/state.json");
    await fs.writeFile(stateFile, '{"schemaVersion":1}');
    const broken = new HardwareStore(root); stores.push(broken);
    await expect(broken.init()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
    expect(await fs.readFile(stateFile, "utf8")).toBe('{"schemaVersion":1}');
    await fs.rm(stateFile); await fs.writeFile(path.join(root, "other.json"), JSON.stringify(emptyHardwareState())); await fs.symlink(path.join(root, "other.json"), stateFile);
    await expect(broken.init()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  });

  it("closes writer authority immediately when the helper exits unexpectedly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-lease-")); roots.push(root);
    const lost = vi.fn();
    const lease = new HardwareWriterLease(lost);
    await lease.acquire(path.join(root, "lock"));
    const child = (lease as unknown as { child: { pid: number; once: (event: string, callback: () => void) => void } }).child;
    const ended = new Promise<void>(resolve => child.once("exit", resolve));
    process.kill(child.pid, "SIGKILL"); await ended;
    expect(() => lease.assertHeld()).toThrow(expect.objectContaining({ code: "WRITER_LOST" }));
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ code: "WRITER_LOST" }));
    await lease.release();
  });

  it("releases the process-held lease after the owning server is killed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-crash-lease-")); roots.push(root);
    const file = path.join(root, "lock");
    const source = `import { HardwareWriterLease } from ${JSON.stringify(new URL("./HardwareWriterLease.ts", import.meta.url).href)}; const lease = new HardwareWriterLease(); await lease.acquire(${JSON.stringify(file)}); process.stdout.write(String(lease.child.pid)+"\\n"); process.stdin.resume();`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
    let helperPid = 0;
    try {
      helperPid = await new Promise<number>((resolve, reject) => { let text = ""; child.stdout.on("data", chunk => { text += chunk; if (text.includes("\n")) resolve(Number(text.trim())); }); child.on("error", reject); child.on("exit", code => { if (!helperPid) reject(new Error(`Lease process exited ${code}`)); }); });
      const exit = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exit;
      for (let attempt = 0; attempt < 100; attempt++) { const stat = await fs.readFile(`/proc/${helperPid}/stat`, "utf8").catch(() => ""); if (!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) break; await new Promise(resolve => setTimeout(resolve, 10)); }
      const lease = new HardwareWriterLease(); await lease.acquire(file); lease.assertHeld(); await lease.release();
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
});
