import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SETTINGS_FILES = [
  "apps/server/src/system/CloudxUpdateService.ts",
  "apps/server/src/system/CloudxUpdateRoutes.ts",
  "apps/server/src/system/RuntimeBuild.ts",
  "packages/shared/src/cloudxUpdate.ts",
  "apps/web/src/ui/CloudxUpdatePanel.tsx",
  // Historical web builds typecheck the Settings fixture with its controller.
  "apps/web/src/ui/SettingsDialog.navigation.test.ts",
  "apps/web/src/cloudxUpdateApi.ts",
];
const READINESS_FILE = "apps/server/src/terminal/TerminalReadiness.ts";
export const MANAGED_INTEGRATION_FILES = [...SETTINGS_FILES, READINESS_FILE];

// The updater remains maintained independently of the selected application.
// Build these small integrations with the target's own dependencies and APIs.
export function prepareManagedIntegration(release, coordinator = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const files = [];
  const service = integrationPath(release, SETTINGS_FILES[0]);
  if (fs.existsSync(service) && !fs.readFileSync(service, "utf8").includes("CLOUDX_UPDATE_COORDINATOR_ROOT")) {
    files.push(...SETTINGS_FILES);
  }
  const server = integrationPath(release, "apps/server/src/server.ts");
  const independentReadiness = fs.existsSync(server) && !fs.readFileSync(server, "utf8").includes("/api/ready/terminals");
  if (independentReadiness) files.push(READINESS_FILE);
  for (const relative of files) {
    const destination = integrationPath(release, relative);
    // A migration must not hide an operator's edits to its integration files.
    const local = execFileSync("git", ["status", "--porcelain", "--", relative], { cwd: release, encoding: "utf8" });
    if (local.trim()) throw new Error(`Managed updater integration conflicts with local changes to ${relative}. Preserve those changes before resuming.`);
    const source = integrationPath(coordinator, relative);
    if (!fs.existsSync(source)) throw new Error(`Managed updater integration is missing: ${relative}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return { version: 1, files, independentReadiness };
}

function integrationPath(root, relative) {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root) throw new Error("Managed integration requires a real absolute root.");
  const parts = relative.split("/");
  let file = root;
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
      throw new Error(`Managed integration cannot follow links or special files: ${relative}`);
  }
  return file;
}
