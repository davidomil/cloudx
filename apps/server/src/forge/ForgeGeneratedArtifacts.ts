const generatedDirectories = new Set(["node_modules", "dist", "build", ".venv", "__pycache__", ".pytest_cache", ".vite", ".cache"]);

export function isGeneratedForgePath(relative: string): boolean {
  return relative.split("/").some(part => generatedDirectories.has(part)) || relative.endsWith(".tsbuildinfo");
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
