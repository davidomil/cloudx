import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ForgeWorker } from "@cloudx/shared";
import {
  requireSafeDirectory,
  writeNewTextFileNoFollow,
} from "../jsonStateFile.js";
import type { PluginDataStore } from "../plugins/PluginDataStore.js";
import { parseWorkers } from "./ForgeWorkflowValidation.js";

export class ForgeWorkflowStore {
  constructor(private readonly data: PluginDataStore) {}
  async read(): Promise<ForgeWorker[]> {
    return parseWorkers((await this.data.read("forge")) ?? []);
  }
  async write(workers: ForgeWorker[]): Promise<void> {
    await this.data.write("forge", parseWorkers(workers));
  }
}
export class ForgeWorkerReports {
  private readonly directory: string;
  constructor(private readonly dataDir: string) {
    this.directory = path.join(dataDir, "forge-reports");
  }
  async prepare(
    attemptId: string,
    context: unknown,
  ): Promise<{ reportPath: string; contextPath: string }> {
    await requireSafeDirectory(this.dataDir, this.directory, {
      create: true,
      label: "Forge completion reports",
    });
    const reportPath = this.filePath(attemptId);
    try {
      await fs.lstat(reportPath);
      throw new Error("A completion report already exists for this attempt.");
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    const contextPath = this.contextPath(attemptId);
    const content = JSON.stringify(context);
    if (!content || Buffer.byteLength(content) > 12_000_000)
      throw new Error("Worker context exceeds the 12 MB limit.");
    await writeNewTextFileNoFollow(
      this.dataDir,
      contextPath,
      content,
      "Forge task context",
    );
    return { reportPath, contextPath };
  }
  async read(attemptId: string): Promise<unknown | undefined> {
    if (
      !(await requireSafeDirectory(this.dataDir, this.directory, {
        create: false,
        label: "Forge completion reports",
      }))
    )
      return undefined;
    let handle;
    try {
      handle = await fs.open(
        this.filePath(attemptId),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1_000_000)
        throw new Error(
          "Completion report must be a regular file no larger than 1 MB.",
        );
      const buffer = Buffer.alloc(1_000_001);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1_000_000)
        throw new Error("Completion report exceeds 1 MB.");
      return JSON.parse(
        buffer.subarray(0, bytesRead).toString("utf8"),
      ) as unknown;
    } finally {
      await handle.close();
    }
  }
  async remove(attemptId: string): Promise<void> {
    if (
      !(await requireSafeDirectory(this.dataDir, this.directory, {
        create: false,
        label: "Forge completion reports",
      }))
    )
      return;
    for (const file of [this.filePath(attemptId), this.contextPath(attemptId)])
      await fs.unlink(file).catch((error) => {
        if (!notFound(error)) throw error;
      });
  }
  private contextPath(id: string): string {
    return this.filePath(id).replace(/\.json$/, ".context.json");
  }
  private filePath(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid report attempt.");
    return path.join(this.directory, `${id}.json`);
  }
}
function notFound(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
