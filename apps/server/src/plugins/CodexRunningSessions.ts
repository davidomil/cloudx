import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_PROCESSES = 10_000;
const MAX_COMMAND_BYTES = 1_048_576;
const BRIDGE = "codex-worker-bridge.mjs";

/** Recovery may waive a broken original CLI only when its native sessions are absent. */
export async function assertNoRunningCodexSessions(
  assistantBin: string,
  signal?: AbortSignal,
  processDirectory = "/proc",
): Promise<void> {
  signal?.throwIfAborted();
  if (!path.isAbsolute(assistantBin) || !process.getuid)
    throw new Error(
      "Codex recovery requires an absolute original executable and same-user process inspection.",
    );
  const original = new Set([assistantBin, await fs.realpath(assistantBin)]);
  const deadline = Date.now() + 5_000;
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error(
        "Codex recovery process inspection exceeded its time limit.",
      );
  };
  try {
    const processes = (await fs.readdir(processDirectory)).filter((name) =>
      /^[1-9]\d*$/u.test(name),
    );
    if (processes.length > MAX_PROCESSES)
      throw new Error(
        "Codex recovery process inspection exceeds the process limit.",
      );
    for (const pid of processes) {
      check();
      const directory = path.join(processDirectory, pid);
      let command;
      try {
        if ((await fs.stat(directory)).uid !== process.getuid()) continue;
        check();
        command = await readCommand(path.join(directory, "cmdline"), check);
      } catch (error) {
        if (
          ["ENOENT", "ESRCH"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          continue;
        throw error;
      }
      for (const executable of bridgeExecutables(command)) {
        check();
        if (
          original.has(executable) ||
          original.has(await fs.realpath(executable))
        ) {
          throw new Error(
            "The original Codex sessions are still running and must be preserved after native startup failed. Finish or stop those tabs and Forge workers before selecting a recovery version.",
          );
        }
      }
    }
    check();
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      `Codex recovery cannot confirm that original native sessions are absent. ${error instanceof Error ? error.message : "Process inspection failed."}`,
      { cause: error },
    );
  }
}

async function readCommand(file: string, check: () => void): Promise<string[]> {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("A process command line is not a regular file.");
    const buffer = Buffer.alloc(MAX_COMMAND_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      check();
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_COMMAND_BYTES)
      throw new Error("A process command line exceeds the 1 MiB limit.");
    return buffer.subarray(0, length).toString("utf8").split("\0");
  } finally {
    await handle.close();
  }
}

function bridgeExecutables(args: string[]): string[] {
  let launch = args;
  if (
    /^python3(?:\.\d+)?$/u.test(path.basename(args[0] ?? "")) &&
    args[1] === "-I" &&
    args[2] === "-S" &&
    args[3] === "-c" &&
    /^CLOUDX_TERMINAL_SUPERVISOR_CONTRACT = "execution-json-v1"$/mu.test(
      args[4] ?? "",
    )
  ) {
    launch = args.slice(8);
  }
  if (
    ["bash", "zsh"].includes(path.basename(launch[0] ?? "")) &&
    launch[1] === "-lc" &&
    launch[2]?.startsWith("exec ")
  ) {
    let prefix;
    try {
      prefix = shellWords(launch[2], 3);
    } catch {
      return [];
    }
    if (
      !isNodeExecutable(prefix[1]) ||
      path.basename(prefix[2] ?? "") !== BRIDGE
    )
      return [];
    launch = shellWords(launch[2]).slice(1);
  }
  return isNodeExecutable(launch[0]) &&
    path.basename(launch[1] ?? "") === BRIDGE
    ? [bridgeExecutable(launch[2])]
    : [];
}

function isNodeExecutable(command: string | undefined): boolean {
  return (
    command === process.execPath ||
    ["node", "nodejs"].includes(path.basename(command ?? ""))
  );
}

function bridgeExecutable(input: string | undefined): string {
  let launch;
  try {
    launch = JSON.parse(input ?? "");
  } catch {
    throw new Error("A CloudX native bridge launch is malformed.");
  }
  if (typeof launch?.command !== "string" || !path.isAbsolute(launch.command))
    throw new Error("A CloudX native bridge executable is unavailable.");
  return launch.command;
}

/** Decode the single-quote escaping emitted by buildLoginShellCommandLaunch. */
function shellWords(command: string, limit = Infinity): string[] {
  const words: string[] = [];
  let word = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === "'") {
      quoted = !quoted;
      started = true;
    } else if (!quoted && character === "\\") {
      if (command[++index] !== "'")
        throw new Error("A CloudX native bridge shell launch is malformed.");
      word += "'";
      started = true;
    } else if (!quoted && /\s/u.test(character)) {
      if (started) words.push(word);
      if (words.length === limit) return words;
      word = "";
      started = false;
    } else {
      if (!quoted && !/[A-Za-z0-9_/:=.,@%+-]/u.test(character))
        throw new Error("A CloudX native bridge shell launch is malformed.");
      word += character;
      started = true;
    }
  }
  if (quoted)
    throw new Error("A CloudX native bridge shell launch is malformed.");
  if (started) words.push(word);
  return words;
}
