import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDirectoryIdentity } from "../directoryIdentity.js";
import { captureForgeRemovalContents, assertForgeRemovalContents, isForgeRemovalContents } from "./ForgeCheckoutRemoval.js";

let root: string;
let checkout: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-checkout-removal-"));
  checkout = path.join(root, "checkout");
  await fs.mkdir(path.join(checkout, "nested"), { recursive: true });
  await fs.writeFile(path.join(checkout, "nested", "first.txt"), "First content\n");
  await fs.writeFile(path.join(checkout, "nested", "second.txt"), "Second content\n");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Authorized checkout removal contents", () => {
  it("accepts surviving authorized files after partial deletion changes their parent metadata", async () => {
    await fs.link(path.join(checkout, "nested", "first.txt"), path.join(checkout, "hard-link.txt"));
    const identity = await readDirectoryIdentity(checkout);
    const authorized = JSON.parse(JSON.stringify(await captureForgeRemovalContents(identity)));
    expect(isForgeRemovalContents(authorized)).toBe(true);
    await fs.rm(path.join(checkout, "nested", "first.txt"));
    await expect(assertForgeRemovalContents(identity, authorized)).resolves.toBeUndefined();
    await fs.rm(path.join(checkout, "nested"), { recursive: true });
    await expect(assertForgeRemovalContents(identity, authorized)).resolves.toBeUndefined();
  });

  it.each(["file", "directory"])("rejects a new %s added to the surviving tree", async kind => {
    const identity = await readDirectoryIdentity(checkout);
    const authorized = await captureForgeRemovalContents(identity);
    const added = path.join(checkout, "recovered-investigation");
    if (kind === "file") await fs.writeFile(added, "Preserve new evidence");
    else await fs.mkdir(added);
    await expect(assertForgeRemovalContents(identity, authorized)).rejects.toThrow("recovered-investigation");
    expect(await fs.lstat(added)).toBeDefined();
  });

  it("rejects same-size edits even when the original modification time is restored", async () => {
    const file = path.join(checkout, "nested", "first.txt");
    await fs.utimes(file, 1_700_000_000, 1_700_000_000);
    const identity = await readDirectoryIdentity(checkout);
    const authorized = await captureForgeRemovalContents(identity);
    await fs.writeFile(file, "Other content\n");
    await fs.utimes(file, 1_700_000_000, 1_700_000_000);
    await expect(assertForgeRemovalContents(identity, authorized)).rejects.toThrow("nested/first.txt");
    expect(await fs.readFile(file, "utf8")).toBe("Other content\n");
  });

  it.each(["replacement", "permissions"])("preserves an authorized file after its %s changes", async changed => {
    const identity = await readDirectoryIdentity(checkout);
    const file = path.join(checkout, "nested", "first.txt");
    const authorized = await captureForgeRemovalContents(identity);
    if (changed === "replacement") {
      await fs.rename(file, path.join(root, "original.txt"));
      await fs.writeFile(file, "First content\n");
    } else await fs.chmod(file, (await fs.stat(file)).mode ^ 0o100);
    await expect(assertForgeRemovalContents(identity, authorized)).rejects.toThrow("nested/first.txt");
    expect(await fs.readFile(file, "utf8")).toBe("First content\n");
  });

  it("records links without following them and rejects a changed target", async () => {
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "External work");
    const link = path.join(checkout, "linked.txt");
    await fs.symlink(outside, link);
    const identity = await readDirectoryIdentity(checkout);
    const authorized = await captureForgeRemovalContents(identity);
    await fs.writeFile(outside, "Edited external work");
    await expect(assertForgeRemovalContents(identity, authorized)).resolves.toBeUndefined();
    await fs.unlink(link);
    await fs.symlink(path.join(root, "different.txt"), link);
    await expect(assertForgeRemovalContents(identity, authorized)).rejects.toThrow("linked.txt");
    expect(await fs.readFile(outside, "utf8")).toBe("Edited external work");
  });

  it("preserves a file replaced by a symbolic link while it is being inspected", async () => {
    const identity = await readDirectoryIdentity(checkout);
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "External work");
    const open = fs.open.bind(fs);
    const file = path.join(checkout, "nested", "first.txt");
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      if (String(target).endsWith("/first.txt") && flags === (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)) {
        await fs.unlink(file);
        await fs.symlink(outside, file);
      }
      return open(target, flags, mode);
    });
    await expect(captureForgeRemovalContents(identity)).rejects.toMatchObject({ code: "ELOOP" });
    expect(await fs.readFile(outside, "utf8")).toBe("External work");
  });

  it("fails closed when interrupted removal has no recorded contents authorization", async () => {
    const identity = await readDirectoryIdentity(checkout);
    await expect(assertForgeRemovalContents(identity, undefined)).rejects.toThrow("no authorized contents inventory");
    expect(await fs.readFile(path.join(checkout, "nested", "first.txt"), "utf8")).toBe("First content\n");
  });

  it("rejects malformed or ambiguous serialized authorization", async () => {
    const authorized = await captureForgeRemovalContents(await readDirectoryIdentity(checkout));
    for (const value of [null, {}, [{ path: "/escape", fingerprint: "a".repeat(64) }],
      [{ path: "../escape", fingerprint: "a".repeat(64) }], [{ path: "nested//file", fingerprint: "a".repeat(64) }],
      [{ path: "file\0name", fingerprint: "a".repeat(64) }], [{ path: "file", fingerprint: "unverified" }],
      [authorized[0], authorized[0]], Array(100_001),
      [{ path: "large".repeat(4 * 1024 * 1024), fingerprint: "a".repeat(64) }]]) expect(isForgeRemovalContents(value)).toBe(false);
  });

  it("preserves unsupported socket files instead of authorizing recursive removal", async () => {
    const socket = path.join(checkout, "service.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    try {
      await expect(captureForgeRemovalContents(await readDirectoryIdentity(checkout))).rejects.toThrow("unsupported file");
      expect((await fs.lstat(socket)).isSocket()).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it("preserves file names that cannot be serialized without changing their bytes", async () => {
    const file = Buffer.concat([Buffer.from(`${checkout}/`), Buffer.from([0xff])]);
    await fs.writeFile(file, "Preserve original file name");
    await expect(captureForgeRemovalContents(await readDirectoryIdentity(checkout))).rejects.toThrow("file name that cannot be recorded");
    expect(await fs.readFile(file, "utf8")).toBe("Preserve original file name");
  });

  it("stops inspection on cancellation without changing the tree", async () => {
    const identity = await readDirectoryIdentity(checkout);
    const signal = AbortSignal.abort(new Error("Cancelled cleanup"));
    await expect(captureForgeRemovalContents(identity, signal)).rejects.toThrow("Cancelled cleanup");
    expect(await fs.readFile(path.join(checkout, "nested", "first.txt"), "utf8")).toBe("First content\n");
  });
});
