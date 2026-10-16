import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extract, list } from "tar";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readDirectoryIdentity } from "../directoryIdentity.js";
import { captureForgeRemovalContents } from "./ForgeCheckoutRemoval.js";
import { ForgeDiagnosticSnapshotRecovery, isSnapshotRecoveryReceipt } from "./ForgeDiagnosticSnapshotRecovery.js";
import type { OwnedDiagnosticSnapshot } from "./ForgeDiagnosticSnapshots.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-snapshot-recovery-"));
  onTestFinished(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  const checkout = path.join(root, "checkout");
  const parent = path.join(checkout, ".cloudx", "forge-snapshots", "1e6fde87-3b73-43ab-9007-73790e80ee41");
  const source = path.join(parent, "source");
  await fs.mkdir(path.join(checkout, ".git"), { recursive: true });
  await fs.mkdir(path.join(source, ".git", "objects", "12"), { recursive: true });
  await fs.mkdir(path.join(source, ".git", "refs", "investigation"), { recursive: true });
  await fs.mkdir(path.join(source, "empty"));
  await fs.writeFile(path.join(source, "working.txt"), "Uncommitted investigation\n");
  await fs.chmod(path.join(source, "working.txt"), 0o751);
  // No HEAD: a Git bundle cannot preserve this incomplete object store.
  await fs.writeFile(path.join(source, ".git", "objects", "12", "unreachable"), Buffer.from([0, 255, 12, 83]));
  await fs.writeFile(path.join(source, ".git", "refs", "investigation", "unpublished"), "12".repeat(20));
  await fs.writeFile(path.join(root, "outside-secret.txt"), "Never traverse this target\n");
  await fs.symlink(path.join(root, "outside-secret.txt"), path.join(source, "external-link"));
  const identity = await readDirectoryIdentity(source);
  const contents = await captureForgeRemovalContents(identity);
  const snapshot: OwnedDiagnosticSnapshot = { workerId: "worker-1", attemptId: "attempt-1",
    path: path.relative(checkout, source).split(path.sep).join("/"), kind: "repository", retentionPolicy: "recover", state: "ready", identity,
    parentIdentity: await readDirectoryIdentity(parent), contents, removalContents: contents,
    origin: { checkout: await readDirectoryIdentity(checkout), gitDirectory: await readDirectoryIdentity(path.join(checkout, ".git")),
      commitSha: "a".repeat(40), url: "https://github.com/example/project.git" } };
  const dataDir = path.join(root, "durable-data");
  const recovery = new ForgeDiagnosticSnapshotRecovery(dataDir);
  const journal: OwnedDiagnosticSnapshot[] = [];
  const save = async () => { journal.push(structuredClone(snapshot)); };
  const preserve = () => recovery.preserve(snapshot, identity, save);
  return { root, checkout, parent, source, snapshot, dataDir, recovery, journal, save, preserve };
}

