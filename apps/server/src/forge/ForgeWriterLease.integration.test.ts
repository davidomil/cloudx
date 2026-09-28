import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ForgeWriterLease } from "./ForgeWriterLease.js";
import { ForgeWorkflowStore } from "./ForgeWorkflowStore.js";
import { PluginDataStore } from "../plugins/PluginDataStore.js";

it.skipIf(process.platform !== "linux").each(["SIGINT", "SIGTERM"] as const)
("keeps the writer lease until service disposal persists its worker and queue after group %s", async signal => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-forge-writer-shutdown-"));
  const data = new PluginDataStore(directory);
  const store = new ForgeWorkflowStore(data);
  const now = new Date().toISOString();
  const id = randomUUID();
  const attemptId = randomUUID();
  const repository = { provider: "github" as const, apiUrl: "https://api.github.com", projectPath: "fixture/cloudx" };
  await store.write([{
    id, attemptId, repository, kind: "issue", number: 1, changeNumber: 7, title: "Resolve conflict", status: "running",
    baseBranch: "main", templateId: "worker", autoPost: false, startedAt: now, updatedAt: now, tabId: "active-tab",
    completion: { attemptId, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    mergeQueue: { sequence: 1, enteredAt: now, phase: "resolving", active: true, position: 1,
      candidate: { headSha: "a".repeat(40), targetHeadSha: "b".repeat(40) } },
  }]);
  const file = await data.writerLockPath("forge");
  const identity = await fs.stat(file);
  const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { once } from "node:events";
    import { ForgeWorkflowService } from ${JSON.stringify(new URL("./ForgeWorkflowService.ts", import.meta.url).href)};
    import { ForgeWorkflowStore } from ${JSON.stringify(new URL("./ForgeWorkflowStore.ts", import.meta.url).href)};
    import { PluginDataStore } from ${JSON.stringify(new URL("../plugins/PluginDataStore.ts", import.meta.url).href)};
    const service = new ForgeWorkflowService({
      store: new ForgeWorkflowStore(new PluginDataStore(process.argv[1])),
      settings: () => ({ repository: ${JSON.stringify(repository)} }),
      reports: { read: async () => undefined },
      runtime: {
        isActive: () => true,
        readTurnCompletion: async (workerId, attemptId) => ({ workerId, attemptId, threadId: "thread", turnId: "turn", status: "running" }),
        close: async () => { process.send("quiescing"); await once(process, "message"); },
      },
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
      void service.dispose().then(() => {
        process.send("disposed"); process.disconnect();
      }).catch(error => { console.error(error); process.exit(1); });
    });
    await service.dashboard();
    process.send("owned");
  `, directory], { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = once(owner, "exit");
  let stderr = "";
  owner.stderr!.on("data", chunk => { stderr += chunk; });
  const nextMessage = () => Promise.race([
    once(owner, "message").then(([message]) => message),
    exited.then(([code]) => { throw new Error(`Fixture exited with ${code}: ${stderr}`); }),
  ]);
  try {
    expect(await nextMessage()).toBe("owned");
    const quiescing = nextMessage();
    process.kill(-owner.pid!, signal);
    expect(await quiescing).toBe("quiescing");
    expect((await store.read())[0].status).toBe("running");
    await expect(store.claimWriter()).rejects.toThrow("Another CloudX service owns");
    const disposed = nextMessage();
    owner.send("finish-quiescence");
    expect(await disposed).toBe("disposed");
    expect(await exited).toEqual([0, null]);
    await store.claimWriter();
    expect((await store.read())[0]).toMatchObject({ status: "paused", mergeQueue: { phase: "blocked", active: false } });
    expect((await fs.stat(file)).ino).toBe(identity.ino);
    expect(stderr).toBe("");
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) process.kill(-owner.pid!, "SIGKILL");
    await exited;
    await store.releaseWriter();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 10_000);

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
