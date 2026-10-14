import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import type { TerminalExit } from "../terminal/TerminalSupervisor.js";

const bridge = new URL(
  "../../helpers/codex-worker-bridge.mjs",
  import.meta.url,
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

it.each(["normal", "startup-exit", "backend-exit", "diagnostic-write-failure"])(
  "isolates backend stderr in a supervised native PTY through %s",
  async (outcome) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-diagnostic-pty-"),
    );
    directories.push(directory);
    const command = path.join(directory, "codex.mjs");
    const processes = path.join(directory, "processes.jsonl");
    const ws = pathToFileURL(createRequire(import.meta.url).resolve("ws")).href;
    await fs.writeFile(
      command,
      `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from ${JSON.stringify(ws)};
const backend = process.argv.includes('app-server');
const record = value => fs.appendFileSync(${JSON.stringify(processes)}, JSON.stringify(value) + '\\n');
record({ pid: process.pid, backend, stderr: fs.readlinkSync('/proc/self/fd/2') });
if (backend) {
  const descendant = spawn('sleep', ['30'], { stdio: ['ignore', 'ignore', 'inherit'] });
  record({ pid: descendant.pid, descendant: true });
  const diagnostic = '\\x1b[31mBACKEND_DIAGNOSTIC_ONLY codex_core::tools::router\\x1b[0m\\npatch hunk café 界\\n';
  for (let index = 0; index < 5000; index++) {
    if (!process.stderr.write(diagnostic)) await once(process.stderr, 'drain');
  }
  process.stderr.write('BACKEND_FINAL_DIAGNOSTIC\\n');
  if (${JSON.stringify(outcome)} === 'startup-exit') process.exit(9);
  else for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    const reply = request.method === 'thread/start'
      ? { id: request.id, result: { thread: { id: '01a08470-d118-7b72-b1df-439e72e5c744', cwd: process.cwd() } } }
      : { id: request.id, error: { code: -32000, message: 'apply_patch verification failed' } };
    process.stdout.write(JSON.stringify(reply) + '\\n');
    if (request.method !== 'thread/start' && ${JSON.stringify(outcome)} === 'backend-exit') setTimeout(() => process.exit(9), 100);
  }
} else {
  process.on('SIGTERM', () => { process.stdout.write('Frontend stopped\\n'); setTimeout(() => process.exit(1), 50); });
  const socket = new WebSocket(process.argv[process.argv.indexOf('--remote') + 1], { headers: { Authorization: 'Bearer ' + process.env.CLOUDX_CODEX_WORKER_TOKEN } });
  socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'thread/start' })));
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.id === 1) {
      process.stdout.write('Frontend composer ready\\n');
      socket.send(JSON.stringify({ id: 2, method: 'ordinary/tool-error' }));
    } else {
      process.stdout.write('Tool result: ' + message.error.message + '\\n');
      if (${JSON.stringify(outcome)} === 'normal') { socket.close(); setTimeout(() => process.exit(0), 50); }
    }
  });
}
`,
      { mode: 0o755 },
    );
    const args = [
      fileURLToPath(bridge),
      JSON.stringify({
        selection: {
          tabId: "diagnostics",
          executionId: "01a08470-d118-7b72-b1df-439e72e5c745",
          receiptPath: path.join(directory, "selected.json"),
        },
        command,
        serverArgs: ["app-server"],
        tuiArgs: [],
      }),
    ];
    const limited = outcome === "diagnostic-write-failure";
    const signalHandler = path.join(directory, "file-limit.mjs");
    if (limited)
      await fs.writeFile(signalHandler, "process.on('SIGXFSZ', () => {});\n");
    const terminal = await new NodePtyTerminalProcessFactory().spawn(
      limited ? "prlimit" : process.execPath,
      limited
        ? [
            "--fsize=4096:4096",
            process.execPath,
            "--import",
            signalHandler,
            ...args,
          ]
        : args,
      { cwd: directory, env: { PATH: process.env.PATH }, cols: 100, rows: 30 },
    );
    let output = "";
    let exit: TerminalExit | undefined;
    terminal.onData((chunk) => {
      output += chunk;
    });
    terminal.onExit((event) => {
      exit = event;
    });
    try {
      terminal.resize(80, 24);
      await expect
        .poll(() => exit, { timeout: 5_000 })
        .toMatchObject({ exitCode: outcome === "normal" ? 0 : 1 });
      expect(output).not.toContain("BACKEND_DIAGNOSTIC_ONLY");
      expect(output).not.toContain("BACKEND_FINAL_DIAGNOSTIC");
      expect(output).not.toContain("\x1b[31m");
      if (outcome === "normal" || outcome === "backend-exit") {
        expect(output).toContain("Frontend composer ready");
        expect(output).toContain(
          "Tool result: apply_patch verification failed",
        );
        expect(
          JSON.parse(
            await fs.readFile(path.join(directory, "selected.json"), "utf8"),
          ),
        ).toMatchObject({
          tabId: "diagnostics",
          executionId: "01a08470-d118-7b72-b1df-439e72e5c745",
        });
      }
      const diagnosticPath = path.join(directory, "cloudx-codex-backend.log");
      const diagnostics = await fs.readFile(diagnosticPath, "utf8");
      if (!limited) expect(diagnostics).toContain("BACKEND_FINAL_DIAGNOSTIC");
      expect((await fs.stat(diagnosticPath)).size).toBeLessThanOrEqual(
        256 * 1024,
      );
      if (outcome !== "normal") {
        expect(output.indexOf("Frontend stopped")).toBeLessThan(
          output.indexOf("CloudX native worker bridge:"),
        );
        expect(output).toContain(
          limited
            ? "Private Codex backend diagnostics could not be saved."
            : "exited before its visible worker (9)",
        );
        expect(output).toContain(
          `${limited ? "Backend diagnostics could not be saved; inspect retained file" : "Private backend diagnostics"}: ${diagnosticPath}`,
        );
        expect(output).not.toContain("Error: EFBIG");
      }
      const children = (await fs.readFile(processes, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(children.find((child) => child.backend).stderr).toMatch(
        /^(socket|pipe):/,
      );
      expect(children.find((child) => child.backend === false).stderr).toMatch(
        /^\/dev\/pts\//,
      );
      for (const child of children)
        await expect(fs.access(`/proc/${child.pid}`)).rejects.toMatchObject({
          code: "ENOENT",
        });
    } finally {
      await terminal.terminate();
    }
  },
  10_000,
);