describe("Forge diagnostic snapshot recovery", () => {
  it("preserves partial Git objects, unpublished refs, working files, modes, links and empty directories outside the checkout", async () => {
    const state = await fixture();
    const longDirectory = path.join(state.source, "long-" + "x".repeat(160));
    await fs.mkdir(longDirectory);
    await fs.writeFile(path.join(longDirectory, "source.txt"), "Long archive path\n");
    state.snapshot.removalContents = await captureForgeRemovalContents(state.snapshot.identity);
    const receipt = await state.preserve();
    expect(state.journal.map(record => record.recovery?.state)).toEqual(["archiving", "verified"]);
    expect(isSnapshotRecoveryReceipt(receipt)).toBe(true);
    expect(receipt.archivePath.startsWith(state.dataDir + path.sep)).toBe(true);
    const recovered = path.join(state.root, "recovered");
    await fs.mkdir(recovered);
    await extract({ file: receipt.archivePath, cwd: recovered, strict: true, preserveOwner: false, preservePaths: true });
    expect(await fs.readFile(path.join(recovered, ".git", "objects", "12", "unreachable"))).toEqual(Buffer.from([0, 255, 12, 83]));
    expect(await fs.readFile(path.join(recovered, ".git", "refs", "investigation", "unpublished"), "utf8")).toBe("12".repeat(20));
    expect(await fs.readFile(path.join(recovered, "working.txt"), "utf8")).toBe("Uncommitted investigation\n");
    expect((await fs.stat(path.join(recovered, "working.txt"))).mode & 0o7777).toBe(0o751);
    expect(await fs.readdir(path.join(recovered, "empty"))).toEqual([]);
    expect(await fs.readlink(path.join(recovered, "external-link"))).toBe(path.join(state.root, "outside-secret.txt"));
    expect(await fs.readFile(path.join(recovered, path.basename(longDirectory), "source.txt"), "utf8")).toBe("Long archive path\n");
    const names: string[] = [];
    await list({ file: receipt.archivePath, onReadEntry: entry => { names.push(entry.path); } });
    expect(names.some(name => name.includes("outside-secret"))).toBe(false);
    // The archive and ownership receipt are independently usable after the disposable checkout disappears.
    await fs.rm(state.checkout, { recursive: true });
    await new ForgeDiagnosticSnapshotRecovery(state.dataDir).verify(structuredClone(state.snapshot));
    const stream = await state.recovery.fileStream(state.snapshot);
    const downloaded: Buffer[] = [];
    for await (const chunk of stream) downloaded.push(Buffer.from(chunk));
    expect(createHash("sha256").update(Buffer.concat(downloaded)).digest("hex")).toBe(receipt.archiveSha256);
  });

  it("resumes an interrupted archive write from the original without publishing duplicate archives", async () => {
    const state = await fixture();
    const open = fs.open.bind(fs);
    let failWrite = true;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith("/snapshot.tar.partial") && failWrite) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementationOnce(async (...writeArgs: Parameters<typeof handle.write>) => {
          await write(...writeArgs);
          throw new Error("Interrupted archive write");
        });
        failWrite = false;
      }
      return handle;
    });
    await expect(state.preserve()).rejects.toThrow("Interrupted archive write");
    expect(state.snapshot.recovery?.state).toBe("archiving");
    expect(await fs.readFile(path.join(state.source, "working.txt"), "utf8")).toContain("Uncommitted investigation");
    vi.restoreAllMocks();
    await new ForgeDiagnosticSnapshotRecovery(state.dataDir).preserve(state.snapshot, state.snapshot.identity, state.save);
    expect(state.snapshot.recovery?.state).toBe("verified");
    expect((await fs.readdir(state.snapshot.recovery!.directory.path)).sort()).toEqual(["ownership.json", "snapshot.tar"]);
  });

  it("reconciles durable publication after a crash before the verified receipt save", async () => {
    const state = await fixture();
    let pending: OwnedDiagnosticSnapshot | undefined;
    await expect(state.recovery.preserve(state.snapshot, state.snapshot.identity, async () => {
      if (state.snapshot.recovery?.state === "archiving") pending = structuredClone(state.snapshot);
      else throw new Error("Interrupted verified receipt save");
    })).rejects.toThrow("Interrupted verified receipt save");
    const inode = (await fs.stat(state.snapshot.recovery!.archivePath)).ino;
    const restarted = pending!;
    await new ForgeDiagnosticSnapshotRecovery(state.dataDir).preserve(restarted, restarted.identity, async () => {});
    expect(restarted.recovery?.state).toBe("verified");
    expect((await fs.stat(restarted.recovery!.archivePath)).ino).toBe(inode);
    await state.recovery.verify(restarted);
  });

  it("keeps the original if archive creation or durable publication fails", async () => {
    const state = await fixture();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[0]).endsWith("/snapshot.tar.partial")) throw new Error("Archive publication unavailable");
      return rename(...args);
    });
    await expect(state.preserve()).rejects.toThrow("Archive publication unavailable");
    expect(state.snapshot.recovery?.state).toBe("archiving");
    expect(await captureForgeRemovalContents(state.snapshot.identity)).toEqual(state.snapshot.removalContents);
    await expect(fs.lstat(state.snapshot.recovery!.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks();
    await state.preserve();
    await state.recovery.verify(state.snapshot);
  });

  it("rejects a source changed before preservation rather than updating its authorized inventory", async () => {
    const state = await fixture();
    await fs.writeFile(path.join(state.source, "working.txt"), "Changed after authorization\n");
    await expect(state.preserve()).rejects.toThrow("authorized removal inventory");
    expect(state.snapshot.recovery).toBeUndefined();
    expect(await fs.readFile(path.join(state.source, "working.txt"), "utf8")).toBe("Changed after authorization\n");
  });

  it("protects changed source after interrupted recovery and keeps the previous export", async () => {
    const state = await fixture();
    let pending: OwnedDiagnosticSnapshot | undefined;
    await expect(state.recovery.preserve(state.snapshot, state.snapshot.identity, async () => {
      if (state.snapshot.recovery?.state === "archiving") pending = structuredClone(state.snapshot);
      else throw new Error("Stopped before save");
    })).rejects.toThrow("Stopped before save");
    await fs.writeFile(path.join(state.source, "working.txt"), "Changed during interruption\n");
    pending!.removalContents = await captureForgeRemovalContents(pending!.identity);
    await expect(state.recovery.preserve(pending!, pending!.identity, async () => {})).rejects.toThrow("receipt does not belong");
    expect(await fs.readFile(path.join(state.source, "working.txt"), "utf8")).toBe("Changed during interruption\n");
    expect((await fs.stat(state.snapshot.recovery!.archivePath)).size).toBeGreaterThan(1024);
  });

  it("rejects a replaced source directory even when its contents match", async () => {
    const state = await fixture();
    await fs.rename(state.source, path.join(state.parent, "original"));
    await fs.cp(path.join(state.parent, "original"), state.source, { recursive: true, verbatimSymlinks: true });
    await expect(state.preserve()).rejects.toThrow("ownership changed");
    expect(state.snapshot.recovery).toBeUndefined();
    expect(await fs.readFile(path.join(state.parent, "original", "working.txt"), "utf8")).toContain("Uncommitted investigation");
  });

  it("verifies archive bytes and ownership provenance before releasing or downloading preserved evidence", async () => {
    const state = await fixture();
    const receipt = await state.preserve();
    const original = await fs.readFile(receipt.archivePath);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] = 1;
    await fs.writeFile(receipt.archivePath, tampered);
    await expect(state.recovery.verify(state.snapshot)).rejects.toThrow();
    await expect(state.recovery.fileStream(state.snapshot)).rejects.toThrow();
    await fs.writeFile(receipt.archivePath, original);
    const ownership = JSON.parse(await fs.readFile(receipt.ownershipPath, "utf8"));
    ownership.workerId = "different-worker";
    await fs.writeFile(receipt.ownershipPath, JSON.stringify(ownership));
    await expect(state.recovery.verify(state.snapshot)).rejects.toThrow("ownership receipt changed");
    expect(await fs.readFile(path.join(state.source, "working.txt"), "utf8")).toContain("Uncommitted investigation");
  });

  it("rejects a changed persisted removal inventory even when its archive and receipt remain valid", async () => {
    const state = await fixture();
    const receipt = await state.preserve();
    await fs.writeFile(path.join(state.source, "added-after-preservation.txt"), "Unpreserved evidence\n");
    state.snapshot.removalContents = await captureForgeRemovalContents(state.snapshot.identity);
    await expect(state.recovery.verify(state.snapshot)).rejects.toThrow("receipt does not belong");
    await expect(state.recovery.fileStream(state.snapshot)).rejects.toThrow("receipt does not belong");
    expect(await fs.readFile(path.join(state.source, "added-after-preservation.txt"), "utf8")).toBe("Unpreserved evidence\n");
    expect((await fs.stat(receipt.archivePath)).size).toBe(receipt.archiveBytes);
  });

  it("protects unknown recovery files and symlink replacements", async () => {
    const state = await fixture();
    const receipt = await state.preserve();
    await fs.writeFile(path.join(receipt.directory.path, "investigation.txt"), "Unknown retained evidence\n");
    await expect(state.recovery.verify(state.snapshot)).rejects.toThrow("unknown files");
    await fs.unlink(path.join(receipt.directory.path, "investigation.txt"));
    await fs.rename(receipt.archivePath, receipt.archivePath + ".original");
    await fs.symlink(path.join(state.source, "working.txt"), receipt.archivePath);
    await expect(state.recovery.verify(state.snapshot)).rejects.toThrow();
    expect(await fs.readFile(path.join(state.source, "working.txt"), "utf8")).toContain("Uncommitted investigation");
  });

  it("keeps files changed during archive creation without publishing an incomplete preservation receipt", async () => {
    const state = await fixture();
    const open = fs.open.bind(fs);
    let changed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith("/snapshot.tar.partial") && !changed) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementationOnce(async (...writeArgs: Parameters<typeof handle.write>) => {
          changed = true;
          await fs.writeFile(path.join(state.source, "working.txt"), "Changed while archiving\n");
          return write(...writeArgs);
        });
      }
      return handle;
    });
    await expect(state.preserve()).rejects.toThrow(/changed|differs/u);
    expect(state.snapshot.recovery?.state).toBe("archiving");
    expect(await fs.readFile(path.join(state.source, "working.txt"), "utf8")).toBe("Changed while archiving\n");
    await expect(fs.lstat(state.snapshot.recovery!.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["objects-link", "metadata-link", "gitdir-file", "alternates", "commondir"])("holds Git metadata with external references: %s", async kind => {
    const state = await fixture();
    if (kind === "objects-link") {
      await fs.rename(path.join(state.source, ".git", "objects"), path.join(state.root, "external-objects"));
      await fs.symlink(path.join(state.root, "external-objects"), path.join(state.source, ".git", "objects"));
    } else if (kind === "metadata-link") {
      await fs.symlink(path.join(state.root, "outside-secret.txt"), path.join(state.source, ".git", "config"));
    } else if (kind === "gitdir-file") {
      await fs.rename(path.join(state.source, ".git"), path.join(state.root, "external-git"));
      await fs.writeFile(path.join(state.source, ".git"), `gitdir: ${path.join(state.root, "external-git")}\n`);
    } else if (kind === "alternates") {
      await fs.mkdir(path.join(state.source, ".git", "objects", "info"));
      await fs.writeFile(path.join(state.source, ".git", "objects", "info", "alternates"), path.join(state.root, "external-objects") + "\n");
    } else {
      await fs.writeFile(path.join(state.source, ".git", "commondir"), "../outside-repository\n");
    }
    state.snapshot.removalContents = await captureForgeRemovalContents(state.snapshot.identity);
    await expect(state.preserve()).rejects.toThrow("Git metadata references files outside");
    expect(state.snapshot.recovery).toBeUndefined();
    expect(await fs.readFile(path.join(state.root, "outside-secret.txt"), "utf8")).toBe("Never traverse this target\n");
  });

  it("protects external refs in an additional bare repository inside the snapshot", async () => {
    const state = await fixture();
    const bare = path.join(state.source, "bare-repository");
    await fs.mkdir(path.join(bare, "objects"), { recursive: true });
    await fs.mkdir(path.join(bare, "refs"));
    await fs.writeFile(path.join(bare, "HEAD"), "ref: refs/heads/unpublished\n");
    await fs.symlink(path.join(state.root, "outside-secret.txt"), path.join(bare, "refs", "unpublished"));
    state.snapshot.removalContents = await captureForgeRemovalContents(state.snapshot.identity);
    await expect(state.preserve()).rejects.toThrow("bare Git metadata references files outside");
    expect(state.snapshot.recovery).toBeUndefined();
  });

  it("rejects oversized source metadata before reading or allocating an archive", async () => {
    const state = await fixture();
    await fs.truncate(path.join(state.source, "working.txt"), 1024 ** 3 + 1);
    const read = vi.spyOn(fs, "readFile");
    await expect(state.preserve()).rejects.toThrow("bounded 1 GiB / 100000");
    expect(read).not.toHaveBeenCalled();
    expect(state.snapshot.recovery).toBeUndefined();
  });

  it("rejects an archive destination inside the disposable checkout", async () => {
    const state = await fixture();
    const unsafe = new ForgeDiagnosticSnapshotRecovery(path.join(state.checkout, "evidence"));
    await expect(unsafe.preserve(state.snapshot, state.snapshot.identity, state.save)).rejects.toThrow("outside the disposable checkout");
    expect(state.snapshot.recovery).toBeUndefined();
  });
});
