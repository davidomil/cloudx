import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { terminalSupervisorRuntime } from "./TerminalSupervisorRuntime.js";

/** Identifies the running code, independently of files replaced by an updater. */
export async function recordTerminalRuntime(dataDir: string, role: "web" | "broker"): Promise<void> {
  const directory = path.join(dataDir, "terminal-runtime");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const owner = await fs.lstat(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid!() || (owner.mode & 0o777) !== 0o700) {
    throw new Error("The terminal runtime receipt directory must be owned by the current user with mode 0700.");
  }
  const stat = await fs.readFile(`/proc/${process.pid}/stat`, "utf8");
  const receipt = {
    version: 1, role, pid: process.pid,
    invocationId: process.env.INVOCATION_ID,
    started: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
    bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    brokerProtocol: 1, supervisor: terminalSupervisorRuntime,
    ...(role === "broker" ? { attachmentExitBeforeReady: true } : {})
  };
  const temporary = path.join(directory, `${role}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, path.join(directory, `${role}.json`));
}
