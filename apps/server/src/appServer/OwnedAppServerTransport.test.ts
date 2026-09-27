import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import { AppServerClient } from "./AppServerClient.js";
import { OwnedAppServerTransport } from "./OwnedAppServerTransport.js";

const directories: string[] = [];
const execute = promisify(execFile);
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

it.each(["finish", "terminate"] as const)("reaps detached app-server descendants before %s releases its writer", async shutdown => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-owned-app-server-"));
  directories.push(directory);
  const command = path.join(directory, "codex.mjs");
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
fs.writeFileSync(process.env.DESCENDANT_RECEIPT, String(child.pid));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id) process.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`);
  await fs.chmod(command, 0o755);
  const receipt = path.join(directory, "child.pid");
  const transport = await OwnedAppServerTransport.create({ command, configurationArgs: [], env: { ...process.env, DESCENDANT_RECEIPT: receipt }, cwd: directory, tabId: "owned-test" });
  const client = new AppServerClient(transport);
  let child = 0;
  try {
    await client.initialize();
    child = Number(await fs.readFile(receipt, "utf8"));
    await fs.access(`/proc/${child}/stat`, constants.F_OK);
    await transport[shutdown]();
  } finally {
    client.close();
    await transport.terminate();
  }
  await expect(fs.access(`/proc/${child}/stat`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports a missing configured executable and confirms no children remain", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-missing-app-server-"));
  directories.push(directory);
  let transport: OwnedAppServerTransport | undefined;
  try {
    transport = await OwnedAppServerTransport.create({ command: path.join(directory, "missing"), configurationArgs: [], env: process.env, cwd: directory, tabId: "missing-test" });
    const client = new AppServerClient(transport);
    await expect(client.initialize()).rejects.toThrow(/exited|closed/);
    client.close();
  } finally {
    await transport?.terminate();
  }
});

it.each(["setup-error", "emitted-error"])("survives a receipt watcher %s through the production create consumer", async mode => {
  const evidence = await receiptObserverProbe(mode);

  expect(evidence.error).toContain("Terminal receipt observation failed");
  expect(evidence.hostContinued).toBe(true);
  expect(evidence.helpers).toHaveLength(1);
  expect(evidence.living).toEqual([]);
  expect(evidence.receiptDirectories).toEqual([]);
  if (mode === "emitted-error") {
    expect(evidence.commandPids).toHaveLength(2);
    expect(evidence.error).toContain("descendant cleanup was confirmed");
  } else expect(evidence.error).toMatch(/descendant (cleanup was confirmed|ownership is unconfirmed)/u);
});

it("reconciles filename-less notifications and removes receipts after detached descendants are reaped", async () => {
  const evidence = await receiptObserverProbe("null-filename");

  expect(evidence.error).toBeUndefined();
  expect(evidence.hostContinued).toBe(true);
  expect(evidence.commandPids).toHaveLength(2);
  expect(evidence.living).toEqual([]);
  expect(evidence.receiptDirectories).toEqual([]);
  expect(evidence.nullNotifications).toBeGreaterThan(0);
});

async function receiptObserverProbe(mode: string): Promise<{
  error?: string; hostContinued: boolean; helpers: number[]; commandPids: number[];
  living: number[]; receiptDirectories: string[]; nullNotifications: number;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-receipt-observer-test-"));
  directories.push(directory);
  const command = path.join(directory, "codex.mjs");
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
fs.writeFileSync(process.env.COMMAND_PIDS, JSON.stringify([process.pid, child.pid]));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });
  const { stdout, stderr } = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import nativeFs from 'node:fs';
    import fs from 'node:fs/promises';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const mode = ${JSON.stringify(mode)};
    const directory = ${JSON.stringify(directory)};
    const pidFile = directory + '/command-pids.json';
    const helpers = [], receiptDirectories = [];
    let watcher, injected = false, nullNotifications = 0;
    const watch = nativeFs.watch, readFile = fs.readFile, spawn = childProcess.spawn;
    childProcess.spawn = (...args) => {
      const child = spawn(...args);
      if (args[0] === 'python3') helpers.push(child.pid);
      return child;
    };
    nativeFs.watch = (target, listener) => {
      receiptDirectories.push(target);
      if (mode === 'setup-error') throw Object.assign(new Error('Injected watcher setup failure'), { code: 'ENOSPC' });
      watcher = watch(target, (event, filename) => {
        if (mode === 'null-filename') { nullNotifications++; listener(event, null); }
        else listener(event, filename);
      });
      return watcher;
    };
    fs.readFile = async (file, ...args) => {
      if (mode === 'emitted-error' && String(file).endsWith('/ready.json') && !injected) {
        const deadline = Date.now() + 3000;
        while (!nativeFs.existsSync(pidFile)) {
          assert.ok(Date.now() < deadline, 'The owned writer did not start');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        injected = true;
        watcher.emit('error', Object.assign(new Error('Injected watcher event failure'), { code: 'EIO' }));
      }
      return readFile(file, ...args);
    };
    syncBuiltinESMExports();
    const { OwnedAppServerTransport } = await import(${JSON.stringify(new URL("./OwnedAppServerTransport.ts", import.meta.url).href)});
    const messages = error => [error.message, ...(error.errors ?? []).map(messages), ...(error.cause ? [messages(error.cause)] : [])].flat().join('; ');
    let error;
    try {
      const transport = await OwnedAppServerTransport.create({ command: ${JSON.stringify(command)}, configurationArgs: [], env: { ...process.env, COMMAND_PIDS: pidFile }, cwd: directory, tabId: 'observer-failure' });
      assert.equal(mode, 'null-filename', 'Observer failure must reject preparation');
      const deadline = Date.now() + 3000;
      while (!nativeFs.existsSync(pidFile)) {
        assert.ok(Date.now() < deadline, 'The owned writer did not start');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await transport.finish();
    } catch (caught) { error = messages(caught); }
    const commandPids = nativeFs.existsSync(pidFile) ? JSON.parse(await readFile(pidFile, 'utf8')) : [];
    const living = [...helpers, ...commandPids].filter(pid => nativeFs.existsSync('/proc/' + pid));
    console.log(JSON.stringify({ error, hostContinued: true, helpers, commandPids, living, receiptDirectories: receiptDirectories.filter(target => nativeFs.existsSync(target)), nullNotifications }));
  `], { timeout: 12_000 });
  expect(stderr).toBe("");
  const evidence = JSON.parse(stdout);
  // Removing a test tree is safe only after the real owner exhausted its children.
  expect(evidence.living).toEqual([]);
  await fs.rm(directory, { recursive: true, force: true });
  await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  return evidence;
}
