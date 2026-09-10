import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RulesSkillsGitService } from "./RulesSkillsGitService.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function startStatus() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-catalog-git-command-"));
  roots.push(root);
  const child = Object.assign(new EventEmitter(), { pid: 123456789, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  let spawned!: () => void;
  const started = new Promise<void>(resolve => { spawned = resolve; });
  vi.mocked(spawn).mockImplementation(() => {
    spawned();
    return child as unknown as ReturnType<typeof spawn>;
  });
  const result = new RulesSkillsGitService(root).status().catch((error: Error) => error);
  await started;
  return { root, child, result };
}

describe("catalog Git command boundary", () => {
  it.each([undefined, null, 42, false, {}, [], "", "   "])("rejects pull without a displayed destination before fetching: %j", async expectedOriginUrl => {
    const service = new RulesSkillsGitService("/catalog");
    vi.spyOn(service, "status").mockResolvedValue({
      isRepository: true, rootPath: "/catalog", branch: "main", originUrl: "/origin.git", hasChanges: false, hasCommits: true
    });
    vi.mocked(spawn).mockClear();

    await expect(service.pull(expectedOriginUrl)).rejects.toThrow(/expectedOriginUrl/i);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects pull from a stale displayed destination without exposing either URL or fetching", async () => {
    const service = new RulesSkillsGitService("/catalog");
    vi.spyOn(service, "status").mockResolvedValue({
      isRepository: true, rootPath: "/catalog", branch: "main", originUrl: "https://example.test/new.git", hasChanges: false, hasCommits: true
    });
    vi.mocked(spawn).mockClear();

    await expect(service.pull("https://private-user:private-password@example.test/old.git")).rejects.toEqual(
      new Error("Origin changed since it was displayed. Refresh Git status and review the destination before pulling.")
    );

    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses only the catalog cwd and a noninteractive environment without inherited Git redirection", async () => {
    vi.stubEnv("GIT_DIR", "/unrelated/repository");
    vi.stubEnv("GIT_WORK_TREE", "/unrelated/files");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "/unrelated/hooks");
    const { root, child, result } = await startStatus();
    child.emit("close", 128);

    expect(await result).toMatchObject({ isRepository: false, rootPath: root });
    const [executable, args, options] = vi.mocked(spawn).mock.lastCall!;
    expect(executable).toBe("git");
    expect(args).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "protocol.ext.allow=never", "-C", root]));
    expect(options).toMatchObject({ stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    expect(options?.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" });
    expect(options?.env).not.toHaveProperty("GIT_DIR");
    expect(options?.env).not.toHaveProperty("GIT_WORK_TREE");
    expect(options?.env).not.toHaveProperty("GIT_CONFIG_COUNT");
    expect(options?.env).not.toHaveProperty("GIT_CONFIG_VALUE_0");
  });

  it("reports launch failures without exposing subprocess details", async () => {
    const { child, result } = await startStatus();
    child.emit("error", new Error("secret launch details"));
    child.emit("close", -2);

    expect(await result).toEqual(new Error("Could not start Git. Check that Git is installed and the catalog is accessible."));
  });

  it("keeps remote credentials in failed Git output out of public errors", async () => {
    const { child, result } = await startStatus();
    child.stderr.write("fatal: https://user:secret-token@example.test/private failed");
    child.emit("close", 1);

    expect(await result).toEqual(new Error("Catalog Git command failed. Check the origin, branch, repository permissions, and Git authentication."));
  });

  it("terminates the Git process group when output exceeds its bound", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const { child, result } = await startStatus();
    child.stdout.write(Buffer.alloc(2_000_001));
    child.emit("close", null);

    expect(await result).toEqual(new Error("Catalog Git command exceeded its output limit."));
    if (process.platform === "win32") expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    else expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  });

  it("terminates a stalled Git process group at the deadline and clears its timer", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const { child, result } = await startStatus();
    await vi.advanceTimersByTimeAsync(60_000);
    child.emit("close", null);

    expect(await result).toEqual(new Error("Catalog Git command timed out after 60 seconds. Check the remote and authentication."));
    if (process.platform === "win32") expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    else expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });
});
