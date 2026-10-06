import path from "node:path";

const generatedDirectories = new Set(["node_modules", "dist", "build", ".venv", "__pycache__", ".pytest_cache", ".vite", ".cache"]);

export function isGeneratedForgePath(relative: string): boolean {
  return relative.split("/").some(part => generatedDirectories.has(part)) || relative.endsWith(".tsbuildinfo");
}

export function isGeneratedForgeLink(relative: string, target: string): boolean {
  if (path.posix.isAbsolute(target) || target.includes("\\") || target.includes("\0")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
  return resolved !== ".." && !resolved.startsWith("../") && !resolved.split("/").includes(".git") && isGeneratedForgePath(resolved);
}

export function isTypeScriptBuildInfo(content: string): boolean {
  let value;
  try { value = JSON.parse(content); } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(value.version)) return false;
  if (Array.isArray(value.fileNames) && value.fileNames.every((file: unknown) => typeof file === "string") &&
      Array.isArray(value.fileInfos) && value.fileInfos.length === value.fileNames.length &&
      value.fileInfos.every((info: unknown) => typeof info === "string" || info && typeof info === "object" &&
        !Array.isArray(info) && typeof (info as { version?: unknown }).version === "string")) return true;
  return !value.fileNames && Array.isArray(value.root) && value.root.every((file: unknown) => typeof file === "string");
}
