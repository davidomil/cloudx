import fs from "node:fs/promises";
import path from "node:path";

export class PathPolicy {
  private readonly roots: string[];

  constructor(allowedRoots: string[]) {
    this.roots = allowedRoots.map((root) => path.resolve(root));
  }

  resolve(candidate: string): string {
    const resolved = path.resolve(candidate);
    if (!this.isAllowed(resolved)) {
      throw new Error(`Path is outside configured Cloudx roots: ${candidate}`);
    }
    return resolved;
  }

  async ensureDirectory(candidate: string, createDirectory: boolean): Promise<string> {
    const resolved = this.resolve(candidate);
    if (createDirectory) {
      await fs.mkdir(resolved, { recursive: true });
    }
    const stat = await fs.stat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(`Directory does not exist: ${resolved}`);
      }
      throw error;
    });
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }
    return resolved;
  }

  isAllowed(resolvedPath: string): boolean {
    const normalized = path.resolve(resolvedPath);
    return this.roots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`));
  }
}
