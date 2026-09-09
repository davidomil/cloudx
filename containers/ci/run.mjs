#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  collectBrowserDiagnostics,
  CommandOutputTail,
} from "./diagnostics.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const commandTimeoutMs = 20 * 60 * 1_000;
const maximumOutputBytes = 64 * 1024 * 1024;
const forcedProcessGroupStopMs = 5_000;
const candidateTerminationPollMs = 25;

export const candidateIdentity = Object.freeze({
  uid: 10_001,
  gid: 10_001,
  username: "cloudx-ci-candidate",
});

export function verificationCommands() {
  return [
    command(10 * 60 * 1_000, "npm", "ci", "--offline"),
    command(commandTimeoutMs, "node", "scripts/ai-change/validate-process.mjs"),
    command(commandTimeoutMs, "npm", "run", "format:check"),
    command(commandTimeoutMs, "npm", "run", "lint"),
    command(
      commandTimeoutMs,
      "npm",
      "run",
      "typecheck",
      "--",
      "--pretty",
      "false",
    ),
    command(commandTimeoutMs, "npm", "run", "test:coverage"),
    command(commandTimeoutMs, "npm", "run", "build"),
    command(
      commandTimeoutMs,
      "uv",
      "lock",
      "--check",
      "--offline",
      "--project",
      "services/asr",
    ),
    command(
      commandTimeoutMs,
      "/opt/cloudx-asr/bin/python",
      "-m",
      "pytest",
      "services/asr/tests",
      "-q",
      { PYTHONPATH: "services/asr/src" },
    ),
    command(
      commandTimeoutMs,
      "uv",
      "lock",
      "--check",
      "--offline",
      "--project",
      "services/documentation-indexer",
    ),
    command(
      commandTimeoutMs,
      "/opt/cloudx-documentation/bin/python",
      "-m",
      "pytest",
      "services/documentation-indexer/tests",
      "-q",
      { PYTHONPATH: "services/documentation-indexer/src" },
    ),
    command(commandTimeoutMs, "npm", "run", "test:browser", { CI: "1" }),
  ];
}

export async function executeVerification({
  root = process.cwd(),
  commands = verificationCommands(),
  identity = candidateIdentity,
  runner = runCommand,
  sourceManifest,
  settleCandidates = async () => {},
  worktreeDigest,
}) {
  const trustedManifest =
    worktreeDigest === undefined
      ? sourceManifest === undefined
        ? await captureSourceManifest(root)
        : freezeSourceManifest(root, sourceManifest)
      : undefined;
  const digestWorktree =
    worktreeDigest ?? (() => calculateWorktreeDigest(root, trustedManifest));
  const before = await digestWorktree();
  const results = [];
  const commandDiagnostics = [];
  for (const planned of commands) {
    const commandBefore = results.at(-1)?.tree_sha256_after ?? before;
    const result = await runner(planned, root, identity);
    await settleCandidates();
    const commandAfter = await digestWorktree();
    results.push({
      command: displayCommand(planned),
      exit_code: result.exitCode,
      stdout_sha256:
        result.stdoutSha256 ??
        digest(result.stdout === undefined ? "" : result.stdout),
      stderr_sha256:
        result.stderrSha256 ??
        digest(result.stderr === undefined ? "" : result.stderr),
      tree_sha256_before: commandBefore,
      tree_sha256_after: commandAfter,
    });
    if (
      (result.exitCode !== 0 || commandAfter !== commandBefore) &&
      result.outputTails
    ) {
      commandDiagnostics.push({
        command_index: results.length - 1,
        ...result.outputTails,
      });
    }
    if (commandAfter !== commandBefore) break;
  }
  await settleCandidates();
  const after = await digestWorktree();
  const evidence = {
    schema_version: 1,
    kind: "managed-container-verification",
    verdict:
      results.length === commands.length &&
      results.every(
        (result) =>
          result.exit_code === 0 &&
          result.tree_sha256_before === result.tree_sha256_after,
      ) &&
      before === after
        ? "passed"
        : "failed",
    tree_sha256_before: before,
    tree_sha256_after: after,
    commands: results,
  };
  if (evidence.verdict === "failed") {
    evidence.diagnostics = {
      trust: "untrusted-candidate-output",
      commands: commandDiagnostics,
      browser: await collectBrowserDiagnostics(root, identity.uid),
    };
  }
  return evidence;
}

export async function captureSourceManifest(root) {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      `safe.directory=${root}`,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--deduplicate",
      "--full-name",
      "-z",
      "--",
    ],
    {
      cwd: root,
      encoding: "buffer",
      maxBuffer: maximumOutputBytes,
    },
  );
  return freezeSourceManifest(
    root,
    stdout.toString("utf8").split("\0").filter(Boolean),
  );
}

