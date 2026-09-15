import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InstallerRunner,
  parseArgs,
  ubuntuBootstrapPlan,
} from "./install-cloudx.mjs";
import { SERVICE_NAMES, inspectUpdateCheckout } from "./install-update.mjs";
import {
  SettingsUpdater,
  UPDATE_TIMEOUT_MS,
  UPDATE_UNIT,
  processBelongsToService,
} from "./settings-update.mjs";

const temporary = [];
afterEach(() =>
  temporary
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);

function installation() {
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx-settings-update-"),
  );
  temporary.push(home);
  const repoRoot = path.join(home, "checkout");
  const dataDir = path.join(repoRoot, ".cloudx");
  const systemdDir = path.join(home, ".config/systemd/user");
  const envPath = path.join(home, ".config/cloudx/cloudx.env");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(systemdDir, { recursive: true });
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, `CLOUDX_DATA_DIR=${dataDir}\n`);
  SERVICE_NAMES.forEach((name) =>
    fs.writeFileSync(path.join(systemdDir, name), "installed unit\n"),
  );
  const calls = [];
  const host = {
    unit: { LoadState: "not-found", ActiveState: "inactive" },
    now: new Date("2026-09-15T12:00:00.000Z"),
    dirty: false,
    sudo: true,
    launch: true,
    installer: () => {},
  };
  const options = {
    repoRoot,
    home,
    dataDir,
    serverPid: 456,
    now: () => host.now,
    readCgroup: (pid) =>
      pid === process.pid
        ? "0::/user.slice/cloudx-settings-update.service\n"
        : "0::/user.slice/cloudx.service\n",
    commands: {
      inspect(command, args, commandOptions) {
        calls.push([command, args, commandOptions]);
        if (command === "systemctl") {
          const name = args[2];
          const state =
            name === UPDATE_UNIT
              ? host.unit
              : {
                  Id: name,
                  LoadState: "loaded",
                  WorkingDirectory: repoRoot,
                  EnvironmentFiles: `${envPath} (ignore_errors=no)`,
                  FragmentPath: path.join(systemdDir, name),
                  NeedDaemonReload: "no",
                  DropInPaths: "",
                  ActiveState: "active",
                  MainPID: "123",
                  ControlGroup: "/user.slice/cloudx.service",
                  ...host.service,
                };
          return Object.entries(state)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n");
        }
        if (command === "sudo") {
          if (!host.sudo) throw new Error("sensitive command output");
          return "";
        }
        if (command === "git") {
          if (args[0] === "status") return host.dirty ? " M source.ts" : "";
          if (args.includes("--show-toplevel")) return repoRoot;
          if (args.includes("HEAD")) return "a".repeat(40);
          throw new Error("Unexpected mutating Git command");
        }
        if (command === "systemd-run") {
          if (typeof host.launch === "function") return host.launch(args);
          if (!host.launch) throw new Error("secret host failure");
          host.unit = {
            LoadState: "loaded",
            ActiveState: "active",
            Description: args
              .find((arg) => arg.startsWith("--description="))
              .slice(14),
            ControlGroup: "/user.slice/cloudx-settings-update.service",
          };
          return "";
        }
        if (command === process.execPath)
          return host.installer(args, commandOptions);
        throw new Error(`Unexpected command: ${command}`);
      },
    },
  };
  return {
    updater: new SettingsUpdater(options),
    options,
    host,
    calls,
    repoRoot,
    home,
    systemdDir,
    envPath,
  };
}

