import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { isSameOrChildPath } from "../pathBoundary.js";

const execute = promisify(execFile);
// A thread group whose leader has exited may still run threads. During an
// ordinary exit those threads are already leaving: the kernel queues SIGKILL
// to each (zap_other_threads) and sets PF_EXITING in do_exit. Only then is
// the group given time to finish; other surviving threads stay uncertain.
const PF_EXITING = 0x4;
const SIGKILL_BIT = 1n << 8n;
const DEFAULT_EXIT_SETTLE_MS = 2_000;
const EXIT_POLL_MS = 20;
interface ProcessIdentity {
  name: string;
  parent: string;
  state: string;
  started: string;
  uids: number[];
  threads?: number;
  // PF_EXITING: the leader thread has started to exit.
  exiting: boolean;
}
interface SystemUserManager {
  pid: string;
  controlGroup: string;
  workingDirectory: string;
  rootDirectory: string;
  rootImage: string;
}
interface Dependencies {
  procDirectory?: string;
  // How long an exiting thread group may take to finish before it is uncertain.
  exitSettleMs?: number;
  uid?: number;
  systemUserManager?: (uid: number) => Promise<SystemUserManager>;
}

/** The system-owned user manager and its PAM keeper are infrastructure; user units are inspected normally. */
export class WorkspaceProcessActivity {
  private readonly procDirectory: string;
  private readonly uid: number;
  constructor(private readonly deps: Dependencies = {}) {
    this.procDirectory = deps.procDirectory ?? "/proc";
    this.uid = deps.uid ?? (process.platform === "linux" ? process.getuid!() : -1);
  }

  async assertInactive(directory: string): Promise<void> {
    if (process.platform !== "linux") throw new Error("Process activity inspection requires Linux; workspaces were preserved.");
    const resolved = path.resolve(directory);
    for (const pid of await fs.readdir(this.procDirectory)) {
      if (!/^\d+$/u.test(pid)) continue;
      let before: ProcessIdentity | undefined;
      try {
        before = await this.identity(pid);
        if (!before.uids.includes(this.uid)) continue;
        if (exited(before)) { await this.assertThreadGroupExited(pid, before); continue; }
        const open: string[] = [];
        const uncertainty: string[] = [];
        try { open.push(await fs.readlink(this.procPath(pid, "cwd"))); }
        catch (error) { uncertainty.push(`cwd: ${message(error)}`); }
        try {
          for (const fd of await fs.readdir(this.procPath(pid, "fd"))) {
            try {
              const file = await fs.readlink(this.procPath(pid, `fd/${fd}`));
              if (file.startsWith("/")) open.push(file);
            } catch (error) {
              if (!vanished(error)) uncertainty.push(`open file ${fd}: ${message(error)}`);
            }
          }
        } catch (error) { uncertainty.push(`open files: ${message(error)}`); }
        const after = await this.identity(pid);
        if (!sameProcess(before, after)) throw new Error("Process identity changed during inspection. Scan again.");
        if (exited(after)) { await this.assertThreadGroupExited(pid, after); continue; }
        const active = open.find(file => [file, file.replace(/ \(deleted\)$/u, "")].some(openPath => isSameOrChildPath(resolved, path.resolve(openPath))));
        if (active) throw new ActiveWorkspaceProcess(`A running process (PID ${pid}) still uses this workspace: ${active}`);
        // An exiting process's files become unreadable before it is a zombie.
        if (uncertainty.length && after.exiting && await this.otherThreadsExiting(pid)) {
          await this.awaitExit(pid, after, uncertainty);
          continue;
        }
        if (uncertainty.length) {
          const verified = await this.isSystemUserInfrastructure(pid, after, resolved).catch(error => {
            throw new Error(`${uncertainty.join("; ")}; ${message(error)}`);
          });
          if (!verified) throw new Error(uncertainty.join("; "));
        }
      } catch (error) {
        if (error instanceof ActiveWorkspaceProcess) throw error;
        if (vanished(error)) {
          // A missing cwd/fd is not proof that the PID vanished (the main thread may have exited).
          try {
            const current = await this.identity(pid);
            if (exited(current)) { await this.assertThreadGroupExited(pid, current); continue; }
          }
          catch (current) { if (vanished(current)) continue; }
        }
        throw new Error(`Process activity for ${resolved} is uncertain: PID ${pid}${before ? ` (${before.name})` : ""}: ${message(error)}`);
      }
    }
  }

