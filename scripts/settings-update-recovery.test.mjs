import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { CloudxUpdateService } from "../apps/server/src/system/CloudxUpdateService.ts";
import { SERVICE_NAMES } from "./install-update.mjs";

const roots = [];
const installed = "a".repeat(40), targetCommit = "b".repeat(40);
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    const pidFile = path.join(root, "worker-pid");
    if (fs.existsSync(pidFile) && !fs.existsSync(path.join(root, "worker-result.json"))) {
      try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("returns Settings confirmation and launch before a valid recovery scan exceeds the 30-second request deadline", async () => {
  const f = recoveryInstallation();
  expect(f.transcriptBytes).toBeGreaterThan(256 * 1024 ** 2);
  vi.stubEnv("CLOUDX_INSTALL_ROOT", f.repoRoot);
  const executeFile = promisify(execFile);
  const deadlines = [];
  const execute = (file, args, options) => {
    if (file === "git") return Promise.resolve({ stdout: installed });
    deadlines.push(options.timeout);
    return executeFile(file, args, { ...options, env: { ...options.env, CLOUDX_TEST_RECOVERY_ROOT: f.root } });
  };
  const catalog = { preview: async () => ({ channel: "main", currentCommit: installed, checkedAt: new Date().toISOString(), state: "available",
    target: { commit: targetCommit, name: "main", url: `https://github.com/davidomil/cloudx/commit/${targetCommit}` }, changelog: [], changelogComplete: true }) };
  const service = new CloudxUpdateService(f.dataDir, execute, catalog, { identity: { verification: "unverified", reason: "fixture" } }, undefined, f.updaterRoot);
  await service.preview();
  const confirmation = await service.start({ channel: "main", targetCommit });
  expect(confirmation.confirmation?.targetCommit).toBe(targetCommit);
  expect(confirmation.run).toBeUndefined();
  expect(f.events().some(event => ["launched", "transcript-read", "history-read", "service-change"].includes(event.kind))).toBe(false);

  const launched = await service.start({ channel: "main", targetCommit, confirmInterruption: true });
  expect(launched.run?.state).toBe("running");
  await vi.waitFor(() => expect(f.events().some(event => event.action === "worker" && event.kind === "transcript-read")).toBe(true), { timeout: 5000 });
  expect((await service.status()).run?.id).toBe(launched.run.id);
  expect(f.events().filter(event => event.action !== "worker" && ["transcript-read", "history-read"].includes(event.kind))).toEqual([]);
  await vi.waitFor(() => expect(fs.existsSync(f.resultFile)).toBe(true), { timeout: 60_000, interval: 250 });
  const result = JSON.parse(fs.readFileSync(f.resultFile, "utf8"));
  expect(result.elapsedMs).toBeGreaterThan(30_000);
  expect(result.plan.blockers).toEqual([]);
  expect(result.plan.requiresInterruption).toBe(true);
  expect(f.events().some(event => event.action === "worker" && event.kind === "progress" && event.message.includes("bytes inspected"))).toBe(true);
  expect(f.events().some(event => event.action === "worker" && event.kind === "history-read")).toBe(true);
  expect(f.events().some(event => event.kind === "service-change")).toBe(false);
  expect(deadlines.every(timeout => timeout === 30_000)).toBe(true);
  expect(fs.statSync(f.transcriptPath).size).toBe(f.transcriptBytes);
}, 90_000);

function recoveryInstallation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-settings-recovery-")); roots.push(root);
  const repoRoot = path.join(root, "checkout"), dataDir = path.join(root, "data"), home = path.join(root, "home");
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  fs.mkdirSync(repoRoot);
  write(path.join(home, ".config/cloudx/cloudx.env"), `CLOUDX_DATA_DIR=${dataDir}\n`);
  for (const name of SERVICE_NAMES) write(path.join(home, ".config/systemd/user", name), "fixture unit");
  const sessionId = "12345678-1234-1234-1234-123456789abc", tabId = "retained-codex";
  const tab = { id: tabId, pluginId: "codex-terminal", title: "Retained session", cwd: repoRoot, status: "running",
    indicator: { color: "green", label: "Running", updatedAt: "now" }, createdAt: "then", updatedAt: "now" };
  write(path.join(dataDir, "sessions.json"), JSON.stringify({ version: 1, activeTabId: tabId, sessions: [{ tab }] }));
  write(path.join(dataDir, "workspace.json"), JSON.stringify({ windows: [{ id: "window", name: "Saved", defaultCwd: repoRoot,
    layout: { activePaneId: "pane", root: { type: "pane", pane: { id: "pane", tabIds: [tabId] } } } }] }));
  const codexHome = path.join(root, "codex-home");
  const transcriptPath = path.join(codexHome, "sessions", `rollout-${sessionId}.jsonl`);
  write(transcriptPath, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: repoRoot } })}\n`);
  const event = '{"type":"event_msg","payload":{"message":"retained history"}}\n';
  const chunk = event.repeat(Math.floor(1024 * 1024 / Buffer.byteLength(event)));
  const fd = fs.openSync(transcriptPath, "a");
  try { for (let index = 0; index < 258; index++) fs.writeSync(fd, chunk); }
  finally { fs.closeSync(fd); }
  const source = fs.statSync(codexHome);
  write(path.join(dataDir, "codex-launches", tabId, ".cloudx-source.json"), JSON.stringify({ version: 1, sourceId: "shared", home: codexHome,
    dev: String(source.dev), ino: String(source.ino) }));
  write(path.join(dataDir, "codex-launches", tabId, ".cloudx-conversation.json"), JSON.stringify({ sessionId, cwd: repoRoot, transcriptPath }));
  write(path.join(dataDir, "forge-workers/history/retained.json"), `{ "retained": true }${" ".repeat(2 * 1024 * 1024)}`);
  write(path.join(root, "transcript-path"), transcriptPath);
  const updaterRoot = path.join(root, "updater");
  const manifest = ["settings-update.mjs", "managed-update.mjs"].map(name => {
    const bytes = name === "settings-update.mjs" ? `import ${JSON.stringify(new URL("./helpers/settings-update-recovery-host.mjs", import.meta.url).href)};\n` : "export {};\n";
    const relative = `scripts/${name}`;
    write(path.join(updaterRoot, relative), bytes);
    return { path: relative, type: "file", size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  write(path.join(updaterRoot, "bundle.json"), JSON.stringify(manifest));
  return { root, repoRoot, dataDir, updaterRoot, transcriptPath, transcriptBytes: fs.statSync(transcriptPath).size,
    resultFile: path.join(root, "worker-result.json"),
    events: () => fs.existsSync(path.join(root, "events.jsonl")) ? fs.readFileSync(path.join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}
