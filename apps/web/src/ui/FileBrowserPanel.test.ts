// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { FileSearchResult, GitDiffFile, GitDiffSummary, GitRepositoryState, WorkspaceTab } from "@cloudx/shared";

import { absoluteTransferPath, archiveExtractionFolderName, buildCompareRefOptions, buildSearchInput, clampFileBrowserTreeSize, CompareRefPicker, compareRefListboxStyle, copyTextToClipboard, defaultDiffViewMode, disposeFileBrowserPanelStatesExcept, entryTransferPath, FileBrowserPanel, fileBrowserBodyClassName, fileBrowserBodyStyle, fileBrowserTreeSizeMax, filePreviewText, fileTransferUploadPath, filterCompareRefOptions, gitAutoRefreshIntervalMilliseconds, gitDiffWorkspaceClassName, highlightedCodeHtml, isExtractableArchivePath, markdownImageFileUrl, markdownImageTransferPath, mergeGitChangesIntoEntries, normalizedPreviewKind, parsePatch, previewLanguageForPath, readFileBrowserPanelState, rememberFileBrowserPanelState, renderMarkdownHtml, resolveNextCompareRef, searchEntriesFromResult, searchResultMatchesInput, searchResultSummary, toolbarClipboardPath, uploadProgressPercent, uploadProgressVisibleFileCount, usesObjectUrlPreview, type FileBrowserPanelState, type OpenFileResult } from "./FileBrowserPanel.js";
import { PathEntry } from "./PathEntry.js";

