import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AutomationClaimLedger } from "./AutomationClaimLedger.js";

describe("AutomationClaimLedger", () => {
  it("maps an exact pair to contained deterministic active and history paths", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-claim-paths-"),
    );
    const ledger = new AutomationClaimLedger(dataDir);

    const first = ledger.locationsFor("group-a", "plugin:test:event:1");
    const same = ledger.locationsFor("group-a", "plugin:test:event:1");
    const other = ledger.locationsFor("group-b", "plugin:test:event:1");

    expect(first).toEqual(same);
    expect(first.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toEqual(other);
    expect(path.relative(dataDir, first.activePath)).not.toMatch(
      /^\.\.(?:\/|$)/u,
    );
    expect(path.relative(dataDir, first.historyPath)).not.toMatch(
      /^\.\.(?:\/|$)/u,
    );
  });

  it("admits one exclusive claim and rejects a concurrent duplicate", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-claim-exclusive-"),
    );
    const first = new AutomationClaimLedger(dataDir);
    const second = new AutomationClaimLedger(dataDir);
    const pair = [{ groupId: "group-a", canonicalEventId: "event-a" }];

    const [left, right] = await Promise.all([
      first.claimBatch(pair),
      second.claimBatch(pair),
    ]);

    expect(left.runs).toHaveLength(1);
    expect(right.runs).toEqual(left.runs);
    expect([...left.created, ...right.created]).toHaveLength(1);
  });

  it("moves the same queued claim to terminal history and rejects replay indefinitely", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-claim-terminal-"),
    );
    const ledger = new AutomationClaimLedger(dataDir);
    const pair = { groupId: "group-a", canonicalEventId: "event-a" };
    const batch = await ledger.claimBatch([pair]);
    const locations = ledger.locationsFor(pair.groupId, pair.canonicalEventId);
    const active = await fs.readFile(locations.activePath, "utf8");

    await ledger.terminalize({
      ...batch.runs[0]!,
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });

    await expect(fs.access(locations.activePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(locations.historyPath, "utf8")).resolves.toBe(
      active,
    );
    await expect(
      new AutomationClaimLedger(dataDir).claimBatch([pair]),
    ).resolves.toMatchObject({ runs: [] });
  });

  it("recovers a crash-interrupted active claim with the same run identity", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-claim-recovery-"),
    );
    const pair = { groupId: "group-a", canonicalEventId: "event-a" };
    const original = await new AutomationClaimLedger(dataDir).claimBatch([
      pair,
    ]);

    const recovered = await new AutomationClaimLedger(dataDir).claimBatch([
      pair,
    ]);

    expect(recovered.runs).toEqual(original.runs);
    expect(recovered.created).toEqual([]);
  });

  it("syncs a claim file before its active parent and both directories when terminalizing", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-claim-sync-order-"),
    );
    const locations = new AutomationClaimLedger(dataDir).locationsFor(
      "group-a",
      "event-a",
    );
    const syncs: string[] = [];
    const ledger = new AutomationClaimLedger(
      dataDir,
      observingFileSystem((target) => {
        syncs.push(target);
      }),
    );

    const batch = await ledger.claimBatch([
      { groupId: "group-a", canonicalEventId: "event-a" },
    ]);

    expect(syncs.slice(-2)).toEqual([
      locations.activePath,
      path.dirname(locations.activePath),
    ]);
    syncs.length = 0;

    await ledger.terminalize({
      ...batch.runs[0]!,
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });

    expect(syncs.slice(-2)).toEqual([
      path.dirname(locations.historyPath),
      path.dirname(locations.activePath),
    ]);
  });

  it("rejects admission and removes its record when active-parent synchronization fails", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-claim-sync-failure-"),
    );
    const locations = new AutomationClaimLedger(dataDir).locationsFor(
      "group-a",
      "event-a",
    );
    let failed = false;
    const ledger = new AutomationClaimLedger(
      dataDir,
      observingFileSystem((target) => {
        if (target === path.dirname(locations.activePath) && !failed) {
          failed = true;
          throw Object.assign(new Error("directory sync failed"), {
            code: "EIO",
          });
        }
      }),
    );

    await expect(
      ledger.claimBatch([{ groupId: "group-a", canonicalEventId: "event-a" }]),
    ).rejects.toThrow("directory sync failed");

    await expect(fs.access(locations.activePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(locations.historyPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["write", "file-sync"] as const)(
    "removes an unpublished claim after a %s failure",
    async (failure) => {
      const dataDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "cloudx-claim-file-failure-"),
      );
      const locations = new AutomationClaimLedger(dataDir).locationsFor(
        "group-a",
        "event-a",
      );
      const ledger = new AutomationClaimLedger(
        dataDir,
        faultingFileSystem(failure, locations.activePath),
      );

      await expect(
        ledger.claimBatch([
          { groupId: "group-a", canonicalEventId: "event-a" },
        ]),
      ).rejects.toThrow(failure);

      await expect(fs.access(locations.activePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.access(locations.historyPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("keeps the active claim when terminal publication fails", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-claim-publish-failure-"),
    );
    const pair = { groupId: "group-a", canonicalEventId: "event-a" };
    const initial = new AutomationClaimLedger(dataDir);
    const batch = await initial.claimBatch([pair]);
    const locations = initial.locationsFor(pair.groupId, pair.canonicalEventId);
    const faulting = new AutomationClaimLedger(
      dataDir,
      faultingFileSystem("publish", locations.activePath),
    );

    await expect(
      faulting.terminalize({
        ...batch.runs[0]!,
        status: "failed",
        finishedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("publish");

    await expect(fs.access(locations.activePath)).resolves.toBeUndefined();
    await expect(fs.access(locations.historyPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers after terminal publication commits but active removal fails", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-claim-removal-failure-"),
    );
    const pair = { groupId: "group-a", canonicalEventId: "event-a" };
    const initial = new AutomationClaimLedger(dataDir);
    const batch = await initial.claimBatch([pair]);
    const locations = initial.locationsFor(pair.groupId, pair.canonicalEventId);
    const run = {
      ...batch.runs[0]!,
      status: "succeeded" as const,
      finishedAt: new Date().toISOString(),
    };
    const faulting = new AutomationClaimLedger(
      dataDir,
      faultingFileSystem("removal", locations.activePath),
    );

    await expect(faulting.terminalize(run)).rejects.toThrow("removal");
    await expect(fs.access(locations.activePath)).resolves.toBeUndefined();
    await expect(fs.access(locations.historyPath)).resolves.toBeUndefined();

    const recovered = new AutomationClaimLedger(dataDir);
    await recovered.terminalize(run);
    await expect(fs.access(locations.activePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(recovered.claimBatch([pair])).resolves.toMatchObject({
      runs: [],
    });
  });

  it("publishes terminal history without replacing a foreign deterministic record", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-claim-collision-"),
    );
    const ledger = new AutomationClaimLedger(dataDir);
    const pair = { groupId: "group-a", canonicalEventId: "event-a" };
    const batch = await ledger.claimBatch([pair]);
    const locations = ledger.locationsFor(pair.groupId, pair.canonicalEventId);
    await fs.mkdir(path.dirname(locations.historyPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.chmod(path.dirname(path.dirname(locations.historyPath)), 0o700);
    await fs.chmod(path.dirname(locations.historyPath), 0o700);
    const foreign = `${JSON.stringify({ ...batch.created[0], runId: "foreign-run" })}\n`;
    await fs.writeFile(locations.historyPath, foreign, { mode: 0o600 });

    await expect(
      ledger.terminalize({
        ...batch.runs[0]!,
        status: "failed",
        finishedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/deterministic identity/iu);

    await expect(fs.readFile(locations.historyPath, "utf8")).resolves.toBe(
      foreign,
    );
    await expect(fs.access(locations.activePath)).resolves.toBeUndefined();
  });

  it.each([
    [
      "directory",
      0o755,
      (locations: ReturnType<AutomationClaimLedger["locationsFor"]>) =>
        path.dirname(locations.activePath),
    ],
    [
      "record",
      0o644,
      (locations: ReturnType<AutomationClaimLedger["locationsFor"]>) =>
        locations.activePath,
    ],
  ])(
    "rejects an automation claim %s with an unsafe mode",
    async (_kind, mode, target) => {
      const dataDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "cloudx-claim-mode-"),
      );
      const pair = { groupId: "group-a", canonicalEventId: "event-a" };
      const ledger = new AutomationClaimLedger(dataDir);
      await ledger.claimBatch([pair]);
      const locations = ledger.locationsFor(
        pair.groupId,
        pair.canonicalEventId,
      );
      await fs.chmod(target(locations), mode);

      await expect(
        new AutomationClaimLedger(dataDir).claimBatch([pair]),
      ).rejects.toThrow(/0700|0600/iu);
    },
  );

  it.each(["malformed", "symlink", "directory"])(
    "fails closed for a %s deterministic claim entry",
    async (kind) => {
      if (kind === "symlink" && process.platform === "win32") return;
      const dataDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "cloudx-claim-invalid-"),
      );
      const ledger = new AutomationClaimLedger(dataDir);
      const locations = ledger.locationsFor("group-a", "event-a");
      await fs.mkdir(path.dirname(locations.activePath), { recursive: true });
      if (kind === "malformed") {
        await fs.writeFile(locations.activePath, "not-json", "utf8");
      } else if (kind === "symlink") {
        const outside = path.join(dataDir, "outside");
        await fs.writeFile(outside, "{}", "utf8");
        await fs.symlink(outside, locations.activePath);
      } else {
        await fs.mkdir(locations.activePath);
      }

      await expect(
        ledger.claimBatch([
          { groupId: "group-a", canonicalEventId: "event-a" },
        ]),
      ).rejects.toThrow(/claim|regular|symbolic|JSON/iu);
    },
  );

  it("looks up one duplicate without scanning or rewriting 10,000 unrelated history entries", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-claim-scale-"),
    );
    const ledger = new AutomationClaimLedger(dataDir);
    const pair = { groupId: "group-a", canonicalEventId: "event-a" };
    const batch = await ledger.claimBatch([pair]);
    await ledger.terminalize({
      ...batch.runs[0]!,
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });
    const unrelated = path.join(
      dataDir,
      "automation-claims",
      "history",
      "ff",
      "ff",
    );
    await fs.mkdir(unrelated, { recursive: true });
    await Promise.all(
      Array.from({ length: 10_000 }, (_, index) =>
        fs.writeFile(
          path.join(unrelated, `${index.toString().padStart(5, "0")}.json`),
          "{}",
        ),
      ),
    );
    const readdir = vi.spyOn(fs, "readdir");
    const open = vi.spyOn(fs, "open");
    const readFile = vi.spyOn(fs, "readFile");

    const duplicate = await new AutomationClaimLedger(dataDir).claimBatch([
      pair,
    ]);

    expect(duplicate.runs).toEqual([]);
    expect(readdir).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(readFile).not.toHaveBeenCalled();
    readdir.mockRestore();
    open.mockRestore();
    readFile.mockRestore();
  }, 20_000);
});

function observingFileSystem(
  onSync: (target: string) => void | Promise<void>,
): typeof fs {
  const open = fs.open.bind(fs);
  return {
    ...fs,
    open: (async (
      target: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode?: Parameters<typeof fs.open>[2],
    ) => {
      const handle = await open(target, flags, mode);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await onSync(String(target));
        await sync();
      };
      return handle;
    }) as typeof fs.open,
  } as typeof fs;
}

function faultingFileSystem(
  failure: "write" | "file-sync" | "publish" | "removal",
  activePath: string,
): typeof fs {
  const fileSystem = { ...fs } as typeof fs;
  const open = fs.open.bind(fs);
  let failed = false;
  fileSystem.open = (async (
    target: Parameters<typeof fs.open>[0],
    flags: Parameters<typeof fs.open>[1],
    mode?: Parameters<typeof fs.open>[2],
  ) => {
    const handle = await open(target, flags, mode);
    if (String(target) !== activePath) return handle;
    const mutable = handle as unknown as {
      writeFile(...args: unknown[]): Promise<void>;
      sync(): Promise<void>;
    };
    const writeFile = mutable.writeFile.bind(handle);
    const sync = mutable.sync.bind(handle);
    mutable.writeFile = async (...args) => {
      if (failure === "write" && !failed) {
        failed = true;
        throw new Error("write failure");
      }
      await writeFile(...args);
    };
    mutable.sync = async () => {
      if (failure === "file-sync" && !failed) {
        failed = true;
        throw new Error("file-sync failure");
      }
      await sync();
    };
    return handle;
  }) as typeof fs.open;
  const link = fs.link.bind(fs);
  fileSystem.link = (async (existingPath, newPath) => {
    if (failure === "publish" && !failed) {
      failed = true;
      throw new Error("publish failure");
    }
    await link(existingPath, newPath);
  }) as typeof fs.link;
  const rm = fs.rm.bind(fs);
  fileSystem.rm = (async (target, options) => {
    if (failure === "removal" && String(target) === activePath && !failed) {
      failed = true;
      throw new Error("removal failure");
    }
    await rm(target, options);
  }) as typeof fs.rm;
  return fileSystem;
}
