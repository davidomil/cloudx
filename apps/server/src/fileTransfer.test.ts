import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { FileTransferService, contentDispositionAttachment } from "./fileTransfer.js";
import { PathPolicy } from "./pathPolicy.js";

const gunzipAsync = promisify(gunzip);

describe("FileTransferService", () => {
  it("downloads one file as its raw bytes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-file-"));
    await fsp.writeFile(path.join(root, "README.md"), "hello transfer\n");
    const service = new FileTransferService(new PathPolicy([root]));

    const download = await service.createDownload(workspaceTab(root), ["README.md"]);

    expect(download).toMatchObject({
      filename: "README.md",
      contentType: "application/octet-stream",
      archive: false
    });
    await expect(streamToBuffer(download.stream).then((buffer) => buffer.toString("utf8"))).resolves.toBe("hello transfer\n");
  });

  it("streams one raw file inline with a browser-usable content type", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-raw-"));
    await fsp.mkdir(path.join(root, "docs", "screenshots"), { recursive: true });
    await fsp.writeFile(path.join(root, "docs", "screenshots", "panel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const service = new FileTransferService(new PathPolicy([root]));

    const file = await service.createRawFile(workspaceTab(root), "docs/screenshots/panel.png");

    expect(file.contentType).toBe("image/png");
    await expect(streamToBuffer(file.stream)).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("serves SVG raw files as inert text instead of inline SVG documents", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-raw-svg-"));
    await fsp.writeFile(path.join(root, "diagram.svg"), '<svg><script>alert("x")</script></svg>');
    const service = new FileTransferService(new PathPolicy([root]));

    const file = await service.createRawFile(workspaceTab(root), "diagram.svg");

    expect(file.contentType).toBe("text/plain; charset=utf-8");
    await expect(streamToBuffer(file.stream).then((buffer) => buffer.toString("utf8"))).resolves.toBe('<svg><script>alert("x")</script></svg>');
  });

  it("downloads folders and multiple entries as a tar.gz archive", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-archive-"));
    await fsp.mkdir(path.join(root, "src"));
    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const app = true;\n");
    await fsp.writeFile(path.join(root, "README.md"), "# Demo\n");
    const service = new FileTransferService(new PathPolicy([root]));

    const download = await service.createDownload(workspaceTab(root), ["src", "README.md"]);
    const tar = await gunzipAsync(await streamToBuffer(download.stream));

    expect(download).toMatchObject({
      filename: "cloudx-files.tar.gz",
      contentType: "application/gzip",
      archive: true
    });
    expect(listTarEntries(tar)).toEqual(
      expect.arrayContaining([
        { path: "README.md", typeflag: "0", size: 7 },
        { path: "src/", typeflag: "5", size: 0 },
        { path: "src/app.ts", typeflag: "0", size: 25 }
      ])
    );
  });

  it("splits long archive paths into non-empty ustar prefix and name fields", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-archive-long-"));
    const firstSegment = "a".repeat(60);
    const secondSegment = "b".repeat(50);
    const longDirectoryPath = `${firstSegment}/${secondSegment}`;
    await fsp.mkdir(path.join(root, longDirectoryPath), { recursive: true });
    await fsp.writeFile(path.join(root, longDirectoryPath, "file.txt"), "long path\n");
    const service = new FileTransferService(new PathPolicy([root]));

    const download = await service.createDownload(workspaceTab(root), [firstSegment]);
    const tar = await gunzipAsync(await streamToBuffer(download.stream));
    const headers = listTarHeaders(tar);

    expect(headers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: `${longDirectoryPath}/`,
          prefix: firstSegment,
          name: `${secondSegment}/`,
          typeflag: "5"
        }),
        expect.objectContaining({
          path: `${longDirectoryPath}/file.txt`,
          prefix: longDirectoryPath,
          name: "file.txt",
          typeflag: "0"
        })
      ])
    );
  });

  it("rejects archive paths whose final segment cannot fit the ustar name field", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-archive-too-long-"));
    const longDirectoryName = "a".repeat(101);
    await fsp.mkdir(path.join(root, longDirectoryName));
    const service = new FileTransferService(new PathPolicy([root]));

    const download = await service.createDownload(workspaceTab(root), [longDirectoryName]);

    await expect(streamToBuffer(download.stream)).rejects.toThrow("Archive path is too long for ustar");
  });

  it("uploads binary file bytes under the tab cwd", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-upload-"));
    const service = new FileTransferService(new PathPolicy([root]));

    const result = await service.upload(workspaceTab(root), "uploads/image.bin", Buffer.from([0, 1, 2, 255]));

    expect(result).toEqual({
      path: path.join(root, "uploads", "image.bin"),
      relativePath: "uploads/image.bin",
      bytes: 4,
      uploaded: true
    });
    await expect(fsp.readFile(path.join(root, "uploads", "image.bin"))).resolves.toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it("uploads pasted image bytes under a Codex terminal cwd", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-codex-upload-"));
    const service = new FileTransferService(new PathPolicy([root]));
    const codexTab = { ...workspaceTab(root), pluginId: "codex-terminal", title: "Codex" };

    const result = await service.upload(codexTab, ".cloudx/pasted-images/screenshot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(result).toEqual({
      path: path.join(root, ".cloudx", "pasted-images", "screenshot.png"),
      relativePath: ".cloudx/pasted-images/screenshot.png",
      bytes: 4,
      uploaded: true
    });
    await expect(fsp.readFile(path.join(root, ".cloudx", "pasted-images", "screenshot.png"))).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("transfers files under child directories whose names start with two dots", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-dotdot-child-"));
    const service = new FileTransferService(new PathPolicy([root]));
    await fsp.mkdir(path.join(root, "..uploads"));
    await fsp.writeFile(path.join(root, "..uploads", "data.txt"), "data\n");

    const download = await service.createDownload(workspaceTab(root), ["..uploads/data.txt"]);
    const upload = await service.upload(workspaceTab(root), "..uploads/new.txt", Buffer.from("new\n"));

    expect(download.filename).toBe("data.txt");
    await expect(streamToBuffer(download.stream).then((buffer) => buffer.toString("utf8"))).resolves.toBe("data\n");
    expect(upload).toMatchObject({
      path: path.join(root, "..uploads", "new.txt"),
      relativePath: "..uploads/new.txt",
      bytes: 4
    });
  });

  it("streams uploads to disk without requiring a buffered request body", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-stream-upload-"));
    const service = new FileTransferService(new PathPolicy([root]));

    const result = await service.upload(workspaceTab(root), "uploads/stream.bin", Readable.from([Buffer.from([1, 2]), Buffer.from([3, 4, 5])]), { maxBytes: 5 });

    expect(result).toEqual({
      path: path.join(root, "uploads", "stream.bin"),
      relativePath: "uploads/stream.bin",
      bytes: 5,
      uploaded: true
    });
    await expect(fsp.readFile(path.join(root, "uploads", "stream.bin"))).resolves.toEqual(Buffer.from([1, 2, 3, 4, 5]));
  });

  it("rejects uploads over the configured byte limit without replacing the existing file", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-upload-limit-"));
    await fsp.mkdir(path.join(root, "uploads"));
    await fsp.writeFile(path.join(root, "uploads", "stream.bin"), "keep");
    const service = new FileTransferService(new PathPolicy([root]));

    await expect(service.upload(workspaceTab(root), "uploads/stream.bin", Readable.from([Buffer.from("123"), Buffer.from("456")]), { maxBytes: 5 })).rejects.toMatchObject({ statusCode: 413 });

    await expect(fsp.readFile(path.join(root, "uploads", "stream.bin"), "utf8")).resolves.toBe("keep");
    await expect(fsp.readdir(path.join(root, "uploads"))).resolves.toEqual(["stream.bin"]);
  });

  it("rejects transfer paths that escape the tab cwd even when the root policy allows them", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-scope-"));
    const project = path.join(root, "project");
    await fsp.mkdir(project);
    const service = new FileTransferService(new PathPolicy([root]));

    await expect(service.createDownload(workspaceTab(project), ["../outside.txt"])).rejects.toThrow("outside the tab working directory");
    await expect(service.upload(workspaceTab(project), "../outside.txt", Buffer.from("nope"))).rejects.toThrow("outside the tab working directory");
  });

  it("rejects downloads that would include symbolic links", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-download-symlink-"));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-download-outside-"));
    await fsp.writeFile(path.join(outside, "secret.txt"), "secret\n");
    await fsp.symlink(path.join(outside, "secret.txt"), path.join(root, "secret-link.txt"));
    await fsp.mkdir(path.join(root, "src"));
    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const app = true;\n");
    await fsp.symlink(path.join(outside, "secret.txt"), path.join(root, "src", "nested-link.txt"));
    const service = new FileTransferService(new PathPolicy([root, outside]));

    await expect(service.createDownload(workspaceTab(root), ["secret-link.txt"])).rejects.toThrow("Symbolic links are not supported for file downloads.");
    await expect(service.createDownload(workspaceTab(root), ["src"])).rejects.toThrow("Symbolic links are not supported for file downloads.");
  });

  it("rejects an archive file if a validated directory is replaced before streaming", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-archive-race-"));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-archive-race-outside-"));
    const src = path.join(root, "src");
    await fsp.mkdir(src);
    await fsp.writeFile(path.join(src, "app.ts"), "safe\n");
    await fsp.writeFile(path.join(outside, "app.ts"), "outside\n");
    const service = new FileTransferService(new PathPolicy([root, outside]));

    await expect(
      replaceDirectoryWithSymlinkBeforeOpen(path.join(src, "app.ts"), src, outside, async () => {
        const download = await service.createDownload(workspaceTab(root), ["src"]);
        return streamToBuffer(download.stream);
      })
    ).rejects.toThrow("Transfer target changed during download");
  });

  it("rejects a single-file download if the file becomes a symlink after path validation", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-download-race-"));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-download-race-outside-"));
    const target = path.join(root, "README.md");
    const outsideFile = path.join(outside, "secret.txt");
    await fsp.writeFile(target, "safe\n");
    await fsp.writeFile(outsideFile, "outside\n");
    const service = new FileTransferService(new PathPolicy([root, outside]));

    await expect(
      replaceWithSymlinkAfterRealpath(target, outsideFile, () => service.createDownload(workspaceTab(root), ["README.md"]))
    ).rejects.toThrow("Symbolic links are not supported for file downloads.");

    await expect(fsp.readFile(outsideFile, "utf8")).resolves.toBe("outside\n");
  });

  it("rejects a raw file if the file becomes a symlink after path validation", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-raw-race-"));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-raw-race-outside-"));
    const target = path.join(root, "image.png");
    const outsideFile = path.join(outside, "secret.png");
    await fsp.writeFile(target, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fsp.writeFile(outsideFile, Buffer.from("outside"));
    const service = new FileTransferService(new PathPolicy([root, outside]));

    await expect(
      replaceWithSymlinkAfterRealpath(target, outsideFile, () => service.createRawFile(workspaceTab(root), "image.png"))
    ).rejects.toThrow("Symbolic links are not supported for file downloads.");
  });

  it("does not create upload parent directories through symlinks outside the tab cwd", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-upload-symlink-"));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-transfer-upload-outside-"));
    await fsp.symlink(outside, path.join(root, "outside-link"), "dir");
    const service = new FileTransferService(new PathPolicy([root, outside]));

    await expect(service.upload(workspaceTab(root), "outside-link/created/file.txt", Buffer.from("nope"))).rejects.toThrow("resolves outside the tab working directory");

    await expect(fsp.stat(path.join(outside, "created"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("formats attachment disposition with a plain and utf-8 filename", () => {
    expect(contentDispositionAttachment("demo archive.tar.gz")).toBe("attachment; filename=\"demo archive.tar.gz\"; filename*=UTF-8''demo%20archive.tar.gz");
  });
});

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function listTarEntries(buffer: Buffer): Array<{ path: string; typeflag: string; size: number }> {
  return listTarHeaders(buffer).map(({ path, typeflag, size }) => ({ path, typeflag, size }));
}

function listTarHeaders(buffer: Buffer): Array<{ path: string; name: string; prefix: string; typeflag: string; size: number }> {
  const entries: Array<{ path: string; name: string; prefix: string; typeflag: string; size: number }> = [];
  for (let offset = 0; offset < buffer.byteLength; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      return entries;
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = Number.parseInt(readTarString(header, 124, 12) || "0", 8);
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      name,
      prefix,
      typeflag: readTarString(header, 156, 1) || "0",
      size
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const value = buffer.toString("utf8", offset, offset + length);
  return value.slice(0, value.indexOf("\0") === -1 ? undefined : value.indexOf("\0"));
}

function workspaceTab(cwd: string): WorkspaceTab {
  return {
    id: "tab-files",
    pluginId: "file-browser",
    title: "Files",
    cwd,
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

async function replaceWithSymlinkAfterRealpath<T>(target: string, symlinkTarget: string, operation: () => Promise<T>): Promise<T> {
  const originalRealpath = fsp.realpath.bind(fsp);
  let replaced = false;
  let targetRealpathCalls = 0;
  const realpath = vi.spyOn(fsp, "realpath").mockImplementation(async (...args: Parameters<typeof fsp.realpath>) => {
    const result = await originalRealpath(...args);
    if (String(args[0]) === target) {
      targetRealpathCalls += 1;
    }
    if (!replaced && targetRealpathCalls === 2) {
      replaced = true;
      await fsp.rm(target);
      await fsp.symlink(symlinkTarget, target);
    }
    return result;
  });
  try {
    return await operation();
  } finally {
    realpath.mockRestore();
  }
}

async function replaceDirectoryWithSymlinkBeforeOpen<T>(target: string, directoryPath: string, symlinkTarget: string, operation: () => Promise<T>): Promise<T> {
  const originalOpen = fsp.open.bind(fsp);
  let replaced = false;
  const open = vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
    if (!replaced && String(args[0]) === target) {
      replaced = true;
      await fsp.rm(directoryPath, { recursive: true });
      await fsp.symlink(symlinkTarget, directoryPath, "dir");
    }
    return originalOpen(...args);
  });
  try {
    return await operation();
  } finally {
    open.mockRestore();
  }
}
