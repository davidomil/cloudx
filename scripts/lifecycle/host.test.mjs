import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectUpdateTarget, SERVICE_NAMES } from "../install-update.mjs";
import {
  DisposableHost,
  makeEvidenceReadable,
  parseHostArgs,
  requireVacantPorts,
  runLifecycle,
} from "./host.mjs";

const source = "a".repeat(40),
  target = "b".repeat(40);
const temporary = [];
const directory = () => {
  const value = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx-lifecycle-host-test-"),
  );
  temporary.push(value);
  return value;
};
afterEach(() => {
  for (const root of temporary.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("disposable lifecycle host", () => {
  const args = (scenario = "upgrade") => [
    "--disposable-host",
    "--scenario",
    scenario,
    "--source",
    source,
    "--target",
    target,
    "--evidence",
    "/tmp/evidence",
  ];

  it("requires explicit disposable-host consent, exact revisions, and a real upgrade", () => {
    expect(parseHostArgs(args())).toEqual({
      disposableHost: true,
      scenario: "upgrade",
      source,
      target,
      evidence: "/tmp/evidence",
    });
    expect(() => parseHostArgs(args().slice(1))).toThrow(
      "--disposable-host is required",
    );
    expect(() =>
      parseHostArgs(args().map((value) => (value === source ? "main" : value))),
    ).toThrow("immutable full Git commit SHA");
    expect(() =>
      parseHostArgs(args().map((value) => (value === source ? target : value))),
    ).toThrow("must differ");
    expect(() => parseHostArgs([...args(), "--target", target])).toThrow(
      "Duplicate option",
    );
    expect(
      parseHostArgs(
        args("install").map((value) => (value === source ? target : value)),
      ).target,
    ).toBe(target);
  });

  it("fails instead of reusing an already-running application service", async () => {
    const occupied = net.createServer();
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    try {
      await expect(
        requireVacantPorts([occupied.address().port]),
      ).rejects.toThrow("no running CloudX installation");
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
    }
    await expect(requireVacantPorts([0])).resolves.toBeUndefined();
  });

  it.each(["requirePrerequisites", "provision", "install"])(
    "retains evidence and performs cleanup after %s fails",
    async (stage) => {
      const host = lifecycleFixture();
      host[stage].mockRejectedValue(new Error(`${stage} failed`));
      const scenario = vi.fn();
      await expect(runLifecycle(host, scenario)).rejects.toThrow(
        `${stage} failed`,
      );
      expect(scenario).not.toHaveBeenCalled();
      expect(host.collectEvidence).toHaveBeenCalledOnce();
      expect(host.cleanup).toHaveBeenCalledOnce();
      expect(host.makeEvidenceReadable).toHaveBeenCalledOnce();
      expect(host.summaries.at(-1)).toMatchObject({
        result: "failed",
        source,
        target,
        error: `${stage} failed`,
      });
      expect(host.collectEvidence.mock.invocationCallOrder[0]).toBeLessThan(
        host.cleanup.mock.invocationCallOrder[0],
      );
      expect(host.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
        host.makeEvidenceReadable.mock.invocationCallOrder[0],
      );
    },
  );

  it("does not turn a failed readiness assertion into a passing host run", async () => {
    const host = lifecycleFixture();
    await expect(
      runLifecycle(host, async () => {
        throw new Error("Target readiness failed");
      }),
    ).rejects.toThrow("Target readiness failed");
    expect(host.summaries.at(-1)).toMatchObject({
      result: "failed",
      phase: "scenario",
    });
    expect(host.cleanup).toHaveBeenCalledOnce();
    expect(host.makeEvidenceReadable).toHaveBeenCalledOnce();
  });

  it("runs cleanup even when evidence collection fails, and rejects cleanup failure", async () => {
    const host = lifecycleFixture();
    host.collectEvidence.mockRejectedValue(new Error("Cannot collect journal"));
    host.cleanup.mockRejectedValue(new Error("Cannot delete account"));
    await expect(
      runLifecycle(host, async () => ({ ready: true })),
    ).rejects.toThrow("Cannot collect journal");
    expect(host.summaries.at(-1)).toMatchObject({
      result: "failed",
      evidenceError: "Cannot collect journal",
      cleanupError: "Cannot delete account",
    });
    expect(host.cleanup).toHaveBeenCalledOnce();
  });

  it("records passing validation only after the scenario and cleanup finish", async () => {
    const host = lifecycleFixture();
    const summary = await runLifecycle(host, async () => ({
      ready: true,
      commit: target,
    }));
    expect(summary).toMatchObject({
      result: "passed",
      validation: { ready: true, commit: target },
    });
    expect(host.summaries[0].result).toBe("running");
    expect(host.summaries.at(-1)).toEqual(summary);
  });

  it("runs the installed checkout's own unattended CPU installer", async () => {
    const evidence = directory(),
      host = new DisposableHost({
        scenario: "upgrade",
        source,
        target,
        evidence,
      });
    host.home = directory();
    host.runAsUser = vi.fn().mockResolvedValue("");
    await host.install();
    const [command, argv, options] = host.runAsUser.mock.calls[0];
    expect(command).toBe("./install.sh");
    expect(argv.slice(0, 2)).toEqual(["--yes", "--answers"]);
    expect(JSON.parse(fs.readFileSync(argv[2], "utf8"))).toMatchObject({
      useGpu: false,
      installWhisperCpp: false,
      installServices: true,
      startServices: true,
    });
    expect(options).toMatchObject({
      timeout: 45 * 60_000,
      log: path.join(evidence, "installer.log"),
    });
    expect(host.controllerEnvironment()).not.toHaveProperty("OPENAI_API_KEY");
    expect(host.controllerEnvironment()).not.toHaveProperty(
      "CLOUDX_ASSISTANT_BIN",
    );
  });

  it("pins the catalog without making standard installed services fail update preflight", async () => {
    const host = new DisposableHost({
      scenario: "upgrade",
      source,
      target,
      evidence: directory(),
    });
    host.home = directory();
    host.repoRoot = directory();
    const paths = {
      repoRoot: host.repoRoot,
      envPath: path.join(host.home, ".config/cloudx/cloudx.env"),
      systemdDir: path.join(host.home, ".config/systemd/user"),
    };
    fs.mkdirSync(path.dirname(paths.envPath), { recursive: true });
    fs.mkdirSync(paths.systemdDir, { recursive: true });
    fs.writeFileSync(paths.envPath, "CLOUDX_PORT=3001\n");
    for (const unit of SERVICE_NAMES)
      fs.writeFileSync(path.join(paths.systemdDir, unit), "[Service]\n");
    const managerEnvironment = {};
    host.runAsUser = vi.fn(async (command, args) => {
      expect([command, ...args.slice(0, 2)]).toEqual([
        "systemctl",
        "--user",
        "set-environment",
      ]);
      for (const assignment of args.slice(2)) {
        const equal = assignment.indexOf("=");
        managerEnvironment[assignment.slice(0, equal)] = assignment.slice(
          equal + 1,
        );
      }
    });
    await host.prepareCatalog();

    const commands = {
      inspect: (_command, args) => {
        const unit = args[2],
          dropIns = path.join(paths.systemdDir, `${unit}.d`);
        return Object.entries({
          LoadState: "loaded",
          NeedDaemonReload: "no",
          WorkingDirectory: paths.repoRoot,
          FragmentPath: path.join(paths.systemdDir, unit),
          EnvironmentFiles: `${paths.envPath} (ignore_errors=no)`,
          DropInPaths: fs.existsSync(dropIns)
            ? fs
                .readdirSync(dropIns)
                .map((file) => path.join(dropIns, file))
                .join(" ")
            : "",
        })
          .map(([key, value]) => `${key}=${value}`)
          .join("\n");
      },
    };
    expect(inspectUpdateTarget({ paths, commands }).kind).toBe("standard");
    expect(managerEnvironment.NODE_OPTIONS).toContain("--import=");
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "console.log(await (await fetch('https://api.github.com/repos/davidomil/cloudx/commits/main')).text())",
      ],
      {
        env: { PATH: process.env.PATH, ...managerEnvironment },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ sha: target });
  });

  it("preserves Git porcelain bytes from a real child process", async () => {
    const host = new DisposableHost({
      scenario: "upgrade",
      source,
      target,
      evidence: directory(),
    });
    const status = " M README.md\0?? local-work.txt\0";
    const output = await host.command(process.execPath, [
      "-e",
      `process.stdout.write(${JSON.stringify(status)})`,
    ]);
    expect(output).toBe(status);
  });

  it("fails the gate and retains the log when the installer process exits with an error", async () => {
    const evidence = directory();
    const commands = new DisposableHost({
      scenario: "upgrade",
      source,
      target,
      evidence,
    });
    const fixture = directory();
    fs.writeFileSync(
      path.join(fixture, "install.sh"),
      "#!/bin/sh\necho 'synthetic installer failure' >&2\nexit 23\n",
      { mode: 0o700 },
    );
    commands.home = fixture;
    commands.runAsUser = (command, args, options) =>
      commands.command(command, args, { ...options, cwd: fixture });
    const host = lifecycleFixture();
    host.install = () => commands.install();
    const scenario = vi.fn();
    await expect(runLifecycle(host, scenario)).rejects.toThrow("exited 23");
    expect(host.summaries.at(-1)).toMatchObject({
      phase: "install",
      result: "failed",
    });
    expect(scenario).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(path.join(evidence, "installer.log"), "utf8"),
    ).toContain("synthetic installer failure");
  });

  it("makes private trace and JSON files readable by the evidence owner", () => {
    const evidence = directory(),
      nested = path.join(evidence, "traces");
    fs.mkdirSync(nested, { mode: 0o700 });
    fs.writeFileSync(path.join(nested, "trace.zip"), "synthetic trace", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(evidence, "scenario.json"), "{}", {
      mode: 0o600,
    });
    const owner = { uid: process.getuid(), gid: process.getgid() };
    makeEvidenceReadable(evidence, owner);
    for (const file of [
      path.join(nested, "trace.zip"),
      path.join(evidence, "scenario.json"),
    ]) {
      expect(fs.statSync(file)).toMatchObject(owner);
      expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    }
    expect(fs.statSync(nested).mode & 0o777).toBe(0o750);
  });

  it("never changes permissions on files outside evidence through a symlink", () => {
    const evidence = directory(),
      outside = path.join(directory(), "credentials");
    fs.writeFileSync(outside, "private", { mode: 0o600 });
    fs.symlinkSync(outside, path.join(evidence, "unexpected-link"));
    expect(() =>
      makeEvidenceReadable(evidence, {
        uid: process.getuid(),
        gid: process.getgid(),
      }),
    ).toThrow("must not contain symbolic links");
    expect(fs.statSync(outside).mode & 0o777).toBe(0o600);
  });

  it("terminates a child command when its deadline expires", async () => {
    const host = new DisposableHost({
      scenario: "upgrade",
      source,
      target,
      evidence: directory(),
    });
    await expect(
      host.command(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeout: 30,
      }),
    ).rejects.toThrow("exceeded 30ms");
  });

  it("keeps receipts and updater logs without archiving credentials, snapshots, or conversation files", () => {
    const host = new DisposableHost({
      scenario: "upgrade",
      source,
      target,
      evidence: directory(),
    });
    const data = directory(),
      evidence = directory();
    fs.writeFileSync(
      path.join(data, "run.json"),
      JSON.stringify({
        run: { state: "failed" },
        transition: {
          environmentText: "TOKEN=private",
          environment: { TOKEN: "private" },
        },
      }),
    );
    fs.writeFileSync(path.join(data, "updater.log"), "readiness failed\n");
    fs.mkdirSync(path.join(data, "snapshot-profile"));
    fs.writeFileSync(
      path.join(data, "snapshot-profile", "conversation.json"),
      "private",
    );
    fs.symlinkSync(
      path.join(data, "snapshot-profile"),
      path.join(data, "linked-profile"),
    );
    host.copyDiagnostics(data, evidence);
    expect(fs.readdirSync(evidence).sort()).toEqual([
      "run.json",
      "updater.log",
    ]);
    expect(
      fs.readFileSync(path.join(evidence, "run.json"), "utf8"),
    ).not.toContain("private");
    expect(fs.readFileSync(path.join(evidence, "updater.log"), "utf8")).toBe(
      "readiness failed\n",
    );
  });
});

function lifecycleFixture() {
  const summaries = [];
  return {
    options: { scenario: "upgrade", source, target },
    summaries,
    writeSummary: (summary) => summaries.push(structuredClone(summary)),
    requirePrerequisites: vi.fn(),
    provision: vi.fn(),
    install: vi.fn(),
    scenarioContext: () => ({ source, target }),
    collectEvidence: vi.fn(),
    cleanup: vi.fn(),
    makeEvidenceReadable: vi.fn(),
  };
}