  private procPath(pid: string, file: string): string { return path.join(this.procDirectory, pid, file); }

  private async assertThreadGroupExited(pid: string, leader: ProcessIdentity): Promise<void> {
    const deadline = Date.now() + (this.deps.exitSettleMs ?? DEFAULT_EXIT_SETTLE_MS);
    while (true) {
      let current: ProcessIdentity;
      try { current = await this.identity(pid); }
      catch (error) { if (vanished(error)) return; throw error; }
      if (!sameProcess(leader, current)) throw new Error("Process identity changed during inspection. Scan again.");
      if (exited(current) && current.threads === 1) return;
      if (!exited(current) || current.threads === undefined || Date.now() >= deadline || !await this.otherThreadsExiting(pid))
        throw new Error(`Thread group exit is unconfirmed: leader state ${current.state}; ${current.threads === undefined ? "thread count is unavailable" : `${current.threads} threads remain`}.`);
      await sleep(EXIT_POLL_MS);
    }
  }

  // Waits for a process whose threads are all exiting to finish, within the
  // settle bound; otherwise its activity stays uncertain.
  private async awaitExit(pid: string, leader: ProcessIdentity, uncertainty: string[]): Promise<void> {
    const deadline = Date.now() + (this.deps.exitSettleMs ?? DEFAULT_EXIT_SETTLE_MS);
    while (Date.now() < deadline) {
      await sleep(EXIT_POLL_MS);
      let current: ProcessIdentity;
      try { current = await this.identity(pid); }
      catch (error) { if (vanished(error)) return; throw error; }
      if (!sameProcess(leader, current)) throw new Error("Process identity changed during inspection. Scan again.");
      if (exited(current)) return this.assertThreadGroupExited(pid, current);
    }
    throw new Error(`${uncertainty.join("; ")}; the exiting process did not finish.`);
  }

