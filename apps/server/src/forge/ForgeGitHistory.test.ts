import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ForgeGitHistoryReceipt } from "@cloudx/shared";
import { readDirectoryIdentity } from "../directoryIdentity.js";
import { JsonStateFile } from "../jsonStateFile.js";
import { writeEvidenceReceipt } from "./ForgeEvidenceFiles.js";
import { ForgeGitHistory, isGitHistoryReceipt } from "./ForgeGitHistory.js";
import { registerForgeGitHistoryRoutes } from "./ForgeGitHistoryRoutes.js";

vi.mock("./ForgeEvidenceFiles.js", async importOriginal => ({
  ...await importOriginal<typeof import("./ForgeEvidenceFiles.js")>(), maxEvidenceBytes: 1024 * 1024,
}));

const execute = promisify(execFile);

async function fixture(objectFormat = "sha1") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-history-"));
  onTestFinished(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "checkout");
  const dataDir = path.join(root, "data");
  const gitPath = process.env.PATH;
  await fs.mkdir(source);
  const git = async (args: string[], signal?: AbortSignal) => (await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: source, signal, env: { PATH: gitPath, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })).stdout;
  await git(["init", "--initial-branch=main", `--object-format=${objectFormat}`]);
  await git(["config", "user.name", "Archive test"]);
  await git(["config", "user.email", "archive@example.invalid"]);
  await fs.writeFile(path.join(source, "original.txt"), "Unpublished pre-rebase work\n");
  await git(["add", "."]);
  await git(["commit", "-m", "Pre-rebase history"]);
  const originalSha = (await git(["rev-parse", "HEAD"])).trim();
  const ref = `refs/cloudx/before-rebase/${originalSha}`;
  await git(["update-ref", ref, originalSha]);
  await fs.writeFile(path.join(source, "current.txt"), "Current work\n");
  await git(["add", "."]);
  await git(["commit", "-m", "Current head"]);
  const commitSha = (await git(["rev-parse", "HEAD"])).trim();
  const checkoutIdentity = await readDirectoryIdentity(source);
  const archive = new ForgeGitHistory(dataDir);
  const input = { workerId: "worker-1", attemptId: "attempt-1", commitSha, checkoutIdentity, refs: [ref] };
  const ownership = new JsonStateFile(dataDir, "forge-workers/workspaces/worker-1.json", "Fixture ownership");
  let receipt: ForgeGitHistoryReceipt | undefined;
  const save = async (intent: ForgeGitHistoryReceipt) => {
    receipt = intent;
    await writeEvidenceReceipt(ownership, { worktree: checkoutIdentity, gitHistory: intent });
  };
  return { root, source, dataDir, git, archive, input, save, ref, originalSha, ownership, get receipt() { return receipt; } };
}

function beforeBundleVerification(action: (handle: FileHandle) => Promise<void>): void {
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith("/proc/self/fd/") && String(args[0]).endsWith("/history.bundle")) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementationOnce(async () => { await sync(); await action(handle); });
    }
    return handle;
  });
}

