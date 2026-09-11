import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { terminalSocketPath } from "../apps/server/src/terminal/TerminalBrokerProtocol.js";
import { startTerminalBroker } from "./test-terminal-broker.mjs";
import { cleanupTerminalRecovery } from "./test-terminal-recovery.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const children = [];
const directories = [];

afterEach(async () => {
  try {
    await Promise.all(
      children.splice(0).map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }),
    );
  } finally {
    await Promise.all(
      directories
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  }
});

it.each([false, true])(
  "finishes real broker cleanup after a web shutdown timeout (attachment fails: %s)",
  async (attachmentFails) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-recovery-cleanup-"),
    );
    directories.push(root);
    const stalledServer = path.join(root, "stalled-server.cjs");
    await fs.writeFile(
      stalledServer,
      `
process.on("SIGTERM", () => {});
process.send({ type: "ready" });
setInterval(() => {}, 1_000);
`,
    );
    const server = fork(stalledServer, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(server);
    await once(server, "message");
    server.disconnect();

    const dataDir = path.join(root, "data");
    const broker = await startTerminalBroker(
      "apps/server/src/terminal/broker.ts",
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CLOUDX_DATA_DIR: dataDir,
          CLOUDX_ALLOWED_ROOTS: root,
        },
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        onSpawn(child) {
          children.push(child);
        },
      },
    );
    const socketPath = terminalSocketPath(dataDir);
    const socket = net.createConnection(socketPath);
    try {
      await once(socket, "connect");
      socket.write('{"type":"attach","sessionId":"missing"}\n');
      const [response] = await once(socket, "data");
      expect(JSON.parse(response.toString())).toEqual({ type: "missing" });
    } finally {
      socket.destroy();
    }

    const logPath = path.join(root, "server.log");
    await fs.writeFile(logPath, "web shutdown stalled; broker was responsive");
    const diagnostics = [];
    const attachmentFailure = new Error("Cannot attach terminal recovery logs");
    const attachLogs = vi.fn(async () => {
      diagnostics.push(await fs.readFile(logPath, "utf8"));
      if (attachmentFails) throw attachmentFailure;
    });

    const failure = await cleanupTerminalRecovery({
      server,
      broker,
      root,
      attachLogs,
    }).catch((error) => error);

    expect(broker.exitCode).toBe(0);
    expect(() => process.kill(broker.pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    await expect(fs.stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(attachLogs).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual([
      "web shutdown stalled; broker was responsive",
    ]);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain(
      `Stop web server: Error: Test process ${server.pid} did not stop after SIGTERM.`,
    );
    if (attachmentFails)
      expect(failure.message).toContain(
        `Attach diagnostic logs: ${attachmentFailure}`,
      );
    expect(failure.errors).toEqual([
      expect.objectContaining({
        message: `Test process ${server.pid} did not stop after SIGTERM.`,
      }),
      ...(attachmentFails ? [attachmentFailure] : []),
    ]);
  },
  20_000,
);

it("removes fixture files when diagnostic capture throws synchronously", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-recovery-cleanup-"),
  );
  directories.push(root);
  const failure = new Error("Cannot capture terminal recovery logs");

  await expect(
    cleanupTerminalRecovery({
      root,
      attachLogs() {
        throw failure;
      },
    }),
  ).rejects.toMatchObject({ errors: [failure] });

  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

it("attaches diagnostics before removing an otherwise released fixture", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-recovery-cleanup-"),
  );
  directories.push(root);
  const attachLogs = vi.fn(async () =>
    expect((await fs.stat(root)).isDirectory()).toBe(true),
  );

  await expect(
    cleanupTerminalRecovery({ root, attachLogs }),
  ).resolves.toBeUndefined();

  expect(attachLogs).toHaveBeenCalledOnce();
  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
});
