import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PluginSessionOwnershipError, type PreparedCodexLaunch } from "@cloudx/plugin-api";

import { TerminalSupervisor } from "../terminal/TerminalSupervisor.js";
import { StdioAppServerTransport } from "./AppServerClient.js";

export class AppServerOwnershipError extends PluginSessionOwnershipError {}

/** Owns preparatory Codex RPCs and every descendant until the TUI can take over. */
export class OwnedAppServerTransport extends StdioAppServerTransport {
  private constructor(private readonly native: ChildProcessByStdio<Writable, Readable, null>, private readonly supervisor: TerminalSupervisor) {
    super({ process: native, stop: () => supervisor.kill() });
  }

  async finish(): Promise<void> {
    this.native.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.supervisor.completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Codex conversation writer did not close before the shutdown deadline.")), 5_000);
        }),
      ]);
      if (result.error) throw new AppServerOwnershipError("Codex conversation shutdown did not confirm descendant ownership.", { cause: result.error });
      if (result.event.exitCode !== 0 || result.event.signal)
        throw new Error("Codex conversation writer did not exit cleanly.");
    } finally { clearTimeout(timer); }
  }

  static async create(launch: PreparedCodexLaunch, signal?: AbortSignal): Promise<OwnedAppServerTransport> {
    signal?.throwIfAborted();
    if (process.platform !== "linux") throw new Error("Owned Codex sessions require Linux subreaper support.");
    const helper = fileURLToPath(new URL("../../helpers/terminal-supervisor.py", import.meta.url));
    await fs.access(helper);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-app-server-"));
    let supervisor: TerminalSupervisor | undefined;
    const abort = () => supervisor?.kill();
    try {
      const native = spawn("python3", ["-I", "-S", helper, directory, String(process.pid), launch.command, ...launch.configurationArgs, "app-server", "--listen", "stdio://"], {
        cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "ignore"],
      });
      if (!native.pid) {
        await new Promise<void>((resolve) => { native.on("error", () => undefined); native.once("close", () => resolve()); });
        throw new Error("Owned Codex sessions require Python 3.9 or newer on PATH.");
      }
      supervisor = new TerminalSupervisor({
        pid: native.pid,
        kill: signal => { native.kill(signal as NodeJS.Signals); },
        onExit: listener => {
          const exit = (code: number | null) => listener({ exitCode: code ?? 125 });
          native.once("close", exit);
          return { dispose: () => native.off("close", exit) };
        },
      }, directory);
      const transport = new OwnedAppServerTransport(native, supervisor);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      await supervisor.ready();
      signal?.throwIfAborted();
      return transport;
    } catch (error) {
      if (supervisor) {
        try { await supervisor.terminate(); } catch (cleanupError) {
          throw new AppServerOwnershipError("Codex conversation preparation failed and process ownership is unresolved.", { cause: new AggregateError([error, cleanupError]) });
        }
      } else await fs.rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async terminate(): Promise<void> {
    this.close();
    try { await this.supervisor.terminate(); } catch (error) {
      throw new AppServerOwnershipError("Codex conversation process ownership is unresolved. Local resources were preserved.", { cause: error });
    }
  }
}