describe("Durable generated Git history", () => {
  it("restores exact generated refs and their full history after the source checkout is deleted", async () => {
    const fixtureState = await fixture();
    const secondRef = `refs/cloudx/before-rebase/${fixtureState.input.commitSha}`;
    await fixtureState.git(["update-ref", secondRef, fixtureState.input.commitSha]);
    await fixtureState.git(["update-ref", "refs/private/unpublished", fixtureState.originalSha]);
    await fixtureState.git(["update-ref", "refs/stash", fixtureState.originalSha]);
    const input = { ...fixtureState.input, refs: [secondRef, fixtureState.ref] };
    const manifest = await fixtureState.archive.preserve(input, undefined, fixtureState.save, fixtureState.git);
    expect(manifest.refs).toEqual([
      { name: secondRef, commitSha: fixtureState.input.commitSha },
      { name: fixtureState.ref, commitSha: fixtureState.originalSha },
    ].sort((left, right) => left.name.localeCompare(right.name)));
    expect(await fixtureState.git(["rev-parse", "refs/private/unpublished"])).toBe(`${fixtureState.originalSha}\n`);
    expect(await fixtureState.git(["rev-parse", "refs/stash"])).toBe(`${fixtureState.originalSha}\n`);
    await fs.rm(fixtureState.source, { recursive: true });
    expect(await fixtureState.archive.read(manifest.archiveId)).toEqual(manifest);
    expect(await fixtureState.archive.list()).toEqual([manifest]);
    const download = path.join(fixtureState.root, "restored.bundle");
    const stream = await fixtureState.archive.fileStream(manifest.archiveId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    await fs.writeFile(download, Buffer.concat(chunks));
    const restored = path.join(fixtureState.root, "restored.git");
    await execute("git", ["init", "--bare", "--template=", restored]);
    await execute("git", ["--git-dir", restored, "bundle", "verify", download]);
    await execute("git", ["--git-dir", restored, "fetch", download, ...manifest.refs.map(ref => `${ref.name}:${ref.name}`)]);
    const refs = (await execute("git", ["--git-dir", restored, "for-each-ref", "--format=%(objectname) %(refname)"])).stdout;
    expect(refs.trim().split("\n").sort()).toEqual(manifest.refs.map(ref => `${ref.commitSha} ${ref.name}`).sort());
    expect((await execute("git", ["--git-dir", restored, "show", `${fixtureState.ref}:original.txt`])).stdout).toBe("Unpublished pre-rebase work\n");
    expect(await fs.readdir(path.join(fixtureState.dataDir, "forge-git-history-staging"))).toEqual([]);
  });

  it("verifies the existing ownership receipt without republishing or changing source refs", async () => {
    const fixtureState = await fixture();
    const manifest = await fixtureState.archive.preserve(fixtureState.input, undefined, fixtureState.save, fixtureState.git);
    const save = vi.fn(fixtureState.save);
    expect(await fixtureState.archive.preserve(fixtureState.input, fixtureState.receipt, save, fixtureState.git)).toEqual(manifest);
    expect(save).not.toHaveBeenCalled();
    expect(await fixtureState.git(["rev-parse", fixtureState.ref])).toBe(`${fixtureState.originalSha}\n`);
  });

  it("verifies local bundles without weakening the runtime HTTPS-only Git boundary", async () => {
    const fixtureState = await fixture();
    vi.stubEnv("GIT_ALLOW_PROTOCOL", "https");
    const restrictedGit = vi.fn(async (args: string[], signal?: AbortSignal) => (await execute("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=",
      "-c", "credential.interactive=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args,
    ], {
      cwd: fixtureState.source, signal,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ALLOW_PROTOCOL: "https", GIT_ASKPASS: "/bin/false", GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" },
    })).stdout);
    const sourceRefs = await fixtureState.git(["for-each-ref", "--format=%(refname) %(objectname)"]);
    const status = await fixtureState.git(["status", "--porcelain=v1"]);
    const bundle = path.join(fixtureState.root, "protocol-check.bundle");
    const restored = path.join(fixtureState.root, "protocol-check.git");
    await fixtureState.git(["bundle", "create", bundle, fixtureState.ref]);
    await restrictedGit(["init", "--bare", "--template=", restored]);
    await expect(restrictedGit(["-C", restored, "-c", "protocol.file.allow=always", "fetch", bundle,
      `${fixtureState.ref}:${fixtureState.ref}`])).rejects.toThrow("transport 'file' not allowed");
    restrictedGit.mockClear();

    const manifest = await fixtureState.archive.preserve(fixtureState.input, undefined, fixtureState.save, restrictedGit);

    expect(await fixtureState.archive.read(manifest.archiveId)).toEqual(manifest);
    expect(manifest.refs).toEqual([{ name: fixtureState.ref, commitSha: fixtureState.originalSha }]);
    expect(restrictedGit.mock.calls.every(([args]) => !args.some(arg => ["init", "bundle", "fetch", "fsck"].includes(arg)))).toBe(true);
    expect(await fixtureState.git(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(sourceRefs);
    expect(await fixtureState.git(["status", "--porcelain=v1"])).toBe(status);
    expect(process.env.GIT_ALLOW_PROTOCOL).toBe("https");
    expect(await fs.readdir(path.join(fixtureState.dataDir, "forge-git-history-staging"))).toEqual([]);
  });

  it("does not inherit credentials, repository overrides or Git configuration for private restore verification", async () => {
    const fixtureState = await fixture();
    const globalConfig = path.join(fixtureState.root, "host-git-config");
    await fs.writeFile(globalConfig, '[url "https://invalid.example/"]\n\tinsteadOf = /\n');
    beforeBundleVerification(async () => {
      for (const [name, value] of Object.entries({ GIT_ALLOW_PROTOCOL: "https", GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "never",
        GIT_DIR: path.join(fixtureState.source, ".git"), GIT_OBJECT_DIRECTORY: path.join(fixtureState.root, "missing-objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(fixtureState.source, ".git/objects"),
        GIT_ASKPASS: path.join(fixtureState.root, "missing-askpass"), HTTPS_PROXY: "http://invalid.example/" })) vi.stubEnv(name, value);
    });

    const manifest = await fixtureState.archive.preserve(fixtureState.input, undefined, fixtureState.save, fixtureState.git);

    expect(await fixtureState.archive.read(manifest.archiveId)).toEqual(manifest);
    expect(await fixtureState.git(["rev-parse", fixtureState.ref])).toBe(`${fixtureState.originalSha}\n`);
    expect(await fs.readdir(path.join(fixtureState.dataDir, "forge-git-history-staging"))).toEqual([]);
  });

  it.each(["stdout limit", "stderr limit", "deadline", "cancellation", "spawn failure"])("bounds private verification and preserves source on %s", async failure => {
    const fixtureState = await fixture();
    const executableDirectory = path.join(fixtureState.root, "verification-git");
    await fs.mkdir(executableDirectory);
    if (failure !== "spawn failure") {
      const program = failure === "stdout limit" ? 'process.stdout.write(Buffer.alloc(2_000_001));'
        : failure === "stderr limit" ? 'process.stderr.write(Buffer.alloc(2_000_001));' : 'setInterval(() => {}, 1_000);';
      await fs.writeFile(path.join(executableDirectory, "git"), `#!${process.execPath}\n${program}\n`, { mode: 0o700 });
    }
    const controller = new AbortController();
    const cancellation = new Error("Cancelled private restore verification");
    beforeBundleVerification(async () => {
      vi.stubEnv("PATH", executableDirectory);
      if (failure === "deadline" || failure === "cancellation") {
        const schedule = globalThis.setTimeout;
        vi.spyOn(globalThis, "setTimeout").mockImplementationOnce(callback => schedule(
          failure === "cancellation" ? () => controller.abort(cancellation) : callback, 25));
      }
    });
    const save = vi.fn(fixtureState.save);

    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, save, fixtureState.git, controller.signal)).rejects.toThrow(
      failure === "spawn failure" ? /ENOENT/ : failure === "cancellation" ? cancellation.message
        : failure === "deadline" ? /five minute deadline/ : /verification exceeded its output limit/);

    expect(save).not.toHaveBeenCalled();
    expect(await fixtureState.archive.list()).toEqual([]);
    expect(await fixtureState.git(["rev-parse", fixtureState.ref])).toBe(`${fixtureState.originalSha}\n`);
    expect(await fs.readFile(path.join(fixtureState.source, "original.txt"), "utf8")).toBe("Unpublished pre-rebase work\n");
    expect(await fs.readdir(path.join(fixtureState.dataDir, "forge-git-history-staging"))).toEqual([]);
  });

  it("supports SHA-256 generated refs and their self-contained version-three bundle", async () => {
    const fixtureState = await fixture("sha256");
    expect(fixtureState.originalSha).toHaveLength(64);
    const manifest = await fixtureState.archive.preserve(fixtureState.input, undefined, fixtureState.save, fixtureState.git);
    expect(manifest.refs).toEqual([{ name: fixtureState.ref, commitSha: fixtureState.originalSha }]);
    await fs.rm(fixtureState.source, { recursive: true });
    expect(await fixtureState.archive.read(manifest.archiveId)).toEqual(manifest);
  });

  it("rejects a bundle with prerequisites even when the source repository has them", async () => {
    const fixtureState = await fixture();
    const ref = `refs/cloudx/before-rebase/${fixtureState.input.commitSha}`;
    await fixtureState.git(["update-ref", ref, fixtureState.input.commitSha]);
    const bundle = path.join(fixtureState.root, "prerequisite.bundle");
    await fixtureState.git(["bundle", "create", bundle, ref, `^${fixtureState.originalSha}`]);
    const contents = await fs.readFile(bundle);
    let replaced = false;
    beforeBundleVerification(async handle => {
      await handle.truncate(0);
      await handle.write(contents, 0, contents.length, 0);
      replaced = true;
    });
    const save = vi.fn(fixtureState.save);
    await expect(fixtureState.archive.preserve({ ...fixtureState.input, refs: [ref] }, undefined, save, fixtureState.git)).rejects.toThrow(/prerequisite/);
    expect(replaced).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(await fixtureState.archive.list()).toEqual([]);
    expect(await fixtureState.git(["rev-parse", ref])).toBe(`${fixtureState.input.commitSha}\n`);
  });

  it("rejects incorrect bundle heads before storing a receipt", async () => {
    const fixtureState = await fixture();
    const ref = `refs/cloudx/before-rebase/${fixtureState.input.commitSha}`;
    await fixtureState.git(["update-ref", ref, fixtureState.input.commitSha]);
    const bundle = path.join(fixtureState.root, "incorrect-heads.bundle");
    await fixtureState.git(["bundle", "create", bundle, ref]);
    const contents = await fs.readFile(bundle);
    beforeBundleVerification(async handle => {
      await handle.truncate(0);
      await handle.write(contents, 0, contents.length, 0);
    });
    const save = vi.fn(fixtureState.save);
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, save, fixtureState.git)).rejects.toThrow(/bundle refs/);
    expect(save).not.toHaveBeenCalled();
    expect(await fixtureState.archive.list()).toEqual([]);
  });

  it("does not accept a receipt from a different completed attempt or a missing durable archive", async () => {
    const fixtureState = await fixture();
    const manifest = await fixtureState.archive.preserve(fixtureState.input, undefined, fixtureState.save, fixtureState.git);
    await expect(fixtureState.archive.preserve({ ...fixtureState.input, attemptId: "another-attempt" }, fixtureState.receipt, fixtureState.save, fixtureState.git)).rejects.toThrow(/completed worker/);
    await fs.rm(path.join(fixtureState.dataDir, "forge-git-history", manifest.archiveId), { recursive: true });
    const save = vi.fn(fixtureState.save);
    await expect(fixtureState.archive.preserve(fixtureState.input, fixtureState.receipt, save, fixtureState.git)).rejects.toThrow(/archive is missing/);
    expect(save).not.toHaveBeenCalled();
    expect(await fixtureState.git(["rev-parse", fixtureState.ref])).toBe(`${fixtureState.originalSha}\n`);
  });

  it("resumes a durably recorded intent interrupted before archive publication", async () => {
    const fixtureState = await fixture();
    const interrupt = async (receipt: ForgeGitHistoryReceipt) => {
      await fixtureState.save(receipt);
      throw new Error("Interrupted before archive publication");
    };
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, interrupt, fixtureState.git)).rejects.toThrow("Interrupted before archive publication");
    expect(fixtureState.receipt?.publication).toBe("pending");
    expect(await fixtureState.archive.list()).toEqual([]);
    const archiveId = fixtureState.receipt!.archiveId;
    const manifest = await fixtureState.archive.preserve(fixtureState.input, fixtureState.receipt, fixtureState.save, fixtureState.git);
    expect(manifest.archiveId).toBe(archiveId);
    expect(fixtureState.receipt?.publication).toBe("complete");
    expect(await fixtureState.archive.read(archiveId)).toEqual(manifest);
    expect(await fs.readdir(path.join(fixtureState.dataDir, "forge-git-history-staging"))).toEqual([]);
  });

  it("completes an already published archive after interruption without recreating the bundle", async () => {
    const fixtureState = await fixture();
    const interrupt = async (receipt: ForgeGitHistoryReceipt) => {
      if (receipt.publication === "complete") throw new Error("Interrupted after archive publication");
      await fixtureState.save(receipt);
    };
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, interrupt, fixtureState.git)).rejects.toThrow("Interrupted after archive publication");
    expect(fixtureState.receipt?.publication).toBe("pending");
    const manifest = await fixtureState.archive.read(fixtureState.receipt!.archiveId);
    const save = vi.fn(fixtureState.save);
    expect(await fixtureState.archive.preserve(fixtureState.input, fixtureState.receipt, save, fixtureState.git)).toEqual(manifest);
    expect(save).toHaveBeenCalledExactlyOnceWith({ ...fixtureState.receipt, publication: "complete" });
    expect(fixtureState.receipt?.publication).toBe("complete");
  });

  it("refuses interrupted-intent recovery when the completed attempt or durable ownership changed", async () => {
    const fixtureState = await fixture();
    const interrupt = async (receipt: ForgeGitHistoryReceipt) => {
      await fixtureState.save(receipt);
      throw new Error("Interrupted intent");
    };
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, interrupt, fixtureState.git)).rejects.toThrow("Interrupted intent");
    const save = vi.fn(fixtureState.save);
    await expect(fixtureState.archive.preserve({ ...fixtureState.input, attemptId: "another-attempt" }, fixtureState.receipt, save, fixtureState.git)).rejects.toThrow(/Interrupted Git history/);
    await fixtureState.ownership.write({ worktree: fixtureState.input.checkoutIdentity, gitHistory: { ...fixtureState.receipt, manifestSha256: "0".repeat(64) } });
    await expect(fixtureState.archive.preserve(fixtureState.input, fixtureState.receipt, save, fixtureState.git)).rejects.toThrow(/Interrupted Git history/);
    expect(save).not.toHaveBeenCalled();
    expect(await fixtureState.archive.list()).toEqual([]);
  });

  it.each(["bundle", "manifest", "ownership"])("blocks a corrupted %s before authorizing source retirement or a download", async corruption => {
    const fixtureState = await fixture();
    const manifest = await fixtureState.archive.preserve(fixtureState.input, undefined, fixtureState.save, fixtureState.git);
    const directory = path.join(fixtureState.dataDir, "forge-git-history", manifest.archiveId);
    if (corruption === "bundle") await fs.writeFile(path.join(directory, `${createHash("sha256").update("history.bundle").digest("hex")}.data`), "Damaged history");
    if (corruption === "manifest") await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, attemptId: "another-attempt" }));
    if (corruption === "ownership") await fixtureState.ownership.write({ worktree: fixtureState.input.checkoutIdentity });
    await expect(fixtureState.archive.preserve(fixtureState.input, fixtureState.receipt, fixtureState.save, fixtureState.git)).rejects.toThrow();
    await expect(fixtureState.archive.fileStream(manifest.archiveId)).rejects.toThrow();
    expect(await fixtureState.git(["rev-parse", fixtureState.ref])).toBe(`${fixtureState.originalSha}\n`);
  });

  it.each(["verification", "receipt"])("preserves the checkout when source refs change during %s", async phase => {
    const fixtureState = await fixture();
    let changed = false;
    if (phase === "verification") beforeBundleVerification(async () => {
      changed = true;
      await fixtureState.git(["update-ref", fixtureState.ref, fixtureState.input.commitSha]);
    });
    const save = async (receipt: ForgeGitHistoryReceipt) => {
      await fixtureState.save(receipt);
      if (phase === "receipt") { changed = true; await fixtureState.git(["update-ref", fixtureState.ref, fixtureState.input.commitSha]); }
    };
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, save, fixtureState.git)).rejects.toThrow(/refs changed|ref identity/);
    expect(changed).toBe(true);
    expect(await fs.readFile(path.join(fixtureState.source, "original.txt"), "utf8")).toBe("Unpublished pre-rebase work\n");
  });

  it("does not publish without a durable receipt or when receipt persistence fails", async () => {
    const fixtureState = await fixture();
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, async () => {}, fixtureState.git)).rejects.toThrow(/ownership receipt/);
    expect(await fixtureState.archive.list()).toEqual([]);
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, async () => { throw new Error("Receipt unavailable"); }, fixtureState.git)).rejects.toThrow("Receipt unavailable");
    expect(await fixtureState.archive.list()).toEqual([]);
    expect(await fs.readdir(path.join(fixtureState.dataDir, "forge-git-history-staging"))).toEqual([]);
  });

  it.each(["arbitrary ref", "stash", "malformed generated ref", "empty", "duplicate", "symbolic ref", "wrong SHA"])("rejects %s rather than widening automatic preservation", async invalid => {
    const fixtureState = await fixture();
    let refs = [fixtureState.ref];
    if (invalid === "arbitrary ref") refs = ["refs/private/work"];
    if (invalid === "stash") refs = ["refs/stash"];
    if (invalid === "malformed generated ref") refs = ["refs/cloudx/before-rebase/../../HEAD"];
    if (invalid === "empty") refs = [];
    if (invalid === "duplicate") refs.push(fixtureState.ref);
    if (invalid === "symbolic ref") await fixtureState.git(["symbolic-ref", fixtureState.ref, "refs/heads/main"]);
    if (invalid === "wrong SHA") await fixtureState.git(["update-ref", fixtureState.ref, fixtureState.input.commitSha]);
    const save = vi.fn(fixtureState.save);
    await expect(fixtureState.archive.preserve({ ...fixtureState.input, refs }, undefined, save, fixtureState.git)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    expect(await fixtureState.archive.list()).toEqual([]);
  });

  it("bounds bundle creation before publication and cleans its private staging directory", async () => {
    const fixtureState = await fixture();
    await fs.writeFile(path.join(fixtureState.source, "incompressible.bin"), randomBytes(2 * 1024 * 1024));
    await fixtureState.git(["add", "."]);
    await fixtureState.git(["commit", "-m", "Large unpublished history"]);
    const commitSha = (await fixtureState.git(["rev-parse", "HEAD"])).trim();
    const ref = `refs/cloudx/before-rebase/${commitSha}`;
    await fixtureState.git(["update-ref", ref, commitSha]);
    const save = vi.fn(fixtureState.save);
    await expect(fixtureState.archive.preserve({ ...fixtureState.input, commitSha, refs: [ref] }, undefined, save, fixtureState.git)).rejects.toThrow(/256 MiB/);
    expect(save).not.toHaveBeenCalled();
    expect(await fixtureState.git(["rev-parse", ref])).toBe(`${commitSha}\n`);
    expect(await fs.readdir(path.join(fixtureState.dataDir, "forge-git-history-staging"))).toEqual([]);
  });

  it.each(["disk failure", "cancellation"])("stops bundle creation and preserves source on streaming %s", async failure => {
    const fixtureState = await fixture();
    const controller = new AbortController();
    const originalOpen = fs.open.bind(fs);
    const message = failure === "disk failure" ? "Disk full during bundle creation" : "Cancelled while writing bundle";
    let interrupted = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith("/proc/self/fd/") && String(args[0]).endsWith("/history.bundle")) {
        vi.spyOn(handle, "write").mockImplementationOnce(async () => {
          interrupted = true;
          const error = new Error(message);
          if (failure === "cancellation") controller.abort(error);
          throw error;
        });
      }
      return handle;
    });
    const save = vi.fn(fixtureState.save);
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, save, fixtureState.git, controller.signal)).rejects.toThrow(message);
    expect(interrupted).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(await fixtureState.archive.list()).toEqual([]);
    expect(await fixtureState.git(["rev-parse", fixtureState.ref])).toBe(`${fixtureState.originalSha}\n`);
    expect(await fs.readdir(path.join(fixtureState.dataDir, "forge-git-history-staging"))).toEqual([]);
  });

  it("preserves source when Git cannot create the bundle", async () => {
    const fixtureState = await fixture();
    await fs.appendFile(path.join(fixtureState.source, ".git/config"), "\n[pack]\n\tthreads = invalid\n");
    const save = vi.fn(fixtureState.save);
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, save, fixtureState.git)).rejects.toThrow(/could not create/);
    expect(save).not.toHaveBeenCalled();
    expect(await fixtureState.archive.list()).toEqual([]);
    expect(await fs.readdir(path.join(fixtureState.dataDir, "forge-git-history-staging"))).toEqual([]);
  });

  it("rejects changed checkout identity, symbolic-link sources and symbolic-link archive parents", async () => {
    const fixtureState = await fixture();
    await expect(fixtureState.archive.preserve({ ...fixtureState.input, checkoutIdentity: { ...fixtureState.input.checkoutIdentity, ino: "0" } }, undefined, fixtureState.save, fixtureState.git)).rejects.toThrow(/ownership changed/);
    const linkedSource = path.join(fixtureState.root, "linked-checkout");
    await fs.symlink(fixtureState.source, linkedSource);
    await expect(fixtureState.archive.preserve({ ...fixtureState.input, checkoutIdentity: { ...fixtureState.input.checkoutIdentity, path: linkedSource } }, undefined, fixtureState.save, fixtureState.git)).rejects.toThrow(/symbolic/);
    await fs.mkdir(fixtureState.dataDir, { recursive: true });
    await fs.symlink(fixtureState.source, path.join(fixtureState.dataDir, "forge-git-history-staging"));
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, fixtureState.save, fixtureState.git)).rejects.toThrow(/symbolic/);
    expect(await fs.readdir(fixtureState.source)).not.toContain("history.bundle");
  });

  it("refuses storage inside its disposable source and an unbounded ref inventory", async () => {
    const fixtureState = await fixture();
    const nested = new ForgeGitHistory(path.join(fixtureState.source, "archives"));
    await expect(nested.preserve(fixtureState.input, undefined, fixtureState.save, fixtureState.git)).rejects.toThrow(/outside/);
    const refs = Array.from({ length: 129 }, (_, index) => `refs/cloudx/before-rebase/${index.toString(16).padStart(40, "0")}`);
    await expect(fixtureState.archive.preserve({ ...fixtureState.input, refs }, undefined, fixtureState.save, fixtureState.git)).rejects.toThrow(/bounded/);
    expect(await fs.readdir(fixtureState.source)).not.toContain("archives");
  });

  it("rejects cancellation and validates serialized receipt input", async () => {
    const fixtureState = await fixture();
    await expect(fixtureState.archive.preserve(fixtureState.input, undefined, fixtureState.save, fixtureState.git, AbortSignal.abort(new Error("Cancelled archive")))).rejects.toThrow("Cancelled archive");
    expect(isGitHistoryReceipt(null)).toBe(false);
    expect(isGitHistoryReceipt({ archiveId: "../escape" })).toBe(false);
    const manifest = await fixtureState.archive.preserve(fixtureState.input, undefined, fixtureState.save, fixtureState.git);
    expect(isGitHistoryReceipt(fixtureState.receipt)).toBe(true);
    expect(isGitHistoryReceipt({ ...fixtureState.receipt, refs: [{ name: "refs/stash", commitSha: fixtureState.originalSha }] })).toBe(false);
    await expect(fixtureState.archive.read("../escape")).rejects.toThrow();
    await fs.symlink(path.join(fixtureState.dataDir, "forge-git-history", manifest.archiveId), path.join(fixtureState.dataDir, "forge-git-history", "11111111-1111-4111-8111-111111111111"));
    await expect(fixtureState.archive.list()).rejects.toThrow(/symbolic/);
  });

  it("serves verified read-only Git bundle downloads and rejects invalid routes", async () => {
    const fixtureState = await fixture();
    const manifest = await fixtureState.archive.preserve(fixtureState.input, undefined, fixtureState.save, fixtureState.git);
    const app = Fastify();
    registerForgeGitHistoryRoutes(app, fixtureState.dataDir);
    onTestFinished(async () => { await app.close(); });
    expect((await app.inject({ method: "GET", url: "/api/forge/git-history" })).json()).toEqual({ archives: [manifest] });
    expect((await app.inject({ method: "GET", url: `/api/forge/git-history/${manifest.archiveId}` })).json()).toEqual(manifest);
    const download = await app.inject({ method: "GET", url: `/api/forge/git-history/${manifest.archiveId}/file` });
    expect(download.statusCode).toBe(200);
    expect(download.headers["cache-control"]).toBe("no-store");
    expect(download.headers["content-disposition"]).toBe('attachment; filename="history.bundle"');
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(createHash("sha256").update(download.rawPayload).digest("hex")).toBe(manifest.files[0]!.sha256);
    expect((await app.inject({ method: "POST", url: "/api/forge/git-history" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/forge/git-history/not-an-id/file" })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/forge/git-history/not-an-id" })).statusCode).toBe(409);
    await fixtureState.ownership.write({ worktree: fixtureState.input.checkoutIdentity });
    expect((await app.inject({ method: "GET", url: `/api/forge/git-history/${manifest.archiveId}/file` })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/forge/git-history" })).statusCode).toBe(409);
  });
});
