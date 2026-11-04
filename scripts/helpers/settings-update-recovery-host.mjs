// Host adapters for the Settings deadline regression. Recovery code runs unchanged.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsUpdater, UPDATE_UNIT } from "../settings-update.mjs";
import { inspectRuntimeUpdate } from "../install-runtime.mjs";

const root = process.env.CLOUDX_TEST_RECOVERY_ROOT;
if (!path.isAbsolute(root ?? "")) throw new Error("Missing isolated recovery fixture.");
const repoRoot = path.join(root, "checkout"), dataDir = path.join(root, "data"), home = path.join(root, "home");
const [action, suppliedDataDir, serverPid, targetCommit, ...flags] = process.argv.slice(2);
if (suppliedDataDir !== dataDir) throw new Error("Recovery fixture data directory changed.");
const events = path.join(root, "events.jsonl");
const event = value => fs.appendFileSync(events, `${JSON.stringify({ action, at: Date.now(), ...value })}\n`);
const unitPath = path.join(root, "unit.json");
const transcriptPath = fs.readFileSync(path.join(root, "transcript-path"), "utf8");
const historyPath = path.join(dataDir, "forge-workers/history/retained.json");
const read = fs.readSync;
let announcedTranscript = false, announcedHistory = false;
fs.readSync = (fd, ...args) => {
  const file = fs.readlinkSync(`/proc/self/fd/${fd}`);
  if (file === transcriptPath) {
    if (!announcedTranscript) { event({ kind: "transcript-read" }); announcedTranscript = true; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 125);
  }
  if (file === historyPath && !announcedHistory) { event({ kind: "history-read" }); announcedHistory = true; }
  return read(fd, ...args);
};

const commands = {
  inspect(command, args) {
    if (command === "systemctl" && args[1] === "show") {
      const service = args[2];
      const state = service === UPDATE_UNIT
        ? fs.existsSync(unitPath) ? JSON.parse(fs.readFileSync(unitPath, "utf8")) : { LoadState: "not-found", ActiveState: "inactive" }
        : { Id: service, LoadState: "loaded", ActiveState: "active", MainPID: "123", InvocationID: "a".repeat(32),
          ControlGroup: `/cloudx-test/${service}`, KillMode: "control-group", SendSIGKILL: "yes", WorkingDirectory: repoRoot,
          EnvironmentFiles: `${home}/.config/cloudx/cloudx.env (ignore_errors=no)`,
          FragmentPath: path.join(home, ".config/systemd/user", service), NeedDaemonReload: "no", DropInPaths: "" };
      return Object.entries(state).map(([key, value]) => `${key}=${value}`).join("\n");
    }
    if (command === "systemd-run") {
      const description = args.find(value => value.startsWith("--description=")).slice(14);
      fs.writeFileSync(unitPath, JSON.stringify({ LoadState: "loaded", ActiveState: "active", Description: description,
        ControlGroup: "/cloudx-test/update" }));
      const output = fs.openSync(path.join(root, "worker.log"), "a");
      try {
        const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker", dataDir], {
          env: process.env, detached: true, stdio: ["ignore", output, output],
        });
        fs.writeFileSync(path.join(root, "worker-pid"), String(worker.pid));
        worker.unref();
      } finally { fs.closeSync(output); }
      event({ kind: "launched" });
      return "";
    }
    event({ kind: "unexpected-command", command, args });
    throw new Error(`Unexpected recovery fixture command: ${command}`);
  },
  run(command, args) {
    event({ kind: "service-change", command, args });
    throw new Error("This regression must not change services.");
  },
};

if (action === "worker") {
  const started = Date.now();
  const plan = inspectRuntimeUpdate({ paths: { repoRoot, dataDir }, commands, target: { kind: "standard" },
    log: message => event({ kind: "progress", message }) });
  fs.writeFileSync(path.join(root, "worker-result.tmp"), JSON.stringify({ elapsedMs: Date.now() - started, plan }));
  fs.renameSync(path.join(root, "worker-result.tmp"), path.join(root, "worker-result.json"));
} else {
  const updater = new SettingsUpdater({ repoRoot, home, dataDir, serverPid, commands,
    readCgroup: () => "0::/cloudx-test/cloudx.service\n",
    stageCoordinator: record => {
      const coordinator = path.join(home, ".local/state/cloudx/settings-update", record.run.id, "fixture-coordinator");
      fs.mkdirSync(coordinator, { recursive: true });
      fs.writeFileSync(path.join(coordinator, "bundle.json"), "[]");
      return coordinator;
    } });
  const result = action === "status" ? updater.status() : action === "start"
    ? updater.start(targetCommit, { confirmInterruption: flags.includes("--confirm-interruption") })
    : (() => { throw new Error("Invalid recovery fixture action."); })();
  console.log(JSON.stringify(result));
}
