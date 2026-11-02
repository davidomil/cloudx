import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { pinClaudeManagedExecutable } from "./ClaudeManagedExecutable.js";

it("pins the canonical executable selected by the launch PATH", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-executable-"));
  try {
    await fs.mkdir(path.join(root, "bin"));
    const native = path.join(root, "claude-reviewed");
    await fs.writeFile(native, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.symlink(native, path.join(root, "bin", "claude"));
    const env: NodeJS.ProcessEnv = { PATH: "missing:bin" };
    await pinClaudeManagedExecutable(env, root);
    expect(env.CLOUDX_CLAUDE_BIN).toBe(native);
    await fs.unlink(path.join(root, "bin", "claude"));
    expect(await fs.readFile(env.CLOUDX_CLAUDE_BIN!, "utf8")).toContain("exit 0");
  } finally { await fs.rm(root, { recursive: true }); }
});

it("rejects missing or non-executable managed launch commands before native work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-executable-"));
  try {
    const binary = path.join(root, "claude");
    await fs.writeFile(binary, "not executable", { mode: 0o600 });
    await expect(pinClaudeManagedExecutable({ CLOUDX_CLAUDE_BIN: binary }, root)).rejects.toThrow("no session has started");
    await expect(pinClaudeManagedExecutable({ PATH: root, CLOUDX_CLAUDE_BIN: "missing" }, root)).rejects.toThrow("configured launch PATH");
  } finally { await fs.rm(root, { recursive: true }); }
});
