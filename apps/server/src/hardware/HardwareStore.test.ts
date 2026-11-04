import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyHardwareState, HardwareStore } from "./HardwareStore.js";
import { HardwareWriterLease } from "./HardwareWriterLease.js";

const roots: string[] = [], stores: HardwareStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.dispose(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-store-")); roots.push(root); const store = new HardwareStore(root); stores.push(store); await store.init(); return { root, store }; }

describe("durable Hardware authority", () => {
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
