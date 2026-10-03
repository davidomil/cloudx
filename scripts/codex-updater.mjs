import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isExactCodexVersion as isVersion, readCodexSelection } from "./codex-selection.mjs";

const UPDATE_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 512 * 1024;

export class CodexUpdateError extends Error {
  constructor(code, message, usableVersion = null) {
    super(message);
    this.name = "CodexUpdateError";
    this.code = code;
    this.usableVersion = usableVersion;
  }
}

function unsupportedInstallation() {
  return new CodexUpdateError(
    "unsupported",
    "Codex updates require an absolute npm prefix/bin/codex executable owned by @openai/codex. Update custom executable wrappers with their own installer, or configure CloudX to use the npm installation.",
  );
}

export function resolveCodexInstallation({ assistantBin, prefix }) {
  if (assistantBin !== undefined) {
    if (
      !path.isAbsolute(assistantBin) ||
      path.basename(assistantBin) !== "codex" ||
      path.basename(path.dirname(assistantBin)) !== "bin"
    ) {
      throw unsupportedInstallation();
    }
    prefix = path.dirname(path.dirname(assistantBin));
  }
  if (typeof prefix !== "string" || !path.isAbsolute(prefix)) {
    throw new CodexUpdateError(
      "unsupported",
      "CLOUDX_NPM_GLOBAL_DIR must be an absolute npm installation path.",
    );
  }
  prefix = canonicalPath(prefix);
  return { assistantBin: path.join(prefix, "bin/codex"), prefix };
}

function canonicalPath(target) {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw filesystemError(error);
    const parent = path.dirname(target);
    if (parent === target) throw filesystemError(error);
    return path.join(canonicalPath(parent), path.basename(target));
  }
}

function verifyNpmOwnership({ assistantBin, prefix }, allowMissing = false) {
  let executable;
  try {
    executable = fs.lstatSync(assistantBin);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return;
    throw unsupportedInstallation();
  }
  if (!executable.isSymbolicLink()) throw unsupportedInstallation();
  try {
    const packageDir = path.join(prefix, "lib/node_modules/@openai/codex");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );
    const bin = manifest.bin?.codex;
    if (
      manifest.name !== "@openai/codex" ||
      typeof bin !== "string" ||
      !isVersion(manifest.version)
    )
      throw unsupportedInstallation();
    const entrypoint = path.resolve(packageDir, bin);
    if (
      !entrypoint.startsWith(`${packageDir}${path.sep}`) ||
      fs.realpathSync(packageDir) !== packageDir ||
      !fs.realpathSync(entrypoint).startsWith(`${packageDir}${path.sep}`) ||
      fs.realpathSync(assistantBin) !== fs.realpathSync(entrypoint)
    )
      throw unsupportedInstallation();
    return manifest.version;
  } catch {
    throw unsupportedInstallation();
  }
}