describe("installed Settings updater", () => {
  it("recognizes the Node child of the standard npm service without requiring MainPID equality", () => {
    const fixture = installation();
    expect(fixture.updater.status()).toEqual({ available: true });
    expect(
      fixture.calls.some(
        ([command, args]) => command === "sudo" && args.join(" ") === "-n true",
      ),
    ).toBe(true);
    expect(fixture.calls.some(([command]) => command === "git")).toBe(false);
  });

  it.each([
    ["other checkout", { WorkingDirectory: "/tmp" }],
    [
      "custom environment",
      { EnvironmentFiles: "/tmp/custom.env (ignore_errors=no)" },
    ],
    ["custom unit", { FragmentPath: "/tmp/custom.service" }],
    ["drop-ins", { DropInPaths: "/tmp/custom.conf" }],
    ["unloaded unit", { LoadState: "not-found" }],
    ["unconfirmed unit", { NeedDaemonReload: "yes" }],
    ["different cgroup", { ControlGroup: "/user.slice/other.service" }],
    ["inactive web service", { ActiveState: "inactive" }],
  ])("disables %s without launching anything", (_name, service) => {
    const { updater, host, calls } = installation();
    host.service = service;
    expect(updater.start()).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining("standard installed"),
    });
    expect(calls.every(([command]) => command === "systemctl")).toBe(true);
  });

  it("rejects a missing terminal service and mismatched persisted data directory", () => {
    const first = installation();
    fs.rmSync(path.join(first.systemdDir, "cloudx-terminal.service"));
    expect(first.updater.status().available).toBe(false);
    const second = installation();
    second.updater.dataDir = second.home;
    expect(second.updater.status().available).toBe(false);
  });

  it("provides a useful manual-checkout explanation when user systemd is unavailable", () => {
    const fixture = installation();
    fs.rmSync(fixture.systemdDir, { recursive: true });
    fixture.updater.commands = {
      inspect() {
        throw new Error("No user bus");
      },
    };
    expect(fixture.updater.status()).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining(
        "development or custom services",
      ),
    });
  });

  it("refuses password-requiring sudo before Git or a launch", () => {
    const { updater, host, calls } = installation();
    host.sudo = false;
    expect(updater.start()).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining("non-interactive sudo"),
    });
    expect(
      calls.some(([command]) => ["git", "systemd-run"].includes(command)),
    ).toBe(false);
  });

  it("uses the shared clean checkout guard without fetching or merging in the request", () => {
    const fixture = installation();
    fixture.host.dirty = true;
    expect(() =>
      inspectUpdateCheckout(fixture.options.commands, fixture.repoRoot),
    ).toThrow("local changes");
    expect(fixture.updater.start()).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining("checkout must be clean"),
    });
    expect(fixture.calls.some(([command]) => command === "systemd-run")).toBe(
      false,
    );
  });

  it("launches an independent bounded service and reconnects to the same durable run", () => {
    const { updater, options, calls, repoRoot } = installation();
    const first = updater.start();
    expect(first).toMatchObject({ available: true, run: { state: "running" } });
    const restartedServer = new SettingsUpdater({ ...options, serverPid: 789 });
    expect(restartedServer.start()).toEqual(first);
    const launches = calls.filter(([command]) => command === "systemd-run");
    expect(launches).toHaveLength(1);
    expect(launches[0][1]).toEqual(
      expect.arrayContaining([
        "--user",
        "--collect",
        "--property=Type=exec",
        `--unit=${UPDATE_UNIT}`,
        `--property=RuntimeMaxSec=${UPDATE_TIMEOUT_MS / 1000}`,
        "--property=KillMode=control-group",
        path.join(repoRoot, "scripts/settings-update.mjs"),
        "run",
        first.run.id,
      ]),
    );
    expect(path.relative(repoRoot, updater.stateDir).startsWith("..")).toBe(
      true,
    );
    expect(fs.statSync(updater.recordPath(first.run.id)).mode & 0o777).toBe(
      0o600,
    );
    expect(
      calls.some(
        ([command, args]) =>
          command === "systemctl" && args.includes("restart"),
      ),
    ).toBe(false);
  });

  it("persists launch failure without exposing command output", () => {
    const { updater, host } = installation();
    host.launch = false;
    const started = updater.start();
    expect(started.run).toMatchObject({
      state: "failed",
      finishedAt: host.now.toISOString(),
    });
    expect(updater.status().run).toEqual(started.run);
    expect(JSON.stringify(started)).not.toContain("secret");
  });

  it("returns the winning run if another start wins the fixed-unit launch race", () => {
    const { updater, options, host } = installation();
    const first = updater.start();
    const active = host.unit;
    host.unit = { LoadState: "not-found", ActiveState: "inactive" };
    updater.finish(updater.read(first.run.id), "failed", "Test stale state");
    host.launch = () => {
      host.unit = active;
      const winner = updater.read(first.run.id);
      winner.run.state = "running";
      updater.save(winner);
      throw new Error("Unit already exists");
    };
    expect(new SettingsUpdater(options).start().run.id).toBe(first.run.id);
  });

  it("keeps the winner after it completes while a concurrent launch fails", () => {
    const { updater, options, host } = installation();
    let winnerId;
    let loser;
    host.launch = (args) => {
      if (winnerId) {
        updater.run(winnerId);
        host.unit = { LoadState: "not-found", ActiveState: "inactive" };
        throw new Error("Unit was already loaded when submitted");
      }
      winnerId = args.at(-1);
      host.unit = {
        LoadState: "loaded",
        ActiveState: "active",
        Description: `CloudX Settings update ${winnerId}`,
        ControlGroup: "/user.slice/cloudx-settings-update.service",
      };
      const concurrent = new SettingsUpdater(options);
      concurrent.status = () => {
        updater.publish(updater.read(winnerId));
        return { available: true };
      };
      const inspectUnit = concurrent.unit.bind(concurrent);
      let inspections = 0;
      concurrent.unit = () =>
        inspections++ === 0 ? { running: false } : inspectUnit();
      loser = concurrent.start();
      return "";
    };
    expect(updater.start().run).toMatchObject({
      id: winnerId,
      state: "succeeded",
    });
    expect(loser.run.state).toBe("failed");
    expect(new SettingsUpdater(options).status().run).toMatchObject({
      id: winnerId,
      state: "succeeded",
    });
  });

  it.each([false, true])(
    "preserves an accepted job when the launch reply is lost, completed=%s",
    (completed) => {
      const { updater, host } = installation();
      host.launch = (args) => {
        const id = args.at(-1);
        host.unit = {
          LoadState: "loaded",
          ActiveState: "active",
          Description: `CloudX Settings update ${id}`,
          ControlGroup: "/user.slice/cloudx-settings-update.service",
        };
        if (completed) {
          updater.run(id);
          host.unit = { LoadState: "not-found", ActiveState: "inactive" };
        }
        throw new Error("Timed out waiting for launch acknowledgement");
      };
      expect(updater.start().run.state).toBe(
        completed ? "succeeded" : "running",
      );
    },
  );

  it("reconciles an interrupted job after the launch grace period", () => {
    const { updater, host, options } = installation();
    const started = updater.start();
    host.unit = { LoadState: "not-found", ActiveState: "inactive" };
    expect(updater.status().run.state).toBe("running");
    host.now = new Date(host.now.getTime() + 30000);
    expect(new SettingsUpdater(options).status().run).toMatchObject({
      id: started.run.id,
      state: "failed",
      message: expect.stringContaining("interrupted"),
    });
  });

  it.each([true, false])(
    "reports installer success=%s only after the bounded installer exits",
    (succeeds) => {
      const { updater, host, calls, repoRoot } = installation();
      const started = updater.start();
      host.installer = (args, options) => {
        expect(updater.status().run.state).toBe("running");
        expect(args).toEqual([
          path.join(repoRoot, "scripts/install-cloudx.mjs"),
          "--update",
          "--yes",
          "--non-interactive",
          "--answers",
          expect.any(String),
        ]);
        expect(JSON.parse(fs.readFileSync(args.at(-1), "utf8"))).toEqual({
          runCodexLogin: false,
          restartServices: true,
        });
        expect(options.timeout).toBeLessThan(UPDATE_TIMEOUT_MS);
        expect(options.stdio[0]).toBe("ignore");
        expect(options.env.CLOUDX_INSTALL_UPDATED_COMMIT).toBeUndefined();
        if (!succeeds) throw new Error("secret installer details");
        return "";
      };
      const completed = updater.run(started.run.id);
      expect(completed.state).toBe(succeeds ? "succeeded" : "failed");
      expect(completed.finishedAt).toBe(host.now.toISOString());
      expect(updater.status().run).toEqual(completed);
      expect(JSON.stringify(completed)).not.toContain("secret");
      expect(
        calls.filter(([command]) => command === process.execPath),
      ).toHaveLength(1);
      expect(
        fs.existsSync(
          path.join(updater.stateDir, `${started.run.id}.answers.json`),
        ),
      ).toBe(false);
    },
  );

  it("revalidates service ownership in the detached worker before invoking the installer", () => {
    const { updater, host, calls } = installation();
    const started = updater.start();
    host.service = { DropInPaths: "/tmp/new-custom-unit.conf" };
    expect(updater.run(started.run.id).state).toBe("failed");
    expect(calls.some(([command]) => command === process.execPath)).toBe(false);
  });

  it("rejects browser-shaped worker IDs and workers outside their managed cgroup", () => {
    const { updater } = installation();
    expect(() => updater.run("../../anything")).toThrow(
      "Invalid update run identifier",
    );
    const started = updater.start();
    updater.readCgroup = () => "0::/user.slice/unrelated.service\n";
    expect(() => updater.run(started.run.id)).toThrow("managed service");
  });
});

