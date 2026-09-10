import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { appendTextFileNoFollow, openOwnedDirectoryNoFollow, openOwnedRegularFileNoFollow, openOwnedTextFileNoFollow, readTextFileNoFollow, requireRegularFile, requireSafeDirectory, writeTextFileAtomic } from "../jsonStateFile.js";
import { TabContextService, type TabContextFileOperations } from "./TabContextService.js";

const fileOperations: TabContextFileOperations = {
  appendTextFileNoFollow,
  openOwnedRegularFileNoFollow,
  openOwnedTextFileNoFollow,
  openOwnedDirectoryNoFollow,
  readTextFileNoFollow,
  requireRegularFile,
  requireSafeDirectory,
  writeTextFileAtomic
};

describe("TabContextService", () => {
  it("keeps owned directory identity stable across bounded UTF-8 log rotation", async () => {
    await withOwnedContext(async ({ service, tab }) => {
      const original = service.directory(tab.contextPath)!;
      const copy = service.directory(tab.contextPath)!;
      copy.ino = "changed by caller";
      expect(service.directory(tab.contextPath)).toEqual(original);
      for (let index = 0; index < 10; index++) {
        await service.record(tab, "terminal-output", `${"🙂".repeat(4000)}\nchunk-${index}`);
        expect((await fs.stat(tab.contextPath!)).size).toBeLessThanOrEqual(64_000);
        expect(service.directory(tab.contextPath)).toEqual(original);
        const text = await service.read(tab);
        expect(text).toContain(`🙂\nchunk-${index}`);
        expect(text).not.toContain("\uFFFD");
      }
      const text = await service.read(tab);
      expect(text).toContain("Trimmed to the latest 64000 bytes");
      expect(text).not.toContain("chunk-0");
      await service.delete(tab);
      expect(service.directory(tab.contextPath)).toBeUndefined();
      await expect(fs.stat(original.path)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["directory", "symlink"])("preserves a replacement owned context %s during reads, writes and deletion", async replacement => {
    await withOwnedContext(async ({ service, tab, root }) => {
      const owned = service.directory(tab.contextPath)!;
      await fs.rename(owned.path, path.join(root, "original-context"));
      const outside = path.join(root, "replacement");
      await fs.mkdir(outside);
      if (replacement === "symlink") await fs.symlink(outside, owned.path, "dir");
      else await fs.rename(outside, owned.path);
      await fs.writeFile(tab.contextPath!, "replacement must survive");
      await expect(service.read(tab)).rejects.toThrow(/ownership changed|symbolic link/);
      await expect(service.record(tab, "terminal-output", "do not append")).rejects.toThrow(/ownership changed|symbolic link/);
      await expect(service.delete(tab)).rejects.toThrow(/ownership changed|symbolic link/);
      expect(await fs.readFile(tab.contextPath!, "utf8")).toBe("replacement must survive");
      expect(service.directory(tab.contextPath)).toEqual(owned);
    });
  });

  it("drains admitted writes and refuses new records while an owned context is being deleted", async () => {
    let entered!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await withOwnedContext(async ({ service, tab }) => {
      const directory = service.directory(tab.contextPath)!;
      const first = service.record(tab, "terminal-output", "first");
      await writing;
      const second = service.record(tab, "terminal-output", "second");
      const deletion = service.delete(tab);
      const late = service.record(tab, "terminal-output", "after deletion admission");
      const reading = service.read(tab);
      release();
      await Promise.all([first, second, deletion, late]);
      expect(await reading).toBe("");
      expect(service.directory(tab.contextPath)).toBeUndefined();
      await expect(fs.stat(directory.path)).rejects.toMatchObject({ code: "ENOENT" });
    }, {
      openOwnedDirectoryNoFollow: async (...args) => {
        const directory = await openOwnedDirectoryNoFollow(...args);
        if (args[3] && !held) { held = true; entered(); await gate; }
        return directory;
      }
    });
  });

  it("does not adopt preexisting owned directories or paths from another service", async () => {
    await withOwnedContext(async ({ service, tab, dataDir }) => {
      await expect(service.create(tab, { ownedDirectory: true })).rejects.toMatchObject({ code: "EEXIST" });
      const other = new TabContextService(dataDir);
      expect(other.directory(tab.contextPath)).toBeUndefined();
      await expect(other.read(tab)).rejects.toThrow("directly within");
      await expect(other.delete(tab)).rejects.toThrow("directly within");
      expect(await service.read(tab)).toContain("Cloudx Tab Context");
    });
  });

  it.each(["symlink", "hardlink", "directory", "oversize"])("rejects unsafe owned context file type or size: %s", async kind => {
    await withOwnedContext(async ({ service, tab, root }) => {
      const outside = path.join(root, "outside.txt");
      await fs.writeFile(outside, "outside must survive");
      await fs.unlink(tab.contextPath!);
      if (kind === "symlink") await fs.symlink(outside, tab.contextPath!);
      if (kind === "hardlink") await fs.link(outside, tab.contextPath!);
      if (kind === "directory") await fs.mkdir(tab.contextPath!);
      if (kind === "oversize") await fs.writeFile(tab.contextPath!, "x".repeat(128_001));
      await expect(service.read(tab)).rejects.toThrow();
      await expect(service.record(tab, "terminal-output", "must not append")).rejects.toThrow();
      expect(await fs.readFile(outside, "utf8")).toBe("outside must survive");
    });
  });

  it("cleans its newly owned directory when context creation runs out of space", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-owned-context-capacity-"));
    const service = new TabContextService(root);
    const originalWrite = fs.writeFile.bind(fs);
    const write = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await originalWrite(...args);
      if (String(args[0]).endsWith("/context.md")) throw capacityError();
    });
    try {
      await expect(service.create(tabFixture(root), { ownedDirectory: true })).resolves.toBeUndefined();
      expect(await fs.readdir(path.join(root, "context"))).toEqual([]);
    } finally {
      write.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates context files and records sanitized events", async () => {
    const { service, tab } = await createContext();

    await service.record(tab, "terminal-output", "\u001b[31mhello\r\n\nworld\u001b[0m\n");
    const text = await service.read(tab);

    expect(text).toContain("# Cloudx Tab Context");
    expect(text).toContain("### ");
    expect(text).toContain("terminal-output");
    expect(text).toContain("hello\nworld");
    expect(text).not.toContain("\u001b");
  });

  it("removes OSC terminal control sequences while preserving visible text", async () => {
    const { service, tab } = await createContext();

    await service.record(tab, "terminal-output", "\u001b]0;secret-title\u0007visible \u001b]8;;https://example.test\u001b\\link\u001b]8;;\u001b\\ done");
    const text = await service.read(tab);

    expect(text).toContain("visible link done");
    expect(text).not.toContain("secret-title");
    expect(text).not.toContain("https://example.test");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
  });

  it("redacts sensitive URL query and fragment values before storing voice prompt history", async () => {
    const { service, tab } = await createContext();

    await service.record(
      tab,
      "plugin-action",
      JSON.stringify(
        {
          url: "http://127.0.0.1:5173/dashboard?token=f5d6&view=graph#access_token=fragment-secret",
          docs: "https://example.test/docs?view=public"
        },
        null,
        2
      )
    );
    const text = await service.read(tab);

    expect(text).toContain("http://127.0.0.1:5173/dashboard?token=redacted&view=graph#redacted");
    expect(text).toContain("https://example.test/docs?view=public");
    expect(text).not.toContain("f5d6");
    expect(text).not.toContain("fragment-secret");
  });

  it("enforces the context byte limit for multi-byte UTF-8 payloads", async () => {
    const { service, tab } = await createContext();

    for (let index = 0; index < 10; index += 1) {
      await service.record(tab, "terminal-output", `chunk-${index}\n${"🙂".repeat(20_000)}`);
    }

    const text = await service.read(tab);
    const stat = await fs.stat(tab.contextPath!);
    expect(stat.size).toBeLessThanOrEqual(64_000);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64_000);
    expect(text).toContain("Trimmed to the latest 64000 bytes");
    expect(text).not.toContain("\uFFFD");
  });

  it("lets tabs start without context history when the disk is full", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-create-enospc-"));
    const service = new TabContextService(path.join(root, ".cloudx"), {
      ...fileOperations,
      openOwnedTextFileNoFollow: vi.fn(async (dataRoot, directoryPath, fileName, label) => {
        const owned = await openOwnedTextFileNoFollow(dataRoot, directoryPath, fileName, label);
        return {
          ...owned,
          write: async () => {
            await owned.write("partial");
            throw capacityError();
          }
        };
      })
    });

    await expect(service.create(tabFixture(root))).resolves.toBeUndefined();
    await expect(fs.readdir(path.join(root, ".cloudx", "context"))).resolves.toEqual([]);
  });

  it("removes a partially created context file when creation fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-create-partial-"));
    const service = new TabContextService(path.join(root, ".cloudx"), {
      ...fileOperations,
      openOwnedTextFileNoFollow: vi.fn(async (dataRoot, directoryPath, fileName, label) => {
        const owned = await openOwnedTextFileNoFollow(dataRoot, directoryPath, fileName, label);
        return {
          ...owned,
          write: async () => {
            await owned.write("partial");
            throw new Error("context write failed");
          }
        };
      })
    });

    await expect(service.create(tabFixture(root))).rejects.toThrow("context write failed");
    await expect(fs.readdir(path.join(root, ".cloudx", "context"))).resolves.toEqual([]);
  });

  it("cleans a failed create through its owned directory after the context parent is swapped", async () => {
    if (process.platform !== "linux") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-create-swap-"));
    const dataDir = path.join(root, ".cloudx");
    const contextDir = path.join(dataDir, "context");
    const renamedContextDir = path.join(dataDir, "context-owned");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-create-swap-outside-"));
    let outsideFile = "";
    const service = new TabContextService(dataDir, {
      ...fileOperations,
      openOwnedTextFileNoFollow: vi.fn(async (dataRoot, directoryPath, fileName, label) => {
        const owned = await openOwnedTextFileNoFollow(dataRoot, directoryPath, fileName, label);
        return {
          ...owned,
          write: async () => {
            await owned.write("partial");
            await fs.rename(contextDir, renamedContextDir);
            await fs.symlink(outside, contextDir, "dir");
            outsideFile = path.join(outside, path.basename(owned.path));
            await fs.writeFile(outsideFile, "outside must survive", "utf8");
            throw new Error("context write failed after parent swap");
          }
        };
      })
    });

    await expect(service.create(tabFixture(root))).rejects.toThrow("context write failed after parent swap");

    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside must survive");
    await expect(fs.readdir(renamedContextDir)).resolves.toEqual([]);
  });

  it("drops context history writes instead of crashing when the disk is full", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-record-enospc-"));
    const dataDir = path.join(root, ".cloudx");
    const initialService = new TabContextService(dataDir);
    const tab = tabFixture(root);
    tab.contextPath = await initialService.create(tab);
    const service = new TabContextService(dataDir, {
      ...fileOperations,
      appendTextFileNoFollow: vi.fn(async () => {
        throw capacityError();
      })
    });

    await expect(service.record(tab, "terminal-output", "still running")).resolves.toBeUndefined();
    await expect(initialService.read(tab)).resolves.not.toContain("still running");
  });

  it("serializes concurrent records to the same context file", async () => {
    const { service, tab } = await createContext();

    await Promise.all(Array.from({ length: 20 }, (_, index) => service.record(tab, "plugin-action", `entry-${index}`)));
    const text = await service.read(tab);

    for (let index = 0; index < 20; index += 1) {
      expect(text).toContain(`entry-${index}`);
    }
  });

  it("rejects symlinked context directories before creating files outside the data directory", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-dir-link-"));
    const dataDir = path.join(root, ".cloudx");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-outside-"));
    await fs.mkdir(dataDir);
    await fs.symlink(outside, path.join(dataDir, "context"), "dir");
    const service = new TabContextService(dataDir);
    const tab = tabFixture(root);

    await expect(service.create(tab)).rejects.toThrow("symbolic link");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("rejects context paths outside the context directory", async () => {
    const { service, tab } = await createContext();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-mutated-"));
    tab.contextPath = path.join(outside, "context.md");

    await expect(service.record(tab, "plugin-action", "outside")).rejects.toThrow("directly within");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("rejects symlinked context files before recording outside the data directory", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { service, tab } = await createContext();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-file-outside-"));
    const outsideFile = path.join(outside, "context.md");
    await fs.writeFile(outsideFile, "outside\n", "utf8");
    await fs.rm(tab.contextPath!);
    await fs.symlink(outsideFile, tab.contextPath!);

    await expect(service.record(tab, "plugin-action", "outside")).rejects.toThrow("symbolic link");
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside\n");
  });

  it("deletes through an owned directory descriptor when the context parent is swapped", async () => {
    if (process.platform !== "linux") {
      return;
    }
    const { tab } = await createContext();
    const dataDir = path.dirname(path.dirname(tab.contextPath!));
    const contextDir = path.dirname(tab.contextPath!);
    const ownedContextDir = path.join(dataDir, "context-owned");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-delete-outside-"));
    const outsideFile = path.join(outside, path.basename(tab.contextPath!));
    const service = new TabContextService(dataDir, {
      ...fileOperations,
      openOwnedRegularFileNoFollow: vi.fn(async (rootPath, directoryPath, fileName, label) => {
        const owned = await openOwnedRegularFileNoFollow(rootPath, directoryPath, fileName, label);
        await fs.rename(contextDir, ownedContextDir);
        await fs.symlink(outside, contextDir, "dir");
        await fs.writeFile(outsideFile, "outside must survive", "utf8");
        return owned;
      })
    });

    await service.delete(tab);

    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside must survive");
    await expect(fs.stat(path.join(ownedContextDir, path.basename(tab.contextPath!)))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps path-like tab ids inside the context directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-id-"));
    const service = new TabContextService(path.join(root, ".cloudx"));
    const tab = tabFixture(root, "../outside");
    const contextPath = await service.create(tab);

    expect(contextPath).toBeDefined();
    expect(path.dirname(contextPath!)).toBe(path.join(root, ".cloudx", "context"));
    await expect(fs.access(path.join(root, ".cloudx", "outside.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createContext(): Promise<{ service: TabContextService; tab: WorkspaceTab }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-context-"));
  const service = new TabContextService(path.join(root, ".cloudx"));
  const tab = tabFixture(root);
  tab.contextPath = await service.create(tab);
  return { service, tab };
}

function tabFixture(root: string, id = "tab-1"): WorkspaceTab {
  return {
    id,
    pluginId: "standard-terminal",
    title: "Shell",
    cwd: root,
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function capacityError(): Error & { code: string } {
  return Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
}

async function withOwnedContext(run: (fixture: { root: string; dataDir: string; service: TabContextService; tab: WorkspaceTab }) => Promise<void>, files: Partial<TabContextFileOperations> = {}): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-owned-context-"));
  const dataDir = path.join(root, "data");
  const service = new TabContextService(dataDir, { ...fileOperations, ...files });
  const tab = tabFixture(root);
  try {
    tab.contextPath = await service.create(tab, { ownedDirectory: true });
    await run({ root, dataDir, service, tab });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
