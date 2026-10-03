import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGED_INTEGRATION_SOURCE_FILES } from "./managed-update-integration.mjs";
import { bundleCoordinator, verifySnapshot } from "./managed-update-store.mjs";
import { COORDINATOR_SCRIPT_FILES } from "./update-coordinator-files.mjs";

export const COORDINATOR_FILES = [...COORDINATOR_SCRIPT_FILES, ...MANAGED_INTEGRATION_SOURCE_FILES];

export function stageInstalledUpdater(sourceRoot, releaseRoot = sourceRoot) {
  const destination = path.join(releaseRoot, "apps/server/dist/updater");
  fs.rmSync(destination, { recursive: true, force: true });
  bundleCoordinator(sourceRoot, destination, COORDINATOR_FILES);
  verifySnapshot(destination, JSON.parse(fs.readFileSync(path.join(destination, "bundle.json"), "utf8")));
  return destination;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  stageInstalledUpdater(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
