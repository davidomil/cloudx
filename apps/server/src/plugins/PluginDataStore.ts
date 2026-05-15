import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export class PluginDataStore {
  private readonly dataPath: string;

  constructor(dataDir: string) {
    this.dataPath = path.join(dataDir, "plugin-data");
  }

  async read(pluginId: string): Promise<unknown | undefined> {
    const filePath = this.filePath(pluginId);
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    return JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
  }

  async write(pluginId: string, value: unknown): Promise<void> {
    await fsp.mkdir(this.dataPath, { recursive: true });
    await fsp.writeFile(this.filePath(pluginId), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private filePath(pluginId: string): string {
    const safeId = pluginId.replace(/[^a-z0-9._-]/gi, "_");
    return path.join(this.dataPath, `${safeId}.json`);
  }
}
