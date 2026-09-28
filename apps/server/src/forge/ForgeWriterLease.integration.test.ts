import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ForgeWriterLease } from "./ForgeWriterLease.js";

it.skipIf(process.platform !== "linux")("releases the kernel lease after its owning service crashes without replacing the lock file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-forge-writer-crash-"));
  const file = path.join(directory, "workflow.writer-lock");
  const lease = new ForgeWriterLease();
  const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { ForgeWriterLease } from ${JSON.stringify(new URL("./ForgeWriterLease.ts", import.meta.url).href)};
    await new ForgeWriterLease().acquire(process.argv[1]);
    process.stdout.write("owned\\n");
    process.stdin.resume();
  `, file], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(owner, "exit");
  try {
    const ready = once(owner.stdout!, "data");
    await Promise.race([ready, exited.then(() => { throw new Error("The fixture writer exited before acquiring ownership."); })]);
    const identity = await fs.stat(file);
    await expect(lease.acquire(file)).rejects.toThrow("Another CloudX service owns");
    owner.kill("SIGKILL");
    await exited;
    await vi.waitFor(() => lease.acquire(file), { timeout: 5_000, interval: 20 });
    expect(() => lease.assertHeld()).not.toThrow();
    expect((await fs.stat(file)).ino).toBe(identity.ino);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await exited;
    await lease.release();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 10_000);
