import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { FileSearchService } from "./FileSearchService.js";

const execFileAsync = promisify(execFile);

describe("FileSearchService", () => {
  it("searches content for patterns that start with a dash", async () => {
    if (!(await hasRipgrep())) {
      return;
    }
    const service = new FileSearchService();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-search-dash-query-"));
    await fs.writeFile(path.join(root, "flags.txt"), "-flag enabled\n");

    const result = await service.search(root, { mode: "content", query: "-flag" });

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "flags.txt",
        type: "content",
        matches: [expect.objectContaining({ lineNumber: 1, column: 1, text: "-flag enabled\n", matchText: "-flag" })]
      })
    ]);
  });

  it("marks content file results as truncated when more matches exist than are returned", async () => {
    if (!(await hasRipgrep())) {
      return;
    }
    const service = new FileSearchService();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-search-truncated-content-"));
    await fs.writeFile(path.join(root, "many.txt"), Array.from({ length: 6 }, (_, index) => `needle ${index + 1}\n`).join(""));

    const result = await service.search(root, { mode: "content", query: "needle" });

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "many.txt",
        type: "content",
        truncated: true,
        matches: [
          expect.objectContaining({ lineNumber: 1, text: "needle 1\n" }),
          expect.objectContaining({ lineNumber: 2, text: "needle 2\n" }),
          expect.objectContaining({ lineNumber: 3, text: "needle 3\n" }),
          expect.objectContaining({ lineNumber: 4, text: "needle 4\n" }),
          expect.objectContaining({ lineNumber: 5, text: "needle 5\n" })
        ]
      })
    ]);
  });

  it("searches filename scopes whose path starts with a dash", async () => {
    if (!(await hasRipgrep())) {
      return;
    }
    const service = new FileSearchService();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-search-dash-path-"));
    await fs.mkdir(path.join(root, "-generated"));
    await fs.writeFile(path.join(root, "-generated", "result.txt"), "hello\n");
    await fs.writeFile(path.join(root, "outside-result.txt"), "outside\n");

    const result = await service.search(root, { mode: "filename", relativePath: "-generated", query: "result" });

    expect(result.files.map((file) => file.path)).toEqual(["-generated/result.txt"]);
  });

  it("preserves filename results whose paths contain newlines", async () => {
    if (!(await hasRipgrep())) {
      return;
    }
    const service = new FileSearchService();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-search-paths-"));
    const filePath = "nested/tab\nname.txt";
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, filePath), "hello\n");

    const result = await service.search(root, { mode: "filename", query: "name.txt" });

    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: filePath,
          type: "filename",
          entryType: "file"
        })
      ])
    );
  });

  it("streams filename search across file lists larger than the buffered command limit", async () => {
    if (process.platform === "win32" || !(await hasRipgrep())) {
      return;
    }
    const service = new FileSearchService();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-search-large-file-list-"));
    const longDirectory = path.join(root, ...Array.from({ length: 8 }, (_, index) => `segment-${index}-${"x".repeat(70)}`));
    await fs.mkdir(longDirectory, { recursive: true });

    const fillerFiles = Array.from({ length: 3_300 }, (_, index) => path.join(longDirectory, `f-${index.toString().padStart(4, "0")}.txt`));
    await writeFilesInBatches(fillerFiles);
    const targetPath = path.join(longDirectory, "needle-target.txt");
    await fs.writeFile(targetPath, "");

    const result = await service.search(root, { mode: "filename", query: "needle-target", maxResults: 1 });

    expect(result.files).toEqual([
      expect.objectContaining({
        path: path.relative(root, targetPath).split(path.sep).join("/"),
        type: "filename",
        entryType: "file"
      })
    ]);
    expect(result.truncated).toBe(false);
  }, 15_000);

  it("streams content search across match sets larger than the buffered command limit", async () => {
    if (process.platform === "win32" || !(await hasRipgrep())) {
      return;
    }
    const service = new FileSearchService();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-search-large-content-"));
    const longDirectory = path.join(root, ...Array.from({ length: 8 }, (_, index) => `segment-${index}-${"x".repeat(70)}`));
    await fs.mkdir(longDirectory, { recursive: true });

    const files = Array.from({ length: 3_300 }, (_, index) => path.join(longDirectory, `match-${index.toString().padStart(4, "0")}.txt`));
    await writeFilesInBatches(files, 100, "needle\n");

    const result = await service.search(root, { mode: "content", query: "needle", maxResults: 1 });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ type: "content", entryType: "file" });
    expect(result.truncated).toBe(true);
  }, 15_000);

  it("rejects malformed ripgrep JSON emitted during streaming content search", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = new FileSearchService();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-search-invalid-json-"));
    const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-search-fake-rg-"));
    const fakeRgPath = path.join(fakeBin, "rg");
    const previousPath = process.env.PATH;
    await fs.writeFile(fakeRgPath, "#!/bin/sh\nprintf '{not-json\\n'\n", "utf8");
    await fs.chmod(fakeRgPath, 0o755);
    process.env.PATH = previousPath ? `${fakeBin}${path.delimiter}${previousPath}` : fakeBin;

    try {
      await expect(service.search(root, { mode: "content", query: "needle" })).rejects.toThrow("Invalid ripgrep JSON output");
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("marks filename results truncated when more matching paths exist than are returned", async () => {
    if (!(await hasRipgrep())) {
      return;
    }
    const service = new FileSearchService();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-search-truncated-filenames-"));
    await fs.writeFile(path.join(root, "match-a.txt"), "");
    await fs.writeFile(path.join(root, "match-b.txt"), "");
    await fs.writeFile(path.join(root, "match-c.txt"), "");

    const result = await service.search(root, { mode: "filename", query: "match", maxResults: 2 });

    expect(result.files).toHaveLength(2);
    expect(result.files.every((file) => file.path.includes("match"))).toBe(true);
    expect(result.truncated).toBe(true);
  });
});

async function hasRipgrep(): Promise<boolean> {
  return execFileAsync("rg", ["--version"])
    .then(() => true)
    .catch(() => false);
}

async function writeFilesInBatches(filePaths: string[], batchSize = 100, content = ""): Promise<void> {
  for (let index = 0; index < filePaths.length; index += batchSize) {
    await Promise.all(filePaths.slice(index, index + batchSize).map((filePath) => fs.writeFile(filePath, content)));
  }
}
