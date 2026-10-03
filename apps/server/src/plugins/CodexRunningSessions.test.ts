import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildLoginShellCommandLaunch } from "../terminal/ShellLaunch.js";
import { terminalSupervisorSource } from "../terminal/TerminalSupervisorRuntime.js";
import { assertNoRunningCodexSessions } from "./CodexRunningSessions.js";

let root: string;
let processes: string;
let original: string;
const bridge = "/cloudx/apps/server/helpers/codex-worker-bridge.mjs";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-running-codex-"));
  processes = path.join(root, "proc");
  original = path.join(root, "codex");
  await fs.mkdir(processes);
  await fs.writeFile(original, "original executable");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function processCommand(args: string[], pid = "12"): Promise<string> {
  const directory = path.join(processes, pid);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "cmdline"), args.join("\0") + "\0");
  return directory;
}

const inspect = (signal?: AbortSignal) =>
  assertNoRunningCodexSessions(original, signal, processes);

it.each(["tab", "Forge worker"])(
  "preserves a running original %s bridge",
  async (kind) => {
    await processCommand([
      "node",
      bridge,
      JSON.stringify({
        command: original,
        ...(kind === "Forge worker"
          ? { binding: { workerId: "worker" } }
          : { selection: { tabId: "tab" } }),
      }),
    ]);
    await expect(inspect()).rejects.toThrow(
      "original Codex sessions are still running",
    );
  },
);

it("preserves an original launch retained in supervisor arguments before its bridge starts", async () => {
  const launch = buildLoginShellCommandLaunch(
    "/usr/bin/node",
    [bridge, JSON.stringify({ command: original })],
    { SHELL: "/bin/bash" },
  );
  await processCommand([
    "python3",
    "-I",
    "-S",
    "-c",
    terminalSupervisorSource,
    "/receipt",
    "123",
    "null",
    launch.command,
    ...launch.args,
  ]);
  await expect(inspect()).rejects.toThrow(
    "original Codex sessions are still running",
  );
});

it("recognizes a direct bridge launch retained by a supervisor", async () => {
  await processCommand([
    "python3",
    "-I",
    "-S",
    "-c",
    terminalSupervisorSource,
    "/receipt",
    "123",
    "null",
    "node",
    bridge,
    JSON.stringify({ command: original }),
  ]);
  await expect(inspect()).rejects.toThrow(
    "original Codex sessions are still running",
  );
});

it("matches an alias to the exact original executable", async () => {
  const alias = path.join(root, "aliased-codex");
  await fs.symlink(original, alias);
  await processCommand(["node", bridge, JSON.stringify({ command: alias })]);
  await expect(inspect()).rejects.toThrow(
    "original Codex sessions are still running",
  );
});

it("decodes apostrophes and spaces in login-shell launch arguments", async () => {
  const executable = path.join(root, "original's codex");
  await fs.symlink(original, executable);
  const launch = buildLoginShellCommandLaunch(
    "/usr/bin/node",
    [
      "/cloudx's source/helpers/codex-worker-bridge.mjs",
      JSON.stringify({ command: executable }),
    ],
    { SHELL: "/bin/zsh" },
  );
  await processCommand([launch.command, ...launch.args]);
  await expect(inspect()).rejects.toThrow(
    "original Codex sessions are still running",
  );
});

it("allows recovery when only unrelated binaries and ordinary processes are running", async () => {
  const other = path.join(root, "another-codex");
  await fs.writeFile(other, "unrelated installation");
  await processCommand(["node", bridge, JSON.stringify({ command: other })]);
  await processCommand(["node", "/cloudx/apps/server/dist/server.js"], "34");
  await expect(inspect()).resolves.toBeUndefined();
});

it.each([
  ["editor", ["vim", bridge]],
  ["viewer", ["tail", "-f", bridge]],
  ["search", ["rg", bridge, "."]],
  ["search for a launch command", ["rg", `exec node ${bridge}`, "."]],
  ["another Node script", ["node", "search.mjs", bridge]],
  [
    "Node script JSON data",
    ["node", "search.mjs", JSON.stringify({ file: bridge })],
  ],
  ["another Python script", ["python3", "search.py", bridge]],
  [
    "Python source without the supervisor contract",
    [
      "python3",
      "-I",
      "-S",
      "-c",
      "search source",
      "/receipt",
      "123",
      "null",
      "node",
      bridge,
    ],
  ],
  ["shell search", ["bash", "-lc", `rg '${bridge}' .`]],
  ["shell viewer", ["bash", "-lc", `exec tail -f '${bridge}'`]],
  [
    "shell Node script",
    ["zsh", "-lc", `exec node search.mjs '${bridge}' "$QUERY"`],
  ],
  [
    "shell search with expansion",
    ["bash", "-lc", `exec rg "$QUERY" '${bridge}'`],
  ],
  ["shell executable expansion", ["bash", "-lc", `exec "$VIEWER" '${bridge}'`]],
])(
  "ignores bridge filenames used as ordinary arguments by a %s",
  async (_kind, args) => {
    await processCommand(args);
    await expect(inspect()).resolves.toBeUndefined();
  },
);

