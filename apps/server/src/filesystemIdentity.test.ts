import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { filesystemIdentity } from "./filesystemIdentity.js";

it("reads the actual Linux filesystem ID from the inherited directory descriptor", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-filesystem-probe-"));
  const handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await filesystemIdentity(handle.fd);
    expect(identity.filesystemId).toMatch(/^[a-f0-9]+$/);
    expect(identity.filesystemId).not.toMatch(/^0+$/);
    expect(identity.filesystemType).toBe((await fs.statfs(root, { bigint: true })).type.toString(16));
    await fs.rename(root, `${root}-renamed`);
    expect(await filesystemIdentity(handle.fd)).toEqual(identity);
  } finally {
    await handle.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(`${root}-renamed`, { recursive: true, force: true });
  }
});