export async function calculateWorktreeDigest(root, sourceManifest) {
  const paths = freezeSourceManifest(root, sourceManifest);
  const hash = createHash("sha256");
  hashField(hash, "schema", "cloudx-source-manifest-v1");
  hashField(hash, "entry-count", String(paths.length));
  for (const relativePath of paths) {
    const absolutePath = sourceEntryPath(root, relativePath);
    hashField(hash, "path", relativePath);
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      hashField(hash, "type", "missing");
      continue;
    }
    hashField(hash, "type", sourceEntryType(stat));
    hashField(hash, "mode", String(stat.mode & 0o7777));
    if (stat.isSymbolicLink()) {
      hashField(hash, "symlink-target", await fs.readlink(absolutePath));
    } else if (stat.isFile()) {
      hashField(hash, "content", await fs.readFile(absolutePath));
    }
  }
  return hash.digest("hex");
}

export async function runCommand(planned, root, identity = candidateIdentity) {
  return new Promise((resolve) => {
    const child = spawn(planned.command, planned.args, {
      cwd: root,
      detached: true,
      env: { ...process.env, USER: identity.username, ...planned.env },
      uid: identity.uid,
      gid: identity.gid,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    const stdoutTail = new CommandOutputTail();
    const stderrTail = new CommandOutputTail();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    let forcedStop;
    const stop = (signal) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The process group already exited.
      }
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forcedStop);
      resolve({
        exitCode: timedOut ? 124 : outputExceeded ? 125 : (code ?? 1),
        stdoutSha256: stdoutHash.digest("hex"),
        stderrSha256: stderrHash.digest("hex"),
        outputTails: {
          stdout: stdoutTail.snapshot(),
          stderr: stderrTail.snapshot(),
        },
      });
    };
    const requestStop = () => {
      stop("SIGTERM");
      if (forcedStop !== undefined) return;
      forcedStop = setTimeout(() => {
        stop("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, forcedProcessGroupStopMs);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, planned.timeoutMs);
    const consume = (stream, hash, tail, write, count) => {
      stream.on("data", (chunk) => {
        if (settled) return;
        hash.update(chunk);
        tail.append(chunk);
        write(chunk);
        const total = count(chunk.length);
        if (total > maximumOutputBytes && !outputExceeded) {
          outputExceeded = true;
          requestStop();
        }
      });
    };
    consume(
      child.stdout,
      stdoutHash,
      stdoutTail,
      (chunk) => process.stdout.write(chunk),
      (bytes) => {
        stdoutBytes += bytes;
        return stdoutBytes;
      },
    );
    consume(
      child.stderr,
      stderrHash,
      stderrTail,
      (chunk) => process.stderr.write(chunk),
      (bytes) => {
        stderrBytes += bytes;
        return stderrBytes;
      },
    );
    child.on("error", (error) => {
      if (!settled) {
        stderrHash.update(error.message);
        stderrTail.append(Buffer.from(error.message));
      }
    });
    child.on("close", finish);
  });
}

export async function terminateCandidateProcesses({
  uid = candidateIdentity.uid,
  procRoot = "/proc",
  terminateGraceMs = 1_000,
  killGraceMs = 5_000,
  kill = process.kill,
  now = Date.now,
  sleep = delay,
} = {}) {
  if (await signalCandidatesUntilSettled("SIGTERM", terminateGraceMs)) return;
  if (await signalCandidatesUntilSettled("SIGKILL", killGraceMs)) return;
  throw new Error(`Candidate UID ${uid} still owns live processes.`);

  async function signalCandidatesUntilSettled(signal, graceMs) {
    const deadline = now() + graceMs;
    do {
      const pids = await liveProcessesOwnedBy(uid, procRoot);
      if (pids.length === 0) return true;
      for (const pid of pids) {
        try {
          kill(pid, signal);
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      await sleep(candidateTerminationPollMs);
    } while (now() < deadline);
    return (await liveProcessesOwnedBy(uid, procRoot)).length === 0;
  }
}

function command(timeoutMs, executable, ...values) {
  const maybeEnvironment = values.at(-1);
  const env = isRecord(maybeEnvironment) ? values.pop() : {};
  return { command: executable, args: values, env, timeoutMs };
}

function displayCommand(planned) {
  return [planned.command, ...planned.args]
    .map((part) => (/\s|["']/u.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function freezeSourceManifest(root, sourceManifest) {
  if (!Array.isArray(sourceManifest)) {
    throw new TypeError("Verifier source manifest must be an array.");
  }
  const paths = [...new Set(sourceManifest)];
  for (const relativePath of paths) sourceEntryPath(root, relativePath);
  return Object.freeze(paths.sort());
}

function sourceEntryPath(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Verifier source manifest contains an invalid path.");
  }
  const absolutePath = path.resolve(root, relativePath);
  const withinRoot = path.relative(path.resolve(root), absolutePath);
  if (
    withinRoot === ".." ||
    withinRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(withinRoot) ||
    withinRoot !== relativePath
  ) {
    throw new Error("Verifier source manifest path escapes its workspace.");
  }
  return absolutePath;
}

function sourceEntryType(stat) {
  if (stat.isFile()) return "regular-file";
  if (stat.isSymbolicLink()) return "symbolic-link";
  if (stat.isDirectory()) return "directory";
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  return "unknown";
}

function hashField(hash, name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(name).update("\0").update(String(bytes.length)).update("\0");
  hash.update(bytes);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function prepareWorkspace({
  source = "/source",
  root = "/work/repository",
  archive = "/tmp/cloudx-source.tar",
  npmCacheSource = "/opt/npm-cache",
} = {}) {
  const workspaceRoot = path.dirname(root);
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.chmod(workspaceRoot, 0o1777);
  // Create disposable Git ownership directly: the sandbox has no CAP_CHOWN.
  const candidateOptions = {
    uid: candidateIdentity.uid,
    gid: candidateIdentity.gid,
    maxBuffer: maximumOutputBytes,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(workspaceRoot, "home"),
      USER: candidateIdentity.username,
      LOGNAME: candidateIdentity.username,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
    },
  };
  await fs.mkdir(path.join(workspaceRoot, "home"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "tmp"), { recursive: true });
  await fs.cp(npmCacheSource, path.join(workspaceRoot, "npm-cache"), {
    recursive: true,
  });
  await execFileAsync("chmod", ["--recursive", "a+rwX", workspaceRoot], {
    maxBuffer: maximumOutputBytes,
  });
  await execFileAsync(
    process.execPath,
    ["-e", "require('node:fs').mkdirSync(process.argv[1])", root],
    candidateOptions,
  );
  await execFileAsync(
    "tar",
    [
      "--exclude=.managed",
      "--exclude=.git",
      "--exclude=node_modules",
      "--exclude=dist",
      "--exclude=coverage",
      "--exclude=playwright-report",
      "--exclude=test-results",
      "--exclude=.venv",
      "--exclude=__pycache__",
      "-C",
      source,
      "-cf",
      archive,
      ".",
    ],
    { maxBuffer: maximumOutputBytes },
  );
  await fs.chmod(archive, 0o444);
  await execFileAsync("tar", ["--no-same-owner", "-C", root, "-xf", archive], {
    ...candidateOptions,
  });
  await fs.rm(archive, { force: true });
  await execFileAsync(
    "chmod",
    ["--recursive", "a+rwX", root],
    candidateOptions,
  );
  await execFileAsync("git", ["init", "--initial-branch=verification"], {
    ...candidateOptions,
    cwd: root,
  });
  await execFileAsync("git", ["add", "--all"], {
    ...candidateOptions,
    cwd: root,
  });
  await execFileAsync("git", ["clean", "-dffX"], {
    ...candidateOptions,
    cwd: root,
  });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=CloudX verifier",
      "-c",
      "user.email=verifier@invalid.local",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--no-verify",
      "--message=verification source snapshot",
    ],
    { ...candidateOptions, cwd: root },
  );
  await copyGitObjectData(source, root);
  await fs.chmod(path.join(workspaceRoot, "tmp"), 0o1777);
  return root;
}

export async function copyGitObjectData(
  source,
  root,
  { maximumFiles = 10_000, maximumBytes = 256 * 1024 * 1024 } = {},
) {
  const sourceGit = path.join(source, ".git");
  const sourceObjects = path.join(sourceGit, "objects");
  const targetObjects = path.join(root, ".git", "objects");
  const files = [];
  let bytes = 0;
  let entries = 0;
  const directoryEntries = async (directory) => {
    if (!(await fs.lstat(directory)).isDirectory()) {
      throw new Error("Git object input must use non-symlink directories.");
    }
    const names = await fs.readdir(directory);
    entries += names.length;
    if (entries > maximumFiles + 258) {
      throw new Error("Git object input exceeds its file-count bound.");
    }
    return names;
  };
  await directoryEntries(sourceGit);
  for (const directory of await directoryEntries(sourceObjects)) {
    if (directory !== "pack" && !/^[0-9a-f]{2}$/u.test(directory)) continue;
    const names = await directoryEntries(path.join(sourceObjects, directory));
    for (const name of names) {
      const pack = /^pack-([0-9a-f]{40})\.(pack|idx)$/u.exec(name);
      if (directory === "pack") {
        if (!pack) continue;
        const counterpart = `pack-${pack[1]}.${pack[2] === "pack" ? "idx" : "pack"}`;
        if (!names.includes(counterpart)) {
          throw new Error(
            "Git object input requires matched pack/index files.",
          );
        }
      } else if (!/^[0-9a-f]{38}$/u.test(name)) continue;
      const relative = path.join(directory, name);
      const input = path.join(sourceObjects, relative);
      const stat = await fs.lstat(input);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) {
        throw new Error("Git object input must be bounded regular files.");
      }
      bytes += stat.size;
      files.push({ relative, input, stat });
      if (files.length > maximumFiles || bytes > maximumBytes) {
        throw new Error("Git object input exceeds its size/count bounds.");
      }
    }
  }
  // Copy only immutable object bytes, never source configuration or references.
  // No source Git command or Git object parser runs in the supervisor.
  for (const { relative, input, stat } of files) {
    const handle = await fs.open(
      input,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        opened.size !== stat.size
      ) {
        throw new Error("Git object input changed before copying.");
      }
      const output = path.join(targetObjects, relative);
      const createdDirectory = await fs.mkdir(path.dirname(output), {
        recursive: true,
      });
      if (createdDirectory !== undefined)
        await fs.chmod(createdDirectory, 0o777);
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== stat.size)
        throw new Error("Git object input changed size.");
      const data = buffer.subarray(0, length);
      try {
        await fs.writeFile(output, data, { flag: "wx", mode: 0o444 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await fs.lstat(output);
        if (
          !existing.isFile() ||
          existing.size !== data.length ||
          !(await fs.readFile(output)).equals(data)
        ) {
          throw new Error(
            "Git object input conflicts with the fresh snapshot.",
          );
        }
      }
    } finally {
      await handle.close();
    }
  }
  return { files: files.length, bytes };
}

export function prepareSupervisor() {
  requireRootSupervisor();
  process.setgroups([]);
}

export async function prepareAttestation(target = "/results/results.json") {
  requireRootSupervisor();
  const stat = await fs.lstat(target);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size !== 0 ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.uid === candidateIdentity.uid
  ) {
    throw new Error(
      "Verifier attestation must be an empty mode-0600 regular file owned outside the candidate UID.",
    );
  }
  const handle = await fs.open(
    target,
    fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
  );
  try {
    const result = await handle.stat();
    if (
      result.dev !== stat.dev ||
      result.ino !== stat.ino ||
      result.size !== 0 ||
      result.nlink !== 1
    ) {
      throw new Error("Verifier attestation changed while it was opened.");
    }
    return { target, handle, dev: result.dev, ino: result.ino };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function publishAttestation(attestation, evidence) {
  requireRootSupervisor();
  try {
    const target = await fs.lstat(attestation.target);
    if (
      target.isSymbolicLink() ||
      target.dev !== attestation.dev ||
      target.ino !== attestation.ino
    ) {
      throw new Error("Verifier attestation path changed during verification.");
    }
    await attestation.handle.truncate(0);
    await attestation.handle.writeFile(
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    await attestation.handle.sync();
  } finally {
    await attestation.handle.close();
  }
}

async function main() {
  prepareSupervisor();
  const attestation = await prepareAttestation();
  let evidence;
  try {
    const root = await prepareWorkspace();
    process.chdir(root);
    evidence = await executeVerification({
      root,
      identity: candidateIdentity,
      settleCandidates: () => terminateCandidateProcesses(),
    });
  } catch (error) {
    evidence = failedEvidence("prepare or execute verifier", error);
  }
  try {
    await terminateCandidateProcesses();
  } catch (error) {
    evidence = failedEvidence("terminate candidate processes", error);
  }
  await publishAttestation(attestation, evidence);
  if (evidence.verdict !== "passed") process.exitCode = 1;
}

async function liveProcessesOwnedBy(uid, procRoot) {
  const entries = await fs.readdir(procRoot, { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const status = await fs.readFile(
        path.join(procRoot, entry.name, "status"),
        "utf8",
      );
      const owner = /^Uid:\s+(\d+)/mu.exec(status)?.[1];
      const state = /^State:\s+([A-Z])/mu.exec(status)?.[1];
      if (Number(owner) === uid && state !== "Z") {
        processes.push(Number(entry.name));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return processes;
}

function failedEvidence(commandName, error) {
  const zero = "0".repeat(64);
  return {
    schema_version: 1,
    kind: "managed-container-verification",
    verdict: "failed",
    tree_sha256_before: zero,
    tree_sha256_after: zero,
    commands: [
      {
        command: commandName,
        exit_code: 1,
        stdout_sha256: zero,
        stderr_sha256: digest(
          error instanceof Error ? error.message : String(error),
        ),
        tree_sha256_before: zero,
        tree_sha256_after: zero,
      },
    ],
  };
}

function requireRootSupervisor() {
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error("Verifier supervisor must run as root.");
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath)
  await main();
