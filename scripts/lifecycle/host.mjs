import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  oldestSupportedRevision,
  verifyLifecycleHistory,
} from "./revisions.mjs";

const controllerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const units = [
  "cloudx.service",
  "cloudx-terminal.service",
  "cloudx-asr.service",
  "cloudx-documentation.service",
];
const standardPorts = [3001, 7810, 7820];

export function parseHostArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--disposable-host") options.disposableHost = true;
    else if (
      ["--scenario", "--source", "--target", "--evidence"].includes(flag)
    ) {
      if (options[flag.slice(2)] !== undefined)
        throw new Error(`Duplicate option: ${flag}`);
      options[flag.slice(2)] = argv[++index];
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.disposableHost)
    throw new Error(
      "--disposable-host is required: the real installer changes Ubuntu packages on this host.",
    );
  if (!["install", "upgrade"].includes(options.scenario))
    throw new Error("--scenario must be install or upgrade.");
  for (const key of ["source", "target"])
    if (!/^[a-f0-9]{40}$/.test(options[key] ?? ""))
      throw new Error(`--${key} must be an immutable full Git commit SHA.`);
  if (options.scenario === "upgrade" && options.source === options.target)
    throw new Error("Upgrade source and target must differ.");
  if (!options.evidence || !path.isAbsolute(options.evidence))
    throw new Error("--evidence must be an absolute directory.");
  return options;
}

export async function requireVacantPorts(ports = standardPorts) {
  for (const port of ports) {
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    } catch (error) {
      throw new Error(
        `Standard CloudX port ${port} is unavailable; use a disposable Ubuntu VM with no running CloudX installation.`,
        { cause: error },
      );
    } finally {
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
    }
  }
}

export function makeEvidenceReadable(directory, owner) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink())
    throw new Error("Lifecycle evidence must not contain symbolic links.");
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(directory))
      makeEvidenceReadable(path.join(directory, entry), owner);
  }
  fs.chownSync(directory, owner.uid, owner.gid);
  fs.chmodSync(directory, stat.isDirectory() ? 0o750 : 0o640);
}

// Evidence and cleanup also run after a failed prerequisite or partial account setup.
export async function runLifecycle(host, scenario) {
  const summary = {
    scenario: host.options.scenario,
    source: host.options.source,
    target: host.options.target,
    startedAt: new Date().toISOString(),
    result: "running",
    phase: "prerequisites",
  };
  host.writeSummary(summary);
  let failure;
  try {
    await host.requirePrerequisites();
    summary.phase = "provision";
    await host.provision();
    summary.phase = "install";
    await host.install();
    summary.phase = "scenario";
    const result = await scenario(host.scenarioContext());
    summary.validation = result;
    summary.result = "passed";
  } catch (error) {
    failure = error;
    summary.result = "failed";
    summary.error = error.message;
  } finally {
    for (const [name, action] of [
      ["evidence", () => host.collectEvidence()],
      ["cleanup", () => host.cleanup()],
      ["permissions", () => host.makeEvidenceReadable()],
    ]) {
      try {
        await action();
      } catch (error) {
        summary[`${name}Error`] = error.message;
        summary.result = "failed";
        failure ??= error;
      }
    }
    summary.finishedAt = new Date().toISOString();
    host.writeSummary(summary);
  }
  if (failure) throw failure;
  return summary;
}

