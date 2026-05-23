import { createHash } from "node:crypto";
import path from "node:path";

import { readTextFileNoFollow, requireRegularFile, requireSafeDirectory, stringifyJsonDocument, writeTextFileAtomic } from "../jsonStateFile.js";

export class PluginDataStore {
  private readonly dataRoot: string;
  private readonly dataPath: string;

  constructor(dataDir: string) {
    this.dataRoot = path.resolve(dataDir);
    this.dataPath = path.join(this.dataRoot, "plugin-data");
  }

  async read(pluginId: string): Promise<unknown | undefined> {
    const filePath = this.filePath(pluginId);
    if (!(await requireSafeDirectory(this.dataRoot, this.dataPath, { create: false, label: "Plugin data directory" }))) {
      return undefined;
    }
    if (!(await requireRegularFile(filePath, "Plugin data file"))) {
      return undefined;
    }
    try {
      return JSON.parse(await readTextFileNoFollow(filePath, "Plugin data file")) as unknown;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async write(pluginId: string, value: unknown): Promise<void> {
    const filePath = this.filePath(pluginId);
    await writeTextFileAtomic(this.dataRoot, filePath, stringifyJsonDocument(value, "Plugin data file"), "Plugin data file");
  }

  private filePath(pluginId: string): string {
    return path.join(this.dataPath, `${pluginDataFileStem(pluginId)}.json`);
  }
}

function pluginDataFileStem(pluginId: string): string {
  if (!pluginId) {
    throw new Error("Plugin id is required.");
  }
  const slug = pluginId.replace(/[^a-z0-9._-]/gi, "_").slice(0, 64) || "plugin";
  const digest = createHash("sha256").update(pluginId).digest("hex");
  return `${slug}-${digest}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
