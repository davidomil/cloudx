import { describe, expect, it } from "vitest";

import { buildSearchInput, filePreviewText, mergeGitChangesIntoEntries, parsePatch, searchEntriesFromResult, searchResultSummary, type OpenFileResult } from "./FileBrowserPanel.js";

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

describe("searchResultSummary", () => {
  it("summarizes scoped and truncated search results", () => {
    expect(
      searchResultSummary({
        query: "Cloudx",
        mode: "content",
        relativePath: "src",
        files: [
          { path: "src/App.tsx", type: "content", matches: [{ lineNumber: 1, column: 14, text: "Cloudx" }], truncated: false },
          { path: "src/main.tsx", type: "content", matches: [{ lineNumber: 2, column: 1, text: "Cloudx" }], truncated: false }
        ],
        truncated: true,
        searchedAt: new Date(0).toISOString()
      })
    ).toBe('2+ files matched content search "Cloudx" in src');
  });
});

describe("buildSearchInput", () => {
  it("searches from the tab root by default and trims query and glob text", () => {
    expect(buildSearchInput("  Cloudx  ", "all", "  *.ts  ")).toEqual({
      query: "Cloudx",
      mode: "all",
      relativePath: "",
      caseSensitive: false,
      glob: "*.ts"
    });
  });

  it("returns undefined for empty search text", () => {
    expect(buildSearchInput("   ", "filename", "")).toBeUndefined();
  });
});

describe("searchEntriesFromResult", () => {
  it("builds active tree entries only for direct search results", () => {
    const entries = searchEntriesFromResult({
      query: "TODO",
      mode: "all",
      relativePath: ".",
      files: [
        {
          path: "docs/TODO.md",
          type: "all",
          entryType: "file",
          matches: [{ text: "docs/TODO.md", matchText: "TODO" }],
          truncated: false
        }
      ],
      truncated: false,
      searchedAt: new Date(0).toISOString()
    });

    expect(entries).toEqual([expect.objectContaining({ name: "docs/TODO.md", type: "file", searchPath: "docs/TODO.md" })]);
    expect(entries).not.toContainEqual(expect.objectContaining({ name: "docs", type: "directory", searchPath: "docs" }));
  });

  it("keeps directory entries when the backend reports the directory itself as a match", () => {
    const entries = searchEntriesFromResult({
      query: "docs",
      mode: "filename",
      relativePath: ".",
      files: [
        {
          path: "docs",
          type: "filename",
          entryType: "directory",
          matches: [{ text: "docs", matchText: "docs" }],
          truncated: false
        }
      ],
      truncated: false,
      searchedAt: new Date(0).toISOString()
    });

    expect(entries).toEqual([expect.objectContaining({ name: "docs", type: "directory", searchPath: "docs" })]);
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
