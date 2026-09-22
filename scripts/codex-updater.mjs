import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const UPDATE_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 512 * 1024;

function isVersion(value) {
  return (
    typeof value === "string" && value.length <= 128 && VERSION.test(value)
  );
}

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
      ].includes(error.code)
    )
      throw error;
  }
  throw new CodexUpdateError(
    "verification",
    "Codex --version did not report a usable version. Check the configured executable and private update log; repair the npm installation before launching new Codex processes.",
  );
}

export async function updateCodexInstallation({
  assistantBin,
  prefix,
  env = process.env,
  signal,
  onProgress,
  onOutput,
  timeoutMs = UPDATE_TIMEOUT_MS,
}) {
  const installation = resolveCodexInstallation({ assistantBin, prefix });
  const release = acquireCodexInstallationLock(installation.prefix);
  const deadline = AbortSignal.timeout(
    Math.max(1, Math.min(timeoutMs, UPDATE_TIMEOUT_MS)),
  );
  const operationSignal = signal
    ? AbortSignal.any([signal, deadline])
    : deadline;
  const npmEnv = npmEnvironment(installation.prefix, env);
  const commandOptions = {
    env: npmEnv,
    signal: operationSignal,
    onOutput,
    outputBudget: { remaining: OUTPUT_LIMIT },
  };
  let previousVersion = null;
  let retainLock = false;
  try {
    const initialPackageVersion = verifyNpmOwnership(installation, true);
    onProgress?.("checking");
    try {
      previousVersion = await readCodexVersion(
        installation.assistantBin,
        commandOptions,
      );
    } catch (error) {
      if (
        [
          "cancelled",
          "timeout",
          "output-limit",
          "log-unavailable",
          "cleanup-incomplete",
          "supervision-unavailable",
        ].includes(error.code)
      )
        throw error;
    }
    const response = await runCommand(
      "npm",
      ["view", "@openai/codex@latest", "version", "--json"],
      { ...commandOptions, timeoutMs: 30_000 },
    );
    let latest;
    try {
      latest = JSON.parse(response);
    } catch {
      /* Invalid registry output is handled below. */
    }
    if (!isVersion(latest))
      throw new CodexUpdateError(
        "installation",
        "npm did not report a valid latest Codex version. Check the npm registry configuration and private update log.",
      );
    if (previousVersion === latest) {
      if (previousVersion !== initialPackageVersion)
        throw new CodexUpdateError(
          "verification",
          "Codex reports a different version from its installed npm package. Repair the npm installation before trying again.",
        );
      return {
        outcome: "current",
        installedVersion: previousVersion,
        previousVersion,
      };
    }
    onProgress?.("updating");
    await runCommand(
      "npm",
      ["i", "-g", "--prefix", installation.prefix, "@openai/codex@latest"],
      { ...commandOptions, timeoutMs: 120_000 },
    );
    onProgress?.("verifying");
    const packageVersion = verifyNpmOwnership(installation);
    const installedVersion = await readCodexVersion(
      installation.assistantBin,
      commandOptions,
    );
    if (installedVersion !== packageVersion || installedVersion !== latest)
      throw new CodexUpdateError(
        "verification",
        "Codex reports a different version from the requested npm release. Check the private update log and repair the npm installation before trying again.",
      );
    return { outcome: "updated", installedVersion, previousVersion };
  } catch (error) {
    if (error.code === "cleanup-incomplete") {
      retainLock = true;
      throw error;
    }
    let usableVersion = null;
    try {
      verifyNpmOwnership(installation);
      usableVersion = await readCodexVersion(installation.assistantBin, {
        env: npmEnv,
        timeoutMs: 5_000,
      });
    } catch (verificationError) {
      if (verificationError.code === "cleanup-incomplete") {
        retainLock = true;
        throw verificationError;
      }
      /* A failed verification must clear the displayed usable version. */
    }
    const failure =
      error instanceof CodexUpdateError
        ? error
        : commandFailure(error, "", "npm");
    if (deadline.aborted && !signal?.aborted) {
      throw new CodexUpdateError(
        "timeout",
        "The Codex update exceeded its time limit. Check network access and the private update log before trying again.",
        usableVersion,
      );
    }
    failure.usableVersion = usableVersion;
    throw failure;
  } finally {
    if (!retainLock) release();
  }
}
