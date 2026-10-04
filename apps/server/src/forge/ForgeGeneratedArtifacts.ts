const generatedDirectories = new Set(["node_modules", "dist", "build", ".venv", "__pycache__", ".pytest_cache", ".vite", ".cache"]);

export function isGeneratedForgePath(relative: string): boolean {
  return relative.split("/").some(part => generatedDirectories.has(part));
}
