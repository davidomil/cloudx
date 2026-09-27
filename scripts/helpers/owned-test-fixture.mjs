import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import {
  existsSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const supervisor = fileURLToPath(
  new URL("../../apps/server/helpers/terminal-supervisor.py", import.meta.url),
);
const cleanupFailure = () =>
  Object.assign(
    new Error(
      "Fixture process cleanup could not be confirmed; directory retained.",
    ),
    { code: "ECLEANUP" },
  );
const cancelled = () =>
  Object.assign(new Error("Fixture command cancelled during cleanup."), {
    code: "ECANCELED",
  });

// Commands use the same subreaper as production terminals. Plain asynchronous
// writes are joined separately so their failures cannot disappear before close.
export class OwnedTestFixture {
  pending = new Set();
  commands = new Map();
  writeFailures = [];
  failedWrites = 0;
  phases = [];
  closing = false;
  unsafeToDelete = false;

  static async create(name, options) {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-managed-history-"),
    );
    return new OwnedTestFixture(name, root, options);
  }

  constructor(
    name,
    root,
    { diagnostics = "test-results/fixtures", cleanupMs = 15_000 } = {},
  ) {
    this.name = name;
    this.root = root;
    this.cleanupMs = cleanupMs;
    this.diagnosticFile = path.resolve(diagnostics, `${randomUUID()}.json`);
  }

  trackWrite(promise) {
    if (this.closing)
      throw new Error("Fixture is closing; new writers are forbidden.");
    this.pending.add(promise);
    promise.then(
      () => this.pending.delete(promise),
      (error) => {
        this.pending.delete(promise);
        this.failedWrites++;
        if (this.writeFailures.length < 32)
          this.writeFailures.push({ code: privateErrorCode(error) });
      },
    );
    return promise;
  }

  run(phase, executable, args, options = {}) {
    if (this.closing)
      throw new Error("Fixture is closing; new commands are forbidden.");
    const controller = new AbortController();
    const command = this.command(
      phase,
      executable,
      args,
      options,
      controller.signal,
    );
    this.commands.set(controller, command);
    command.then(
      () => this.commands.delete(controller),
      () => this.commands.delete(controller),
    );
    return command;
  }

  async command(phase, executable, args, options, signal) {
    const started = performance.now();
    const observation = { phase, state: "running" };
    this.phases.push(observation);
    let directory;
    try {
      // Outside the fixture: the deletion command must retain its own receipts.
      directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "cloudx-history-command-"),
      );
      observation.receiptDirectory = directory;
      if (signal?.aborted) {
        await fs.rm(directory, { recursive: true, force: true });
        throw cancelled();
      }
      const result = await new Promise((resolve, reject) => {
        const {
          timeout = 120_000,
          maxBuffer = 4 * 1024 * 1024,
          ...spawnOptions
        } = options;
        // Establish receipt observation before any command can be launched.
        const watcher = watch(directory);
        watcher.unref();
        const child = spawn(
          "python3",
          [
            "-I",
            "-S",
            supervisor,
            directory,
            String(process.pid),
            "null",
            executable,
            ...args,
          ],
          {
            cwd: this.root,
            ...spawnOptions,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        observation.pid = child.pid;
        let failure, completion, shutdownTimer;
        let stopping = false,
          settled = false,
          acknowledged = false;
        const output = { stdout: [], stderr: [] };
        const sizes = { stdout: 0, stderr: 0 };
        const result = () =>
          Object.fromEntries(
            Object.entries(output).map(([name, chunks]) => [
              name,
              Buffer.concat(chunks).toString("utf8"),
            ]),
          );
        const settle = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(shutdownTimer);
          signal?.removeEventListener("abort", abort);
          if (error) reject(Object.assign(error, result()));
          else resolve(result());
        };
        const stop = (error) => {
          failure ??= error;
          if (stopping || settled) return;
          stopping = true;
          // SIGTERM asks the subreaper to kill and reap every adopted descendant.
          child.kill("SIGTERM");
          shutdownTimer = setTimeout(() => {
            this.unsafeToDelete = true;
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            settle(cleanupFailure());
          }, 5_000);
        };
        const abort = () => stop(cancelled());
        const timer = setTimeout(
          () =>
            stop(
              Object.assign(new Error(`Fixture ${phase} timed out.`), {
                code: "ETIMEDOUT",
              }),
            ),
          timeout,
        );
        const acknowledge = () => {
          if (
            acknowledged ||
            !existsSync(path.join(directory, "complete.json"))
          )
            return;
          acknowledged = true;
          try {
            const ready = JSON.parse(
              readFileSync(path.join(directory, "ready.json"), "utf8"),
            );
            const receipt = JSON.parse(
              readFileSync(path.join(directory, "complete.json"), "utf8"),
            );
            if (
              ready.pid !== child.pid ||
              Object.keys(ready).length !== 1 ||
              receipt.pid !== child.pid ||
              !Number.isInteger(receipt.exitCode) ||
              receipt.exitCode < 0 ||
              receipt.exitCode > 255 ||
              (receipt.signal !== undefined &&
                (receipt.exitCode !== 0 ||
                  !Number.isInteger(receipt.signal) ||
                  receipt.signal < 1 ||
                  receipt.signal > 64))
            )
              throw cleanupFailure();
            completion = receipt;
            observation.completion = receipt;
          } catch {
            failure = cleanupFailure();
            this.unsafeToDelete = true;
          }
          try {
            const temporary = path.join(directory, "acknowledged.tmp");
            writeFileSync(temporary, JSON.stringify({ pid: child.pid }), {
              mode: 0o600,
            });
            renameSync(temporary, path.join(directory, "acknowledged.json"));
          } catch {
            stop(cleanupFailure());
          }
        };
        watcher.on("change", acknowledge);
        watcher.on("error", () => stop(cleanupFailure()));
        acknowledge();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        for (const stream of ["stdout", "stderr"]) {
          child[stream].on("data", (bytes) => {
            const available = Math.max(0, maxBuffer - sizes[stream]);
            sizes[stream] += bytes.length;
            if (available) output[stream].push(bytes.subarray(0, available));
            if (sizes[stream] > maxBuffer)
              stop(
                Object.assign(
                  new Error("Fixture command output exceeded its bound."),
                  { code: "ENOBUFS" },
                ),
              );
          });
        }
        child.once("error", (error) => {
          failure ??= error;
        });
        child.once("exit", (code, signal) => {
          observation.exit = { code, signal };
        });
        child.once("close", async (code, signal) => {
          watcher.close();
          observation.close = { code, signal };
          if (settled) return;
          try {
            if (
              completion &&
              !existsSync(directory) &&
              !signal &&
              code === completion.exitCode
            ) {
              observation.childrenReaped = true;
              if (completion.exitCode !== 0 || completion.signal)
                failure ??= Object.assign(
                  new Error(
                    `Fixture ${phase} exited ${completion.exitCode || completion.signal}.`,
                  ),
                  { code: completion.exitCode, signal: completion.signal },
                );
            } else if (
              !acknowledged &&
              !existsSync(path.join(directory, "ready.json"))
            ) {
              // The helper writes readiness before forking any command.
              await fs.rm(directory, { recursive: true, force: true });
              failure ??= Object.assign(
                new Error("Fixture supervisor exited before launch."),
                { code: "ESUPERVISOR" },
              );
            } else {
              this.unsafeToDelete = true;
              failure = cleanupFailure();
            }
          } catch {
            this.unsafeToDelete = true;
            failure = cleanupFailure();
          }
          settle(failure);
        });
      });
      observation.state = "passed";
      return result;
    } catch (error) {
      if (directory && observation.pid === undefined)
        await fs.rm(directory, { recursive: true, force: true });
      observation.state = "failed";
      observation.code = privateErrorCode(error);
      throw error;
    } finally {
      observation.durationMs = Math.round(performance.now() - started);
    }
  }

  async close(bodyState = "unknown") {
    this.closing = true;
    const started = performance.now();
    const report = {
      name: this.name,
      bodyState,
      phases: this.phases,
      cleanup: { state: "running" },
    };
    try {
      const waiting = performance.now();
      const commands = [...this.commands.values()];
      for (const controller of this.commands.keys()) controller.abort();
      await Promise.all([
        Promise.allSettled(commands),
        within(
          Promise.allSettled([...this.pending]),
          5_000,
          "pending fixture writers",
        ),
      ]);
      if (this.unsafeToDelete) throw cleanupFailure();
      report.cleanup.waitMs = Math.round(performance.now() - waiting);
      await this.command(
        "remove-fixture",
        process.execPath,
        [
          "-e",
          "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })",
          this.root,
        ],
        { cwd: os.tmpdir(), timeout: this.cleanupMs },
      );
      try {
        await fs.access(this.root);
        throw new Error("Fixture directory survived deletion.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      report.cleanup.directoryRemoved = true;
      if (this.failedWrites) throw new Error("Tracked fixture write failed.");
      report.cleanup.state = "passed";
    } catch (error) {
      report.cleanup.state = "failed";
      throw new Error(
        `Fixture ${this.name} cleanup failed after ${Math.round(performance.now() - started)}ms (test body: ${bodyState}).`,
        { cause: error },
      );
    } finally {
      report.cleanup.durationMs = Math.round(performance.now() - started);
      report.writes = {
        failed: this.failedWrites,
        failures: this.writeFailures,
      };
      await fs.mkdir(path.dirname(this.diagnosticFile), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(this.diagnosticFile, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
    }
  }
}

function privateErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code)
    ? error.code
    : null;
}

async function within(promise, milliseconds, phase) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${phase}.`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
