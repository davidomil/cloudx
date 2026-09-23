import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function writeRuntimeBuild({ repoRoot, commit } = {}) {
  repoRoot ??= fileURLToPath(new URL("../", import.meta.url));
  const git = args => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const checkout = git(["rev-parse", "HEAD"]);
  if (commit !== undefined && commit !== checkout) throw new Error("Runtime build commit does not match the checkout.");
  const directory = path.join(repoRoot, "apps/server/dist");
  if (!fs.statSync(path.join(directory, "index.js")).isFile()) throw new Error("Build the server before recording its runtime identity.");
  const artifacts = {};
  for (const relative of fs.readdirSync(directory, { recursive: true }).filter(name => name.endsWith(".js")).sort()) {
    if (!fs.lstatSync(path.join(directory, relative)).isFile()) throw new Error("Runtime JavaScript artifacts must be regular files.");
    artifacts[relative] = sha256(fs.readFileSync(path.join(directory, relative)));
  }
  const receipt = {
    version: 1, commit: checkout, builtAt: new Date().toISOString(),
    sourceDirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
    nodeVersion: process.version,
    lockSha256: sha256(fs.readFileSync(path.join(repoRoot, "package-lock.json"))),
    artifactSha256: sha256(JSON.stringify(artifacts)), artifacts
  };
  const temporary = path.join(directory, `.runtime-build-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, "runtime-build.json"));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return receipt;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeRuntimeBuild();
