import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertPinnedTerminalRuntime, assertStoppedService, prepareRuntimeUpdate } from "./install-runtime.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const state = { LoadState: "loaded", ActiveState: "active", MainPID: "123", InvocationID: "1".repeat(32), ControlGroup: "/user/cloudx.service", WorkingDirectory: "/repo", KillMode: "control-group", SendSIGKILL: "yes" };
function fixture(role = "broker") {
  const receipt = { version: 1, role, pid: 123, invocationId: "1".repeat(32), started: "456", bootId: "boot", brokerProtocol: 1,
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
  expect(test.check).toThrow(/cannot safely survive.*--migrate-terminals/);
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
it("keeps the broker alive if recovery state cannot be backed up", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-migrate-")); roots.push(root);
  fs.writeFileSync(path.join(root, "workspace.json"), "{}");
  const actions = [];
  const commands = {
    inspect: (_cmd, args) => Object.entries(actions.length && args[2] === "cloudx.service"
      ? { ...state, ActiveState: "inactive", MainPID: "0", ControlGroup: "" } : { ...state, ControlGroup: "/cloudx-migrate-fixture.service" }).map(([k, v]) => `${k}=${v}`).join("\n"),
    run: (_cmd, args) => actions.push(args),
  };
  expect(() => prepareRuntimeUpdate({ paths: { dataDir: root, repoRoot: "/repo" }, commands, target: { kind: "standard" }, migrateTerminals: true, log: () => {} })).toThrow("Legacy workspace has no saved session identities");
  expect(actions).toEqual([["--user", "stop", "cloudx.service"]]);
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
