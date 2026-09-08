import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { TerminalProcessTree } from "./TerminalProcessTree.js";

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
});

describe.skipIf(process.platform !== "linux")("TerminalProcessTree", () => {
  it("waits for a terminal and its detached child to stop while preserving an unrelated process", async () => {
    const childScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const command = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'});console.log(child.pid);process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    const terminal = spawn(process.execPath, ["-e", command], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const unrelated = spawn(process.execPath, ["-e", childScript], { detached: true, stdio: "ignore" });
    children.push(terminal, unrelated);
    const tree = new TerminalProcessTree(terminal.pid!);
    const detachedPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Child did not start")), 5_000);
      terminal.stdout!.once("data", (data: Buffer) => { clearTimeout(timer); resolve(Number(data.toString().trim())); });
    });
    try {
      await tree.terminate();
      expect(await isRunning(terminal.pid!)).toBe(false);
      expect(await isRunning(detachedPid)).toBe(false);
      expect(await isRunning(unrelated.pid!)).toBe(true);
      await expect(tree.terminate()).resolves.toBeUndefined();
    } finally {
      try { process.kill(detachedPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  });

  it("treats an already exited terminal as quiescent", async () => {
    const terminal = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
    children.push(terminal);
    const tree = new TerminalProcessTree(terminal.pid!);
    await new Promise<void>((resolve) => terminal.once("exit", () => resolve()));
    await expect(tree.terminate()).resolves.toBeUndefined();
  });
});

async function isRunning(pid: number): Promise<boolean> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
