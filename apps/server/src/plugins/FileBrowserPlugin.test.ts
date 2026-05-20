import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { create as createTar } from "tar";

import type { FileSearchResult, WorkspaceTab } from "@cloudx/shared";

import { PathPolicy } from "../pathPolicy.js";
import { FileBrowserPlugin, filePreviewMetadataForPath } from "./FileBrowserPlugin.js";

describe("FileBrowserPlugin", () => {
  it("exposes Git auto-refresh settings", () => {
    const plugin = new FileBrowserPlugin(new PathPolicy([process.cwd()]));

    expect(plugin.descriptor().configFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "gitAutoRefresh", type: "boolean", defaultValue: true }),
        expect.objectContaining({ key: "gitAutoRefreshSeconds", type: "number", defaultValue: 15, min: 1, step: 1 })
      ])
    );
  });

  it("lists directories, opens text files, and exposes standardized voice context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-"));
    await fs.writeFile(path.join(root, "README.md"), "hello");
    const tab: WorkspaceTab = {
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: root,
      status: "running",
      indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab,
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    const listing = await session.handleAction("list_directory", { relativePath: "" });
    const opened = await session.handleAction("open_file", { relativePath: "README.md" });
    const context = await session.voiceContext();

    expect(JSON.stringify(listing)).toContain("README.md");
    expect(opened.content).toBe("hello");
    expect(opened).toMatchObject({ previewKind: "markdown", mimeType: "text/markdown; charset=utf-8", sizeBytes: 5 });
    expect(context).toMatchObject({
      kind: "file-browser",
      cwd: root,
      currentRelativePath: ".",
      openFile: { relativePath: "README.md", contentPreview: "hello", truncated: false }
    });
    expect(context.visibleText).toContain("Directory .");
    expect(context.visibleText).toContain("Open file README.md");
  });

  it("lists symlinked directories as directories so browsing them does not call open_file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-symlink-"));
    const target = path.join(root, "target-skill");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "SKILL.md"), "# Understand Diff\n");
    await fs.symlink(target, path.join(root, "understand-diff"), "dir");
    const tab: WorkspaceTab = {
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: root,
      status: "running",
      indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab,
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    const listing = await session.handleAction("list_directory", { relativePath: "" }) as { entries: Array<{ name: string; type: string }> };
    const nested = await session.handleAction("list_directory", { relativePath: "understand-diff" }) as { entries: Array<{ name: string; type: string }> };

    expect(listing.entries).toContainEqual({ name: "understand-diff", type: "directory" });
    expect(nested.entries).toContainEqual({ name: "SKILL.md", type: "file" });
  });

  it("opens image and PDF files as renderable preview metadata without decoding binary content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-"));
    await fs.writeFile(path.join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(path.join(root, "manual.pdf"), Buffer.from("%PDF-1.7\n"));
    const tab: WorkspaceTab = {
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: root,
      status: "running",
      indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab,
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    await expect(session.handleAction("open_file", { relativePath: "pixel.png" })).resolves.toMatchObject({
      relativePath: "pixel.png",
      previewKind: "image",
      mimeType: "image/png",
      content: "",
      truncated: false,
      sizeBytes: 4
    });
    await expect(session.handleAction("open_file", { relativePath: "manual.pdf" })).resolves.toMatchObject({
      relativePath: "manual.pdf",
      previewKind: "pdf",
      mimeType: "application/pdf",
      content: "",
      truncated: false
    });
    expect((await session.voiceContext()).openFile).toMatchObject({
      relativePath: "manual.pdf",
      previewKind: "pdf",
      mimeType: "application/pdf",
      contentPreview: "PDF preview: application/pdf, 9 bytes."
    });
  });

  it("classifies preview metadata from file extensions", () => {
    expect(filePreviewMetadataForPath("/repo/docs/README.markdown")).toEqual({ previewKind: "markdown", mimeType: "text/markdown; charset=utf-8" });
    expect(filePreviewMetadataForPath("/repo/public/photo.webp")).toEqual({ previewKind: "image", mimeType: "image/webp" });
    expect(filePreviewMetadataForPath("/repo/public/spec.pdf")).toEqual({ previewKind: "pdf", mimeType: "application/pdf" });
    expect(filePreviewMetadataForPath("/repo/src/App.tsx")).toEqual({ previewKind: "text", mimeType: "text/plain; charset=utf-8" });
  });

  it("returns full markdown previews for long files while keeping voice context bounded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-long-"));
    const longMarkdown = `# Long\n\n${"body line\n".repeat(12_000)}`;
    await fs.writeFile(path.join(root, "LONG.md"), longMarkdown);
    const tab: WorkspaceTab = {
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: root,
      status: "running",
      indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab,
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    const opened = await session.handleAction("open_file", { relativePath: "LONG.md" });
    const context = await session.voiceContext();

    expect(opened).toMatchObject({
      relativePath: "LONG.md",
      previewKind: "markdown",
      truncated: false,
      content: longMarkdown,
      sizeBytes: Buffer.byteLength(longMarkdown, "utf8")
    });
    expect(context.openFile).toMatchObject({
      relativePath: "LONG.md",
      truncated: true
    });
    expect(context.openFile?.contentPreview.length).toBeLessThan(longMarkdown.length);
  });

  it("edits files through voice-exposed file actions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-"));
    await fs.writeFile(path.join(root, "README.md"), "hello world");
    const tab: WorkspaceTab = {
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: root,
      status: "running",
      indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab,
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    await session.handleAction("replace_in_file", { relativePath: "README.md", oldText: "world", newText: "Cloudx" });
    await session.handleAction("write_file", { relativePath: "notes/todo.md", content: "ship it\n", create: true });

    await expect(fs.readFile(path.join(root, "README.md"), "utf8")).resolves.toBe("hello Cloudx");
    await expect(fs.readFile(path.join(root, "notes/todo.md"), "utf8")).resolves.toBe("ship it\n");
    await expect(Promise.resolve(session.voiceContext()).then((context) => context.openFile)).resolves.toMatchObject({
      relativePath: "notes/todo.md",
      contentPreview: "ship it\n"
    });
  });

  it("rejects opening directories as files before reading content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-"));
    await fs.mkdir(path.join(root, "src"));
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab: {
        id: "tab-1",
        pluginId: "file-browser",
        title: "Files",
        cwd: root,
        status: "running",
        indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      },
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    await expect(session.handleAction("open_file", { relativePath: "src" })).rejects.toThrow("Not a file:");
  });

  it("extracts zip archives from the file browser action into a same-named folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-zip-extract-"));
    await fs.writeFile(path.join(root, "release.zip"), createZipArchive([{ path: "docs/readme.txt", content: "zip docs\n" }]));
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab: workspaceTab(root),
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    const result = await session.handleAction("extract_archive", { relativePath: "release.zip", destination: "folder" });

    expect(result).toMatchObject({ archiveRelativePath: "release.zip", destinationRelativePath: "release", extracted: true });
    await expect(fs.readFile(path.join(root, "release", "docs", "readme.txt"), "utf8")).resolves.toBe("zip docs\n");
  });

  it("extracts tar and tar.gz archives next to the archive without overwriting existing files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-tar-extract-"));
    const source = path.join(root, "source");
    await fs.mkdir(path.join(source, "dist"), { recursive: true });
    await fs.writeFile(path.join(source, "dist", "app.txt"), "tar docs\n");
    await createTar({ cwd: source, file: path.join(root, "bundle.tar.gz"), gzip: true }, ["dist"]);
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab: workspaceTab(root),
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    const result = await session.handleAction("extract_archive", { relativePath: "bundle.tar.gz", destination: "here" });

    expect(result).toMatchObject({ archiveRelativePath: "bundle.tar.gz", destinationRelativePath: ".", extracted: true });
    await expect(fs.readFile(path.join(root, "dist", "app.txt"), "utf8")).resolves.toBe("tar docs\n");
    await expect(session.handleAction("extract_archive", { relativePath: "bundle.tar.gz", destination: "here" })).rejects.toThrow("Extraction target already exists");
  });

  it("rejects archive entries that try to escape the extraction destination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-unsafe-archive-"));
    const outsideName = `${path.basename(root)}-escape.txt`;
    await fs.writeFile(path.join(root, "unsafe.zip"), createZipArchive([{ path: `../${outsideName}`, content: "nope\n" }]));
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab: workspaceTab(root),
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    await expect(session.handleAction("extract_archive", { relativePath: "unsafe.zip", destination: "here" })).rejects.toThrow();
    await expect(fs.access(path.join(root, "..", outsideName))).rejects.toThrow();
  });

  it("searches files by filename and content and exposes search results to voice context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "README.md"), "hello Cloudx\n");
    await fs.writeFile(path.join(root, "src", "App.tsx"), "export const title = 'Cloudx Search';\n");
    await fs.writeFile(path.join(root, "src", "App.test.tsx"), "Cloudx Search test\n");
    await fs.writeFile(path.join(root, ".hidden.md"), "Cloudx hidden\n");
    const tab: WorkspaceTab = {
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: root,
      status: "running",
      indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab,
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    const filenameResult = (await session.handleAction("search_files", {
      query: "read",
      mode: "filename"
    })) as unknown as FileSearchResult;
    const contentResult = (await session.handleAction("search_files", {
      query: "cloudx search",
      mode: "content",
      relativePath: "src",
      glob: "!*.test.tsx"
    })) as unknown as FileSearchResult;
    const context = await session.voiceContext();

    expect(filenameResult.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(contentResult).toMatchObject({
      mode: "content",
      relativePath: "src",
      files: [
        {
          path: "src/App.tsx",
          matches: [expect.objectContaining({ lineNumber: 1, text: "export const title = 'Cloudx Search';\n" })]
        }
      ]
    });
    expect(contentResult.files.some((file) => file.path === "src/App.test.tsx")).toBe(false);
    expect(contentResult.files.some((file) => file.path === ".hidden.md")).toBe(false);
    expect(context.visibleText).toContain('Search content "cloudx search" in src');
    expect(context.metadata?.searchResultCount).toBe(1);
  });

  it("searches filenames and contents together by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-"));
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "TODO.md"), "# Roadmap\n");
    await fs.writeFile(path.join(root, "notes.md"), "TODO in content\n");
    const tab: WorkspaceTab = {
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: root,
      status: "running",
      indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab,
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    const result = (await session.handleAction("search_files", { query: "TODO" })) as unknown as FileSearchResult;

    expect(result.mode).toBe("all");
    expect(result.files.map((file) => file.path)).toEqual(["docs/TODO.md", "notes.md"]);
  });

  it("includes matching folders in filename search", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-"));
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "TODO.md"), "# Roadmap\n");
    const tab: WorkspaceTab = {
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: root,
      status: "running",
      indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab,
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    const result = (await session.handleAction("search_files", { query: "docs", mode: "filename" })) as unknown as FileSearchResult;

    expect(result.files).toEqual([
      expect.objectContaining({ path: "docs", entryType: "directory" }),
      expect.objectContaining({ path: "docs/TODO.md", entryType: "file" })
    ]);
  });

  it("rejects Git diff actions when the plugin config disables them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-"));
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({
      tab: {
        id: "tab-1",
        pluginId: "file-browser",
        title: "Files",
        cwd: root,
        status: "running",
        indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      },
      cwd: root,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined },
      getConfig: () => ({ showGitDiff: false })
    });

    await expect(session.handleAction("get_git_state", {})).rejects.toThrow("Git diff is disabled");
  });
});

function workspaceTab(cwd: string): WorkspaceTab {
  return {
    id: "tab-1",
    pluginId: "file-browser",
    title: "Files",
    cwd,
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function createZipArchive(entries: Array<{ path: string; content: string }>): Buffer {
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
    centralHeader.writeUInt32LE(0, 38);
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
