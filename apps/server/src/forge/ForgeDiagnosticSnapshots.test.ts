import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extract } from "tar";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readDirectoryIdentity } from "../directoryIdentity.js";
import { ForgeDiagnosticSnapshotRecovery } from "./ForgeDiagnosticSnapshotRecovery.js";
import { ForgeDiagnosticSnapshots, isOwnedDiagnosticSnapshot, type OwnedDiagnosticSnapshot } from "./ForgeDiagnosticSnapshots.js";

const execute = promisify(execFile);
const workerId = "worker-1";
const attemptId = "attempt-1";
const url = "https://github.com/example/project.git";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-diagnostic-snapshot-"));
  onTestFinished(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  const checkout = path.join(root, "checkout");
  await fs.mkdir(path.join(checkout, "nested"), { recursive: true });
  const git = async (args: string[]) => (await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: checkout, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })).stdout;
  await git(["init", "--initial-branch=main", "--template="]);
  await git(["config", "user.name", "Snapshot test"]);
  await git(["config", "user.email", "snapshot@example.invalid"]);
  await git(["config", "tar.umask", "0022"]);
  await fs.writeFile(path.join(checkout, ".gitignore"), ".cloudx/\n*.log\n");
  await fs.writeFile(path.join(checkout, "source.txt"), "Committed source\n");
  await fs.writeFile(path.join(checkout, "nested", "child.txt"), "Committed child\n");
  await git(["add", "."]);
  await git(["commit", "-m", "Committed diagnostic input"]);
  const commitSha = (await git(["rev-parse", "HEAD"])).trim();
  const checkoutIdentity = await readDirectoryIdentity(checkout);
  const gitDirectory = await readDirectoryIdentity(path.join(checkout, ".git"));
  const recovery = new ForgeDiagnosticSnapshotRecovery(path.join(root, "durable-data"));
  const snapshots = new ForgeDiagnosticSnapshots(recovery);
  const journal: OwnedDiagnosticSnapshot[] = [];
  const save = async (snapshot: OwnedDiagnosticSnapshot) => { journal.push(structuredClone(snapshot)); };
  const create = (kind: "source-only" | "repository" = "source-only") => snapshots.create(checkoutIdentity, gitDirectory, url,
    workerId, attemptId, { kind, commitSha }, git, save);
  const retire = (snapshot: OwnedDiagnosticSnapshot, protectedPaths: string[] = [], saveRemoval = async () => {}, signal?: AbortSignal) =>
    snapshots.retire(checkoutIdentity, [snapshot], protectedPaths, saveRemoval, git, signal);
  return { root, checkout, checkoutIdentity, gitDirectory, git, commitSha, snapshots, recovery, journal, save, create, retire };
}

async function interruptRemoval(state: Awaited<ReturnType<typeof fixture>>, snapshot: OwnedDiagnosticSnapshot): Promise<string> {
  const retiring = path.join(path.dirname(snapshot.identity.path), "retiring-source");
  const remove = fs.rm.bind(fs);
  vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).endsWith("/retiring-source")) {
      await remove(path.join(retiring, "nested", "child.txt"));
      throw new Error("Interrupted source removal");
    }
    return remove(...args);
  });
  await expect(state.retire(snapshot)).rejects.toThrow("Interrupted source removal");
  vi.restoreAllMocks();
  expect(snapshot.state).toBe("removing");
  await expect(fs.lstat(snapshot.identity.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(retiring, "source.txt"), "utf8")).toBe("Committed source\n");
  return retiring;
}

