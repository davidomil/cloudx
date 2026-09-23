import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hashFile, writeUpdateJson } from "./managed-update-store.mjs";

export async function launchManagedRuntime({ entry, buildFile, receiptFile }) {
  if (![entry, buildFile, receiptFile].every(file => typeof file === "string" && path.isAbsolute(file)))
    throw new Error("Managed runtime entry, prepared build manifest, and runtime receipt must be absolute paths.");
  const directory = fs.realpathSync(path.dirname(entry));
  const receiptPath = path.join(fs.realpathSync(path.dirname(receiptFile)), path.basename(receiptFile));
  const manifestPath = path.join(fs.realpathSync(path.dirname(buildFile)), path.basename(buildFile));
  if (path.basename(entry) !== "index.js" || receiptPath === manifestPath || inside(directory, receiptPath))
    throw new Error("The runtime receipt must be separate from the prepared manifest and executable artifacts.");
  const previous = fs.lstatSync(receiptFile, { throwIfNoEntry: false });
  if (previous && (!previous.isFile() || previous.uid !== process.getuid()))
    throw new Error("The runtime receipt must be an owned regular file.");
  fs.rmSync(receiptFile, { force: true });
  const manifest = readBuildManifest(buildFile);
  verifyRuntimeArtifacts(directory, manifest);
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const { artifacts, ...build } = manifest;
  const receipt = {
    version: 1, verified: true, verification: "verified", commit: build.commit,
    artifactSha256: build.artifactSha256, build, pid: process.pid,
    processStarted: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
    bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    invocationId: process.env.INVOCATION_ID ?? null,
  };
  process.env.CLOUDX_INSTALL_ROOT = path.resolve(path.dirname(entry), "../../..");
  await import(pathToFileURL(entry).href);
  verifyRuntimeArtifacts(directory, manifest);
  writeUpdateJson(receiptFile, receipt);
  return receipt;
}

function readBuildManifest(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error("The prepared runtime build manifest must be a regular file.");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!manifest || manifest.version !== 1 || !/^[a-f0-9]{40}$/.test(manifest.commit)
    || typeof manifest.builtAt !== "string" || !Number.isFinite(Date.parse(manifest.builtAt))
    || typeof manifest.sourceDirty !== "boolean" || manifest.nodeVersion !== process.version
    || !isDigest(manifest.lockSha256) || !isDigest(manifest.artifactSha256)
    || !manifest.artifacts || typeof manifest.artifacts !== "object" || Array.isArray(manifest.artifacts)
    || !Object.hasOwn(manifest.artifacts, "index.js")
    || !Object.entries(manifest.artifacts).every(([relative, digest]) =>
      relative.endsWith(".js") && !path.isAbsolute(relative) && relative.split(/[\\/]/).every(part => part !== ".." && part !== "." && part !== "") && isDigest(digest)))
    throw new Error("The prepared runtime build manifest is invalid or uses a different Node runtime.");
  if (createHash("sha256").update(JSON.stringify(manifest.artifacts)).digest("hex") !== manifest.artifactSha256)
    throw new Error("The prepared runtime artifact manifest digest does not match.");
  return manifest;
}

function verifyRuntimeArtifacts(directory, manifest) {
  if (hashFile(path.resolve(directory, "../../../package-lock.json")) !== manifest.lockSha256)
    throw new Error("The runtime dependency lock does not match the prepared build.");
  const expected = Object.keys(manifest.artifacts).sort();
  const actual = fs.readdirSync(directory, { recursive: true }).filter(relative => relative.endsWith(".js")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Runtime artifacts do not match the prepared inventory.");
  for (const [relative, digest] of Object.entries(manifest.artifacts)) {
    const file = path.join(directory, relative);
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file || hashFile(file) !== digest)
      throw new Error(`Runtime artifact does not match its prepared build: ${relative}`);
  }
}

function isDigest(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function inside(root, file) { return file === root || file.startsWith(`${root}${path.sep}`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [entry, buildFile, receiptFile, ...extra] = process.argv.slice(2);
  try {
    if (extra.length) throw new Error("Usage: managed-runtime-launch.mjs <entry> <prepared manifest> <runtime receipt>");
    process.argv = [process.execPath, entry];
    await launchManagedRuntime({ entry, buildFile, receiptFile });
  } catch (error) {
    console.error(`CloudX runtime startup verification failed: ${error.message}`);
    process.exit(1);
  }
}
