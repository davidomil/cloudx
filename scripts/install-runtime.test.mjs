import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertPinnedTerminalRuntime, assertStoppedService, inspectRuntimeUpdate, prepareRuntimeUpdate } from "./install-runtime.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const state = { LoadState: "loaded", ActiveState: "active", MainPID: "123", InvocationID: "1".repeat(32), ControlGroup: "/user/cloudx.service", WorkingDirectory: "/repo", KillMode: "control-group", SendSIGKILL: "yes" };
function fixture(role = "broker") {
  const receipt = { version: 1, role, pid: 123, invocationId: "1".repeat(32), started: "456", bootId: "boot", brokerProtocol: 1,
    ...(role === "broker" ? { attachmentExitBeforeReady: true } : {}),
    supervisor: { pinned: true, contract: "execution-json-v1", sourceSha256: "a".repeat(64) } };
  const files = {
    [`/data/terminal-runtime/${role}.json`]: JSON.stringify(receipt),
    "/proc/123/stat": `123 (a name) ${["S", ...Array(18).fill("0"), "456"].join(" ")}`,
    "/proc/sys/kernel/random/boot_id": "boot\n",
    "/proc/123/cgroup": "0::/user/cloudx.service\n",
  };
  return { receipt, files, check: () => assertPinnedTerminalRuntime({ dataDir: "/data", role, service: "cloudx.service", state, readFile: file => {
    if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return files[file];
  } }) };
}

it.each(["web", "broker"])("accepts the live %s runtime with a pinned compatible helper", role => {
  expect(fixture(role).check).not.toThrow();
});
it.each([
  ["missing receipt", undefined],
  ["stale PID", { pid: 124 }],
  ["stale start", { started: "455" }],
  ["old boot", { bootId: "old" }],
  ["previous invocation", { invocationId: "2".repeat(32) }],
  ["wrong wire protocol", { brokerProtocol: 2 }],
  ["mutable helper", { supervisor: { pinned: false } }],
])("rejects %s before any mutations", (_reason, change) => {
  const test = fixture();
  if (change) test.files["/data/terminal-runtime/broker.json"] = JSON.stringify({ ...test.receipt, ...change });
  else delete test.files["/data/terminal-runtime/broker.json"];
  expect(test.check).toThrow(/cannot safely survive.*requires confirmation/);
});
it("rejects a receipt from a different service cgroup", () => {
  const test = fixture("web");
  test.files["/proc/123/cgroup"] = "0::/user/other.service";
  expect(test.check).toThrow("current service invocation");
});
it("accepts a confirmed stopped service without reading an old receipt", () => {
  const readFile = vi.fn();
  assertPinnedTerminalRuntime({ state: { ...state, ActiveState: "inactive", MainPID: "0", ControlGroup: "" }, readFile });
  expect(readFile).not.toHaveBeenCalled();
});
it("refuses a live legacy broker even when the web service has stopped", () => {
  const commands = {
    inspect: (_command, args) => Object.entries(args[2] === "cloudx.service" ? { ...state, ActiveState: "inactive", MainPID: "0", ControlGroup: "" } : state).map(([k, v]) => `${k}=${v}`).join("\n"),
    run: vi.fn(),
  };
  expect(() => prepareRuntimeUpdate({ paths: { dataDir: "/nonexistent", repoRoot: "/repo" }, commands, target: { kind: "standard" } })).toThrow("cloudx-terminal.service cannot safely survive");
  expect(commands.run).not.toHaveBeenCalled();
});
it("requires kernel cgroup emptiness after service stop, including descendants", () => {
  const commands = { inspect: () => "LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlGroup=" };
  expect(() => assertStoppedService(commands, "cloudx.service", "/user/cloudx.service", () => "populated 1\n")).toThrow("still owns processes");
  expect(() => assertStoppedService(commands, "cloudx.service", "/user/cloudx.service", () => "populated 0\n")).not.toThrow();
  expect(() => assertStoppedService(commands, "cloudx.service", "/user/cloudx.service", () => { throw Object.assign(new Error(), { code: "ENOENT" }); })).not.toThrow();
});
it("checks the original cgroup even if a stopped service definition disappears", () => {
  const commands = { inspect: () => "LoadState=not-found" };
  expect(() => assertStoppedService(commands, "cloudx.service", "/user/cloudx.service", () => "populated 1\n")).toThrow("still owns processes");
  expect(() => assertStoppedService(commands, "cloudx.service", "/user/cloudx.service", () => "populated 0\n")).not.toThrow();
});
it("keeps the broker alive if recovery state cannot be backed up", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-migrate-")); roots.push(root);
  fs.writeFileSync(path.join(root, "workspace.json"), "{invalid");
  const actions = [];
  const commands = {
    inspect: (_cmd, args) => Object.entries(actions.length && args[2] === "cloudx.service"
      ? { ...state, ActiveState: "inactive", MainPID: "0", ControlGroup: "" } : { ...state, ControlGroup: "/cloudx-migrate-fixture.service" }).map(([k, v]) => `${k}=${v}`).join("\n"),
    run: (_cmd, args) => actions.push(args),
  };
  expect(() => prepareRuntimeUpdate({ paths: { dataDir: root, repoRoot: "/repo" }, commands, target: { kind: "standard" }, migrateTerminals: true, log: () => {} })).toThrow("Invalid recovery state");
  expect(actions).toEqual([]);
});
it("rejects a stopped main PID with surviving service descendants", () => {
  expect(() => assertPinnedTerminalRuntime({ state: { ...state, ActiveState: "inactive", MainPID: "0" }, service: "custom.service", readFile: () => "populated 1\n" })).toThrow("still owns processes");
});
it("rejects migration without the active owner's original cgroup before stopping either service", () => {
  const commands = { inspect: () => Object.entries({ ...state, ControlGroup: "" }).map(([k, v]) => `${k}=${v}`).join("\n"), run: vi.fn() };
  expect(() => prepareRuntimeUpdate({ paths: { repoRoot: "/repo" }, commands, target: { kind: "standard" }, migrateTerminals: true })).toThrow("original service control group");
  expect(commands.run).not.toHaveBeenCalled();
});
it("does not treat missing cgroup.events in an existing group as proof of cleanup", () => {
  const exists = vi.spyOn(fs, "existsSync").mockReturnValue(true);
  try {
    const commands = { inspect: () => "LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlGroup=" };
    expect(() => assertStoppedService(commands, "cloudx.service", "/user/cloudx.service", () => {
      throw Object.assign(new Error("missing cgroup.events"), { code: "ENOENT" });
    })).toThrow("requires unified cgroup.events evidence");
  } finally { exists.mockRestore(); }
});

