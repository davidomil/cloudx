import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { COOPERATION_LIMITS } from "@cloudx/shared";
import { requireSafeDirectory } from "../jsonStateFile.js";
import { CooperationError, requireCooperation } from "./CooperationError.js";
import { emptyBlackboardState, type BlackboardState } from "./BlackboardState.js";

export class BlackboardRepository {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly rootDir: string) {}

  serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async load(): Promise<BlackboardState> {
    try {
      await requireSafeDirectory(this.rootDir, this.rootDir, { create: true, label: "Cooperation data directory" });
      try { return JSON.parse(await this.readText("state.json", COOPERATION_LIMITS.stateBytes)) as BlackboardState; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyBlackboardState(); throw error; }
    } catch (error) {
      if (error instanceof CooperationError) throw error;
      throw new CooperationError("INTEGRITY_ERROR", "The cooperation authority cannot be read. Preserve it for explicit repair.");
    }
  }

  async commit(state: BlackboardState): Promise<void> {
    requireCooperation(Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`) <= COOPERATION_LIMITS.stateBytes, "LIMIT_EXCEEDED", "Saved boards and history exceed the cooperation state budget.");
    let replaced = false;
    try { await this.writeText("state.json", `${JSON.stringify(state, null, 2)}\n`, () => { replaced = true; }); }
    catch (error) {
      if (replaced) throw new CooperationError("INTEGRITY_ERROR", "The authority was replaced, but storage durability could not be confirmed. Inspect the saved receipt before any further write.", { authorityReplaced: true });
      throw error;
    }
  }

  async writeBytes(relativePath: string, bytes: Buffer): Promise<void> {
    await this.withDirectory(path.dirname(relativePath), true, async directory => {
      const file = await fs.open(this.child(directory, path.basename(relativePath)), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    });
  }

  async readBytes(relativePath: string): Promise<Buffer> {
    return this.withDirectory(path.dirname(relativePath), false, async directory => {
      const file = await fs.open(this.child(directory, path.basename(relativePath)), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        requireCooperation(stat.isFile() && stat.size <= COOPERATION_LIMITS.imageBytes, "ASSET_INVALID", "The original image file is invalid.");
        return await file.readFile();
      } finally { await file.close(); }
    });
  }

  async removeBytes(relativePath: string): Promise<void> {
    await this.withDirectory(path.dirname(relativePath), false, async directory => {
      const target = this.child(directory, path.basename(relativePath));
      const stat = await fs.lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      requireCooperation(!stat || stat.isFile(), "INTEGRITY_ERROR", "An original image was replaced before cleanup.");
      if (stat) await fs.unlink(target);
    });
  }

  async removeBoard(boardId: string): Promise<void> {
    await this.withDirectory("boards", false, directory => fs.rm(this.child(directory, boardId), { recursive: true, force: true }));
  }

  async writeText(relativePath: string, content: string, onReplaced?: () => void): Promise<void> {
    await this.withDirectory(path.dirname(relativePath), true, async directory => {
      const target = this.child(directory, path.basename(relativePath));
      const existing = await fs.lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      requireCooperation(!existing || existing.isFile(), "INTEGRITY_ERROR", "The managed document must be a regular file.");
      const temporary = this.child(directory, `.cooperation-${randomUUID()}.tmp`);
      const file = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(content, "utf8"); await file.sync(); await file.close();
        await fs.rename(temporary, target); onReplaced?.(); await directory.sync();
      } catch (error) {
        await file.close().catch(() => undefined); await fs.unlink(temporary).catch(() => undefined); throw error;
      }
    });
  }

  async readText(relativePath: string, maximumBytes: number): Promise<string> {
    return this.withDirectory(path.dirname(relativePath), false, async directory => {
      const file = await fs.open(this.child(directory, path.basename(relativePath)), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        requireCooperation(stat.isFile() && stat.size <= maximumBytes, "INTEGRITY_ERROR", "The managed document is invalid or exceeds its byte budget.");
        return await file.readFile("utf8");
      } finally { await file.close(); }
    });
  }

  private async withDirectory<T>(relativePath: string, create: boolean, action: (directory: Awaited<ReturnType<typeof fs.open>>) => Promise<T>): Promise<T> {
    requireCooperation(process.platform === "linux", "INTEGRITY_ERROR", "Cooperation managed storage requires Linux descriptor-relative file access.");
    const segments = relativePath === "." ? [] : relativePath.split(path.sep);
    requireCooperation(segments.every(segment => segment && segment !== "." && segment !== ".."), "INTEGRITY_ERROR", "Managed paths must stay inside cooperation storage.");
    let directory = await fs.open(this.rootDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const segment of segments) {
        const child = this.child(directory, segment);
        if (create) await fs.mkdir(child, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
        const next = await fs.open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await directory.close(); directory = next;
      }
      return await action(directory);
    } finally { await directory.close(); }
  }

  private child(directory: Awaited<ReturnType<typeof fs.open>>, name: string): string {
    requireCooperation(path.basename(name) === name && name !== "." && name !== "..", "INTEGRITY_ERROR", "Managed filenames cannot traverse directories.");
    return `/proc/self/fd/${directory.fd}/${name}`;
  }

  resolve(relativePath: string): string {
    const target = path.resolve(this.rootDir, relativePath);
    requireCooperation(target.startsWith(`${path.resolve(this.rootDir)}${path.sep}`), "ASSET_INVALID", "The image must belong to the managed board.");
    return target;
  }
}
