import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

import { bundleCoordinator } from "./managed-update-store.mjs";

const supportedHost = process.platform === "linux"
  && fs.readFileSync("/etc/os-release", "utf8").includes("ID=ubuntu")
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5_000 }).status === 0;

it.skipIf(!supportedHost)("keeps the bundled updater alive after its initiating systemd unit stops and its checkout files are replaced", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-update-systemd-"));
  const original = path.join(root, "checkout");
  const staged = path.join(root, "state", "coordinator");
  const ownerUnit = `cloudx-update-test-owner-${randomUUID()}.service`;
  const coordinatorUnit = `cloudx-update-test-coordinator-${randomUUID()}.service`;
  fs.mkdirSync(original);
  fs.copyFileSync(new URL("./managed-update-store.mjs", import.meta.url), path.join(original, "managed-update-store.mjs"));
  fs.writeFileSync(path.join(original, "payload.mjs"), "export const payload = 'staged coordinator payload';\n");
  fs.writeFileSync(path.join(original, "coordinator.mjs"), `
    import fs from 'node:fs';
    import path from 'node:path';
    import { execFileSync } from 'node:child_process';
    import { verifySnapshot, writeUpdateJson } from './managed-update-store.mjs';
    const [root, original, ownerUnit] = process.argv.slice(2);
    const directory = path.dirname(new URL(import.meta.url).pathname);
    verifySnapshot(directory, JSON.parse(fs.readFileSync(path.join(directory, 'bundle.json'), 'utf8')));
    const owner = JSON.parse(fs.readFileSync(path.join(root, 'owner.json'), 'utf8'));
    const coordinatorGroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    if (coordinatorGroup === owner.group) throw new Error('Updater remained in the initiating service group.');
    execFileSync('systemctl', ['--user', 'stop', ownerUnit]);
    if (fs.existsSync('/proc/' + owner.pid)) throw new Error('The initiating process did not stop.');
    for (const file of ['payload.mjs', 'coordinator.mjs', 'managed-update-store.mjs'])
      fs.writeFileSync(path.join(original, file), 'replaced source is deliberately not JavaScript');
    const { payload } = await import('./payload.mjs');
    writeUpdateJson(path.join(root, 'completed.json'), { payload, pid: process.pid, coordinatorGroup, owner });
  `);
  bundleCoordinator(original, staged, ["coordinator.mjs", "managed-update-store.mjs", "payload.mjs"]);
  const ownerScript = path.join(root, "owner.mjs");
  fs.writeFileSync(ownerScript, `
    import fs from 'node:fs';
    import { execFileSync } from 'node:child_process';
    fs.writeFileSync(${JSON.stringify(path.join(root, "owner.json"))}, JSON.stringify({ pid: process.pid, group: fs.readFileSync('/proc/self/cgroup', 'utf8') }));
    execFileSync('systemd-run', ${JSON.stringify([
      "--user", "--quiet", "--collect", `--unit=${coordinatorUnit}`, "--property=Type=exec",
      "--property=KillMode=control-group", "--property=RuntimeMaxSec=20", "--property=UMask=0077", "--",
      process.execPath, path.join(staged, "coordinator.mjs"), root, original, ownerUnit
    ])});
    setInterval(() => {}, 1_000);
  `);
  try {
    execFileSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=${ownerUnit}`,
      "--property=Type=exec", "--property=KillMode=control-group", "--property=RuntimeMaxSec=20",
      "--", process.execPath, ownerScript], { timeout: 5_000 });
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "completed.json"))).toBe(true), { timeout: 10_000 });
    const completed = JSON.parse(fs.readFileSync(path.join(root, "completed.json"), "utf8"));
    expect(completed.payload).toBe("staged coordinator payload");
    expect(completed.coordinatorGroup).toContain(coordinatorUnit);
    expect(completed.owner.group).toContain(ownerUnit);
    expect(completed.coordinatorGroup).not.toBe(completed.owner.group);
    expect(fs.existsSync(`/proc/${completed.owner.pid}`)).toBe(false);
    expect(fs.readFileSync(path.join(original, "payload.mjs"), "utf8")).toContain("replaced source");
  } catch (error) {
    const journal = spawnSync("journalctl", ["--user", "--no-pager", "-n", "30", "-u", ownerUnit, "-u", coordinatorUnit], { encoding: "utf8", timeout: 5_000 });
    throw new Error(`${error.message}\nIsolated updater service journal:\n${journal.stdout}`, { cause: error });
  } finally {
    for (const unit of [ownerUnit, coordinatorUnit]) spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 5_000 });
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