  // True when every thread besides the leader is exiting or already gone.
  private async otherThreadsExiting(pid: string): Promise<boolean> {
    let threads: string[];
    try { threads = await fs.readdir(this.procPath(pid, "task")); }
    catch (error) { return vanished(error); }
    for (const tid of threads.filter(tid => tid !== pid && /^\d+$/u.test(tid))) {
      try {
        const stat = await fs.readFile(this.procPath(pid, `task/${tid}/stat`), "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
        const flags = Number(fields[6]);
        if (["Z", "X", "x"].includes(fields[0] ?? "") || (Number.isSafeInteger(flags) && (flags & PF_EXITING) !== 0)) continue;
        const status = await fs.readFile(this.procPath(pid, `task/${tid}/status`), "utf8");
        const masks = ["SigPnd", "ShdPnd"].map(name => new RegExp(`^${name}:\\s+([0-9a-f]+)\\s*$`, "mu").exec(status)?.[1]);
        if (masks.some(mask => mask !== undefined && (BigInt(`0x${mask}`) & SIGKILL_BIT) !== 0n)) continue;
        return false;
      } catch (error) {
        if (!vanished(error)) return false;
      }
    }
    return true;
  }

  private async identity(pid: string): Promise<ProcessIdentity> {
    const stat = await fs.readFile(this.procPath(pid, "stat"), "utf8");
    const name = /^\d+ \((.*)\) /su.exec(stat);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    const status = await fs.readFile(this.procPath(pid, "status"), "utf8");
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/mu.exec(status);
    const threads = /^Threads:\s+(\d+)\s*$/mu.exec(status);
    if (!name || !/^\d+$/u.test(fields[1] ?? "") || !/^\d+$/u.test(fields[19] ?? "") || !uids)
      throw new Error("Process ownership or start-time identity is unavailable.");
    const flags = Number(fields[6]);
    return {
      name: name[1]!, parent: fields[1]!, state: fields[0]!, started: fields[19]!, uids: uids.slice(1).map(Number),
      exiting: Number.isSafeInteger(flags) && (flags & PF_EXITING) !== 0, ...(threads ? { threads: Number(threads[1]) } : {})
    };
  }

  private async isSystemUserInfrastructure(pid: string, identity: ProcessIdentity, directory: string): Promise<boolean> {
    const managerProcess = identity.name === "systemd" && identity.parent === "1";
    const pamKeeper = identity.name === "(sd-pam)";
    if ((!managerProcess && !pamKeeper) || identity.uids.some(uid => uid !== this.uid)) return false;
    try {
      const expectedGroup = `/user.slice/user-${this.uid}.slice/user@${this.uid}.service`;
      const group = await fs.readFile(this.procPath(pid, "cgroup"), "utf8");
      if (!group.trim().split("\n").includes(`0::${expectedGroup}/init.scope`)) return false;
      const managerPid = managerProcess ? pid : identity.parent;
      const managerBefore = managerProcess ? identity : await this.identity(managerPid);
      if (managerBefore.name !== "systemd" || managerBefore.parent !== "1" || managerBefore.uids.some(uid => uid !== this.uid)) return false;
      if (await fs.readFile(this.procPath(managerPid, "cgroup"), "utf8") !== group) return false;
      const manager = await (this.deps.systemUserManager ?? systemUserManager)(this.uid);
      if (manager.pid !== managerPid || manager.controlGroup !== expectedGroup || manager.rootDirectory || manager.rootImage) return false;
      if (manager.workingDirectory) {
        if (!path.isAbsolute(manager.workingDirectory) || isSameOrChildPath(directory, await fs.realpath(manager.workingDirectory))) return false;
      }
      if (!sameProcess(identity, await this.identity(pid))) throw new Error("System user manager identity changed during inspection. Scan again.");
      if (!sameProcess(managerBefore, await this.identity(managerPid))) throw new Error("System user manager parent identity changed during inspection. Scan again.");
      if (await fs.readFile(this.procPath(pid, "cgroup"), "utf8") !== group) throw new Error("System user manager ownership changed during inspection. Scan again.");
      if (await fs.readFile(this.procPath(managerPid, "cgroup"), "utf8") !== group) throw new Error("System user manager parent ownership changed during inspection. Scan again.");
      return true;
    } catch (error) {
      throw new Error(`Cannot verify the system-owned user manager: ${message(error)}`);
    }
  }
}

class ActiveWorkspaceProcess extends Error {}
function exited(identity: ProcessIdentity): boolean { return ["Z", "X", "x"].includes(identity.state); }
function sameProcess(first: ProcessIdentity, second: ProcessIdentity): boolean {
  return first.started === second.started && first.name === second.name && first.parent === second.parent && first.uids.every((uid, index) => uid === second.uids[index]);
}
function vanished(error: unknown): boolean { return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? ""); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function systemUserManager(uid: number): Promise<SystemUserManager> {
  const result = await execute("systemctl", ["--system", "--no-pager", "show", `user@${uid}.service`,
    "--property=MainPID", "--property=ControlGroup", "--property=WorkingDirectory", "--property=RootDirectory", "--property=RootImage"],
  { timeout: 5_000, maxBuffer: 16_384, env: { ...process.env, SYSTEMD_PAGER: "", SYSTEMD_COLORS: "0" } });
  const fields = Object.fromEntries(result.stdout.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  if (!["MainPID", "ControlGroup", "WorkingDirectory", "RootDirectory", "RootImage"].every(key => typeof fields[key] === "string")) throw new Error("The system service record is incomplete.");
  return { pid: fields.MainPID!, controlGroup: fields.ControlGroup!, workingDirectory: fields.WorkingDirectory!, rootDirectory: fields.RootDirectory!, rootImage: fields.RootImage! };
}