export class DisposableHost {
  constructor(options) {
    this.options = options;
    this.username = `cloudx-ci-${randomBytes(6).toString("hex")}`;
    this.home = `/home/${this.username}`;
    this.repoRoot = path.join(this.home, "cloudx");
    this.dataDir = path.join(this.repoRoot, ".cloudx");
    this.remote = path.join(this.home, "candidate.git");
    this.sudoers = `/etc/sudoers.d/${this.username}`;
    this.node = process.execPath;
    fs.mkdirSync(options.evidence, { recursive: true });
    const evidenceStat = fs.statSync(options.evidence);
    this.evidenceOwner = {
      uid: Number(process.env.SUDO_UID ?? evidenceStat.uid),
      gid: Number(process.env.SUDO_GID ?? evidenceStat.gid),
    };
    if (
      !Object.values(this.evidenceOwner).every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new Error(
        "The evidence owner must have valid numeric user and group IDs.",
      );
    this.log = path.join(options.evidence, "host.log");
    this.abort = new AbortController();
  }

  writeSummary(summary) {
    fs.writeFileSync(
      path.join(this.options.evidence, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }

  makeEvidenceReadable() {
    makeEvidenceReadable(this.options.evidence, this.evidenceOwner);
  }

  async command(
    command,
    args,
    {
      cwd = controllerRoot,
      timeout = 60_000,
      log = this.log,
      signal = this.abort.signal,
    } = {},
  ) {
    const output = fs.openSync(log, "a");
    fs.writeSync(
      output,
      `\n$ ${[command, ...args].map((value) => JSON.stringify(value)).join(" ")}\n`,
    );
    let stdout = "";
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          env: this.controllerEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        let timeoutError;
        const terminate = (reason) => {
          timeoutError = reason;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") reject(error);
          }
        };
        const timer = setTimeout(
          () => terminate(new Error(`${command} exceeded ${timeout}ms.`)),
          timeout,
        );
        const cancelled = () => terminate(new Error("Lifecycle cancelled."));
        signal?.addEventListener("abort", cancelled, { once: true });
        if (signal?.aborted) cancelled();
        child.stdout.on("data", (data) => {
          fs.writeSync(output, data);
          stdout = (stdout + data).slice(-2_000_000);
        });
        child.stderr.on("data", (data) => fs.writeSync(output, data));
        child.once("error", (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancelled);
          reject(error);
        });
        child.once("close", (code, childSignal) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancelled);
          if (timeoutError) reject(timeoutError);
          else if (code !== 0)
            reject(
              new Error(
                `${command} exited ${code ?? childSignal}; see ${path.basename(log)}.`,
              ),
            );
          else resolve(stdout);
        });
      });
    } finally {
      fs.closeSync(output);
    }
  }

  controllerEnvironment() {
    return {
      PATH: `${path.dirname(this.node)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      HOME: "/root",
      LANG: "C.UTF-8",
      DEBIAN_FRONTEND: "noninteractive",
    };
  }

  runAsUser(command, args, options = {}) {
    return this.command(
      "runuser",
      [
        "-u",
        this.username,
        "--",
        "env",
        "-i",
        `HOME=${this.home}`,
        `USER=${this.username}`,
        `LOGNAME=${this.username}`,
        "SHELL=/bin/bash",
        "LANG=C.UTF-8",
        `PATH=${path.dirname(this.node)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        `XDG_RUNTIME_DIR=/run/user/${this.uid}`,
        `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${this.uid}/bus`,
        "DEBIAN_FRONTEND=noninteractive",
        "GIT_TERMINAL_PROMPT=0",
        command,
        ...args,
      ],
      { cwd: this.repoRoot, ...options },
    );
  }

  async requirePrerequisites() {
    if (process.getuid?.() !== 0)
      throw new Error(
        "The disposable host controller must run as root (sudo node scripts/lifecycle/host.mjs ...). ",
      );
    if (
      process.platform !== "linux" ||
      !/^ID=ubuntu$/m.test(fs.readFileSync("/etc/os-release", "utf8"))
    )
      throw new Error("A disposable supported Ubuntu VM is required.");
    if (fs.readFileSync("/proc/1/comm", "utf8").trim() !== "systemd")
      throw new Error(
        "PID 1 must be systemd; an ordinary unprivileged container is unsupported.",
      );
    await requireVacantPorts();
    for (const sha of new Set([this.options.source, this.options.target])) {
      const actual = await this.command("git", [
        "-c",
        `safe.directory=${controllerRoot}`,
        "rev-parse",
        "--verify",
        `${sha}^{commit}`,
      ]);
      if (actual.trim() !== sha)
        throw new Error(
          `Commit ${sha} is unavailable in the controller checkout.`,
        );
    }
    if (this.options.scenario === "upgrade")
      verifyLifecycleHistory(
        {
          baseline: oldestSupportedRevision,
          source: this.options.source,
          target: this.options.target,
        },
        controllerRoot,
      );
  }

  async provision() {
    await this.command("useradd", [
      "--create-home",
      "--shell",
      "/bin/bash",
      this.username,
    ]);
    this.accountCreated = true;
    this.uid = Number(await this.command("id", ["-u", this.username]));
    this.gid = Number(await this.command("id", ["-g", this.username]));
    fs.writeFileSync(
      this.sudoers,
      `${this.username} ALL=(ALL) NOPASSWD: ALL\n`,
      { mode: 0o440 },
    );
    await this.command("visudo", ["--check", "--file", this.sudoers]);
    await this.command("loginctl", ["enable-linger", this.username]);
    await this.command("systemctl", ["start", `user@${this.uid}.service`]);
    await this.runAsUser("systemctl", ["--user", "show-environment"], {
      cwd: this.home,
    });
    if (!fs.statSync(`/run/user/${this.uid}/bus`).isSocket())
      throw new Error("The isolated systemd user bus is missing.");
    await this.createFrozenOrigin();
    await this.runAsUser(
      "git",
      ["config", "--global", "--add", "safe.directory", this.remote],
      { cwd: this.home },
    );
    await this.runAsUser(
      "git",
      [
        "clone",
        "--no-hardlinks",
        "--branch",
        "main",
        this.remote,
        this.repoRoot,
      ],
      { cwd: this.home },
    );
    const installed =
      this.options.scenario === "install"
        ? this.options.target
        : this.options.source;
    await this.runAsUser("git", ["reset", "--hard", installed]);
    await this.runAsUser("git", ["config", "user.name", "CloudX Lifecycle"]);
    await this.runAsUser("git", [
      "config",
      "user.email",
      "lifecycle@example.invalid",
    ]);
    this.assertFreshInstallation();
    this.prepareCatalog();
    const { startProfileProvider } = await import("./profile.mjs");
    this.provider = await startProfileProvider({
      home: this.home,
      repoRoot: this.repoRoot,
    });
    await this.command("chown", ["-R", `${this.uid}:${this.gid}`, this.home]);
    // The frozen upstream is readable by the app but cannot be moved by its updater.
    await this.command("chown", ["-R", "root:root", this.remote]);
    await this.command("chmod", ["-R", "a-w", this.remote]);
  }

  async createFrozenOrigin() {
    await this.command("git", ["init", "--bare", this.remote]);
    for (const [name, commit] of Object.entries({
      source: this.options.source,
      main: this.options.target,
    }))
      await this.command("git", [
        "-c",
        `safe.directory=${controllerRoot}`,
        "push",
        this.remote,
        `${commit}:refs/heads/${name}`,
      ]);
    await this.command("git", [
      "--git-dir",
      this.remote,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    // The fresh user can read the immutable remote, without inheriting controller credentials.
    await this.command("chmod", ["-R", "a+rX", this.remote]);
  }

  assertFreshInstallation() {
    for (const relative of [
      ".cloudx",
      "node_modules",
      "apps/web/dist",
      "apps/server/dist",
      "services/asr/.venv",
      "services/documentation-indexer/.venv",
    ])
      if (fs.existsSync(path.join(this.repoRoot, relative)))
        throw new Error(`The clean checkout already contains ${relative}.`);
    for (const relative of [
      ".config/cloudx",
      ".config/systemd/user/cloudx.service",
      ".local/state/cloudx",
    ])
      if (fs.existsSync(path.join(this.home, relative)))
        throw new Error(
          `The fresh application home already contains ${relative}.`,
        );
    fs.writeFileSync(
      path.join(this.options.evidence, "fresh-installation.json"),
      JSON.stringify(
        {
          home: this.home,
          repoRoot: this.repoRoot,
          profileAbsent: true,
          dependenciesAbsent: true,
          generatedBuildsAbsent: true,
          servicesAbsent: true,
          runtimeReceiptsAbsent: true,
        },
        null,
        2,
      ),
    );
  }

  prepareCatalog() {
    const fixtures = path.join(this.home, "lifecycle-fixtures");
    fs.mkdirSync(fixtures);
    fs.copyFileSync(
      new URL("./catalog-transport.mjs", import.meta.url),
      path.join(fixtures, "catalog-transport.mjs"),
    );
    fs.writeFileSync(
      path.join(fixtures, "revisions.json"),
      JSON.stringify({
        source: this.options.source,
        target: this.options.target,
      }),
    );
    const dropIn = path.join(
      this.home,
      ".config/systemd/user/cloudx.service.d",
    );
    fs.mkdirSync(dropIn, { recursive: true });
    fs.writeFileSync(
      path.join(dropIn, "lifecycle-catalog.conf"),
      `[Service]\nEnvironment="NODE_OPTIONS=--import=${fixtures}/catalog-transport.mjs"\nEnvironment="CLOUDX_LIFECYCLE_REVISIONS=${fixtures}/revisions.json"\n`,
    );
  }

  async install() {
    const answers = path.join(this.home, "installer-answers.json");
    fs.writeFileSync(
      answers,
      JSON.stringify({
        allowedRoots: this.home,
        port: 3001,
        cpuThreads: 2,
        useGpu: false,
        installWhisperCpp: false,
        installServices: true,
        startServices: true,
        enableLinger: true,
        runCodexLogin: false,
      }),
    );
    await this.runAsUser("./install.sh", ["--yes", "--answers", answers], {
      timeout: 45 * 60_000,
      log: path.join(this.options.evidence, "installer.log"),
    });
  }

  async captureServiceState(unit = "cloudx.service") {
    const text = await this.runAsUser("systemctl", [
      "--user",
      "show",
      unit,
      "--property=MainPID,InvocationID,ActiveState,SubState,ControlGroup,ExecMainStatus,FragmentPath",
    ]);
    return Object.fromEntries(
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  }

  scenarioContext() {
    return {
      ...this.options,
      home: this.home,
      repoRoot: this.repoRoot,
      dataDir: this.dataDir,
      username: this.username,
      uid: this.uid,
      gid: this.gid,
      baseUrl: "https://127.0.0.1:3001",
      origin: "https://127.0.0.1:3001",
      asrUrl: "http://127.0.0.1:7810",
      documentationUrl: "http://127.0.0.1:7820",
      provider: this.provider,
      runAsUser: this.runAsUser.bind(this),
      captureServiceState: this.captureServiceState.bind(this),
      signal: this.abort.signal,
    };
  }

  async collectEvidence() {
    if (!this.accountCreated) return;
    const errors = [];
    const capture = async (name, command, args, user = true) => {
      try {
        await (user
          ? this.runAsUser(command, args, {
              cwd: this.home,
              log: path.join(this.options.evidence, name),
              signal: null,
            })
          : this.command(command, args, {
              log: path.join(this.options.evidence, name),
              signal: null,
            }));
      } catch (error) {
        errors.push(error.message);
      }
    };
    await capture("services.log", "systemctl", ["--user", "show", ...units]);
    await capture(
      "journal.log",
      "journalctl",
      ["_UID=" + this.uid, "--no-pager", "-n", "3000"],
      false,
    );
    await capture("checkout.log", "git", [
      "-C",
      this.repoRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    for (const [name, url] of Object.entries({
      runtime: "https://127.0.0.1:3001/api/runtime",
      web: "https://127.0.0.1:3001/api/ready",
      terminals: "https://127.0.0.1:3001/api/ready/terminals",
      asr: "http://127.0.0.1:7810/ready",
      documentation: "http://127.0.0.1:7820/ready",
    }))
      await capture(
        `${name}-response.log`,
        "curl",
        [
          "--insecure",
          "--silent",
          "--show-error",
          "--max-time",
          "10",
          "--write-out",
          "\nHTTP_STATUS=%{http_code}\n",
          url,
        ],
        false,
      );
    const roots = [
      path.join(this.home, ".local/state/cloudx/settings-update"),
      path.join(this.dataDir, "terminal-runtime"),
    ];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      this.copyDiagnostics(
        root,
        path.join(this.options.evidence, path.basename(root)),
      );
    }
    fs.writeFileSync(
      path.join(this.options.evidence, "collection.json"),
      JSON.stringify({ errors }, null, 2),
    );
    // Failed diagnostic commands are retained as evidence; setup failure remains the primary result.
  }

  copyDiagnostics(source, destination) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name),
        to = path.join(destination, entry.name);
      if (
        entry.isFile() &&
        /\.(json|log)$/.test(entry.name) &&
        fs.statSync(from).size <= 10_000_000
      ) {
        if (entry.name.endsWith(".json")) {
          const value = JSON.parse(fs.readFileSync(from, "utf8"));
          fs.writeFileSync(
            to,
            JSON.stringify(
              value,
              (key, item) =>
                /^(environmentText|environment|token|auth|password|secret)$/i.test(
                  key,
                )
                  ? "[redacted]"
                  : item,
              2,
            ),
          );
        } else fs.copyFileSync(from, to);
      } else if (entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
        this.copyDiagnostics(from, to);
    }
  }

  async cleanup() {
    const errors = [];
    const attempt = async (action) => {
      try {
        await action();
      } catch (error) {
        errors.push(error.message);
      }
    };
    if (this.provider) await attempt(() => this.provider.close());
    if (this.accountCreated) {
      await attempt(() =>
        this.command("loginctl", ["disable-linger", this.username], {
          timeout: 10_000,
          signal: null,
        }),
      );
      if (this.uid)
        await attempt(() =>
          this.command("systemctl", ["stop", `user@${this.uid}.service`], {
            timeout: 60_000,
            signal: null,
          }),
        );
      await attempt(() =>
        this.command("userdel", ["--remove", this.username], {
          timeout: 30_000,
          signal: null,
        }),
      );
    }
    fs.rmSync(this.sudoers, { force: true });
    if (errors.length)
      throw new Error(`Disposable host cleanup failed: ${errors.join(" ")}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let deadline;
  try {
    const host = new DisposableHost(parseHostArgs(process.argv.slice(2)));
    deadline = setTimeout(() => host.abort.abort(), 75 * 60_000);
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => host.abort.abort());
    await runLifecycle(host, async (context) => {
      const { runScenario } = await import("./scenario.mjs");
      return runScenario(context);
    });
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}
