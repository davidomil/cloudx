import { describe, expect, it } from "vitest";

import { filePreviewText, mergeGitChangesIntoEntries, parsePatch, type OpenFileResult } from "./FileBrowserPanel.js";

describe("filePreviewText", () => {
  it("uses relative paths when the server returns them", () => {
    const opened: OpenFileResult = {
      path: "/home/example/project/README.md",
      relativePath: "README.md",
      truncated: false,
      content: "# Demo"
    };

    expect(filePreviewText(opened)).toBe("README.md\n\n# Demo");
  });

  it("falls back to path for older open file results", () => {
    expect(filePreviewText({ path: "/workspace/README.md", truncated: true, content: "partial" })).toBe("/workspace/README.md\n[truncated]\npartial");
  });
});

describe("parsePatch", () => {
  it("parses Git unified diff output for rendering", () => {
    const files = parsePatch(`diff --git a/README.md b/README.md
index ce01362..94954ab 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-hello
+hello Cloudx
`);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ oldPath: "README.md", newPath: "README.md", type: "modify" });
    expect(files[0]?.hunks[0]?.changes).toHaveLength(2);
  });

  it("returns an empty list when no patch is available", () => {
    expect(parsePatch(undefined)).toEqual([]);
    expect(parsePatch("")).toEqual([]);
  });
});

describe("mergeGitChangesIntoEntries", () => {
  it("marks changed files and directories with descendant change counts", () => {
    const entries = [
      { name: "README.md", type: "file" as const },
      { name: "src", type: "directory" as const },
      { name: "docs", type: "directory" as const }
    ];
    const merged = mergeGitChangesIntoEntries(entries, "", {
      compareRef: "HEAD",
      truncated: false,
      files: [
        { path: "README.md", status: "modified", statusCode: "M" },
        { path: "src/App.tsx", status: "modified", statusCode: "M" },
        { path: "src/new.ts", status: "untracked", statusCode: "?" },
        { path: "docs/old.md", status: "deleted", statusCode: "D" }
      ]
    });

    expect(merged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "README.md", gitChange: expect.objectContaining({ statusCode: "M", changedFileCount: 1 }) }),
        expect.objectContaining({ name: "src", gitChange: expect.objectContaining({ changedFileCount: 2 }) }),
        expect.objectContaining({ name: "docs", gitChange: expect.objectContaining({ changedFileCount: 1 }) })
      ])
    );
  });

  it("adds virtual deleted files for the current directory when they no longer exist on disk", () => {
    const merged = mergeGitChangesIntoEntries([{ name: "live.txt", type: "file" as const }], "docs", {
      compareRef: "HEAD",
      truncated: false,
      files: [
        { path: "docs/deleted.md", status: "deleted", statusCode: "D" },
        { path: "src/elsewhere.ts", status: "modified", statusCode: "M" }
      ]
    });

    expect(merged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "deleted.md", type: "file", virtual: true, gitChange: expect.objectContaining({ status: "deleted", statusCode: "D" }) })
      ])
    );
    expect(merged.some((entry) => entry.name === "elsewhere.ts")).toBe(false);
  });
});
