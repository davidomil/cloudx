import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

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
  const entries: Array<{ path: string; typeflag: string; size: number }> = [];
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