function migrationFrom(cgroup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-migration-caller-")); roots.push(root);
  fs.writeFileSync(path.join(root, "preserved-state"), "unchanged");
  const stopped = [];
  const commands = {
    inspect: (_command, args) => Object.entries({ ...state, ControlGroup: `/user/${args[2]}`,
      ...(stopped.includes(args[2]) ? { ActiveState: "inactive", MainPID: "0" } : {}),
    }).map(([key, value]) => `${key}=${value}`).join("\n"),
    run: vi.fn((_command, args) => stopped.push(args[2])),
  };
  return {
    root, commands, stopped,
    migrate: () => prepareRuntimeUpdate({ paths: { dataDir: root, repoRoot: "/repo" }, commands,
      target: { kind: "standard" }, migrateTerminals: true, log: () => {},
      readFile: file => {
        if (file !== "/proc/self/cgroup") return "populated 0\n";
        if (cgroup instanceof Error) throw cgroup;
        return cgroup;
      },
    }),
  };
}

it.each([
  ["cloudx.service", ""], ["cloudx.service", "/worker/launch"],
  ["cloudx-terminal.service", ""], ["cloudx-terminal.service", "/shell/child"],
])("refuses migration from %s%s before stopping either service", (service, descendant) => {
  const migration = migrationFrom(`0::/user/${service}${descendant}\n`);
  expect(migration.migrate).toThrow(new RegExp(`${service}.*external terminal`));
  expect(migration.commands.run).not.toHaveBeenCalled();
  expect(fs.readdirSync(migration.root)).toEqual(["preserved-state"]);
  expect(fs.readFileSync(path.join(migration.root, "preserved-state"), "utf8")).toBe("unchanged");
});

it.each([
  "", "invalid", "0::relative\n", "0::/user/../other\n", "0::/one\n0::/two\n",
  "1:name=systemd:/user/external.scope\n", new Error("Permission denied"),
])("refuses migration when caller cgroup evidence cannot be verified: %s", cgroup => {
  const migration = migrationFrom(cgroup);
  expect(migration.migrate).toThrow(/Cannot verify the updater.*control group/);
  expect(migration.commands.run).not.toHaveBeenCalled();
  expect(fs.readdirSync(migration.root)).toEqual(["preserved-state"]);
});

it.each(["/", "/user/external.scope", "/user/cloudx-terminal.service-other", "/user/cloudx.service-other/child"])(
  "allows migration from an external caller at %s", group => {
    const migration = migrationFrom(`0::${group}\n`);
    expect(migration.migrate).not.toThrow();
    expect(migration.stopped).toEqual(["cloudx.service", "cloudx-terminal.service"]);
  },
);

const currentRuntime = { brokerProtocol: 1, supervisorContract: "execution-json-v1", persistentSessions: true };

function plannedRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-runtime-plan-")); roots.push(root);
  const services = { "cloudx.service": { ...state }, "cloudx-terminal.service": { ...state } };
  const web = fixture("web"), broker = fixture("broker");
  const files = { ...web.files, ...broker.files, "/proc/self/cgroup": "0::/user/updater.service\n" };
  const actions = [];
  const options = {
    paths: { dataDir: root, repoRoot: "/repo" }, target: { kind: "standard" }, targetRuntime: currentRuntime,
    log: vi.fn(), commands: {
      inspect: (_command, args) => Object.entries(services[args[2]]).map(([key, value]) => `${key}=${value}`).join("\n"),
      run: vi.fn((_command, args) => {
        actions.push(args[2]);
        services[args[2]] = { ...services[args[2]], ActiveState: "inactive", MainPID: "0" };
      }),
    },
    readFile: file => {
      if (file.startsWith("/sys/fs/cgroup/")) return "populated 0\n";
      const actual = file.startsWith(root) ? file.replace(root, "/data") : file;
      if (!(actual in files)) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT" });
      return files[actual];
    },
  };
  return { root, services, files, actions, options };
}

it("returns a read-only interruption plan for the missing terminal-runtime/web.json incident", () => {
  const f = plannedRuntime();
  delete f.files["/data/terminal-runtime/web.json"];
  const plan = inspectRuntimeUpdate(f.options);
  expect(plan.requiresInterruption).toBe(true);
  expect(plan.blockers).toEqual([]);
  expect(plan.reasons).toEqual([{ service: "cloudx.service", role: "web", message: expect.stringContaining("terminal-runtime/web.json") }]);
  expect(f.actions).toEqual([]);
  expect(fs.readdirSync(f.root)).toEqual([]);
  let refusal;
  try { prepareRuntimeUpdate(f.options); } catch (error) { refusal = error; }
  expect(refusal.code).toBe("CLOUDX_TERMINAL_CONFIRMATION_REQUIRED");
  expect(refusal.plan).toEqual(plan);
  expect(f.actions).toEqual([]);
  expect(prepareRuntimeUpdate({ ...f.options, interruptionConfirmed: true }).plan).toEqual(plan);
  expect(f.actions).toEqual(["cloudx.service"]);
  expect(f.services["cloudx-terminal.service"].ActiveState).toBe("active");
});

it("preserves compatible services even when interruption was previously confirmed", () => {
  const f = plannedRuntime();
  expect(prepareRuntimeUpdate({ ...f.options, interruptionConfirmed: true }).plan.requiresInterruption).toBe(false);
  expect(f.actions).toEqual([]);
});

it.each([undefined, false])("requires managed confirmation before replacing a broker without ordered attachment exits: %s", capability => {
  const f = plannedRuntime();
  const receipt = JSON.parse(f.files["/data/terminal-runtime/broker.json"]);
  f.files["/data/terminal-runtime/broker.json"] = JSON.stringify({ ...receipt, attachmentExitBeforeReady: capability });
  const plan = inspectRuntimeUpdate(f.options);
  expect(plan.requiresInterruption).toBe(true);
  expect(plan.blockers).toEqual([]);
  expect(plan.reasons).toEqual([{ service: "cloudx-terminal.service", role: "broker", message: expect.stringContaining("ordered attachment exit reporting") }]);
  expect(plan.stopServices).toEqual(["cloudx.service", "cloudx-terminal.service"]);
  expect(() => prepareRuntimeUpdate(f.options)).toThrow("Confirm terminal interruption");
  expect(f.actions).toEqual([]);
  expect(prepareRuntimeUpdate({ ...f.options, interruptionConfirmed: true }).plan).toEqual(plan);
  expect(f.actions).toEqual(["cloudx.service", "cloudx-terminal.service"]);
});

it.each([undefined, { ...currentRuntime, persistentSessions: false }, { ...currentRuntime, brokerProtocol: 2 }, { ...currentRuntime, supervisorContract: "old" }])(
  "requires interruption when the selected target cannot use the live runtime: %j", targetRuntime => {
    const f = plannedRuntime();
    const plan = inspectRuntimeUpdate({ ...f.options, targetRuntime });
    expect(plan.reasons).toHaveLength(2);
    expect(plan.reasons.every(reason => reason.message.includes("selected target"))).toBe(true);
    expect(f.actions).toEqual([]);
  },
);

it("does not require receipts or target capability evidence for missing or verified stopped services", () => {
  const f = plannedRuntime();
  f.services["cloudx.service"] = { LoadState: "not-found" };
  f.services["cloudx-terminal.service"] = { ...state, ActiveState: "failed", MainPID: "0" };
  expect(inspectRuntimeUpdate({ ...f.options, targetRuntime: undefined }).requiresInterruption).toBe(false);
  expect(f.actions).toEqual([]);
});

