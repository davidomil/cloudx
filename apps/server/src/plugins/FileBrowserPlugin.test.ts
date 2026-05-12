import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

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
});
