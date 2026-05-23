import path from "node:path";

export function relativeChildPath(parentPath: string, childPath: string): string | undefined {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  if (relative === "") {
    return "";
  }
  return isChildRelativePath(relative) ? relative : undefined;
}

export function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  return relativeChildPath(parentPath, childPath) !== undefined;
}

export function isDirectChildPath(parentPath: string, childPath: string): boolean {
  const relative = relativeChildPath(parentPath, childPath);
  return relative !== undefined && relative !== "" && !relative.includes(path.sep);
}

function isChildRelativePath(relativePath: string): boolean {
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}