it("migrates an explicitly selected custom service without touching a foreign broker", () => {
  const f = plannedRuntime();
  f.services["custom.service"] = { ...state };
  f.services["cloudx-terminal.service"].WorkingDirectory = "/foreign";
  delete f.files["/data/terminal-runtime/web.json"];
  const result = prepareRuntimeUpdate({ ...f.options, target: { kind: "web", serviceNames: ["custom.service"] }, interruptionConfirmed: true });
  expect(result.plan.services.map(entry => entry.service)).toEqual(["custom.service"]);
  expect(f.actions).toEqual(["custom.service"]);
  expect(f.services["cloudx-terminal.service"].ActiveState).toBe("active");
});

it.each(["cloudx.service", "cloudx-terminal.service"])("blocks a standard update when %s belongs to another checkout", service => {
  const f = plannedRuntime();
  f.services[service].WorkingDirectory = "/foreign";
  expect(inspectRuntimeUpdate(f.options).blockers).toEqual([{ service, message: expect.stringContaining("another checkout") }]);
  expect(() => prepareRuntimeUpdate({ ...f.options, interruptionConfirmed: true })).toThrow("another checkout");
  expect(f.actions).toEqual([]);
});

it("checks active Forge work and recovery paths during planning, before service stops", () => {
  const f = plannedRuntime();
  delete f.files["/data/terminal-runtime/web.json"];
  fs.mkdirSync(path.join(f.root, "forge-workers/workspaces"), { recursive: true });
  fs.writeFileSync(path.join(f.root, "forge-workers/workspaces/worker.json"), JSON.stringify({ id: "worker", launchPending: true, gitPending: false, cleaned: false }));
  expect(inspectRuntimeUpdate(f.options).blockers[0].message).toContain("pending launch or Git operation");
  expect(() => prepareRuntimeUpdate({ ...f.options, interruptionConfirmed: true })).toThrow("pending launch");
  expect(f.actions).toEqual([]);
  fs.rmSync(path.join(f.root, "forge-workers"), { recursive: true });
  fs.symlinkSync("/etc/passwd", path.join(f.root, "sessions.json"));
  expect(inspectRuntimeUpdate(f.options).blockers[0].message).toContain("owned regular file");
  expect(f.actions).toEqual([]);
});

it("discloses lost legacy identities and snapshots exact layouts after confirmation", () => {
  const f = plannedRuntime();
  const bytes = '{"windows":[{"id":"old-window","layout":{"root":{"type":"pane","id":"old-pane","tabIds":["old-tab"]}}}]}\n';
  fs.writeFileSync(path.join(f.root, "workspace.json"), bytes);
  delete f.files["/data/terminal-runtime/web.json"];
  const plan = inspectRuntimeUpdate(f.options);
  expect(plan.blockers).toEqual([]);
  expect(plan.recovery.legacySessionIdentitiesUnavailable).toBe(true);
  expect(plan.recovery.warnings.join(" ")).toContain("cannot be restored");
  expect(() => prepareRuntimeUpdate(f.options)).toThrow("Confirm terminal interruption");
  expect(fs.readdirSync(f.root)).toEqual(["workspace.json"]);
  const { recoverySnapshot } = prepareRuntimeUpdate({ ...f.options, interruptionConfirmed: true });
  expect(fs.readFileSync(path.join(recoverySnapshot, "workspace.json"), "utf8")).toBe(bytes);
  expect(fs.readFileSync(path.join(f.root, "workspace.json"), "utf8")).toBe(bytes);
  expect(fs.existsSync(path.join(f.root, "sessions.json"))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(recoverySnapshot, "manifest.json"), "utf8")).legacySessionIdentitiesUnavailable).toBe(true);
});

it("does not stop services or write a recovery snapshot during a dry run", () => {
  const f = plannedRuntime();
  delete f.files["/data/terminal-runtime/web.json"];
  prepareRuntimeUpdate({ ...f.options, interruptionConfirmed: true, dryRun: true });
  expect(f.actions).toEqual([]);
  expect(fs.readdirSync(f.root)).toEqual([]);
});

it("accepts mixed termination but reports unsafe legacy termination and unstable units before stopping", () => {
  const f = plannedRuntime();
  delete f.files["/data/terminal-runtime/web.json"];
  f.services["cloudx.service"].KillMode = "mixed";
  expect(inspectRuntimeUpdate(f.options).blockers).toEqual([]);
  f.services["cloudx.service"].KillMode = "process";
  expect(inspectRuntimeUpdate(f.options).blockers[0].message).toContain("termination policy");
  f.services["cloudx.service"].ActiveState = "deactivating";
  expect(inspectRuntimeUpdate(f.options).blockers[0].message).toContain("not stable");
  expect(f.actions).toEqual([]);
});
