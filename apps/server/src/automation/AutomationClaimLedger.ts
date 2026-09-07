import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { AutomationRunSummary } from "@cloudx/shared";

const LEDGER_DIRECTORY = "automation-claims";
const CLAIM_SCHEMA_VERSION = 1;

interface ClaimPair {
  groupId: string;
  canonicalEventId: string;
}

interface ClaimRecord extends ClaimPair {
  schemaVersion: 1;
  key: string;
  runId: string;
  startedAt: string;
}

export interface AutomationClaimBatch {
  runs: AutomationRunSummary[];
  created: ClaimRecord[];
}

export class AutomationClaimLedger {
  private static readonly queues = new Map<string, Promise<void>>();
  private readonly root: string;

  constructor(
    private readonly dataDir: string,
    private readonly fileSystem: typeof fs = fs,
  ) {
    this.root = path.join(dataDir, LEDGER_DIRECTORY);
  }

  locationsFor(
    groupId: string,
    canonicalEventId: string,
  ): { key: string; activePath: string; historyPath: string } {
    const pair = validPair({ groupId, canonicalEventId });
    const key = claimKey(pair);
    const shard = [key.slice(0, 2), key.slice(2, 4), `${key}.json`];
    return {
      key,
      activePath: path.join(this.root, "active", ...shard),
      historyPath: path.join(this.root, "history", ...shard),
    };
  }

  claimBatch(pairs: ClaimPair[]): Promise<AutomationClaimBatch> {
    const normalized = pairs.map(validPair);
    const keys = normalized.map((pair) => claimKey(pair));
    if (new Set(keys).size !== keys.length) {
      return Promise.reject(
        new Error("Automation claim fanout pairs must be unique."),
      );
    }
    return this.serialize(async () => {
      await this.ensureLayout();
      const runs: AutomationRunSummary[] = [];
      const created: ClaimRecord[] = [];
      try {
        for (const pair of normalized) {
          const locations = this.locationsFor(
            pair.groupId,
            pair.canonicalEventId,
          );
          await this.validateRecordDirectory(locations.historyPath);
          const historical = await readRecord(
            this.fileSystem,
            locations.historyPath,
            pair,
            locations.key,
          );
          if (historical) continue;
          await this.validateRecordDirectory(locations.activePath);
          const active = await readRecord(
            this.fileSystem,
            locations.activePath,
            pair,
            locations.key,
          );
          if (active) {
            runs.push(runFor(active));
            continue;
          }
          const record: ClaimRecord = {
            schemaVersion: CLAIM_SCHEMA_VERSION,
            key: locations.key,
            groupId: pair.groupId,
            canonicalEventId: pair.canonicalEventId,
            runId: randomUUID(),
            startedAt: new Date().toISOString(),
          };
          await this.ensureRecordDirectory(locations.activePath);
          await createExclusiveRecord(
            this.fileSystem,
            locations.activePath,
            record,
          );
          created.push(record);
          runs.push(runFor(record));
        }
        return { runs, created };
      } catch (error) {
        try {
          await this.removeCreated(created);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Automation claim batch failed and rollback was incomplete.",
          );
        }
        throw error;
      }
    });
  }

  rollbackCreated(records: ClaimRecord[]): Promise<void> {
    return this.serialize(() => this.removeCreated(records));
  }

  terminalize(run: AutomationRunSummary): Promise<void> {
    if (
      !run.triggerEventId ||
      run.status === "queued" ||
      run.status === "running"
    ) {
      return Promise.resolve();
    }
    return this.serialize(async () => {
      await this.ensureLayout();
      const locations = this.locationsFor(run.groupId, run.triggerEventId!);
      const pair = {
        groupId: run.groupId,
        canonicalEventId: run.triggerEventId!,
      };
      await this.validateRecordDirectory(locations.historyPath);
      const historical = await readRecord(
        this.fileSystem,
        locations.historyPath,
        pair,
        locations.key,
      );
      if (historical) {
        if (historical.runId !== run.id)
          throw claimMismatch(locations.historyPath);
        await this.removeMatchingActive(
          locations.activePath,
          pair,
          locations.key,
          run.id,
        );
        return;
      }
      await this.validateRecordDirectory(locations.activePath);
      const active = await readRecord(
        this.fileSystem,
        locations.activePath,
        pair,
        locations.key,
      );
      if (!active) return;
      if (active.runId !== run.id) throw claimMismatch(locations.activePath);
      await this.ensureRecordDirectory(locations.historyPath);
      await publishTerminalRecord(
        this.fileSystem,
        locations.activePath,
        locations.historyPath,
        active,
      );
    });
  }

  private async removeCreated(records: ClaimRecord[]): Promise<void> {
    const removals = await Promise.allSettled(
      records.map(async (record) => {
        const location = this.locationsFor(
          record.groupId,
          record.canonicalEventId,
        ).activePath;
        await this.validateRecordDirectory(location);
        const current = await readRecord(
          this.fileSystem,
          location,
          record,
          record.key,
        );
        if (current?.runId === record.runId)
          await removeAndSync(this.fileSystem, location);
      }),
    );
    const failures = removals
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError(
        failures,
        "Automation claim rollback did not durably remove every owned record.",
      );
  }

  private async ensureLayout(): Promise<void> {
    await ensureDataDirectory(this.fileSystem, this.dataDir);
    await ensureOwnedDirectory(this.fileSystem, this.root);
    await ensureOwnedDirectory(this.fileSystem, path.join(this.root, "active"));
    await ensureOwnedDirectory(
      this.fileSystem,
      path.join(this.root, "history"),
    );
  }

  private async ensureRecordDirectory(filePath: string): Promise<void> {
    const { firstShard } = recordDirectories(filePath);
    await ensureOwnedDirectory(this.fileSystem, firstShard);
    await ensureOwnedDirectory(this.fileSystem, path.dirname(filePath));
  }

  private async validateRecordDirectory(filePath: string): Promise<void> {
    const { firstShard, secondShard } = recordDirectories(filePath);
    if (!(await validateOwnedDirectoryIfPresent(this.fileSystem, firstShard)))
      return;
    await validateOwnedDirectoryIfPresent(this.fileSystem, secondShard);
  }

  private async removeMatchingActive(
    filePath: string,
    pair: ClaimPair,
    key: string,
    runId: string,
  ): Promise<void> {
    await this.validateRecordDirectory(filePath);
    const active = await readRecord(this.fileSystem, filePath, pair, key);
    if (!active) return;
    if (active.runId !== runId) throw claimMismatch(filePath);
    await removeAndSync(this.fileSystem, filePath);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous =
      AutomationClaimLedger.queues.get(this.root) ?? Promise.resolve();
    const current = previous.then(operation);
    AutomationClaimLedger.queues.set(
      this.root,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }
}

