import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { create as createTar } from "tar";

import { ArchiveExtractionService } from "./ArchiveExtractionService.js";

describe("ArchiveExtractionService", () => {
  it("extracts archives from valid child directories whose names start with two dots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archive-dotdot-child-"));
    const archiveDir = path.join(root, "..archives");
    const archivePath = path.join(archiveDir, "release.zip");
    await fs.mkdir(archiveDir);
    await fs.writeFile(archivePath, createZipArchive([{ path: "docs/readme.txt", content: "docs\n" }]));
    const service = new ArchiveExtractionService();

    const result = await service.extract({ cwd: root, archivePath, destination: "folder" });

    expect(result).toMatchObject({
      archiveRelativePath: "..archives/release.zip",
      destinationRelativePath: "..archives/release",
      extracted: true
    });
    await expect(fs.readFile(path.join(archiveDir, "release", "docs", "readme.txt"), "utf8")).resolves.toBe("docs\n");
  });

  it("rejects zip entries over the configured per-entry size limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archive-entry-limit-"));
    const archivePath = path.join(root, "release.zip");
    await fs.writeFile(archivePath, createZipArchive([{ path: "docs/readme.txt", content: "123456" }]));
    const service = new ArchiveExtractionService({ limits: { maxEntryCount: 10, maxEntryBytes: 5, maxTotalBytes: 100 } });

    await expect(service.extract({ cwd: root, archivePath, destination: "folder" })).rejects.toThrow("maximum size");

    await expect(fs.access(path.join(root, "release"))).rejects.toThrow();
    await expectTemporaryExtractionDirectoriesRemoved(root);
  });

  it("rejects zip archives over the configured total extracted size limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archive-total-limit-"));
    const archivePath = path.join(root, "release.zip");
    await fs.writeFile(
      archivePath,
      createZipArchive([
        { path: "docs/one.txt", content: "123" },
        { path: "docs/two.txt", content: "456" }
      ])
    );
    const service = new ArchiveExtractionService({ limits: { maxEntryCount: 10, maxEntryBytes: 10, maxTotalBytes: 5 } });

    await expect(service.extract({ cwd: root, archivePath, destination: "folder" })).rejects.toThrow("maximum extracted size");

    await expect(fs.access(path.join(root, "release"))).rejects.toThrow();
    await expectTemporaryExtractionDirectoriesRemoved(root);
  });

  it("rejects duplicate zip entry paths after normalizing safe path aliases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archive-duplicate-entry-"));
    const archivePath = path.join(root, "release.zip");
    await fs.writeFile(
      archivePath,
      createZipArchive([
        { path: "docs/./readme.txt", content: "first\n" },
        { path: "docs/readme.txt", content: "second\n" }
      ])
    );
    const service = new ArchiveExtractionService();

    await expect(service.extract({ cwd: root, archivePath, destination: "folder" })).rejects.toThrow("duplicate entry path");

    await expect(fs.access(path.join(root, "release"))).rejects.toThrow();
    await expectTemporaryExtractionDirectoriesRemoved(root);
  });

  it("rejects unsafe zip paths before creating directories outside the extraction destination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archive-zip-preflight-"));
    const outsideDirectory = path.join(path.dirname(root), `${path.basename(root)}-outside`);
    const archivePath = path.join(root, "unsafe.zip");
    await fs.writeFile(archivePath, createZipArchive([{ path: `../${path.basename(outsideDirectory)}/file.txt`, content: "nope\n" }]));
    const service = new ArchiveExtractionService();

    await expect(service.extract({ cwd: root, archivePath, destination: "here" })).rejects.toThrow();

    await expect(fs.access(outsideDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expectTemporaryExtractionDirectoriesRemoved(root);
  });

  it("rejects zip symlink entries before extraction", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archive-zip-symlink-"));
    const archivePath = path.join(root, "release.zip");
    await fs.writeFile(
      archivePath,
      createZipArchive([
        {
          path: "link.txt",
          content: "/etc/passwd",
          externalFileAttributes: zipExternalFileAttributes(ZIP_UNIX_SYMLINK_FILE_TYPE)
        }
      ])
    );
    const service = new ArchiveExtractionService();

    await expect(service.extract({ cwd: root, archivePath, destination: "folder" })).rejects.toThrow("entry type is not supported");

    await expect(fs.access(path.join(root, "release"))).rejects.toThrow();
    await expectTemporaryExtractionDirectoriesRemoved(root);
  });

  it("rejects zip special file entries instead of extracting them as regular files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archive-zip-special-file-"));
    const archivePath = path.join(root, "release.zip");
    await fs.writeFile(
      archivePath,
      createZipArchive([
        {
          path: "pipe",
          content: "",
          externalFileAttributes: zipExternalFileAttributes(ZIP_UNIX_FIFO_FILE_TYPE)
        }
      ])
    );
    const service = new ArchiveExtractionService();

    await expect(service.extract({ cwd: root, archivePath, destination: "folder" })).rejects.toThrow("entry type is not supported");

    await expect(fs.access(path.join(root, "release"))).rejects.toThrow();
    await expectTemporaryExtractionDirectoriesRemoved(root);
  });

  it("rejects tar archives over the configured entry count limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archive-count-limit-"));
    const source = path.join(root, "source");
    const archivePath = path.join(root, "bundle.tar");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "one.txt"), "one");
    await fs.writeFile(path.join(source, "two.txt"), "two");
    await createTar({ cwd: source, file: archivePath }, ["one.txt", "two.txt"]);
    const service = new ArchiveExtractionService({ limits: { maxEntryCount: 1, maxEntryBytes: 100, maxTotalBytes: 100 } });

    await expect(service.extract({ cwd: root, archivePath, destination: "folder" })).rejects.toThrow("more than 1 entries");

    await expect(fs.access(path.join(root, "bundle"))).rejects.toThrow();
    await expectTemporaryExtractionDirectoriesRemoved(root);
  });

  it("rejects duplicate tar entry paths instead of letting later entries overwrite earlier ones", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archive-duplicate-tar-"));
    const source = path.join(root, "source");
    const archivePath = path.join(root, "bundle.tar");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "one.txt"), "one");
    await createTar({ cwd: source, file: archivePath }, ["one.txt", "one.txt"]);
    const service = new ArchiveExtractionService();

    await expect(service.extract({ cwd: root, archivePath, destination: "folder" })).rejects.toThrow("duplicate entry path");

    await expect(fs.access(path.join(root, "bundle"))).rejects.toThrow();
    await expectTemporaryExtractionDirectoriesRemoved(root);
  });

  it("rejects folder destinations already occupied by dangling symlinks before extraction", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archive-dangling-destination-"));
    const archivePath = path.join(root, "release.zip");
    const destinationPath = path.join(root, "release");
    await fs.writeFile(archivePath, createZipArchive([{ path: "docs/readme.txt", content: "docs\n" }]));
    await fs.symlink(path.join(root, "missing-target"), destinationPath, "dir");
    const service = new ArchiveExtractionService();

    await expect(service.extract({ cwd: root, archivePath, destination: "folder" })).rejects.toThrow("Extraction destination already exists");

    await expect(fs.lstat(destinationPath).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
    await expectTemporaryExtractionDirectoriesRemoved(root);
  });

  it("rejects invalid extraction limits when the service is constructed", () => {
    expect(() => new ArchiveExtractionService({ limits: { maxEntryCount: 0 } })).toThrow("positive safe integer");
  });
});

async function expectTemporaryExtractionDirectoriesRemoved(root: string): Promise<void> {
  const entries = await fs.readdir(root);
  expect(entries.some((entry) => entry.startsWith(".cloudx-extract-"))).toBe(false);
}

const ZIP_UNIX_FIFO_FILE_TYPE = 0o010000;
const ZIP_UNIX_SYMLINK_FILE_TYPE = 0o120000;

function createZipArchive(entries: Array<{ path: string; content: string; externalFileAttributes?: number }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const filename = Buffer.from(entry.path);
    const content = Buffer.from(entry.content);
    const crc = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(content.byteLength, 18);
    localHeader.writeUInt32LE(content.byteLength, 22);
    localHeader.writeUInt16LE(filename.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, filename, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.byteLength, 20);
    centralHeader.writeUInt32LE(content.byteLength, 24);
    centralHeader.writeUInt16LE(filename.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(entry.externalFileAttributes ?? 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, filename);
    offset += localHeader.byteLength + filename.byteLength + content.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function zipExternalFileAttributes(unixFileType: number): number {
  return unixFileType * 0x10000;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
