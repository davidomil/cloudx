import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { HardwareError, requireHardware } from "./HardwareError.js";

export class HardwareWriterLease {
  private child?: ChildProcess;
  private held = false;
  constructor(private readonly onLost?: (error: HardwareError) => void) {}

  async acquire(file: string): Promise<boolean> {
    if (this.held) return false;
    requireHardware(process.platform === "linux", "STORE_UNAVAILABLE", "Hardware storage requires the Linux writer lease.");
    const handle = await fs.open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      requireHardware((await handle.stat()).isFile(), "STORE_UNAVAILABLE", "Hardware writer ownership must be a regular file.");
      const child = spawn("flock", ["--nonblock", "--conflict-exit-code", "73", "--no-fork", "/proc/self/fd/3", process.execPath, "-e", 'process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});process.stdin.resume();process.stdin.on("end",()=>process.exit(0));process.stdout.write("owned\\n")'], { stdio: ["pipe", "pipe", "ignore", handle.fd] });
      this.child = child;
      child.on("exit", () => { const unexpected = this.held && this.child === child; this.held = false; if (unexpected) this.onLost?.(new HardwareError("WRITER_LOST", "Hardware writer ownership was lost.")); });
      await new Promise<void>((resolve, reject) => {
        child.once("error", error => reject(new HardwareError("STORE_UNAVAILABLE", "The Linux flock writer lease helper could not be started.", { errno: (error as NodeJS.ErrnoException).code })));
        child.once("exit", code => reject(new HardwareError("WRITER_LOST", code === 73 ? "Another CloudX service owns this hardware inventory." : "Hardware writer ownership could not be acquired.")));
        child.stdout!.once("data", () => { this.held = true; resolve(); });
      });
      await handle.close();
      return true;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await this.release().catch(() => undefined);
      throw error;
    }
  }

  assertHeld(): void { requireHardware(this.held, "WRITER_LOST", "Hardware writer ownership was lost. Run operator reconciliation to reacquire saved claims."); }

  async release(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) { this.held = false; return; }
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.stdin!.end(); });
    this.held = false;
  }
}