afterEach(() => {
  disposeFileBrowserPanelStatesExcept(new Set());
  document.body.replaceChildren();
});

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

  it("detects renderable preview kinds, sanitizes markdown output, and highlights code", () => {
    expect(normalizedPreviewKind({ path: "/repo/README.md", relativePath: "README.md" })).toBe("markdown");
    expect(normalizedPreviewKind({ path: "/repo/pixel.png", previewKind: "image" })).toBe("image");
    expect(usesObjectUrlPreview({ path: "/repo/manual.pdf", previewKind: "pdf" })).toBe(true);
    expect(usesObjectUrlPreview({ path: "/repo/README.md", previewKind: "markdown" })).toBe(false);
    expect(previewLanguageForPath("/repo/src/App.tsx")).toBe("typescript");

    const html = renderMarkdownHtml(
      [
        "# Title",
        "",
        '<img src=x onerror="alert(1)">',
        "",
        '<style>.file-browser-panel{display:none}</style>',
        '<div id="preview" name="location" style="position:fixed;inset:0;z-index:9999">spoof</div>',
        '<form><input name="token"><button>Run</button></form>',
        '<picture><source srcset="https://example.test/pixel.png"><img src="https://example.test/fallback.png" alt="remote"></picture>',
        "",
        "```ts",
        "const value = true;",
        "```",
        "",
        "**bold**"
      ].join("\n")
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("hljs-keyword");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<picture");
    expect(html).not.toContain("<source");
    expect(html).not.toContain("https://example.test");
    expect(html).toContain('id="user-content-preview"');
    expect(html).toContain('name="user-content-location"');
    expect(highlightedCodeHtml("const value = true;", "ts")).toContain("hljs-keyword");
  });

  it("rewrites relative Markdown image sources through the file browser raw file route", () => {
    const html = renderMarkdownHtml(
      [
        "![Split panes](docs/screenshots/cloudx-split-panes.png)",
        "",
        '<img src="docs/screenshots/cloudx-mobile-portrait.png" width="390" alt="Mobile portrait">',
        "",
        "![External](https://example.test/image.png)"
      ].join("\n"),
      { resolveImageUrl: (href) => markdownImageFileUrl("tab-files", "README.md", href) }
    );

    expect(markdownImageTransferPath("docs/README.md", "../screenshots/panel.png?raw=1#preview")).toBe("screenshots/panel.png");
    expect(markdownImageTransferPath("README.md", "https://example.test/image.png")).toBeUndefined();
    expect(html).toContain('/api/tabs/tab-files/files/raw?relativePath=docs%2Fscreenshots%2Fcloudx-split-panes.png');
    expect(html).toContain('/api/tabs/tab-files/files/raw?relativePath=docs%2Fscreenshots%2Fcloudx-mobile-portrait.png');
    expect(html).not.toContain("https://example.test");
  });

  it("keeps Markdown image rewrites inside the sanitizer boundary", () => {
    const html = renderMarkdownHtml('<img src="docs/panel.png" srcset="https://example.test/panel@2x.png 2x" alt="Panel">', { resolveImageUrl: () => "javascript:alert(1)" });

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("srcset=");
    expect(html).not.toContain("https://example.test");
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

describe("file transfer path helpers", () => {
  it("builds download paths from the current directory or search result path", () => {
    expect(entryTransferPath({ name: "README.md" }, "")).toBe("README.md");
    expect(entryTransferPath({ name: "App.tsx" }, "src")).toBe("src/App.tsx");
    expect(entryTransferPath({ name: "App.tsx", searchPath: "packages/app/src/App.tsx" }, "src")).toBe("packages/app/src/App.tsx");
  });

  it("builds upload targets under the current directory using the selected filename", () => {
    expect(fileTransferUploadPath("", "README.md")).toBe("README.md");
    expect(fileTransferUploadPath("docs", "notes.md")).toBe("docs/notes.md");
    expect(fileTransferUploadPath("docs", "nested/notes.md")).toBe("docs/notes.md");
    expect(fileTransferUploadPath("docs", "notes.md", "Project/nested/notes.md")).toBe("docs/Project/nested/notes.md");
    expect(fileTransferUploadPath("docs", "notes.md", "../notes.md")).toBe("docs/notes.md");
  });

  it("detects archives that get right-click extraction options", () => {
    expect(isExtractableArchivePath("release.zip")).toBe(true);
    expect(isExtractableArchivePath("release.tar")).toBe(true);
    expect(isExtractableArchivePath("release.tar.gz")).toBe(true);
    expect(isExtractableArchivePath("release.tgz")).toBe(true);
    expect(isExtractableArchivePath("release.gz")).toBe(false);
    expect(archiveExtractionFolderName("dist/release.tar.gz")).toBe("release");
    expect(archiveExtractionFolderName("dist/project.zip")).toBe("project");
  });

  it("reports aggregate upload progress percentages", () => {
    expect(uploadProgressPercent({ uploadedBytes: 0, totalBytes: 0 })).toBe(0);
    expect(uploadProgressPercent({ uploadedBytes: 512, totalBytes: 1024 })).toBe(50);
    expect(uploadProgressPercent({ uploadedBytes: 2048, totalBytes: 1024 })).toBe(100);
    expect(uploadProgressVisibleFileCount({ completedFiles: 0, totalFiles: 1, activePath: "video.mp4" })).toBe(1);
    expect(uploadProgressVisibleFileCount({ completedFiles: 1, totalFiles: 2, activePath: "next.mp4" })).toBe(2);
    expect(uploadProgressVisibleFileCount({ completedFiles: 1, totalFiles: 1 })).toBe(1);
  });

  it("keeps file upload available while folder upload is absent", () => {
    const html = renderToStaticMarkup(createElement(FileBrowserPanel, { tab: workspaceTab("tab-files", "/repo"), config: { showGitDiff: false } }));
    const container = document.createElement("div");
    container.innerHTML = html;

    const fileUploadButton = container.querySelector('button[aria-label="Upload files"]') as HTMLButtonElement;
    const folderUploadButton = container.querySelector('button[aria-label="Upload directory"]');
    const fileInputs = Array.from(container.querySelectorAll('input[type="file"]')) as HTMLInputElement[];

    expect(fileUploadButton.disabled).toBe(false);
    expect(folderUploadButton).toBeNull();
    expect(html).not.toContain("Upload directory to");
    expect(fileInputs).toHaveLength(1);
    expect(fileInputs[0]!.disabled).toBe(false);
  });

  it("builds toolbar and context-menu clipboard paths", async () => {
    const writes: string[] = [];
    expect(toolbarClipboardPath("")).toBe(".");
    expect(toolbarClipboardPath("docs/specs")).toBe("docs/specs");
    expect(absoluteTransferPath("/repo", "docs/specs.md")).toBe("/repo/docs/specs.md");
    expect(absoluteTransferPath("/", "docs/specs.md")).toBe("/docs/specs.md");

    await copyTextToClipboard("docs/specs.md", { writeText: async (value) => { writes.push(value); } });
    expect(writes).toEqual(["docs/specs.md"]);
  });
});

describe("file browser panel state cache", () => {
  it("restores cached directory and open-file state for the same tab cwd", () => {
    const tab = workspaceTab("tab-files", "/repo");
    rememberFileBrowserPanelState(tab, fileBrowserState({
      relativePath: "src",
      entries: [{ name: "App.tsx", type: "file" }],
      opened: { path: "/repo/src/App.tsx", relativePath: "src/App.tsx", truncated: false, content: "export const app = true;\n" },
      searchVisible: true
    }));

    const html = renderToStaticMarkup(createElement(FileBrowserPanel, { tab, config: { showGitDiff: false } }));
    const normalizedHtml = html.toLowerCase();

    expect(html).toContain(">src<");
    expect(html).toContain("App.tsx");
    expect(html).toContain("src/App.tsx");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("app =");
    expect(html).toContain("Select files or folders to download");
    expect(html).not.toContain("Hide preview");
    expect(html).not.toContain("Show preview");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("file-list-download");
    expect(normalizedHtml).toContain('autocomplete="off"');
    expect(normalizedHtml).toContain('autocorrect="off"');
    expect(normalizedHtml).toContain('autocapitalize="none"');
    expect(normalizedHtml).toContain('spellcheck="false"');
  });

  it("can restore Markdown source mode for open files", () => {
    const tab = workspaceTab("tab-files", "/repo");
    rememberFileBrowserPanelState(tab, fileBrowserState({
      entries: [{ name: "README.md", type: "file" }],
      opened: { path: "/repo/README.md", relativePath: "README.md", truncated: false, content: "# Title\n\n```ts\nconst value = true;\n```" },
      markdownPreviewMode: "source"
    }));

    const html = renderToStaticMarkup(createElement(FileBrowserPanel, { tab, config: { showGitDiff: false } }));

    expect(html).toContain("Markdown source");
    expect(html).toContain("language-markdown");
    expect(html).toContain("# Title");
    expect(html).not.toContain("<h1>Title</h1>");
  });

  it("hides rendered Git diffs while keeping changed-file indicators when the Git bar is hidden", () => {
    const tab = workspaceTab("tab-files", "/repo");
    rememberFileBrowserPanelState(tab, fileBrowserState({
      entries: [{ name: "README.md", type: "file" }],
      gitState: gitRepositoryState(),
      diffSummary: gitDiffSummary(),
      openedDiff: gitDiffFile(),
      gitBarVisible: false
    }));

    const html = renderToStaticMarkup(createElement(FileBrowserPanel, { tab }));

    expect(html).not.toContain("git-diff-workspace");
    expect(html).toContain("tree-change-badge");
    expect(html).toContain("deleted.md");
    expect(html).not.toContain("updated line");
    expect(html).toContain("README.md");
  });

  it("does not render stale search previews after search inputs change", () => {
    const tab = workspaceTab("tab-files", "/repo");
    rememberFileBrowserPanelState(tab, fileBrowserState({
      searchQuery: "TODO",
      searchMode: "all",
      searchGlob: "*.md",
      searchVisible: true,
      searchResult: {
        query: "TODO",
        mode: "all",
        relativePath: ".",
        glob: "*.ts",
        files: [
          {
            path: "src/old.ts",
            type: "content",
            entryType: "file",
            matches: [{ lineNumber: 1, column: 1, text: "TODO old\n", matchText: "TODO" }],
            truncated: false
          }
        ],
        truncated: false,
        searchedAt: new Date(0).toISOString()
      }
    }));

    const html = renderToStaticMarkup(createElement(FileBrowserPanel, { tab, config: { showGitDiff: false } }));

    expect(html).not.toContain("src/old.ts");
    expect(html).toContain("Select a file to preview it.");
  });

  it("ignores cached state after cwd changes and disposes closed tabs", () => {
    const tab = workspaceTab("tab-files", "/repo");
    rememberFileBrowserPanelState(tab, fileBrowserState());

    expect(readFileBrowserPanelState(tab)?.relativePath).toBe("src");
    expect(readFileBrowserPanelState({ ...tab, cwd: "/other" })).toBeUndefined();

    disposeFileBrowserPanelStatesExcept(new Set(["tab-other"]));

    expect(readFileBrowserPanelState(tab)).toBeUndefined();
  });
});

describe("path entry text assistance attributes", () => {
  it("disables browser and OS corrections while keeping the custom suggestions list", () => {
    const html = renderToStaticMarkup(createElement(PathEntry, { inputId: "directory", value: "/home/david", onChange: () => undefined }));
    const normalizedHtml = html.toLowerCase();

    expect(normalizedHtml).toContain('autocomplete="off"');
    expect(normalizedHtml).toContain('autocorrect="off"');
    expect(normalizedHtml).toContain('autocapitalize="none"');
    expect(normalizedHtml).toContain('spellcheck="false"');
    expect(html).toContain('aria-autocomplete="list"');
  });
});

describe("git auto-refresh helpers", () => {
  it("defaults rendered Git diffs to unified view", () => {
    expect(defaultDiffViewMode()).toBe("unified");
  });

  it("uses a 15 second interval by default and configured seconds when provided", () => {
    expect(gitAutoRefreshIntervalMilliseconds({})).toBe(15_000);
    expect(gitAutoRefreshIntervalMilliseconds({ gitAutoRefreshSeconds: 30 })).toBe(30_000);
  });

  it("does not produce an interval for invalid frequencies", () => {
    expect(gitAutoRefreshIntervalMilliseconds({ gitAutoRefreshSeconds: 0 })).toBeUndefined();
    expect(gitAutoRefreshIntervalMilliseconds({ gitAutoRefreshSeconds: -1 })).toBeUndefined();
  });

  it("preserves a valid selected compare ref while falling back when that ref disappears", () => {
    const state = {
      isRepository: true,
      cwd: "/repo",
      folderEmpty: false,
      defaultCompareRef: "origin/main",
      compareRefs: ["origin/main", "origin/dev"],
      setup: { canInitialize: false, canClone: false, canSetOrigin: true }
    } satisfies GitRepositoryState;

    expect(resolveNextCompareRef(state, "origin/dev")).toBe("origin/dev");
    expect(resolveNextCompareRef(state, "deleted/ref")).toBe("origin/main");
    expect(resolveNextCompareRef(state, undefined)).toBe("origin/main");
  });

  it("orders compare refs with main first and the current branch upstream second", () => {
    expect(
      buildCompareRefOptions({
        defaultCompareRef: "origin/main",
        upstream: "origin/feature/cloudx",
        compareRefs: ["origin/main", "origin/feature/cloudx", "origin/dev"]
      })
    ).toEqual([
      { value: "origin/main", label: "origin/main", detail: "default" },
      { value: "origin/feature/cloudx", label: "origin/feature/cloudx", detail: "branch upstream" },
      { value: "origin/dev", label: "origin/dev" }
    ]);
    expect(buildCompareRefOptions({ compareRefs: [] })).toEqual([{ value: "", label: "working tree" }]);
  });

  it("does not offer a stale upstream ref that is absent from compare refs", () => {
    expect(
      buildCompareRefOptions({
        defaultCompareRef: "origin/main",
        upstream: "origin/deleted-feature",
        compareRefs: ["origin/main", "origin/dev"]
      })
    ).toEqual([
      { value: "origin/main", label: "origin/main", detail: "default" },
      { value: "origin/dev", label: "origin/dev" }
    ]);
  });

  it("filters compare refs and caps the visible option list", () => {
    const options = Array.from({ length: 16 }, (_, index) => ({
      value: `origin/branch-${index}`,
      label: `origin/branch-${index}`
    }));

    expect(filterCompareRefOptions(options, "")).toHaveLength(12);
    expect(filterCompareRefOptions(options, "branch-15")).toEqual([{ value: "origin/branch-15", label: "origin/branch-15" }]);
  });

  it("positions the compare ref list outside the clipped Git bar", () => {
    expect(compareRefListboxStyle({ bottom: 20, left: 12, width: 180 })).toEqual({
      top: "25px",
      left: "12px",
      width: "280px"
    });
  });

  it("opens a branch autocomplete list and filters typed refs", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const selections: string[] = [];
    const state = {
      isRepository: true,
      cwd: "/repo",
      folderEmpty: false,
      defaultCompareRef: "origin/main",
      upstream: "origin/feature/cloudx",
      compareRefs: ["origin/main", "origin/feature/cloudx", "origin/dev"],
      setup: { canInitialize: false, canClone: false, canSetOrigin: false }
    } satisfies GitRepositoryState;

    await act(async () => {
      root.render(createElement(CompareRefPicker, { state, compareRef: "origin/main", disabled: false, onCompareRefChange: (value) => selections.push(value) }));
    });

    const input = container.querySelector('[role="combobox"]') as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });
    setInputValue(input, "feature");
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const optionLabels = Array.from(document.body.querySelectorAll(".git-compare-option span")).map((option) => option.textContent);
    expect(optionLabels).toEqual(["origin/feature/cloudx"]);

    const featureOption = document.body.querySelector(".git-compare-option") as HTMLButtonElement;
    await act(async () => {
      featureOption.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(selections).toEqual(["origin/feature/cloudx"]);

    await unmount(root);
  });
});

describe("file browser visibility class names", () => {
  it("adds layout modifiers when the tree or diff files are hidden", () => {
    expect(fileBrowserBodyClassName(true)).toBe("file-browser-body");
    expect(fileBrowserBodyClassName(false)).toBe("file-browser-body tree-hidden");
    expect(fileBrowserBodyClassName(true, true)).toBe("file-browser-body resizing");
    expect(gitDiffWorkspaceClassName(true)).toBe("git-diff-workspace");
    expect(gitDiffWorkspaceClassName(false)).toBe("git-diff-workspace files-hidden");
  });

  it("clamps and exposes the resizable tree size", () => {
    expect(clampFileBrowserTreeSize(120, 800)).toBe(160);
    expect(clampFileBrowserTreeSize(320, 800)).toBe(320);
    expect(clampFileBrowserTreeSize(900, 800)).toBe(640);
    expect(fileBrowserTreeSizeMax(800)).toBe(640);
    expect(fileBrowserBodyStyle(320)).toEqual({ "--file-tree-size": "320px" });
  });

  it("renders splitter value semantics for assistive technology", () => {
    const tab = workspaceTab("tab-files", "/repo");
    rememberFileBrowserPanelState(tab, fileBrowserState({ fileTreeSize: 320 }));

    const html = renderToStaticMarkup(createElement(FileBrowserPanel, { tab, config: { showGitDiff: false } }));
    const container = document.createElement("div");
    container.innerHTML = html;
    const splitter = container.querySelector('[role="separator"]');

    expect(splitter?.getAttribute("aria-orientation")).toBe("vertical");
    expect(splitter?.getAttribute("aria-valuemin")).toBe("160");
    expect(splitter?.getAttribute("aria-valuemax")).toBe("640");
    expect(splitter?.getAttribute("aria-valuenow")).toBe("320");
    expect(splitter?.getAttribute("aria-valuetext")).toBe("320px");
  });
});

describe("searchResultMatchesInput", () => {
  it("invalidates cached search results when query mode or glob changes", () => {
    const result = {
      query: "TODO",
      mode: "all",
      relativePath: ".",
      glob: "*.ts",
      files: [],
      truncated: false,
      searchedAt: new Date(0).toISOString()
    } satisfies FileSearchResult;

    expect(searchResultMatchesInput(result, "TODO", "all", "*.ts")).toBe(true);
    expect(searchResultMatchesInput(result, "TODO", "all", "*.md")).toBe(false);
    expect(searchResultMatchesInput(result, "TODO", "content", "*.ts")).toBe(false);
    expect(searchResultMatchesInput(result, "FIXME", "all", "*.ts")).toBe(false);
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

  it("parses quoted Git paths and treats malformed patches as unrenderable", () => {
    const quotedPathPatch = [
      'diff --git "a/notes\\nwith\\ttab.txt" "b/notes\\nwith\\ttab.txt"',
      "new file mode 100644",
      "index 0000000..0000000",
      "--- /dev/null",
      '+++ "b/notes\\nwith\\ttab.txt"',
      "@@ -0,0 +1 @@",
      "+hello",
      ""
    ].join("\n");
    const malformedPathPatch = [
      "diff --git a/notes",
      "with\ttab.txt b/notes",
      "with\ttab.txt",
      "new file mode 100644",
      "index 0000000..0000000",
      "--- /dev/null",
      "+++ b/notes",
      "with\ttab.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      ""
    ].join("\n");

    expect(parsePatch(quotedPathPatch)).toHaveLength(1);
    expect(parsePatch(malformedPathPatch)).toEqual([]);
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

function workspaceTab(id: string, cwd: string): WorkspaceTab {
  return {
    id,
    pluginId: "file-browser",
    title: "Files",
    cwd,
    status: "running",
    indicator: {
      color: "green",
      label: "OK",
      updatedAt: new Date(0).toISOString()
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function fileBrowserState(overrides: Partial<FileBrowserPanelState> = {}): FileBrowserPanelState {
  return {
    relativePath: "src",
    entries: [],
    compareRef: "",
    diffViewMode: "unified",
    cloneUrl: "",
    originUrl: "",
    searchQuery: "",
    searchMode: "all",
    searchGlob: "",
    searchExpanded: false,
    treeVisible: true,
    searchVisible: false,
    gitBarVisible: true,
    gitDiffFilesVisible: true,
    markdownPreviewMode: "rendered",
    fileTreeSize: 280,
    ...overrides
  };
}

function gitRepositoryState(): GitRepositoryState {
  return {
    isRepository: true,
    cwd: "/repo",
    rootPath: "/repo",
    folderEmpty: false,
    currentBranch: "main",
    defaultCompareRef: "origin/main",
    compareRefs: ["origin/main"],
    setup: { canInitialize: false, canClone: false, canSetOrigin: true }
  };
}

function gitDiffSummary(): GitDiffSummary {
  return {
    compareRef: "origin/main",
    truncated: false,
    files: [
      { path: "src/README.md", status: "modified", statusCode: "M", additions: 1, deletions: 0 },
      { path: "src/deleted.md", status: "deleted", statusCode: "D", additions: 0, deletions: 1 }
    ]
  };
}

function gitDiffFile(): GitDiffFile {
  return {
    path: "src/README.md",
    status: "modified",
    statusCode: "M",
    patch: "diff --git a/src/README.md b/src/README.md\n--- a/src/README.md\n+++ b/src/README.md\n@@ -1 +1 @@\n-old line\n+updated line\n"
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}
