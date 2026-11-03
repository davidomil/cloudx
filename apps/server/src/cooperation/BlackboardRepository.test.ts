import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlackboardRepository } from "./BlackboardRepository.js";
import { BlackboardService } from "./BlackboardService.js";

let root: string;
let repository: BlackboardRepository;
const imagePath = "boards/board/assets/original.png";
const bytes = Buffer.from("Original image bytes");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cooperation-durability-"));
  repository = new BlackboardRepository(root);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

async function observeWrites(options: { failPath?: string; failWrite?: boolean; failure?: Error } = {}) {
  const synced: string[] = [];
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    const relative = path.relative(root, await fs.realpath(`/proc/self/fd/${file.fd}`)) || ".";
    const sync = file.sync.bind(file);
    vi.spyOn(file, "sync").mockImplementation(async () => {
      synced.push(relative);
      if (relative === options.failPath) throw options.failure;
      await sync();
    });
    if (options.failWrite && relative === imagePath) vi.spyOn(file, "writeFile").mockRejectedValueOnce(options.failure);
    return file;
  });
  return synced;
}

describe("BlackboardRepository original durability", () => {
  it("makes a fresh configured root and its newly allocated parent durable before service readiness", async () => {
    const rootDir = path.join(root, "new-data", "cooperation");
    const synced = await observeWrites();
    const boards = new BlackboardService({ rootDir });
    await boards.init();
    expect(boards.listBoards()).toEqual([]);
    expect(synced).toEqual(expect.arrayContaining([".", "new-data", "new-data/cooperation"]));
    expect(synced.indexOf(".")).toBeLessThan(synced.indexOf("new-data"));
    expect(synced.indexOf("new-data")).toBeLessThan(synced.indexOf("new-data/cooperation"));
  });

  it("refuses startup when its configured parent directory cannot be flushed", async () => {
    const rootDir = path.join(root, "new-data", "cooperation");
    const failure = new Error("Configured parent flush failed");
    await observeWrites({ failPath: "new-data", failure });
    const boards = new BlackboardService({ rootDir });
    await expect(boards.init()).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
    expect(() => boards.listBoards()).toThrow("has not finished validating");
    await expect(fs.stat(path.join(rootDir, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks();
    const restarted = new BlackboardService({ rootDir });
    await restarted.init();
    expect(restarted.listBoards()).toEqual([]);
  });

  it("flushes canonical ancestors while retaining a configured parent alias", async () => {
    const canonicalParent = path.join(root, "canonical-data");
    await fs.mkdir(canonicalParent);
    const alias = path.join(root, "data-alias");
    await fs.symlink(canonicalParent, alias);
    const synced = await observeWrites();
    await new BlackboardRepository(path.join(alias, "cooperation")).load();
    expect(synced).toEqual(expect.arrayContaining(["canonical-data", "canonical-data/cooperation"]));
  });

  it("continues to reject a symbolic configured root", async () => {
    const canonicalRoot = path.join(root, "canonical-root");
    const symbolicRoot = path.join(root, "symbolic-root");
    await fs.mkdir(canonicalRoot);
    await fs.symlink(canonicalRoot, symbolicRoot);
    await expect(new BlackboardRepository(symbolicRoot).load()).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });

  it("flushes the original and every newly created directory entry before acknowledging its write", async () => {
    const synced = await observeWrites();
    await repository.writeBytes(imagePath, bytes);
    expect(await fs.readFile(path.join(root, imagePath))).toEqual(bytes);
    expect(synced).toEqual(expect.arrayContaining([".", "boards", "boards/board", "boards/board/assets", imagePath]));
    expect(synced.indexOf(imagePath)).toBeLessThan(synced.lastIndexOf("boards/board/assets"));
  });

  it.each([
    { label: "byte write", failWrite: true },
    { label: "original flush", failPath: imagePath },
    { label: "original directory flush", failPath: "boards/board/assets" }
  ])("removes the unacknowledged original when its $label fails", async options => {
    const failure = new Error(`${options.label} failed`);
    await observeWrites({ ...options, failure });
    await expect(repository.writeBytes(imagePath, bytes)).rejects.toBe(failure);
    await expect(fs.stat(path.join(root, imagePath))).rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks();
    await repository.writeBytes(imagePath, bytes);
    expect(await fs.readFile(path.join(root, imagePath))).toEqual(bytes);
  });

  it("reports cleanup failure together with the failed original write", async () => {
    const failure = new Error("Original flush failed");
    const cleanupFailure = new Error("Original removal failed");
    await observeWrites({ failPath: imagePath, failure });
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(cleanupFailure);
    await expect(repository.writeBytes(imagePath, bytes)).rejects.toMatchObject({ name: "AggregateError", errors: [failure, cleanupFailure] });
  });

  it("preserves an existing original when exclusive creation is refused", async () => {
    await repository.writeBytes(imagePath, bytes);
    await expect(repository.writeBytes(imagePath, Buffer.from("Replacement"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(path.join(root, imagePath))).toEqual(bytes);
  });

  it("stops before creating an original when a parent directory cannot be made durable", async () => {
    const failure = new Error("Managed parent flush failed");
    await observeWrites({ failPath: "boards", failure });
    await expect(repository.writeBytes(imagePath, bytes)).rejects.toBe(failure);
    await expect(fs.stat(path.join(root, imagePath))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
