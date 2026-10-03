import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { PluginSession } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";
import { updateCodexInstallation } from "../../../../scripts/codex-updater.mjs";
import { readCodexSelection, resolveSelectedCodexCommand } from "../../../../scripts/codex-selection.mjs";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { completedVerificationTurn, readVerificationTranscript } from "./CodexVerificationTranscript.js";

const nativeBinary = process.env.CLOUDX_NATIVE_CODEX;

function completeResponse(response: ServerResponse, text: string) {
  const item = { type: "message", id: "msg_first_selection", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: "resp_first_selection", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_first_selection", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

it.skipIf(!nativeBinary).each([
  { recovery: false, keepRunning: true, viewer: false, title: "rejects a first selection whose migration breaks the existing CLI while original tabs and Forge workers finish" },
  { recovery: true, keepRunning: false, viewer: false, title: "recovers the first selection from a CLI already failing startup without live original sessions or changes to retained state" },
  { recovery: true, keepRunning: false, viewer: true, title: "recovers the first selection while an unrelated bridge file viewer is running" },
  { recovery: true, keepRunning: true, viewer: false, title: "rejects first-selection startup recovery while original tabs and Forge workers are still running" },
])("$title", async ({ recovery: recovering, keepRunning, viewer: viewBridge }) => {
  const shouldRecover = recovering && !keepRunning;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-first-selection-"));
  const home = path.join(root, "home");
  const sqliteHome = path.join(root, "shared-sqlite");
  const data = path.join(root, "data");
  const prefix = path.join(root, "npm-prefix");
  const packageDir = path.join(prefix, "lib/node_modules/@openai/codex");
  const entrypoint = path.join(packageDir, "bin/codex.py");
  const assistantBin = path.join(prefix, "bin/codex");
  const tools = path.join(root, "tools");
  const commandLog = path.join(root, "native-launches.jsonl");
  const brokenOriginal = path.join(root, "broken-original");
  let viewer: ChildProcess | undefined;
  const sources = new CodexStateSources(data, { CODEX_HOME: home });
  const sessions: PluginSession[] = [];
  const answer = "The original native installation completed the turn.";
  let pendingWorker: ServerResponse | undefined;
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      if (input.text?.format?.schema?.properties?.title) completeResponse(response, '{"title":"Native first selection"}');
      else if (body.includes("Keep the original Forge turn pending")) pendingWorker = response;
      else completeResponse(response, answer);
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const port = (provider.address() as { port: number }).port;
    await Promise.all([home, sqliteHome, tools, path.dirname(entrypoint), path.dirname(assistantBin)].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
    const originalConfig = [
      '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
      'check_for_update_on_startup = false', 'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
      `sqlite_home = ${JSON.stringify(sqliteHome)}`,
      '[model_providers.cloudx-native]', 'name = "CloudX native first selection"',
      `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', '',
    ].join("\n");
    await fs.writeFile(path.join(home, "config.toml"), originalConfig);
    const version = execFileSync(nativeBinary!, ["--version"], { encoding: "utf8" }).trim().replace(/^codex-cli /u, "");
    const python = execFileSync("python3", ["-I", "-S", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
    const executable = (candidate: boolean) => `#!${python}
import json, os, pathlib, re, sqlite3, sys
candidate = ${candidate ? "True" : "False"}
if sys.argv[1:] == ["--version"]:
    print("codex-cli " + ${JSON.stringify(candidate ? version : "0.0.0")})
    sys.exit(0)
home = pathlib.Path(os.environ["CODEX_HOME"])
config = (home / "config.toml").read_text()
match = re.search(r'^sqlite_home\\s*=\\s*(".*")\\s*$', config, re.MULTILINE)
sqlite_home = pathlib.Path(json.loads(match.group(1))) if match else home
databases = sorted(sqlite_home.glob("state_*.sqlite"))
event = {"candidate": candidate, "home": str(home), "sqliteHome": str(sqlite_home), "rejected": not candidate and pathlib.Path(${JSON.stringify(brokenOriginal)}).is_file(), "migrated": False}
for database in databases:
    with sqlite3.connect(database) as connection:
        if not candidate and not event["rejected"] and (sqlite_home / "retained-identities.json").is_file():
            connection.execute("CREATE TABLE IF NOT EXISTS cloudx_original_baseline (version INTEGER)")
        if candidate and connection.execute("SELECT 1 FROM sqlite_schema WHERE name = 'cloudx_original_baseline'").fetchone():
            event["rejected"] = True
        if candidate and ${recovering ? "False" : "True"} and (sqlite_home / "retained-identities.json").is_file():
            assert "cloudx-codex-state-verification-" in str(sqlite_home)
            assert (sqlite_home / "retained-identities.json").is_file()
            connection.execute("CREATE TABLE IF NOT EXISTS cloudx_incompatible_candidate (version INTEGER)")
            event["migrated"] = True
        elif not candidate and connection.execute("SELECT 1 FROM sqlite_schema WHERE name = 'cloudx_incompatible_candidate'").fetchone():
            event["rejected"] = True
with open(${JSON.stringify(commandLog)}, "a") as log:
    log.write(json.dumps(event) + "\\n")
if event["rejected"]:
    print("Original CLI rejects candidate migration", file=sys.stderr)
    sys.exit(86)
os.execv(${JSON.stringify(nativeBinary)}, [${JSON.stringify(nativeBinary)}, *sys.argv[1:]])
`;
    const originalExecutable = executable(false);
    const manifestPath = path.join(packageDir, "package.json");
    const originalManifest = JSON.stringify({ name: "@openai/codex", version: "0.0.0", bin: { codex: "bin/codex.py" } });
    await fs.writeFile(manifestPath, originalManifest);
    await fs.writeFile(entrypoint, originalExecutable, { mode: 0o700 });
    await fs.symlink(entrypoint, assistantBin);
    const candidateFile = path.join(root, "candidate.py");
    await fs.writeFile(candidateFile, executable(true), { mode: 0o700 });
    await fs.writeFile(path.join(tools, "npm"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === 'view') console.log(JSON.stringify({versions: [${JSON.stringify(version)}], 'dist-tags': {latest: ${JSON.stringify(version)}}}));
else if (process.argv[2] === 'i') {
  const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
  const packageDir = path.join(prefix, 'lib/node_modules/@openai/codex');
  fs.mkdirSync(path.join(packageDir, 'bin'), {recursive: true});
  fs.mkdirSync(path.join(prefix, 'bin'), {recursive: true});
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({name: '@openai/codex', version: ${JSON.stringify(version)}, bin: {codex: 'bin/codex.py'}}));
  fs.copyFileSync(${JSON.stringify(candidateFile)}, path.join(packageDir, 'bin/codex.py'));
  fs.symlinkSync(path.join(packageDir, 'bin/codex.py'), path.join(prefix, 'bin/codex'));
} else process.exit(91);
`, { mode: 0o700 });
    const env = { PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}`, TMPDIR: process.env.TMPDIR, HOME: home, CODEX_HOME: home, CLOUDX_DATA_DIR: data, CLOUDX_ASSISTANT_BIN: assistantBin, SHELL: "/bin/sh", TERM: "xterm-256color" };
    const plugin = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, data, sources, env);
    const start = async (id: string, worker = false) => {
      const tab: WorkspaceTab = { id, pluginId: "codex-terminal", ...(worker ? { ownerPluginId: "forge" } : {}), title: id, cwd: root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "Running", updatedAt: "" } };
      const binding = { workerId: id, attemptId: `${id}-attempt`, receiptPath: path.join(root, `${id}-turn.json`) };
      const session = await plugin.createSession({ tab, cwd: root,
        ...(worker ? { codexTurn: binding, initialInput: { prompt: "Keep the original Forge turn pending until the selection is rejected." } } : {}),
        controls: { closeTab: () => undefined, setTabIndicator: () => undefined },
      });
      sessions.push(session);
      session.onData!(text => { if (text.includes("\u001b[6n")) session.write!("\u001b[1;1R"); });
      const recovery = new CodexConversationRecovery(sources.viewPath(id));
      await expect.poll(() => recovery.read()?.sessionId ?? session.snapshot().recentOutput, { timeout: 15_000 }).toMatch(/^[a-f0-9-]{36}$/u);
      return { session, recovery, threadId: recovery.read()!.sessionId, binding };
    };
    const originalTab = await start("original-tab");
    await originalTab.session.handleAction("wait_until_ready", { timeoutMs: 10_000 });
    await originalTab.session.handleAction("enter_text", { text: "Save this retained conversation before selecting another version.", submit: true });
    await expect.poll(async () => completedVerificationTurn(await readVerificationTranscript(originalTab.recovery.read()?.transcriptPath), 0, originalTab.threadId, answer), { timeout: 15_000 }).toBeDefined();
    const retainedTranscript = await fs.readFile(originalTab.recovery.read()!.transcriptPath!, "utf8");
    const firstNewEvent = (await readVerificationTranscript(originalTab.recovery.read()?.transcriptPath)).length;
    const originalWorker = await start("original-worker", true);
    await expect.poll(() => Boolean(pendingWorker), { timeout: 15_000 }).toBe(true);
    expect(readCodexSelection(prefix)).toBeNull();

    const retainedDatabases = new Map<string, Buffer>();
    if (recovering) {
      if (!keepRunning) await Promise.all(sessions.map(session => session.terminate?.()));
      await fs.writeFile(brokenOriginal, "The original CLI fails startup before any version selection.\n");
      for (const file of await fs.readdir(sqliteHome)) {
        if (/^state_.*\.sqlite(?:-wal)?$/u.test(file)) retainedDatabases.set(file, await fs.readFile(path.join(sqliteHome, file)));
      }
      expect(retainedDatabases.size).toBeGreaterThan(0);
      expect(execFileSync(assistantBin, ["--version"], { encoding: "utf8", env }).trim()).toBe("codex-cli 0.0.0");
    }

    if (viewBridge) {
      const bridge = fileURLToPath(new URL("../../helpers/codex-worker-bridge.mjs", import.meta.url));
      viewer = spawn("tail", ["-f", bridge], { stdio: "ignore" });
      await once(viewer, "spawn");
      expect((await fs.readFile(`/proc/${viewer.pid}/cmdline`, "utf8")).split("\0")).toEqual(["tail", "-f", bridge, ""]);
    }
    let output = "";
    const result = await updateCodexInstallation({ assistantBin, prefix, targetVersion: version, env, onOutput: (text: string) => { output += text; } }).catch((error: unknown) => error);

    if (shouldRecover) {
      if (viewBridge) expect([viewer!.exitCode, viewer!.signalCode]).toEqual([null, null]);
      expect(result, output).toMatchObject({ outcome: "updated", activeVersion: version, installedVersion: version, previousVersion: null });
      const selection = readCodexSelection(prefix)!;
      expect(selection.active.version).toBe(version);
      expect(selection.previous).toBeNull();
      expect(resolveSelectedCodexCommand(assistantBin)).toBe(selection.active.assistantBin);
      expect(output).toContain("Original Codex already fails native startup on retained state");
      expect(output).toContain("Native compatibility verified");
      for (const [file, content] of retainedDatabases) expect(await fs.readFile(path.join(sqliteHome, file)), file).toEqual(content);
    } else {
      expect(result, output).toMatchObject({ code: "runtime-verification", usableVersion: "0.0.0" });
      expect(readCodexSelection(prefix)).toBeNull();
      expect(resolveSelectedCodexCommand(assistantBin)).toBe(assistantBin);
    }
    expect(await fs.readFile(entrypoint, "utf8")).toBe(originalExecutable);
    expect(await fs.readFile(manifestPath, "utf8")).toBe(originalManifest);
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(originalConfig);
    expect(await fs.readFile(originalTab.recovery.read()!.transcriptPath!, "utf8")).toBe(retainedTranscript);
    const launchLog = await fs.readFile(commandLog, "utf8");
    const launches = launchLog.trim().split("\n").map(line => JSON.parse(line) as { candidate: boolean; sqliteHome: string; migrated: boolean; rejected: boolean });
    if (recovering) {
      const rejected = launches.findIndex(launch => !launch.candidate && launch.rejected);
      const copiedCandidate = launches.findIndex(launch => launch.candidate && launch.sqliteHome.includes("cloudx-codex-state-verification-"));
      expect(rejected).toBeGreaterThanOrEqual(0);
      if (shouldRecover) {
        expect(copiedCandidate).toBeGreaterThan(rejected);
        expect(launches.filter(launch => launch.candidate).length).toBeGreaterThanOrEqual(8);
      } else {
        expect(copiedCandidate).toBe(-1);
        expect(output).toContain("original Codex sessions are still running");
      }
      expect(launches.some(launch => launch.migrated)).toBe(false);
    } else {
      const migration = launches.find(launch => launch.migrated);
      expect(migration).toMatchObject({ candidate: true, sqliteHome: expect.stringContaining("cloudx-codex-state-verification-") });
      expect(launches).toContainEqual(expect.objectContaining({ candidate: false, sqliteHome: migration!.sqliteHome, rejected: true }));
    }
    const retainedIds: string[] = JSON.parse(execFileSync(python, ["-I", "-S", "-c", `
import json, pathlib, sqlite3, sys
identities = []
for file in pathlib.Path(sys.argv[1]).glob("state_*.sqlite"):
    with sqlite3.connect(file.as_uri() + "?mode=ro", uri=True) as connection:
        assert not connection.execute("SELECT 1 FROM sqlite_schema WHERE name = 'cloudx_incompatible_candidate'").fetchone()
        identities.extend(row[0] for row in connection.execute("SELECT id FROM threads"))
print(json.dumps(identities))
`, sqliteHome], { encoding: "utf8" }));
    expect(retainedIds).toEqual(expect.arrayContaining([originalTab.threadId, originalWorker.threadId]));
    if (shouldRecover) return;
    expect(originalTab.session.snapshot().status).toBe("running");
    expect(originalWorker.session.snapshot().status).toBe("running");

    await originalTab.session.handleAction("wait_until_ready", { timeoutMs: 10_000 });
    await originalTab.session.handleAction("enter_text", { text: "Complete on the original installation after the first selection was rejected.", submit: true });
    await expect.poll(async () => completedVerificationTurn(await readVerificationTranscript(originalTab.recovery.read()?.transcriptPath), firstNewEvent, originalTab.threadId, answer), { timeout: 15_000 }).toBeDefined();
    completeResponse(pendingWorker!, answer);
    let receipt: { status: string; threadId: string; turnId: string } | undefined;
    await expect.poll(async () => {
      try { receipt = JSON.parse(await fs.readFile(originalWorker.binding.receiptPath, "utf8")); } catch { return originalWorker.session.snapshot().recentOutput; }
      return receipt?.status;
    }, { timeout: 15_000 }).toBe("completed");
    expect(receipt!.threadId).toBe(originalWorker.threadId);
    await originalWorker.session.handleAction("finish", { threadId: originalWorker.threadId, turnId: receipt!.turnId });
    expect(originalWorker.session.snapshot().status).toBe("completed");
    expect(originalWorker.session.snapshot().recentOutput).toContain(answer);
    expect(originalTab.recovery.read()!.sessionId).toBe(originalTab.threadId);
    expect(await fs.readFile(commandLog, "utf8")).toBe(launchLog);
  } finally {
    if (viewer?.pid && viewer.exitCode === null && viewer.signalCode === null) {
      const exited = once(viewer, "exit");
      viewer.kill();
      await exited;
    }
    await Promise.all(sessions.map(session => session.terminate?.()));
    await sources.dispose();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 90_000);
