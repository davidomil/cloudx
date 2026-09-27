import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isCodexVersion as isVersion, compareCodexVersions, readSelection, writeSelection } from "./codex-selection.mjs";

const UPDATE_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 512 * 1024;

export class CodexUpdateError extends Error {
  constructor(code, message, usableVersion = null) {
    super(message);
    this.name = "CodexUpdateError";
    this.code = code;
    this.usableVersion = usableVersion;
    this.installedVersion = null;
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

export function readCodexSelection(options) {
  if (options.assistantBin !== undefined && !isNpmExecutable(options.assistantBin)) return null;
  return readSelection(resolveCodexInstallation(options));
}

export function resolveSelectedCodexBinary({ assistantBin, prefix }) {
  if (assistantBin !== undefined && !isNpmExecutable(assistantBin)) return assistantBin;
  const installation = resolveCodexInstallation({ assistantBin, prefix });
  const selected = readSelection(installation)?.active;
  if (!selected) return installation.assistantBin;
  const selectedInstallation = resolveCodexInstallation({ assistantBin: selected.assistantBin, prefix });
  if (verifyNpmOwnership(selectedInstallation) !== selected.version) throw new CodexUpdateError("verification", "The selected Codex installation changed. Select and verify a release again before launching new Codex processes.");
  return selected.assistantBin;
}

function isNpmExecutable(command) {
  return path.isAbsolute(command) && path.basename(command) === "codex" && path.basename(path.dirname(command)) === "bin";
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
    const child = spawn(
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
    let stdout = "";
    let stderr = "";
    let failure;
    let cleanupTimer;
    let stopping = false;
    let settled = false;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
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
    const timer = setTimeout(
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
        result = completedCommand(directory, child.pid);
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
        "permission",
      ].includes(error.code)
    )
      throw error;
  }
  throw new CodexUpdateError(
    "verification",
    "Codex --version did not report a usable version. Check the configured executable and private update log; repair the npm installation before launching new Codex processes.",
  );
}

async function verifyCodexLaunch(assistantBin, options, previousAssistantBin) {
  const verifier = fileURLToPath(
    new URL("./codex-runtime-verification.mjs", import.meta.url),
  );
  try {
    await runCommand(process.execPath, [verifier, assistantBin, ...(previousAssistantBin ? [previousAssistantBin] : [])], {
      ...options,
      timeoutMs: 60_000,
    });
  } catch (error) {
    if (["cancelled", "timeout", "output-limit", "log-unavailable", "cleanup-incomplete", "supervision-unavailable"].includes(error.code)) throw error;
    throw new CodexUpdateError(
      "runtime-verification",
      "The candidate Codex CLI failed CloudX tab launch, conversation selection, Forge turn, or shared-state verification. The active selection was preserved. Check the private update log or installer output for the failed step. If the active CLI can no longer launch, enable recovery mode in Settings and apply your chosen release.",
    );
  }
}

export async function discoverCodexReleases({ env = process.env, signal, prefix, onOutput, outputBudget } = {}) {
  const response = await runCommand("npm", ["view", "@openai/codex", "versions", "dist-tags", "--json"], {
    env: npmEnvironment(prefix ?? env.CLOUDX_NPM_GLOBAL_DIR ?? path.join(env.HOME ?? os.homedir(), ".local/share/cloudx/npm-global"), env),
    signal, onOutput, outputBudget, timeoutMs: 30_000,
  });
  let metadata;
  try { metadata = JSON.parse(response); } catch { /* Validate the registry response below. */ }
  const versions = metadata?.versions;
  const latestStable = metadata?.["dist-tags"]?.latest;
  if (!Array.isArray(versions) || !versions.length || versions.length > 20_000 || !versions.every(isVersion)
    || !isVersion(latestStable) || latestStable.split("+")[0].includes("-") || !versions.includes(latestStable)) {
    throw new CodexUpdateError("registry", "npm did not report a valid published Codex release list and latest stable version. Check the registry configuration; no other release was selected.");
  }
  return { latestStable, versions: [...new Set(versions)].sort((a, b) => compareCodexVersions(b, a)) };
}

export async function updateCodexInstallation({
  assistantBin,
  prefix,
  targetVersion = "latest",
  acknowledgeDowngrade = false,
  recoveryMode = false,
  env = process.env,
  signal,
  onProgress,
  onTarget,
  onInstalled,
  onOutput,
  timeoutMs = UPDATE_TIMEOUT_MS,
}) {
  if (!["latest", "previous"].includes(targetVersion) && !isVersion(targetVersion)) {
    throw new CodexUpdateError("invalid-version", "Select an exact published Codex version, latest stable, or the previous verified version.");
  }
  if (typeof acknowledgeDowngrade !== "boolean") throw new CodexUpdateError("invalid-version", "Invalid downgrade acknowledgement.");
  if (typeof recoveryMode !== "boolean") throw new CodexUpdateError("invalid-version", "Invalid recovery mode.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new CodexUpdateError("invalid-timeout", "Codex selection requires a positive integer timeout.");
  const installation = resolveCodexInstallation({ assistantBin, prefix });
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, UPDATE_TIMEOUT_MS)));
  const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const commandOptions = {
    env: npmEnvironment(installation.prefix, env), signal: operationSignal, onOutput,
    outputBudget: { remaining: OUTPUT_LIMIT },
  };
  const release = acquireCodexInstallationLock(installation.prefix);
  let previousVersion = null;
  let installedVersion = null;
  let retainLock = false;
  let candidate;
  let preparedCandidate = false;
  let activated = false;
  try {
    const selection = readSelection(installation);
    const active = selection?.active ?? { assistantBin: installation.assistantBin, version: null };
    const activeInstallation = resolveCodexInstallation({ assistantBin: active.assistantBin, prefix: installation.prefix });
    const packageVersion = verifyNpmOwnership(activeInstallation, !selection);
    onProgress?.("checking");
    if (packageVersion) {
      previousVersion = await readCodexVersion(active.assistantBin, commandOptions);
      if (previousVersion !== packageVersion || active.version && previousVersion !== active.version) {
        throw new CodexUpdateError("verification", "The active Codex executable differs from its package or saved selection. Repair the installation before selecting another version.");
      }
    }
    const releases = await discoverCodexReleases({ ...commandOptions, prefix: installation.prefix });
    const target = targetVersion === "latest" ? releases.latestStable
      : targetVersion === "previous" ? selection?.previous?.version : targetVersion;
    if (!target) throw new CodexUpdateError("no-previous", "There is no previous verified Codex version to return to.");
    if (!releases.versions.includes(target)) throw new CodexUpdateError("unpublished", "The requested exact Codex version is not published in the configured npm registry. The active selection was preserved.");
    onTarget?.(target);
    if (previousVersion && compareCodexVersions(target, previousVersion) < 0 && !acknowledgeDowngrade) {
      throw new CodexUpdateError("downgrade-confirmation", "Confirm the downgrade in Settings: shared conversations may contain newer state. Integration verification cannot prove every existing conversation is compatible; recovery mode also skips cross-version resume checks.");
    }
    if (target === previousVersion) {
      onProgress?.("verifying");
      installedVersion = target;
      onInstalled?.(target);
      await verifyCodexLaunch(active.assistantBin, commandOptions);
      operationSignal.throwIfAborted();
      writeSelection(installation, { version: target, assistantBin: active.assistantBin }, selection?.previous ?? null);
      activated = true;
      return { outcome: "current", installedVersion: target, previousVersion, activeVersion: target, previousVerifiedVersion: selection?.previous?.version ?? null };
    }
    onProgress?.("updating");
    if (selection?.previous?.version === target) {
      candidate = resolveCodexInstallation({ assistantBin: selection.previous.assistantBin, prefix: installation.prefix });
    } else {
      const candidatePrefix = path.join(installation.prefix, ".cloudx-codex/installs", randomUUID());
      fs.mkdirSync(candidatePrefix, { recursive: true, mode: 0o700 });
      candidate = resolveCodexInstallation({ prefix: candidatePrefix });
      preparedCandidate = true;
      await runCommand("npm", ["i", "-g", "--prefix", candidate.prefix, `@openai/codex@${target}`], {
        ...commandOptions, env: npmEnvironment(candidate.prefix, env), timeoutMs: 120_000,
      });
    }
    onProgress?.("verifying");
    const candidatePackageVersion = verifyNpmOwnership(candidate);
    const candidateVersion = await readCodexVersion(candidate.assistantBin, commandOptions);
    if (candidateVersion !== target || candidatePackageVersion !== target) {
      throw new CodexUpdateError("verification", "The candidate Codex executable differs from the exact requested npm release. The active installation was preserved; check the private update log.");
    }
    installedVersion = target;
    onInstalled?.(target);
    if (recoveryMode) onOutput?.("Recovery mode: verifying the requested candidate without launching the active CLI. Cross-version shared-state compatibility is not checked.\n");
    await verifyCodexLaunch(candidate.assistantBin, commandOptions, recoveryMode ? undefined : selection?.active.assistantBin);
    operationSignal.throwIfAborted();
    writeSelection(installation, { version: target, assistantBin: candidate.assistantBin }, selection?.active ?? null);
    activated = true;
    return { outcome: "updated", installedVersion, previousVersion, activeVersion: target, previousVerifiedVersion: selection?.active.version ?? null };
  } catch (error) {
    retainLock = error.code === "cleanup-incomplete";
    const failure = error instanceof CodexUpdateError ? error : commandFailure(error, "", "npm");
    failure.usableVersion = previousVersion;
    failure.installedVersion = installedVersion;
    if (deadline.aborted && !signal?.aborted && !retainLock) {
      const timeout = new CodexUpdateError("timeout", "The Codex selection exceeded its time limit. The active installation was preserved. Check network access and the private update log before trying again.", previousVersion);
      timeout.installedVersion = installedVersion;
      throw timeout;
    }
    throw failure;
  } finally {
    if (!retainLock) {
      try {
        try { if (preparedCandidate && !activated) fs.rmSync(candidate.prefix, { recursive: true, force: true }); }
        finally { release(); }
      } catch {
        const failure = new CodexUpdateError("permission", "Codex selection cleanup could not complete. Check the private update log, npm prefix permissions and .cloudx-codex-update.lock before starting another selection.", activated ? installedVersion : previousVersion);
        failure.installedVersion = installedVersion;
        throw failure;
      }
    }
  }
}
