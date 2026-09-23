import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertDirectoryIdentity, readDirectoryIdentity, sameDirectoryIdentity } from "./directoryIdentity.js";
import { openOwnedDirectoryNoFollow } from "./jsonStateFile.js";

vi.mock("./filesystemIdentity.js", () => ({ filesystemIdentity: async () => ({ filesystemType: "ef53", filesystemId: "f00d1234" }) }));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-directory-identity-"));
  roots.push(root);
  const owned = await openOwnedDirectoryNoFollow(root, path.join(root, "owned"), "Test directory");
  const saved = owned.identity;
  await owned.close();
  return { root, saved };
}

it("reopens the same durable directory after only its saved device number changes", async () => {
  const { root, saved } = await fixture();
  const previous = { ...saved, dev: String(BigInt(saved.dev) + 2n) };
  const reopened = await openOwnedDirectoryNoFollow(root, saved.path, "Test directory", previous);
  expect(reopened.identity).toEqual(saved);
  await reopened.close();
});

it.each(["filesystemId", "filesystemType", "uid", "birthtimeNs"] as const)("rejects changed %s even when pathname and inode match", async field => {
  const { saved } = await fixture();
  const changed = { ...saved, durable: { ...saved.durable!, [field]: field === "filesystemId" ? "abcd1234" : "1" } };
  expect(() => assertDirectoryIdentity(changed, saved, "Owned directory")).toThrow(/ownership changed/);
});

it("keeps a legacy device mismatch blocked until deliberate filesystem reconciliation", async () => {
  const { saved } = await fixture();
  const legacy = { path: saved.path, dev: "1", ino: saved.ino };
  expect(() => assertDirectoryIdentity(legacy, saved, "Owned directory")).toThrow(/device changed from 1.*reconcile/);
  expect(sameDirectoryIdentity({ ...legacy, dev: saved.dev }, saved)).toBe(true);
});

it("does not treat a device-derived or unsupported filesystem ID as durable evidence", async () => {
  const { saved } = await fixture();
  const current = { ...saved, durable: { ...saved.durable!, filesystemType: "58465342" } };
  expect(sameDirectoryIdentity({ ...current, dev: "1" }, current)).toBe(false);
});

it("rejects replaced directories and symbolic-link substitutions", async () => {
  const { root, saved } = await fixture();
  await fs.rename(saved.path, path.join(root, "original"));
  await fs.mkdir(saved.path);
  await expect(openOwnedDirectoryNoFollow(root, saved.path, "Test directory", saved)).rejects.toThrow(/ownership changed/);
  await fs.rmdir(saved.path);
  await fs.symlink(path.join(root, "original"), saved.path);
  await expect(readDirectoryIdentity(saved.path)).rejects.toThrow(/symbolic links/);
});

it("rejects an ancestor symlink even when it points to the original owned directory", async () => {
  const { root } = await fixture();
  const parent = path.join(root, "parent");
  await fs.mkdir(path.join(parent, "child"), { recursive: true });
  const saved = await readDirectoryIdentity(path.join(parent, "child"));
  await fs.rename(parent, `${parent}-original`);
  await fs.symlink(`${parent}-original`, parent);
  await expect(readDirectoryIdentity(saved.path)).rejects.toThrow(/symbolic links/);
  expect((await fs.stat(path.join(`${parent}-original`, "child"), { bigint: true })).ino.toString()).toBe(saved.ino);
});
