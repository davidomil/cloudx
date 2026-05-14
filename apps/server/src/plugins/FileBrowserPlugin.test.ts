import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FileSearchResult, WorkspaceTab } from "@cloudx/shared";

import { PathPolicy } from "../pathPolicy.js";
import { FileBrowserPlugin } from "./FileBrowserPlugin.js";

describe("FileBrowserPlugin", () => {
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
    expect(context).toMatchObject({
      kind: "file-browser",
      cwd: root,
      currentRelativePath: ".",
      openFile: { relativePath: "README.md", contentPreview: "hello", truncated: false }
    });
    expect(context.visibleText).toContain("Directory .");
    expect(context.visibleText).toContain("Open file README.md");
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