export function acquireCodexInstallationLock(prefix) {
  let lockPath;
  let owned = false;
  try {
    fs.mkdirSync(prefix, { recursive: true });
    lockPath = path.join(fs.realpathSync(prefix), ".cloudx-codex-update.lock");
    const fd = fs.openSync(lockPath, "wx", 0o600);
    owned = true;
    try {
      fs.writeFileSync(fd, `${process.pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (owned) fs.rmSync(lockPath, { force: true });
    if (error.code === "EEXIST") {
      throw new CodexUpdateError(
        "busy",
        "Another CloudX installer or Codex update owns this installation. Wait for it to finish. If an installer was forcibly stopped, remove .cloudx-codex-update.lock from the npm prefix only after confirming no installer is running.",
      );
    }
    throw filesystemError(error);
  }
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      throw filesystemError(error);
    }
  };
}

function filesystemError() {
  return new CodexUpdateError(
    "permission",
    "Cannot access the Codex npm installation. Check that its configured prefix exists and is writable by the CloudX service user.",
  );
}

function npmEnvironment(prefix, env) {
  return {
    ...env,
    NPM_CONFIG_PREFIX: prefix,
    npm_config_prefix: prefix,
    npm_config_fetch_retries: "0",
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_logs_max: "0",
    PATH: `${path.join(prefix, "bin")}${path.delimiter}${env.PATH ?? ""}`,
  };
}

function commandFailure(error, output, command) {
  if (error?.code === "ENOENT" && command === "npm")
    return new CodexUpdateError(
      "npm-unavailable",
      "npm is unavailable to the CloudX service. Install Node.js/npm and make npm available on the service PATH.",
    );
  if (/EACCES|EPERM/.test(`${error?.code ?? ""} ${output}`))
    return filesystemError(error);
  if (
    /ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|ENET|EHOST|CERT_|certificate/i.test(
      output,
    )
  )
    return new CodexUpdateError(
      "network",
      "Cannot reach the npm registry. Check the network, registry/proxy settings and certificates, then try again.",
    );
  return new CodexUpdateError(
    "installation",
    "The Codex npm command failed. Check the private update log and npm registry configuration, then try again.",
  );
}

function incompleteCleanupError() {
  return new CodexUpdateError(
    "cleanup-incomplete",
    "Codex subprocess cleanup could not be confirmed. Inspect installer processes and stop any remaining update processes before removing .cloudx-codex-update.lock from the npm prefix.",
  );
}

function supervisionUnavailable() {
  return new CodexUpdateError(
    "supervision-unavailable",
    "Codex updates require Linux process supervision, Python 3.9 or newer on the service PATH, and the bundled terminal-supervisor.py helper. Repair these CloudX prerequisites before updating.",
  );
}

function completedCommand(directory, pid) {
  try {
    const receipt = JSON.parse(
      fs.readFileSync(path.join(directory, "complete.json"), "utf8"),
    );
    if (
      receipt?.pid === pid &&
      Number.isInteger(receipt.exitCode) &&
      receipt.exitCode >= 0 &&
      receipt.exitCode <= 255 &&
      (receipt.signal === undefined ||
        (receipt.exitCode === 0 &&
          Number.isInteger(receipt.signal) &&
          receipt.signal > 0 &&
          receipt.signal <= 64))
    )
      return receipt;
  } catch {
    /* Only the owner's completion receipt proves all descendants were reaped. */
  }
  throw incompleteCleanupError();
}

function supervisorRejectedBeforeLaunch(directory, pid) {
  try {
    const receipts = fs.readdirSync(directory);
    // The helper writes ready before forking. An error after readiness cannot
    // establish whether the command or any of its descendants remain alive.
    if (receipts.includes("ready.json") || receipts.includes("complete.json"))
      return false;
    const error = JSON.parse(
      fs.readFileSync(path.join(directory, "error.json"), "utf8"),
    );
    return (
      error?.pid === pid &&
      typeof error.message === "string" &&
      error.message.length > 0
    );
  } catch {
    return false;
  }
}

function runCommand(
  command,
  args,
  {
    env,
    signal,
    timeoutMs = 10_000,
    onOutput,
    outputBudget = { remaining: OUTPUT_LIMIT },
  },
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new CodexUpdateError(
          "cancelled",
          "The Codex update was cancelled before completion. Check the installed version before trying again.",
        ),
      );
      return;
    }
    const helper = fileURLToPath(
      new URL("../apps/server/helpers/terminal-supervisor.py", import.meta.url),
    );
    if (process.platform !== "linux" || !fs.existsSync(helper)) {
      reject(supervisionUnavailable());
      return;
    }
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cloudx-codex-command-"),
    );
    let stdout = "";
    let stderr = "";
    let failure;
    let cleanupTimer;
    let stopping = false;
    let settled = false;
    let completion;
    let completionError;
    let acknowledged = false;
    let watcher;
    let child;
    let timer;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      if (error?.code !== "cleanup-incomplete") watcher?.close();
      signal?.removeEventListener("abort", cancel);
      if (error?.code !== "cleanup-incomplete") {
        try {
          fs.rmSync(directory, { recursive: true, force: true });
        } catch {
          error ??= filesystemError();
        }
      }
      if (error) reject(error);
      else resolve(result);
    };
    const stop = (error) => {
      if (stopping || settled) return;
      stopping = true;
      failure ??= error;
      if (!child) {
        settle(supervisionUnavailable());
        return;
      }
      // Keep the subreaper alive to adopt and reap detached descendants.
      child.kill("SIGTERM");
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle(incompleteCleanupError());
      }, 1_250);
    };
    const cancel = () =>
      stop(
        new CodexUpdateError(
          "cancelled",
          "The Codex update was cancelled before completion. Check the installed version before trying again.",
        ),
      );
    const acknowledgeCompletion = () => {
      if (acknowledged || !fs.existsSync(path.join(directory, "complete.json")))
        return;
      acknowledged = true;
      try {
        completion = completedCommand(directory, child.pid);
      } catch (error) {
        completionError = error;
      }
      try {
        const temporary = path.join(directory, "acknowledged.tmp");
        fs.writeFileSync(temporary, JSON.stringify({ pid: child.pid }), {
          mode: 0o600,
        });
        fs.renameSync(temporary, path.join(directory, "acknowledged.json"));
      } catch {
        stop(incompleteCleanupError());
      }
    };
    try {
      watcher = fs.watch(directory, acknowledgeCompletion);
      watcher.on("error", () => stop(incompleteCleanupError()));
      watcher.unref();
    } catch {
      settle(new CodexUpdateError(
        "supervision-unavailable",
        "Cannot observe Codex subprocess completion. Check filesystem watch limits and temporary directory access before updating.",
      ));
      return;
    }
    try {
      child = spawn(
        "python3",
        [
          "-I",
          "-S",
          helper,
          directory,
          String(process.pid),
          "null",
          command,
          ...args,
        ],
        {
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      settle(supervisionUnavailable());
      return;
    }
    acknowledgeCompletion();
    timer = setTimeout(
      () =>
        stop(
          new CodexUpdateError(
            "timeout",
            "The Codex update exceeded its time limit. Check network access and the private update log before trying again.",
          ),
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const collect = (chunk, isError) => {
      const allowed = chunk.subarray(0, Math.max(0, outputBudget.remaining));
      outputBudget.remaining -= chunk.length;
      const text = allowed.toString("utf8");
      if (isError) stderr += text;
      else stdout += text;
      if (text) {
        try {
          onOutput?.(text);
        } catch {
          stop(
            new CodexUpdateError(
              "log-unavailable",
              "Cannot write the private Codex update log. Check free disk space and CloudX data directory permissions before trying again.",
            ),
          );
        }
      }
      if (outputBudget.remaining < 0)
        stop(
          new CodexUpdateError(
            "output-limit",
            "The Codex update produced too much output and was stopped. Check the private update log before trying again.",
          ),
        );
    };
    child.stdout.on("data", (chunk) => collect(chunk, false));
    child.stderr.on("data", (chunk) => collect(chunk, true));
    child.on("error", () => {
      failure ??= supervisionUnavailable();
    });
    child.on("close", (code, signal) => {
      watcher?.close();
      if (settled) return;
      if (!child.pid) {
        settle(failure ?? supervisionUnavailable());
        return;
      }
      if (
        code === 125 &&
        !signal &&
        supervisorRejectedBeforeLaunch(directory, child.pid)
      ) {
        settle(supervisionUnavailable());
        return;
      }
      let result;
      try {
        if (completionError) throw completionError;
        if (!completion || fs.existsSync(directory))
          throw incompleteCleanupError();
        result = completion;
      } catch (error) {
        settle(error);
        return;
      }
      const launchError =
        result.exitCode === 127 &&
        /Terminal command failed to start: \[Errno 2\]/.test(stderr)
          ? { code: "ENOENT" }
          : result.exitCode === 127 &&
              /Terminal command failed to start: \[Errno 13\]/.test(stderr)
            ? { code: "EACCES" }
            : undefined;
      settle(
        failure ??
          (result.exitCode !== 0 || result.signal
            ? commandFailure(launchError, stderr, command)
            : undefined),
        stdout.trim(),
      );
    });
  });
}

export async function readCodexVersion(
  assistantBin,
  {
    env = process.env,
    signal,
    timeoutMs = 10_000,
    onOutput,
    outputBudget,
  } = {},
) {
  try {
    const output = await runCommand(assistantBin, ["--version"], {
      env,
      signal,
      timeoutMs,
      onOutput,
      outputBudget,
    });
    const version = /^codex-cli (\S+)\s*$/m.exec(output)?.[1];
    if (isVersion(version)) return version;
  } catch (error) {
    if (
      [
        "timeout",
        "cancelled",
        "output-limit",
        "log-unavailable",
        "cleanup-incomplete",
        "supervision-unavailable",
      ].includes(error.code)
    )
      throw error;
  }
  throw new CodexUpdateError(
    "verification",
    "Codex --version did not report a usable version. Check the configured executable and private update log; repair the npm installation before launching new Codex processes.",
  );
}

async function verifyCodexLaunch(assistantBin, options, previousAssistantBin, allowStartupRecovery = false) {
  const verifier = fileURLToPath(
    new URL("./codex-runtime-verification.mjs", import.meta.url),
  );
  const stateHome = path.resolve(options.env.CODEX_HOME?.trim() || path.join(options.env.HOME?.trim() || os.homedir(), ".codex"));
  const args = [verifier, assistantBin, "--shared-state-home", stateHome];
  if (options.env.CLOUDX_DATA_DIR) args.push("--cloudx-data-dir", options.env.CLOUDX_DATA_DIR);
  if (previousAssistantBin && previousAssistantBin !== assistantBin) args.push("--previous-bin", previousAssistantBin);
  if (allowStartupRecovery) args.push("--allow-startup-recovery", "true");
  try {
    await runCommand(process.execPath, args, {
      ...options,
      timeoutMs: 120_000,
    });
  } catch (error) {
    if (["cancelled", "timeout", "output-limit", "log-unavailable", "cleanup-incomplete", "supervision-unavailable"].includes(error.code)) throw error;
    throw new CodexUpdateError(
      "runtime-verification",
      "The candidate Codex CLI failed CloudX tab launch, conversation selection, Forge turn, or shared-state compatibility verification. The active selection is unchanged. Check the private update log or installer output for the failed step before selecting a supported release.",
    );
  }
}

function compareVersions(left, right) {
  const parts = version => {
    const [, core, prerelease] = /^(\d+\.\d+\.\d+)(?:-([^+]+))?/.exec(version);
    return [...core.split("."), ...(prerelease?.split(".") ?? [])];
  };
  const a = parts(left), b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] === b[index]) continue;
    if (index >= 3 && (a[index] === undefined || b[index] === undefined)) {
      if (index === 3) return a[index] === undefined ? 1 : -1;
      return a[index] === undefined ? -1 : 1;
    }
    const numericA = /^\d+$/.test(a[index]), numericB = /^\d+$/.test(b[index]);
    if (numericA && numericB) return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export async function listCodexReleases({ prefix, env = process.env, ...options } = {}) {
  const response = await runCommand("npm", ["view", "@openai/codex", "versions", "dist-tags", "--json"], {
    ...options,
    env: prefix ? npmEnvironment(prefix, env) : { ...env, npm_config_fetch_retries: "0", npm_config_update_notifier: "false", npm_config_logs_max: "0" },
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  let metadata;
  try { metadata = JSON.parse(response); } catch { /* Rejected below. */ }
  const versions = metadata?.versions;
  const latestStable = metadata?.["dist-tags"]?.latest;
  if (!Array.isArray(versions) || !versions.length || versions.some(version => !isVersion(version)) ||
      !isVersion(latestStable) || latestStable.split("+")[0].includes("-") || !versions.includes(latestStable)) {
    throw new CodexUpdateError("installation", "npm did not report a valid published Codex release list and latest stable version. Check the registry configuration and private update log.");
  }
  return {
    latestStable,
    versions: [...new Set(versions)].sort((a, b) => compareVersions(b, a)).map(version => ({ version, prerelease: version.split("+")[0].includes("-") })),
  };
}

function activateCodexSelection(prefix, active, previous, signal) {
  if (signal.aborted) throw new CodexUpdateError("cancelled", "The Codex selection was cancelled before activation. The previously active installation is unchanged.");
  const destination = path.join(prefix, ".cloudx-codex-selection.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, active, previous }, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw filesystemError(error);
  }
}

export async function updateCodexInstallation({
  assistantBin,
  prefix,
  targetVersion = "latest",
  env = process.env,
  signal,
  onProgress,
  onOutput,
  onTarget,
  onInstalled,
  timeoutMs = UPDATE_TIMEOUT_MS,
}) {
  if (targetVersion !== "latest" && !isVersion(targetVersion)) {
    throw new CodexUpdateError("invalid-version", "Select an exact published Codex version, such as 0.155.1, or explicitly select latest stable.");
  }
  const installation = resolveCodexInstallation({ assistantBin, prefix });
  const release = acquireCodexInstallationLock(installation.prefix);
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, UPDATE_TIMEOUT_MS)));
  const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const npmEnv = npmEnvironment(installation.prefix, env);
  const commandOptions = { env: npmEnv, signal: operationSignal, onOutput, outputBudget: { remaining: OUTPUT_LIMIT } };
  let activeVersion = null;
  let selectedVersion = null;
  let retainLock = false;
  let activeInstallation = installation;
  try {
    const selection = readCodexSelection(installation.prefix);
    if (selection) activeInstallation = { assistantBin: selection.active.assistantBin, prefix: path.dirname(path.dirname(selection.active.assistantBin)) };
    const initialPackageVersion = verifyNpmOwnership(activeInstallation, !selection);
    onProgress?.("checking");
    try {
      activeVersion = await readCodexVersion(activeInstallation.assistantBin, commandOptions);
    } catch (error) {
      if (error.code !== "verification") throw error;
    }
    if ((selection && activeVersion !== selection.active.version) || (activeVersion && activeVersion !== initialPackageVersion)) {
      throw new CodexUpdateError("verification", "The active Codex executable no longer matches its installed package or verified selection. Repair that installation before selecting another version.");
    }
    const releases = await listCodexReleases({ ...commandOptions, prefix: installation.prefix });
    const target = targetVersion === "latest" ? releases.latestStable : targetVersion;
    if (!releases.versions.some(release => release.version === target)) throw new CodexUpdateError("unpublished-version", `Codex ${target} is not a published @openai/codex release. Select a version from the release list.`);
    onTarget?.(target);
    if (activeVersion === target) {
      onInstalled?.(activeVersion);
      onProgress?.("verifying");
      await verifyCodexLaunch(activeInstallation.assistantBin, commandOptions);
      if (!selection) activateCodexSelection(installation.prefix, { version: activeVersion, assistantBin: activeInstallation.assistantBin }, null, operationSignal);
      selectedVersion = activeVersion;
      return { outcome: "current", installedVersion: activeVersion, activeVersion, previousVersion: selection?.previous?.version ?? null };
    }
    let candidate;
    if (selection?.previous?.version === target) {
      candidate = { assistantBin: selection.previous.assistantBin, prefix: path.dirname(path.dirname(selection.previous.assistantBin)) };
    } else {
      onProgress?.("updating");
      const candidates = path.join(installation.prefix, ".cloudx-codex");
      fs.mkdirSync(candidates, { recursive: true });
      if (fs.realpathSync(candidates) !== candidates) throw unsupportedInstallation();
      const candidatePrefix = fs.mkdtempSync(path.join(candidates, `${target}-`));
      candidate = { prefix: candidatePrefix, assistantBin: path.join(candidatePrefix, "bin/codex") };
      await runCommand("npm", ["i", "-g", "--prefix", candidate.prefix, `@openai/codex@${target}`], {
        ...commandOptions,
        env: npmEnvironment(candidate.prefix, env),
        timeoutMs: 120_000,
      });
    }
    onProgress?.("verifying");
    const packageVersion = verifyNpmOwnership(candidate);
    const installedVersion = await readCodexVersion(candidate.assistantBin, commandOptions);
    onInstalled?.(installedVersion);
    if (installedVersion !== packageVersion || installedVersion !== target) throw new CodexUpdateError("verification", "Codex reports a different version from the requested npm release. The active installation is unchanged; check the private update log.");
    await verifyCodexLaunch(candidate.assistantBin, commandOptions, activeVersion ? activeInstallation.assistantBin : undefined, !selection && Boolean(activeVersion));
    activateCodexSelection(installation.prefix, { version: installedVersion, assistantBin: candidate.assistantBin }, selection?.active ?? null, operationSignal);
    selectedVersion = installedVersion;
    return { outcome: "updated", installedVersion, activeVersion: installedVersion, previousVersion: selection?.active.version ?? null };
  } catch (error) {
    if (error.code === "cleanup-incomplete") {
      retainLock = true;
      throw error;
    }
    // Candidate preparation never writes the active installation or its dependencies.
    // A second bounded check can establish the original version after early cancellation.
    if (!activeVersion) {
      try {
        verifyNpmOwnership(activeInstallation);
        activeVersion = await readCodexVersion(activeInstallation.assistantBin, { env: npmEnv, timeoutMs: 5_000 });
      } catch (verificationError) {
        if (verificationError.code === "cleanup-incomplete") {
          retainLock = true;
          throw verificationError;
        }
      }
    }
    const failure = error instanceof CodexUpdateError ? error :
      error.code === "selection" ? new CodexUpdateError("selection", error.message) : commandFailure(error, "", "npm");
    if (deadline.aborted && !signal?.aborted) throw new CodexUpdateError("timeout", "The Codex update exceeded its time limit. Check network access and the private update log before trying again.", activeVersion);
    failure.usableVersion = activeVersion;
    throw failure;
  } finally {
    if (!retainLock) {
      try { release(); }
      catch (error) {
        if (!selectedVersion) throw error;
        throw new CodexUpdateError(
          "lock-release",
          `Codex ${selectedVersion} is selected for new launches, but the installation lock could not be removed. Check prefix permissions and remove any remaining .cloudx-codex-update.lock only after confirming no installer is running.`,
          selectedVersion,
        );
      }
    }
  }
}