it.each([
  { command: "tail", args: ["-f", bridge] },
  { command: "/usr/bin/node", args: ["search.mjs", bridge] },
])(
  "ignores a supervised $command process viewing the bridge",
  async ({ command, args }) => {
    for (const [index, shell] of [
      "/bin/sh",
      "/bin/bash",
      "/bin/zsh",
    ].entries()) {
      const launch = buildLoginShellCommandLaunch(command, args, {
        SHELL: shell,
      });
      await processCommand(
        [
          "python3",
          "-I",
          "-S",
          "-c",
          terminalSupervisorSource,
          "/receipt",
          "123",
          "null",
          launch.command,
          ...launch.args,
        ],
        String(12 + index),
      );
    }
    await expect(inspect()).resolves.toBeUndefined();
  },
);

it("ignores bridge filenames inside a genuine launch's other JSON fields", async () => {
  const other = path.join(root, "another-codex");
  await fs.writeFile(other, "unrelated installation");
  await processCommand([
    "node",
    bridge,
    JSON.stringify({
      command: other,
      cwd: path.dirname(bridge),
      description: bridge,
    }),
  ]);
  await expect(inspect()).resolves.toBeUndefined();
});

it.each(["/bin/sh", "/bin/bash", "/bin/zsh"])(
  "rejects malformed genuine bridges retained by a %s supervisor",
  async (shell) => {
    const launch = buildLoginShellCommandLaunch("node", [bridge, "not JSON"], {
      SHELL: shell,
    });
    await processCommand([
      "python3",
      "-I",
      "-S",
      "-c",
      terminalSupervisorSource,
      "/receipt",
      "123",
      "null",
      launch.command,
      ...launch.args,
    ]);
    await expect(inspect()).rejects.toThrow(
      "native bridge launch is malformed",
    );
  },
);

it("ignores processes owned by another user without reading their command lines", async () => {
  const directory = await processCommand([
    "node",
    bridge,
    JSON.stringify({ command: original }),
  ]);
  const ownership = Object.assign(await fs.stat(directory), {
    uid: process.getuid!() + 1,
  });
  vi.spyOn(fs, "stat").mockResolvedValue(ownership);
  const open = vi.spyOn(fs, "open");
  await expect(inspect()).resolves.toBeUndefined();
  expect(open).not.toHaveBeenCalled();
});

it("ignores a PID that disappears during inspection", async () => {
  await fs.mkdir(path.join(processes, "12"));
  await expect(inspect()).resolves.toBeUndefined();
});

it.each(["not JSON", "{}", '{"command":"codex"}'])(
  "rejects uncertain bridge input %s",
  async (input) => {
    await processCommand(["node", bridge, input]);
    await expect(inspect()).rejects.toThrow("cannot confirm");
  },
);

it("rejects malformed login-shell bridge input", async () => {
  await processCommand([
    "bash",
    "-lc",
    `exec node ${bridge} '{"command":"${original}"}`,
  ]);
  await expect(inspect()).rejects.toThrow("cannot confirm");
});

it("rejects a bridge without its launch input", async () => {
  await processCommand(["node", bridge]);
  await expect(inspect()).rejects.toThrow("cannot confirm");
});

it("rejects a command line with an unexpected file type", async () => {
  const directory = await processCommand(["node", "server.js"]);
  await fs.rm(path.join(directory, "cmdline"));
  await fs.mkdir(path.join(directory, "cmdline"));
  await expect(inspect()).rejects.toThrow("not a regular file");
});

it("rejects unavailable process inspection", async () => {
  await fs.rm(processes, { recursive: true });
  await expect(inspect()).rejects.toThrow("cannot confirm");
});

it("rejects a denied same-user command line", async () => {
  await processCommand(["node", "server.js"]);
  vi.spyOn(fs, "open").mockRejectedValue(
    Object.assign(new Error("Permission denied"), { code: "EACCES" }),
  );
  await expect(inspect()).rejects.toThrow("cannot confirm");
});

it("bounds each same-user process command line", async () => {
  await processCommand(["x".repeat(1_048_577)]);
  await expect(inspect()).rejects.toThrow("1 MiB limit");
});

it("bounds the number of processes inspected", async () => {
  vi.spyOn(fs, "readdir").mockResolvedValue(
    Array.from({ length: 10_001 }, (_, index) => String(index + 1)) as never,
  );
  await expect(inspect()).rejects.toThrow("process limit");
});

it("bounds the total process inspection time", async () => {
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(5_000);
  await expect(inspect()).rejects.toThrow("time limit");
});

it("cancels before inspection", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(inspect(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});

it("cancels while scanning a same-user process", async () => {
  const directory = await processCommand(["node", "server.js"]);
  const ownership = await fs.stat(directory);
  const controller = new AbortController();
  vi.spyOn(fs, "stat").mockImplementation(async () => {
    controller.abort();
    return ownership;
  });
  await expect(inspect(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});