describe("Owned Forge diagnostic snapshots", () => {
  it("rejects an oversized committed tree before allocating or recording a copy", async () => {
    const state = await fixture();
    const git = vi.fn(async (args: string[]) => {
      const result = await state.git(args);
      if (!args.includes("ls-tree")) return result;
      const oversized = result.replace(/(^|\0)([0-7]{6} blob [a-f0-9]+ +)\d+(\t)/u,
        (_entry, boundary: string, metadata: string, separator: string) => `${boundary}${metadata}${1024 ** 3 + 1}${separator}`);
      expect(oversized).not.toBe(result);
      return oversized;
    });
    const save = vi.fn(state.save);
    await expect(state.snapshots.create(state.checkoutIdentity, state.gitDirectory, url, workerId, attemptId,
      { kind: "source-only", commitSha: state.commitSha }, git, save)).rejects.toThrow("bounded 1 GiB / 100000 entry limit");
    expect(save).not.toHaveBeenCalled();
    expect(git.mock.calls.some(([args]) => args.includes("archive"))).toBe(false);
    await expect(fs.lstat(path.join(state.checkout, ".cloudx"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records ownership and commit provenance before exporting committed source without Git or working files", async () => {
    const state = await fixture();
    await fs.writeFile(path.join(state.checkout, "source.txt"), "Staged source\n");
    await state.git(["add", "source.txt"]);
    await fs.writeFile(path.join(state.checkout, "source.txt"), "Unstaged source\n");
    await fs.writeFile(path.join(state.checkout, "untracked.txt"), "Local investigation\n");
    await fs.writeFile(path.join(state.checkout, "ignored.log"), "Ignored investigation\n");
    const git = vi.fn(state.git);
    const snapshot = await state.snapshots.create(state.checkoutIdentity, state.gitDirectory, url, workerId, attemptId,
      { kind: "source-only", commitSha: state.commitSha }, git, async receipt => {
        await state.save(receipt);
        if (receipt.state === "creating") expect(git.mock.calls.some(([args]) => args.includes("archive"))).toBe(false);
      });
    expect(snapshot.path).toMatch(/^\.cloudx\/forge-snapshots\/[a-f0-9-]{36}\/source$/u);
    expect(snapshot).toMatchObject({ workerId, attemptId, kind: "source-only", retentionPolicy: "disposable", state: "ready",
      origin: { checkout: state.checkoutIdentity, gitDirectory: state.gitDirectory, commitSha: state.commitSha, url } });
    expect(snapshot.identity).toEqual(await readDirectoryIdentity(snapshot.identity.path));
    expect(state.journal.map(receipt => receipt.state)).toEqual(["creating", "ready"]);
    expect(state.journal[0]!.contents).toBeUndefined();
    expect(state.journal.every(receipt => isOwnedDiagnosticSnapshot(receipt, workerId, state.checkoutIdentity))).toBe(true);
    expect((await fs.readdir(snapshot.identity.path)).sort()).toEqual([".gitignore", "nested", "source.txt"]);
    expect(await fs.readFile(path.join(snapshot.identity.path, "source.txt"), "utf8")).toBe("Committed source\n");
    expect(snapshot.contents!.map(entry => entry.path)).not.toContain(".git");
    expect(await fs.readdir(path.dirname(snapshot.identity.path))).toEqual(["source"]);
  });

  it("exports executable mode and committed dangling link bytes before retiring only the copy", async () => {
    const state = await fixture();
    const linkTarget = "missing-source.txt";
    await fs.writeFile(path.join(state.checkout, "run.sh"), "#!/bin/sh\nprintf 'diagnostic source\\n'\n");
    await fs.chmod(path.join(state.checkout, "run.sh"), 0o755);
    await fs.symlink(linkTarget, path.join(state.checkout, "external-link"));
    await state.git(["add", "run.sh", "external-link"]);
    await state.git(["commit", "-m", "Executable and committed link"]);
    const commitSha = (await state.git(["rev-parse", "HEAD"])).trim();
    const snapshot = await state.snapshots.create(state.checkoutIdentity, state.gitDirectory, url, workerId, attemptId,
      { kind: "source-only", commitSha }, state.git, state.save);
    const executable = path.join(snapshot.identity.path, "run.sh");
    const linked = path.join(snapshot.identity.path, "external-link");
    const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
    expect((await fs.stat(executable)).mode & 0o777).toBe(0o755 & ~process.umask());
    expect(sha256(await fs.readFile(executable))).toBe(sha256(await state.git(["show", `${commitSha}:run.sh`])));
    expect((await fs.lstat(linked)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(linked)).mode & 0o777).toBe(0o777);
    expect(await fs.readlink(linked)).toBe(linkTarget);
    await expect(fs.stat(linked)).rejects.toMatchObject({ code: "ENOENT" });
    expect(sha256(await fs.readlink(linked))).toBe(sha256(await state.git(["show", `${commitSha}:external-link`])));
    await state.retire(snapshot);
    expect(snapshot.state).toBe("removed");
    await expect(fs.lstat(snapshot.identity.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readlink(path.join(state.checkout, "external-link"))).toBe(linkTarget);
    expect(await fs.readFile(path.join(state.checkout, "source.txt"), "utf8")).toBe("Committed source\n");
  });

  it("preserves repository copies and their unique unpublished refs in a verified archive before retirement", async () => {
    const state = await fixture();
    const tree = (await state.git(["rev-parse", "HEAD^{tree}"])).trim();
    const unpublished = (await state.git(["commit-tree", tree, "-m", "Unpublished diagnostic history"])).trim();
    await state.git(["update-ref", "refs/private/investigation", unpublished]);
    const snapshot = await state.create("repository");
    const gitArgs = [`--git-dir=${path.join(snapshot.identity.path, ".git")}`, `--work-tree=${snapshot.identity.path}`];
    expect(snapshot.retentionPolicy).toBe("recover");
    expect((await state.git([...gitArgs, "rev-parse", "refs/private/investigation"])).trim()).toBe(unpublished);
    expect(await state.git([...gitArgs, "cat-file", "-p", unpublished])).toContain("Unpublished diagnostic history");
    await state.retire(snapshot);
    expect(snapshot.state).toBe("removed");
    expect(snapshot.recovery?.state).toBe("verified");
    const restored = path.join(state.root, "restored-repository");
    await fs.mkdir(restored);
    await extract({ file: snapshot.recovery!.archivePath, cwd: restored });
    expect(await state.git([`--git-dir=${path.join(restored, ".git")}`, "cat-file", "-p", unpublished])).toContain("Unpublished diagnostic history");
    await state.recovery.verify(snapshot);
  });

  it.each(["directory", "symbolic link"])("preserves a replacement %s when source ownership changes while saving the creation receipt", async replacement => {
    const state = await fixture();
    const relocated = path.join(state.root, "relocated-source");
    let replacementPath = "";
    await expect(state.snapshots.create(state.checkoutIdentity, state.gitDirectory, url, workerId, attemptId,
      { kind: "source-only", commitSha: state.commitSha }, state.git, async receipt => {
        await state.save(receipt);
        if (receipt.state !== "creating") return;
        await fs.rename(receipt.identity.path, relocated);
        replacementPath = replacement === "directory" ? receipt.identity.path : path.join(state.root, "outside-source");
        await fs.mkdir(replacementPath);
        await fs.writeFile(path.join(replacementPath, "keep.txt"), "Preserve replacement bytes\n");
        if (replacement === "symbolic link") await fs.symlink(replacementPath, receipt.identity.path);
      })).rejects.toThrow(/ownership changed|symbolic link/u);
    expect(await fs.readdir(replacementPath)).toEqual(["keep.txt"]);
    expect(await fs.readFile(path.join(replacementPath, "keep.txt"), "utf8")).toBe("Preserve replacement bytes\n");
    expect(await fs.readdir(relocated)).toEqual([]);
    expect(state.journal.map(receipt => receipt.state)).toEqual(["creating"]);
  });

  it.each(["investigation.log", "source.txt"])("preserves %s added while the creation receipt is saved instead of blessing or overwriting it", async file => {
    const state = await fixture();
    await expect(state.snapshots.create(state.checkoutIdentity, state.gitDirectory, url, workerId, attemptId,
      { kind: "source-only", commitSha: state.commitSha }, state.git, async receipt => {
        await state.save(receipt);
        if (receipt.state === "creating") await fs.writeFile(path.join(receipt.identity.path, file), "Preserve investigator bytes\n");
      })).rejects.toThrow("acquired source during creation");
    const interrupted = state.journal[0]!;
    expect(await fs.readFile(path.join(interrupted.identity.path, file), "utf8")).toBe("Preserve investigator bytes\n");
    expect(state.journal.map(receipt => receipt.state)).toEqual(["creating"]);
    await expect(state.retire(interrupted)).rejects.toThrow("requires recovery");
    expect(await fs.readFile(path.join(interrupted.identity.path, file), "utf8")).toBe("Preserve investigator bytes\n");
  });

  it("preserves source added after the archive command finishes and before extraction", async () => {
    const state = await fixture();
    let injected = false;
    await expect(state.snapshots.create(state.checkoutIdentity, state.gitDirectory, url, workerId, attemptId,
      { kind: "source-only", commitSha: state.commitSha }, async args => {
        const result = await state.git(args);
        if (args.includes("archive")) {
          injected = true;
          await fs.writeFile(path.join(state.journal[0]!.identity.path, "source.txt"), "Preserve source written during export\n");
        }
        return result;
      }, state.save)).rejects.toThrow("acquired source during creation");
    expect(injected).toBe(true);
    expect(await fs.readFile(path.join(state.journal[0]!.identity.path, "source.txt"), "utf8")).toBe("Preserve source written during export\n");
    expect(state.journal.map(receipt => receipt.state)).toEqual(["creating"]);
  });

  it("preserves an extracted source edit made after committed-content verification", async () => {
    const state = await fixture();
    const unlink = fs.unlink.bind(fs);
    let edited = false;
    vi.spyOn(fs, "unlink").mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
      await unlink(...args);
      if (String(args[0]).endsWith("/source.tar")) {
        edited = true;
        await fs.writeFile(path.join(state.journal[0]!.identity.path, "source.txt"), "Preserve source edited after verification\n");
      }
    });
    await expect(state.create()).rejects.toThrow("changed after committed-source verification");
    expect(edited).toBe(true);
    expect(await fs.readFile(path.join(state.journal[0]!.identity.path, "source.txt"), "utf8")).toBe("Preserve source edited after verification\n");
    expect(state.journal.map(receipt => receipt.state)).toEqual(["creating"]);
  });

  it.each(["empty", "partial object store"])("rejects an explicit %s .git instead of discovering the ancestor repository", async kind => {
    const state = await fixture();
    const nested = path.join(state.checkout, "partial-copy");
    const partialGit = path.join(nested, ".git");
    await fs.mkdir(partialGit, { recursive: true });
    if (kind === "partial object store") await fs.cp(path.join(state.gitDirectory.path, "objects"), path.join(partialGit, "objects"), { recursive: true });
    expect((await state.git(["-C", nested, "rev-parse", "HEAD"])).trim()).toBe(state.commitSha);
    const save = vi.fn(state.save);
    await expect(state.snapshots.create(await readDirectoryIdentity(nested), await readDirectoryIdentity(partialGit), url,
      workerId, attemptId, { kind: "source-only", commitSha: state.commitSha }, state.git, save)).rejects.toThrow(/not a git repository/u);
    expect(save).not.toHaveBeenCalled();
    expect(await fs.readdir(nested)).toEqual([".git"]);
  });

  it("retires only an unchanged source copy and records both removal transitions", async () => {
    const state = await fixture();
    const snapshot = await state.create();
    const transitions: string[] = [];
    await state.retire(snapshot, [], async () => { transitions.push(snapshot.state); });
    expect(transitions).toEqual(["ready", "removing", "removed"]);
    await expect(fs.lstat(snapshot.identity.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(state.checkout, "source.txt"), "utf8")).toBe("Committed source\n");
    expect((await state.git(["rev-parse", "HEAD"])).trim()).toBe(state.commitSha);
  });

  it.each(["edit", "deletion", "untracked source", "ignored log", "partial .git", "bare repository"])("preserves a source-only copy after %s changes its authorized contents", async change => {
    const state = await fixture();
    const snapshot = await state.create();
    const source = snapshot.identity.path;
    let protectedFile = path.join(source, "source.txt");
    if (change === "edit") await fs.writeFile(protectedFile, "Edited diagnostic source\n");
    if (change === "deletion") await fs.unlink(path.join(source, "nested", "child.txt"));
    if (change === "untracked source" || change === "ignored log") {
      protectedFile = path.join(source, change === "ignored log" ? "investigation.log" : "investigation.txt");
      await fs.writeFile(protectedFile, "New diagnostic evidence\n");
    }
    if (change === "partial .git") {
      protectedFile = path.join(source, ".git", "objects", "unique-object");
      await fs.mkdir(path.dirname(protectedFile), { recursive: true });
      await fs.writeFile(protectedFile, "Unique local object bytes\n");
    }
    if (change === "bare repository") {
      await state.git(["init", "--bare", "--template=", path.join(source, "history")]);
      protectedFile = path.join(source, "history", "HEAD");
    }
    const before = await fs.readFile(protectedFile);
    const save = vi.fn(async () => {});
    await expect(state.retire(snapshot, [], save)).rejects.toThrow(/contents were preserved|repository history/u);
    expect(await fs.readFile(protectedFile)).toEqual(before);
    expect(snapshot.state).toBe("ready");
    expect(save).toHaveBeenCalledOnce();
    expect(snapshot.hold).toBeTruthy();
    expect(snapshot.removalContents).toBeUndefined();
  });

  it.each(["copy", "parent", "child"])("respects explicit retention of the snapshot %s", async selection => {
    const state = await fixture();
    const snapshot = await state.create();
    const retained = selection === "parent" ? ".cloudx" : selection === "child" ? `${snapshot.path}/source.txt` : snapshot.path;
    await expect(state.retire(snapshot, [retained])).rejects.toThrow("explicitly retained");
    expect(await fs.readFile(path.join(snapshot.identity.path, "source.txt"), "utf8")).toBe("Committed source\n");
  });

  it("stops cancellation during content verification without moving or removing source bytes", async () => {
    const state = await fixture();
    const snapshot = await state.create();
    const controller = new AbortController();
    const open = fs.open.bind(fs);
    let interrupted = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith("/proc/self/fd/") && String(args[0]).endsWith("/source.txt")) {
        interrupted = true;
        controller.abort(new Error("Cancelled snapshot verification"));
      }
      return handle;
    });
    const save = vi.fn(async () => {});
    await expect(state.retire(snapshot, [], save, controller.signal)).rejects.toThrow("Cancelled snapshot verification");
    expect(interrupted).toBe(true);
    expect(await fs.readFile(path.join(snapshot.identity.path, "source.txt"), "utf8")).toBe("Committed source\n");
    expect(snapshot.state).toBe("ready");
    expect(save).not.toHaveBeenCalled();
    expect(snapshot.hold).toBeUndefined();
    expect(snapshot.removalContents).toBeUndefined();
  });

  it.each(["directory", "symbolic link"])("preserves a replacement source %s and the relocated original", async replacement => {
    const state = await fixture();
    const snapshot = await state.create();
    const recovered = path.join(state.root, "recovered-source");
    await fs.rename(snapshot.identity.path, recovered);
    if (replacement === "directory") {
      await fs.mkdir(snapshot.identity.path);
      await fs.writeFile(path.join(snapshot.identity.path, "source.txt"), "Replacement evidence\n");
    } else await fs.symlink(recovered, snapshot.identity.path);
    await expect(state.retire(snapshot)).rejects.toThrow(/ownership changed|symbolic link/u);
    expect(await fs.readFile(path.join(recovered, "source.txt"), "utf8")).toBe("Committed source\n");
    expect(await fs.readFile(path.join(snapshot.identity.path, "source.txt"), "utf8")).toBe(replacement === "directory" ? "Replacement evidence\n" : "Committed source\n");
    expect(snapshot.state).toBe("ready");
  });

  it("preserves the original source moved into a replacement snapshot parent", async () => {
    const state = await fixture();
    const snapshot = await state.create();
    const parent = path.dirname(snapshot.identity.path);
    const recoveredParent = path.join(state.root, "recovered-parent");
    await fs.rename(parent, recoveredParent);
    await fs.mkdir(parent);
    await fs.rename(path.join(recoveredParent, "source"), snapshot.identity.path);
    await fs.writeFile(path.join(parent, "investigation.log"), "Replacement parent evidence\n");
    await expect(state.retire(snapshot)).rejects.toThrow("ownership changed");
    expect(await fs.readFile(path.join(snapshot.identity.path, "source.txt"), "utf8")).toBe("Committed source\n");
    expect(await fs.readFile(path.join(parent, "investigation.log"), "utf8")).toBe("Replacement parent evidence\n");
    expect(snapshot.state).toBe("ready");
  });

  it("preserves both copies when source and interrupted removal directories conflict", async () => {
    const state = await fixture();
    const snapshot = await state.create();
    const retiring = path.join(path.dirname(snapshot.identity.path), "retiring-source");
    await fs.mkdir(retiring);
    await fs.writeFile(path.join(retiring, "investigation.log"), "Conflicting removal evidence\n");
    await expect(state.retire(snapshot)).rejects.toThrow("conflicting removal directories");
    expect(await fs.readFile(path.join(snapshot.identity.path, "source.txt"), "utf8")).toBe("Committed source\n");
    expect(await fs.readFile(path.join(retiring, "investigation.log"), "utf8")).toBe("Conflicting removal evidence\n");
  });

  it.each(["source", "retiring-source"])("blocks cleanup when %s reappears after its snapshot was removed", async directory => {
    const state = await fixture();
    const snapshot = await state.create();
    await state.retire(snapshot);
    const reappeared = path.join(path.dirname(snapshot.identity.path), directory);
    await fs.mkdir(reappeared);
    await fs.writeFile(path.join(reappeared, "investigation.log"), "New source evidence\n");
    const save = vi.fn(async () => {});
    await expect(state.retire(snapshot, [], save)).rejects.toThrow("reappeared");
    expect(await fs.readFile(path.join(reappeared, "investigation.log"), "utf8")).toBe("New source evidence\n");
    expect(snapshot.state).toBe("removed");
    expect(save).toHaveBeenCalledOnce();
    expect(snapshot.hold).toContain("reappeared after retirement");
  });

  it("accepts an already removed snapshot while both source paths remain absent", async () => {
    const state = await fixture();
    const snapshot = await state.create();
    await state.retire(snapshot);
    const save = vi.fn(async () => {});
    await state.retire(snapshot, [], save);
    expect(snapshot.state).toBe("removed");
    expect(save).not.toHaveBeenCalled();
    expect(snapshot.hold).toBeUndefined();
  });

  it("resumes interrupted removal of surviving authorized bytes", async () => {
    const state = await fixture();
    const snapshot = await state.create();
    const retiring = await interruptRemoval(state, snapshot);
    await new ForgeDiagnosticSnapshots().retire(state.checkoutIdentity, [structuredClone(snapshot)], [], async () => {}, state.git);
    await expect(fs.lstat(retiring)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(state.checkout, "source.txt"), "utf8")).toBe("Committed source\n");
  });

  it.each(["added evidence", "modified source", "partial .git"])("preserves %s when interrupted removal is resumed", async change => {
    const state = await fixture();
    const snapshot = await state.create();
    const retiring = await interruptRemoval(state, snapshot);
    const protectedFile = path.join(retiring, change === "modified source" ? "source.txt" : change === "partial .git" ? ".git/unique-object" : "recovered.log");
    await fs.mkdir(path.dirname(protectedFile), { recursive: true });
    await fs.writeFile(protectedFile, "Preserve changed diagnostic bytes\n");
    const resumed = structuredClone(snapshot);
    await expect(new ForgeDiagnosticSnapshots().retire(state.checkoutIdentity, [resumed], [], async () => {}, state.git))
      .rejects.toThrow(/new or modified contents|repository history/u);
    expect(await fs.readFile(protectedFile, "utf8")).toBe("Preserve changed diagnostic bytes\n");
    expect(resumed.state).toBe("removing");
  });

  it("requires recovery for a copy interrupted before its content authorization was recorded", async () => {
    const state = await fixture();
    await expect(state.snapshots.create(state.checkoutIdentity, state.gitDirectory, url, workerId, attemptId,
      { kind: "source-only", commitSha: state.commitSha }, async args => {
        if (args.includes("archive")) throw new Error("Interrupted archive export");
        return state.git(args);
      }, state.save)).rejects.toThrow("Interrupted archive export");
    const interrupted = state.journal[0]!;
    await fs.writeFile(path.join(interrupted.identity.path, "investigation.log"), "Evidence from incomplete export\n");
    await expect(state.retire(interrupted)).rejects.toThrow("requires recovery");
    expect(await fs.readFile(path.join(interrupted.identity.path, "investigation.log"), "utf8")).toBe("Evidence from incomplete export\n");
  });

  it.each(["checkout identity", "Git directory identity", "missing commit"])("preserves the copy when its origin has changed %s", async change => {
    const state = await fixture();
    const snapshot = await state.create();
    if (change === "checkout identity") snapshot.origin.checkout = { ...snapshot.origin.checkout, ino: "0" };
    if (change === "Git directory identity") snapshot.origin.gitDirectory = { ...snapshot.origin.gitDirectory, ino: "0" };
    if (change === "missing commit") snapshot.origin.commitSha = "f".repeat(state.commitSha.length);
    await expect(state.retire(snapshot)).rejects.toThrow(change === "missing commit" ? /Needed a single revision|origin cannot be verified/u : /ownership changed/u);
    expect(await fs.readFile(path.join(snapshot.identity.path, "source.txt"), "utf8")).toBe("Committed source\n");
    expect(snapshot.state).toBe("ready");
  });

  it("keeps a missing repository snapshot held until its external recovery has verified provenance", async () => {
    const state = await fixture();
    const snapshot = await state.create("repository");
    const recovered = path.join(state.root, "recovered-repository");
    await fs.rename(snapshot.identity.path, recovered);
    await expect(state.retire(snapshot)).rejects.toThrow("receipt does not belong");
    expect(snapshot.state).toBe("ready");
    expect(snapshot.recovery).toBeUndefined();
    expect((await state.git([`--git-dir=${path.join(recovered, ".git")}`, "rev-parse", "HEAD"])).trim()).toBe(state.commitSha);
    expect(await fs.readFile(path.join(recovered, "source.txt"), "utf8")).toBe("Committed source\n");
  });

  it.each(["source-only", "repository"] as const)("keeps relocated %s snapshot records until their required recovery proof is available", async kind => {
    const state = await fixture();
    const snapshot = await state.create(kind);
    const recoveredParent = path.join(state.root, "recovered-snapshot");
    await fs.rename(path.dirname(snapshot.identity.path), recoveredParent);
    const save = vi.fn(async () => {});
    if (kind === "repository") {
      await expect(state.retire(snapshot, [], save)).rejects.toThrow("receipt does not belong");
      expect(snapshot.state).toBe("ready");
      expect(snapshot.recovery).toBeUndefined();
    } else {
      await state.retire(snapshot, [], save);
      expect(snapshot.state).toBe("removed");
    }
    expect(save).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(recoveredParent, "source", "source.txt"), "utf8")).toBe("Committed source\n");
    if (kind === "repository") expect((await state.git([`--git-dir=${path.join(recoveredParent, "source", ".git")}`, "rev-parse", "HEAD"])).trim()).toBe(state.commitSha);
    await expect(fs.lstat(snapshot.identity.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes repository removal after restart using the same verified archive of the complete original copy", async () => {
    const state = await fixture();
    const snapshot = await state.create("repository");
    const retiring = await interruptRemoval(state, snapshot);
    expect(snapshot.recovery?.state).toBe("verified");
    const receipt = structuredClone(snapshot.recovery!);
    const archiveInode = (await fs.stat(receipt.archivePath)).ino;
    const restored = path.join(state.root, "original-before-partial-removal");
    await fs.mkdir(restored);
    await extract({ file: receipt.archivePath, cwd: restored });
    expect(await fs.readFile(path.join(restored, "nested", "child.txt"), "utf8")).toBe("Committed child\n");
    await expect(fs.lstat(path.join(retiring, "nested", "child.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const resumed = structuredClone(snapshot);
    const recovery = new ForgeDiagnosticSnapshotRecovery(path.join(state.root, "durable-data"));
    const restarted = new ForgeDiagnosticSnapshots(recovery);
    await restarted.retire(state.checkoutIdentity, [resumed], [], async () => {}, state.git);
    expect(resumed.state).toBe("removed");
    expect(resumed.hold).toBeUndefined();
    expect(resumed.recovery).toEqual(receipt);
    expect((await fs.stat(receipt.archivePath)).ino).toBe(archiveInode);
    expect((await fs.readdir(receipt.directory.path)).sort()).toEqual(["ownership.json", "snapshot.tar"]);
    await recovery.verify(resumed);
    await expect(fs.lstat(retiring)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["added working file", "changed working file", "new Git object"])("protects %s in pending repository removal after restart", async change => {
    const state = await fixture();
    const snapshot = await state.create("repository");
    const retiring = await interruptRemoval(state, snapshot);
    const receipt = structuredClone(snapshot.recovery!);
    const archiveInode = (await fs.stat(receipt.archivePath)).ino;
    const relative = change === "changed working file" ? "source.txt" : change === "new Git object" ? ".git/objects/ab/unpublished" : "investigation.txt";
    const protectedFile = path.join(retiring, relative);
    await fs.mkdir(path.dirname(protectedFile), { recursive: true });
    await fs.writeFile(protectedFile, "New evidence after the preserved copy\n");
    const resumed = structuredClone(snapshot);
    const recovery = new ForgeDiagnosticSnapshotRecovery(path.join(state.root, "durable-data"));
    await expect(new ForgeDiagnosticSnapshots(recovery).retire(state.checkoutIdentity, [resumed], [], async () => {}, state.git))
      .rejects.toThrow("new or modified contents");
    expect(resumed.state).toBe("removing");
    expect(await fs.readFile(protectedFile, "utf8")).toBe("New evidence after the preserved copy\n");
    expect((await fs.stat(receipt.archivePath)).ino).toBe(archiveInode);
    await recovery.verify(resumed);
  });

  it.each(["ready", "removing", "removed"] as const)("holds an absent %s repository snapshot without an archive receipt despite matching origin HEAD", async status => {
    const state = await fixture();
    const snapshot = await state.create("repository");
    await fs.rm(snapshot.identity.path, { recursive: true });
    snapshot.state = status;
    expect((await state.git(["rev-parse", "HEAD"])).trim()).toBe(state.commitSha);
    await expect(state.retire(snapshot)).rejects.toThrow("receipt does not belong");
    expect(snapshot.state).toBe(status);
    expect(snapshot.recovery).toBeUndefined();
    expect(snapshot.hold).toContain("receipt does not belong");
  });

  it.each(["directory", "symbolic link"])("protects the changed repository replacement %s and the original copy", async replacement => {
    const state = await fixture();
    const snapshot = await state.create("repository");
    const original = path.join(state.root, "original-repository");
    await fs.rename(snapshot.identity.path, original);
    if (replacement === "directory") {
      await fs.mkdir(snapshot.identity.path);
      await fs.writeFile(path.join(snapshot.identity.path, "investigation.txt"), "Replacement evidence\n");
    } else await fs.symlink(original, snapshot.identity.path);
    await expect(state.retire(snapshot)).rejects.toThrow(/ownership changed|symbolic link/u);
    expect(snapshot.state).toBe("ready");
    expect(snapshot.recovery).toBeUndefined();
    expect(await fs.readFile(path.join(original, "source.txt"), "utf8")).toBe("Committed source\n");
    if (replacement === "directory") expect(await fs.readFile(path.join(snapshot.identity.path, "investigation.txt"), "utf8")).toBe("Replacement evidence\n");
    else expect(await fs.readlink(snapshot.identity.path)).toBe(original);
  });

  it("rejects malformed or mismatched serialized ownership without granting a disposable lifecycle", async () => {
    const state = await fixture();
    const snapshot = await state.create();
    const invalid = [null, {}, [], { ...snapshot, workerId: "other-worker" }, { ...snapshot, attemptId: "../attempt" },
      { ...snapshot, path: "nested/source" }, { ...snapshot, path: `${snapshot.path}/../source` },
      { ...snapshot, retentionPolicy: "recover" }, { ...snapshot, state: "unknown" }, { ...snapshot, contents: undefined },
      { ...snapshot, identity: { ...snapshot.identity, path: state.checkout } },
      { ...snapshot, identity: { ...snapshot.identity, ino: "unverified" } },
      { ...snapshot, parentIdentity: undefined }, { ...snapshot, parentIdentity: { ...snapshot.parentIdentity, path: state.checkout } },
      { ...snapshot, parentIdentity: { ...snapshot.parentIdentity, ino: "unverified" } },
      { ...snapshot, origin: { ...snapshot.origin, checkout: { ...state.checkoutIdentity, ino: "0" } } },
      { ...snapshot, origin: { ...snapshot.origin, gitDirectory: { ...state.gitDirectory, path: path.join(state.root, ".git") } } },
      { ...snapshot, origin: { ...snapshot.origin, commitSha: "HEAD" } },
      { ...snapshot, contents: [{ path: "../outside", fingerprint: "a".repeat(64) }] },
      { ...snapshot, contents: [snapshot.contents![0], snapshot.contents![0]] }];
    expect(isOwnedDiagnosticSnapshot(snapshot, workerId, state.checkoutIdentity)).toBe(true);
    for (const receipt of invalid) expect(isOwnedDiagnosticSnapshot(receipt, workerId, state.checkoutIdentity)).toBe(false);
  });
});
