import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MISSING_SETTINGS_FILES, prepareMissingSettingsIntegration } from "./managed-update-settings-integration.mjs";
import { SESSION_INTEGRATION_FILES, SESSION_PERSISTENCE_FILES, prepareSessionIntegration } from "./managed-update-session-integration.mjs";

const SETTINGS_FILES = [
  "apps/server/src/system/CloudxUpdateService.ts",
  "apps/server/src/system/CloudxUpdateCatalog.ts",
  "apps/server/src/system/CloudxUpdateRoutes.ts",
  "apps/server/src/system/RuntimeBuild.ts",
  "packages/shared/src/cloudxUpdate.ts",
  "apps/web/src/ui/CloudxUpdatePanel.tsx",
  // Historical builds typecheck these fixtures with the maintained contracts.
  "apps/server/src/system/CloudxUpdateService.test.ts",
  "apps/server/src/system/CloudxUpdateRoutes.test.ts",
  "apps/web/src/ui/SettingsDialog.navigation.test.ts",
  "apps/web/src/cloudxUpdateApi.ts",
];
const READINESS_FILE = "apps/server/src/terminal/TerminalReadiness.ts";
const LEGACY_READINESS_SOURCE = "scripts/managed-update-readiness-legacy.ts";
const TERMINAL_CONTRACT_FILE = "apps/server/src/terminal/TerminalProcess.ts";
const SERVER_FILE = "apps/server/src/server.ts";
const LEGACY_SETTINGS_CONTRACT = 'Pick<CloudxUpdateService, "status" | "start">';
const MANAGED_SETTINGS_CONTRACT = 'Pick<CloudxUpdateService, "status" | "start" | "preview" | "selectChannel">';
export const MANAGED_INTEGRATION_SOURCE_FILES = [...SETTINGS_FILES, READINESS_FILE, LEGACY_READINESS_SOURCE,
  "scripts/managed-update-settings-integration.mjs", "scripts/managed-update-session-integration.mjs", ...SESSION_PERSISTENCE_FILES];
export const MANAGED_INTEGRATION_FILES = [...new Set([...SETTINGS_FILES, READINESS_FILE, ...MISSING_SETTINGS_FILES,
  ...SESSION_INTEGRATION_FILES, ...SESSION_PERSISTENCE_FILES])];

// The updater remains maintained independently of the selected application.
// Build these small integrations with the target's own dependencies and APIs.
export function prepareManagedIntegration(release, coordinator = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const files = [];
  const service = integrationPath(release, SETTINGS_FILES[0]);
  const server = integrationPath(release, SERVER_FILE);
  const serverSource = fs.existsSync(server) ? fs.readFileSync(server, "utf8") : "";
  let migrated = {};
  if (fs.existsSync(server) && !fs.existsSync(service)) {
    migrated = prepareMissingSettingsIntegration(relative => fs.readFileSync(integrationPath(release, relative), "utf8"));
    files.push(...SETTINGS_FILES.filter(file => file !== "apps/web/src/ui/SettingsDialog.navigation.test.ts"), ...MISSING_SETTINGS_FILES);
  } else if (fs.existsSync(service) && !fs.readFileSync(service, "utf8").includes("CLOUDX_UPDATE_COORDINATOR_ROOT")) {
    files.push(...SETTINGS_FILES);
    if (serverSource.includes(LEGACY_SETTINGS_CONTRACT)) {
      migrated[SERVER_FILE] = serverSource.replace(LEGACY_SETTINGS_CONTRACT, MANAGED_SETTINGS_CONTRACT);
      files.push(SERVER_FILE);
    } else if (!serverSource.includes(MANAGED_SETTINGS_CONTRACT)) {
      throw new Error("Managed updater integration does not recognize the target server's Settings contract.");
    }
  }
  const independentReadiness = fs.existsSync(server) && !serverSource.includes("/api/ready/terminals");
  const readiness = independentReadiness ? inspectTerminalReadiness(release) : undefined;
  if (independentReadiness) files.push(READINESS_FILE);
  const sessionRecovery = readiness?.terminalMode === "direct" && fs.existsSync(integrationPath(release, "apps/server/src/sessionStore.ts")) &&
    !fs.existsSync(integrationPath(release, SESSION_PERSISTENCE_FILES[0]));
  if (sessionRecovery) {
    Object.assign(migrated, prepareSessionIntegration(relative => migrated[relative] ?? fs.readFileSync(integrationPath(release, relative), "utf8")));
    files.push(...SESSION_INTEGRATION_FILES, ...SESSION_PERSISTENCE_FILES);
  }
  const uniqueFiles = [...new Set(files)];
  const changes = uniqueFiles.map(relative => {
    const destination = integrationPath(release, relative);
    // A migration must not hide an operator's edits to its integration files.
    const local = execFileSync("git", ["status", "--porcelain", "--", relative], { cwd: release, encoding: "utf8" });
    if (local.trim()) throw new Error(`Managed updater integration conflicts with local changes to ${relative}. Preserve those changes before resuming.`);
    if (Object.hasOwn(migrated, relative)) return { destination, content: migrated[relative] };
    const source = integrationPath(coordinator, relative === READINESS_FILE ? readiness.source : relative);
    if (!fs.existsSync(source)) throw new Error(`Managed updater integration is missing: ${relative}`);
    return { destination, content: fs.readFileSync(source) };
  });
  for (const { destination, content } of changes) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  return { version: 1, files: uniqueFiles, independentReadiness, ...(readiness?.terminalMode === "direct" ? { terminalMode: "direct" } : {}),
    ...(sessionRecovery ? { sessionRecovery: "saved-tabs-v1" } : {}) };
}

export function inspectTerminalReadiness(release) {
  const source = fs.readFileSync(integrationPath(release, TERMINAL_CONTRACT_FILE), "utf8");
  const options = source.match(/export interface TerminalSpawnOptions\s*\{([^}]+)\}/)?.[1].replace(/\s/g, "");
  const supervisedOptions = "cwd:string;env:NodeJS.ProcessEnv;cols:number;rows:number;sessionId?:string;";
  if (!source.includes("terminate(): Promise<void>"))
    throw new Error("Managed readiness requires the target's supervised terminal shutdown contract.");
  if (recognizesDirectTerminalContract(source) &&
      !fs.existsSync(integrationPath(release, "apps/server/src/terminal/DurableTerminalProcess.ts")))
    return { source: LEGACY_READINESS_SOURCE, terminalMode: "direct" };
  if (options === supervisedOptions) return { source: LEGACY_READINESS_SOURCE, terminalMode: "broker" };
  if (options === `${supervisedOptions}execution?:TerminalExecutionBinding;`) return { source: READINESS_FILE, terminalMode: "broker" };
  throw new Error("Managed updater integration does not recognize the target terminal spawn contract.");
}

export function recognizesDirectTerminalContract(source) {
  const inlineOptions = source.match(/spawn\(command: string, args: string\[\], options: \{([^}]+)\}\): Promise<TerminalProcess>;/)?.[1].replace(/\s/g, "");
  return source.includes("terminate(): Promise<void>") && inlineOptions === "cwd:string;env:NodeJS.ProcessEnv;cols:number;rows:number";
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
