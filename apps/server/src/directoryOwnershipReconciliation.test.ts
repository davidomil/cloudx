import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { filesystemIdentity } from "./filesystemIdentity.js";
import { readDirectoryIdentity } from "./directoryIdentity.js";
import { DirectoryOwnershipReconciler } from "./directoryOwnershipReconciliation.js";

vi.mock("./filesystemIdentity.js", () => ({ filesystemIdentity: vi.fn(async () => ({ filesystemType: "ef53", filesystemId: "f00d1234" })) }));

it("rejects a proposed renumber that splits one saved device into multiple filesystems", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-reconcile-devices-"));
  try {
    const reconciliation = new DirectoryOwnershipReconciler();
    for (const filesystemId of ["aaaa", "bbbb"]) {
      const directory = path.join(root, filesystemId);
      await fs.mkdir(directory);
      vi.mocked(filesystemIdentity).mockResolvedValue({ filesystemType: "ef53", filesystemId });
      const saved = await readDirectoryIdentity(directory);
      await reconciliation.add({ path: saved.path, ino: saved.ino, dev: "1" });
    }
    const preview = reconciliation.preview({});
    expect(() => reconciliation.validate(preview, { fingerprint: preview.fingerprint, attestations: preview.directories }))
      .toThrow(/Saved device 1 maps to conflicting filesystems/);
    expect((await fs.readdir(root)).sort()).toEqual(["aaaa", "bbbb"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
