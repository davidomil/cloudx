import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";

/** The kernel releases this lock after a crash; no stale ownership file needs removal. */
export class ForgeWriterLease {
  private child?: ChildProcess;
  private held = false;

  async acquire(file: string): Promise<void> {
    if (this.held) return;
    const handle = await fs.open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Forge writer ownership must be a regular file.");
      const child = spawn("flock", ["--nonblock", "--conflict-exit-code", "73", "--no-fork", "/proc/self/fd/3",
        process.execPath, "-e", `
          // The owner closes stdin only after graceful shutdown has persisted its state.
          process.on("SIGINT", () => {});
          process.on("SIGTERM", () => {});
          process.stdin.resume();
          process.stdin.on("end", () => process.exit(0));
          process.stdout.write("owned\\n");
        `],
      { stdio: ["pipe", "pipe", "ignore", handle.fd] });
      this.child = child;
      child.on("exit", () => { this.held = false; });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => reject(new Error(code === 73
          ? "Another CloudX service owns the Forge workflow and merge queues. Stop that service before starting a competing writer."
          : "Forge could not acquire its workflow writer lock.")));
        child.stdout!.once("data", () => { this.held = true; resolve(); });
      });
    } finally { await handle.close(); }
  }

  assertHeld(): void {
    if (!this.held) throw new Error("Forge lost its workflow writer ownership. Restart to reconcile saved queues before continuing.");
  }

  async release(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      child.once("exit", () => resolve());
      child.stdin!.end();
    });
  }
}
