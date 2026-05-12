import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { PathPolicy } from "../pathPolicy.js";
import { FileBrowserPlugin } from "./FileBrowserPlugin.js";

describe("FileBrowserPlugin", () => {
  it("lists directories and opens text files under cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-files-"));
    await fs.writeFile(path.join(root, "README.md"), "hello");
    const tab: WorkspaceTab = {
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: root,
      status: "running",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const session = new FileBrowserPlugin(new PathPolicy([root])).createSession({ tab, cwd: root });

    const listing = await session.handleAction("list_directory", { relativePath: "" });
    const opened = await session.handleAction("open_file", { relativePath: "README.md" });

    expect(JSON.stringify(listing)).toContain("README.md");
    expect(opened.content).toBe("hello");
  });
});