function claimKey(pair: ClaimPair): string {
  return createHash("sha256")
    .update(
      `${Buffer.byteLength(pair.groupId)}:${pair.groupId}${Buffer.byteLength(pair.canonicalEventId)}:${pair.canonicalEventId}`,
    )
    .digest("hex");
}

function validPair(pair: ClaimPair): ClaimPair {
  if (!pair.groupId.trim() || !pair.canonicalEventId.trim()) {
    throw new Error(
      "Automation claim groupId and canonicalEventId must be non-empty strings.",
    );
  }
  return { groupId: pair.groupId, canonicalEventId: pair.canonicalEventId };
}

function runFor(record: ClaimRecord): AutomationRunSummary {
  return {
    id: record.runId,
    groupId: record.groupId,
    triggerEventId: record.canonicalEventId,
    status: "queued",
    startedAt: record.startedAt,
    trace: [],
  };
}

async function createExclusiveRecord(
  fileSystem: typeof fs,
  filePath: string,
  record: ClaimRecord,
): Promise<void> {
  let created = false;
  try {
    const handle = await fileSystem.open(
      filePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(fileSystem, path.dirname(filePath));
  } catch (error) {
    if (!created) throw error;
    try {
      await removeAndSync(fileSystem, filePath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Automation claim creation and durable cleanup both failed.",
      );
    }
    throw error;
  }
}

async function readRecord(
  fileSystem: typeof fs,
  filePath: string,
  pair: ClaimPair,
  key: string,
): Promise<ClaimRecord | undefined> {
  let handle;
  try {
    handle = await fileSystem.open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new Error(
      `Automation claim entry cannot be opened safely: ${filePath}`,
      { cause: error },
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Error(
        `Automation claim entry is not a regular file: ${filePath}`,
      );
    requireOwnedMode(
      stat,
      0o600,
      `Automation claim entry is not an owned 0600 file: ${filePath}`,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      throw new Error(`Automation claim entry is not valid JSON: ${filePath}`, {
        cause: error,
      });
    }
    if (
      !isClaimRecord(parsed) ||
      parsed.key !== key ||
      parsed.groupId !== pair.groupId ||
      parsed.canonicalEventId !== pair.canonicalEventId
    ) {
      throw claimMismatch(filePath);
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

async function ensureOwnedDirectory(
  fileSystem: typeof fs,
  directory: string,
): Promise<void> {
  let created = false;
  try {
    await fileSystem.mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const stat = await fileSystem.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Automation claim directory must be an owned non-symbolic directory: ${directory}`,
    );
  }
  requireOwnedMode(
    stat,
    0o700,
    `Automation claim directory must be owned with mode 0700: ${directory}`,
  );
  if (!created) return;
  try {
    await syncDirectory(fileSystem, path.dirname(directory));
  } catch (error) {
    try {
      await fileSystem.rmdir(directory);
      await syncDirectory(fileSystem, path.dirname(directory));
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Automation claim directory publication and cleanup both failed.",
      );
    }
    throw error;
  }
}

async function validateOwnedDirectoryIfPresent(
  fileSystem: typeof fs,
  directory: string,
): Promise<boolean> {
  let stat;
  try {
    stat = await fileSystem.lstat(directory);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Automation claim directory must be an owned non-symbolic directory: ${directory}`,
    );
  }
  requireOwnedMode(
    stat,
    0o700,
    `Automation claim directory must be owned with mode 0700: ${directory}`,
  );
  return true;
}

async function publishTerminalRecord(
  fileSystem: typeof fs,
  activePath: string,
  historyPath: string,
  record: ClaimRecord,
): Promise<void> {
  let published = false;
  try {
    await fileSystem.link(activePath, historyPath);
    published = true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const historical = await readRecord(
      fileSystem,
      historyPath,
      record,
      record.key,
    );
    if (historical?.runId !== record.runId) throw claimMismatch(historyPath);
  }
  if (published) {
    try {
      await syncDirectory(fileSystem, path.dirname(historyPath));
    } catch (error) {
      try {
        const historical = await readRecord(
          fileSystem,
          historyPath,
          record,
          record.key,
        );
        if (historical?.runId === record.runId)
          await removeAndSync(fileSystem, historyPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Automation claim publication and cleanup both failed.",
        );
      }
      throw error;
    }
  }
  await removeAndSync(fileSystem, activePath);
}

async function ensureDataDirectory(
  fileSystem: typeof fs,
  directory: string,
): Promise<void> {
  await fileSystem.mkdir(directory, { recursive: true });
  const stat = await fileSystem.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Automation data directory must be a non-symbolic directory: ${directory}`,
    );
  }
}

async function removeAndSync(
  fileSystem: typeof fs,
  filePath: string,
): Promise<void> {
  await fileSystem.rm(filePath);
  await syncDirectory(fileSystem, path.dirname(filePath));
}

async function syncDirectory(
  fileSystem: typeof fs,
  directory: string,
): Promise<void> {
  const handle = await fileSystem.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requireOwnedMode(
  stat: { mode: number; uid: number },
  mode: number,
  message: string,
): void {
  if (
    (stat.mode & 0o777) !== mode ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error(message);
  }
}

function recordDirectories(filePath: string): {
  firstShard: string;
  secondShard: string;
} {
  const secondShard = path.dirname(filePath);
  return { firstShard: path.dirname(secondShard), secondShard };
}

function isClaimRecord(value: unknown): value is ClaimRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ClaimRecord).schemaVersion === CLAIM_SCHEMA_VERSION &&
    typeof (value as ClaimRecord).key === "string" &&
    typeof (value as ClaimRecord).groupId === "string" &&
    typeof (value as ClaimRecord).canonicalEventId === "string" &&
    typeof (value as ClaimRecord).runId === "string" &&
    typeof (value as ClaimRecord).startedAt === "string"
  );
}

function claimMismatch(filePath: string): Error {
  return new Error(
    `Automation claim entry does not match its deterministic identity: ${filePath}`,
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