describe("unattended installer execution", () => {
  it("requires update mode and applies non-interactive sudo to commands", () => {
    expect(() => parseArgs(["--non-interactive"])).toThrow("requires --update");
    expect(parseArgs(["--update", "--non-interactive"])).toMatchObject({
      update: true,
      nonInteractive: true,
    });
    const runner = new InstallerRunner({
      dryRun: true,
      nonInteractive: true,
      log: () => {},
    });
    runner.run("sudo", ["apt-get", "update"]);
    runner.run("sudo", ["-n", "true"]);
    expect(runner.commands.map(({ args }) => args)).toEqual([
      ["-n", "apt-get", "update"],
      ["-n", "true"],
    ]);
    expect(
      ubuntuBootstrapPlan({ nonInteractive: true }).find(
        ([command]) => command === "sh",
      )[2],
    ).toContain("sudo -n -E bash");
  });

  it("checks cgroup membership at a service boundary on cgroup v1 and v2", () => {
    expect(
      processBelongsToService(
        "0::/user/cloudx.service/child\n",
        "/user/cloudx.service",
      ),
    ).toBe(true);
    expect(
      processBelongsToService(
        "3:name=systemd:/user/cloudx.service\n",
        "/user/cloudx.service",
      ),
    ).toBe(true);
    expect(
      processBelongsToService(
        "0::/user/cloudx.service-other\n",
        "/user/cloudx.service",
      ),
    ).toBe(false);
    expect(
      processBelongsToService(
        "3:cpu:/user/cloudx.service\n",
        "/user/cloudx.service",
      ),
    ).toBe(false);
    expect(processBelongsToService("0::/anything\n", "/")).toBe(false);
  });
});
