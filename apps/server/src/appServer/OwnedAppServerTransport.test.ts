import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { AppServerClient } from "./AppServerClient.js";
import { OwnedAppServerTransport } from "./OwnedAppServerTransport.js";

const directories: string[] = [];
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
