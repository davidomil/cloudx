import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { InstallerRunner, activateManagedServices } from "./install-cloudx.mjs";
import { parseEnvironmentFile, updateEnvironmentFile } from "./installer-environment.mjs";
import { terminalSocketPath } from "../apps/server/src/terminal/DurableTerminalProcess.ts";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const temporary = [];
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.skipIf(!fs.existsSync(path.join(sourceRoot, "apps/server/dist/config.js"))).each(["default", "custom"])("keeps the %s profile, selected Codex, TLS and terminal identities when loading activated staged modules", profile => {
  const home = fs.mkdtempSync(path.join(sourceRoot, "node_modules/.cloudx-managed-profile-")); temporary.push(home);
  const repoRoot = path.join(home, "checkout"), releaseRoot = path.join(home, "release");
  const dataDir = profile === "default" ? path.join(repoRoot, ".cloudx") : path.join(home, "custom profile");
  const envPath = path.join(home, ".config/cloudx/cloudx.env");
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const prefix = path.join(home, "codex-prefix");
  const assistantBin = path.join(prefix, "bin/codex");
  const selectedBin = path.join(prefix, ".cloudx-codex/installs/11111111-1111-4111-8111-111111111111/bin/codex");
  const packageDir = path.join(path.dirname(path.dirname(selectedBin)), "lib/node_modules/@openai/codex");
  fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  fs.mkdirSync(path.dirname(selectedBin), { recursive: true });
  fs.mkdirSync(path.dirname(assistantBin), { recursive: true });
  fs.writeFileSync(assistantBin, "retained original process dependency");
  fs.writeFileSync(path.join(packageDir, "bin/codex.js"), "selected process dependency", { mode: 0o755 });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.155.1", bin: { codex: "bin/codex.js" } }));
  fs.symlinkSync(path.join(packageDir, "bin/codex.js"), selectedBin);
  const selectionPath = path.join(prefix, ".cloudx-codex-selection.json");
  const selection = JSON.stringify({ schemaVersion: 1, active: { version: "0.155.1", assistantBin: selectedBin }, previous: null });
  fs.writeFileSync(selectionPath, selection);
  const envConfig = { CLOUDX_PORT: "3443", CLOUDX_ASSISTANT_BIN: assistantBin, ...(profile === "custom" ? { CLOUDX_DATA_DIR: dataDir } : {}) };
  fs.writeFileSync(envPath, updateEnvironmentFile("# Saved configuration\nPRIVATE_SETTING=retained\n", envConfig));
  fs.mkdirSync(path.join(dataDir, "certs"), { recursive: true });
  for (const file of ["cloudx-local.key", "cloudx-local.crt"]) fs.writeFileSync(path.join(dataDir, "certs", file), "saved TLS");
  const saved = { version: 1, sessions: [{ tab: { id: "original-shell", pluginId: "standard-terminal", title: "Original shell",
    cwd: repoRoot, createdAt: "then", updatedAt: "now", status: "running", indicator: { color: "green", label: "Running", updatedAt: "now" } } }] };
  fs.writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify(saved));
  fs.cpSync(path.join(sourceRoot, "apps/server/dist"), path.join(releaseRoot, "apps/server/dist"), { recursive: true });
  fs.mkdirSync(path.join(releaseRoot, "scripts"));
  for (const file of ["codex-updater.mjs", "codex-selection.mjs"]) fs.copyFileSync(path.join(sourceRoot, "scripts", file), path.join(releaseRoot, "scripts", file));
  fs.writeFileSync(path.join(releaseRoot, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(sourceRoot, "node_modules"), path.join(releaseRoot, "node_modules"));
  fs.mkdirSync(path.join(repoRoot, "apps/server"), { recursive: true });
  fs.symlinkSync(path.join(releaseRoot, "apps/server/dist"), path.join(repoRoot, "apps/server/dist"));
  const coordinator = path.join(home, "coordinator");
  const runtimeLaunch = { script: path.join(coordinator, "scripts/managed-runtime-launch.mjs"), buildFile: path.join(releaseRoot, "apps/server/dist/runtime-build.json"), receiptFile: path.join(home, "receipt.json") };
  activateManagedServices({ repoRoot, releaseRoot, home, envConfig, runtimeLaunch,
    runner: new InstallerRunner({ cwd: repoRoot, log() {} }) });
  const activatedEnv = parseEnvironmentFile(fs.readFileSync(envPath, "utf8"));
  expect(activatedEnv.CLOUDX_DATA_DIR).toBe(dataDir);
  expect(activatedEnv.CLOUDX_INSTALL_ROOT).toBe(repoRoot);
  expect(activatedEnv.CLOUDX_UPDATE_COORDINATOR_ROOT).toBe(coordinator);
  expect(activatedEnv.PRIVATE_SETTING).toBe("retained");
  expect(activatedEnv.CLOUDX_ASSISTANT_BIN).toBe(assistantBin);
  expect(fs.readFileSync(selectionPath, "utf8")).toBe(selection);
  expect(fs.readFileSync(assistantBin, "utf8")).toBe("retained original process dependency");
  expect(fs.readFileSync(selectedBin, "utf8")).toBe("selected process dependency");

  const inspected = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { loadConfig } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "apps/server/dist/config.js")).href)};
    import { terminalSocketPath } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "apps/server/dist/terminal/DurableTerminalProcess.js")).href)};
    import { SessionStateStore } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "apps/server/dist/workspace/SessionStateStore.js")).href)};
    import { resolveAssistantCommand } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "apps/server/dist/terminal/ShellLaunch.js")).href)};
    const config = loadConfig(JSON.parse(process.argv[1]));
    console.log(JSON.stringify({ assistantBin: resolveAssistantCommand(JSON.parse(process.argv[1])), dataDir: config.dataDir, https: config.https, socket: terminalSocketPath(config.dataDir), sessions: await new SessionStateStore(config.dataDir).read() }));
  `, JSON.stringify(activatedEnv)], { encoding: "utf8" }));
  expect(inspected.dataDir).toBe(dataDir);
  expect(inspected.assistantBin).toBe(selectedBin);
  expect(inspected.https).toEqual({ keyPath: path.join(dataDir, "certs/cloudx-local.key"), certPath: path.join(dataDir, "certs/cloudx-local.crt") });
  expect(inspected.sessions).toEqual(saved);
  expect(inspected.socket).toBe(terminalSocketPath(dataDir));
  expect(fs.existsSync(path.join(releaseRoot, ".cloudx"))).toBe(false);
}, 15_000);
