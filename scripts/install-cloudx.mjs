#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const ASR_MODEL_ID = "Systran/faster-whisper-large-v3";
export const SERVICE_NAMES = ["cloudx-asr.service", "cloudx.service"];
export const UBUNTU_APT_PACKAGES = [
  "ca-certificates",
  "curl",
  "gnupg",
  "git",
  "build-essential",
  "python3",
  "python3-venv",
  "python3-pip",
  "openssl",
  "ripgrep"
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: false,
    answersPath: undefined,
    yes: false,
    noStart: false,
    uninstall: false,
    update: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--answers") {
      options.answersPath = argv[++index];
      if (!options.answersPath) {
        throw new Error("--answers requires a JSON file path.");
      }
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--no-start") {
      options.noStart = true;
    } else if (arg === "--uninstall") {
      options.uninstall = true;
    } else if (arg === "--update") {
      options.update = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown installer option: ${arg}`);
    }
  }
  if (options.uninstall && options.update) {
    throw new Error("--update cannot be combined with --uninstall.");
  }
  return options;
}

export function helpText() {
  return [
    "Cloudx installer wizard",
    "",
    "The shell bootstrap installs Ubuntu packages and Node.js/npm when needed.",
    "This Node wizard then installs Cloudx dependencies, Codex CLI, ASR,",
    "the Faster Whisper model, config files, and optional systemd user services.",
    "",
    "Usage: ./install.sh [options]",
    "       node scripts/install-cloudx.mjs [options]",
    "",
    "Options:",
    "  --update           Pull the latest checkout and update installed dependencies/services.",
    "  --uninstall        Remove Cloudx services and selected local install artifacts.",
    "  --dry-run          Print commands and planned file writes without changing the system.",
    "  --answers <json>   Read wizard answers from a JSON file.",
    "  --yes              Use defaults for prompts not supplied by --answers.",
    "  --no-start         Install services without starting them.",
    "  -h, --help         Show this help."
  ].join("\n");
}

export function parseOsRelease(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    values[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return values;
}

export function assertSupportedPlatform(osRelease) {
  if (osRelease.ID !== "ubuntu") {
    throw new Error(`Cloudx installer currently supports Ubuntu first. Detected: ${osRelease.PRETTY_NAME ?? osRelease.ID ?? "unknown OS"}.`);
  }
  const major = Number.parseInt(osRelease.VERSION_ID ?? "0", 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Cloudx installer supports Ubuntu 22.04 or newer. Detected: ${osRelease.VERSION_ID ?? "unknown version"}.`);
  }
}

export function parseNodeMajor(versionText) {
  const match = /v?(\d+)\./.exec(versionText.trim());
  return match ? Number.parseInt(match[1], 10) : 0;
}

export function needsNodeInstall(nodeVersionText, hasNpm) {
  return parseNodeMajor(nodeVersionText) < 22 || !hasNpm;
}

export function defaultCpuThreads(parallelism = defaultParallelism()) {
  return Math.max(1, Math.floor(parallelism / 2));
}

export function validateCpuThreads(value, parallelism = defaultParallelism()) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > parallelism) {
    throw new Error(`CPU threads must be an integer from 1 to ${parallelism}.`);
  }
  return parsed;
}

export function resolveDeviceConfig({ gpuDetected, useGpu, cudaRuntimeReady }) {
  if (useGpu && !gpuDetected) {
    throw new Error("GPU mode was requested, but no NVIDIA GPU was detected with nvidia-smi.");
  }
  if (useGpu && !cudaRuntimeReady) {
    throw new Error("GPU mode was requested, but CUDA/cuDNN runtime libraries were not detected. Install NVIDIA CUDA/cuDNN first or rerun with CPU mode.");
  }
  return useGpu ? { device: "cuda", computeType: "float16" } : { device: "cpu", computeType: "int8" };
}

export function buildEnvLines(config) {
  return [
    `CLOUDX_HOST=${config.host}`,
    `CLOUDX_PORT=${config.port}`,
    `CLOUDX_ALLOWED_ROOTS=${config.allowedRoots}`,
    `CLOUDX_DATA_DIR=${config.dataDir}`,
    `CLOUDX_ASR_URL=http://127.0.0.1:7810`,
    `CLOUDX_ASR_MODEL_PATH=${config.modelDir}`,
    `CLOUDX_ASR_DEVICE=${config.device}`,
    `CLOUDX_ASR_COMPUTE_TYPE=${config.computeType}`,
    `CLOUDX_ASR_LANGUAGE=${config.language}`,
    `CLOUDX_ASR_CPU_THREADS=${config.cpuThreads}`,
    `CLOUDX_ASR_NUM_WORKERS=1`,
    `CLOUDX_VOICE_DEBUG_TRANSCRIPTS=false`,
    ""
  ];
}

export function renderEnvFile(config) {
  return buildEnvLines(config).join("\n");
}

export function renderAsrService({ repoRoot: root, envPath, uvicornPath, asrDir }) {
  return [
    "[Unit]",
    "Description=Cloudx local Faster Whisper ASR",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${root}`,
    `EnvironmentFile=${envPath}`,
    `ExecStart=${uvicornPath} cloudx_asr.main:app --app-dir ${path.join(asrDir, "src")} --host 127.0.0.1 --port 7810`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

export function renderCloudxService({ repoRoot: root, envPath, nodePath, npmPath }) {
  return [
    "[Unit]",
    "Description=Cloudx web workbench",
    "After=network-online.target cloudx-asr.service",
    "Wants=cloudx-asr.service",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${root}`,
    `EnvironmentFile=${envPath}`,
    `ExecStartPre=${nodePath} ${path.join(root, "scripts/create-local-cert.mjs")}`,
    `ExecStart=${npmPath} run start -w @cloudx/server`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillSignal=SIGINT",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

export function ubuntuBootstrapPlan({ nodeVersionText = "", hasNpm = false } = {}) {
  const commands = [
    ["sudo", "apt-get", "update"],
    ["sudo", "apt-get", "install", "-y", ...UBUNTU_APT_PACKAGES]
  ];
  if (needsNodeInstall(nodeVersionText, hasNpm)) {
    commands.push(["sh", "-lc", "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"]);
    commands.push(["sudo", "apt-get", "install", "-y", "nodejs"]);
  }
  return commands;
}

export function cloudxAccessUrls(port, networkInterfaces = os.networkInterfaces()) {
  const urls = [`https://127.0.0.1:${port}`];
  for (const addresses of Object.values(networkInterfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`https://${address.address}:${port}`);
      }
    }
  }
  return [...new Set(urls)];
}

export class InstallerRunner {
  constructor({ dryRun = false, cwd = repoRoot, log = console.log } = {}) {
    this.dryRun = dryRun;
    this.cwd = cwd;
    this.log = log;
    this.commands = [];
    this.writes = [];
  }

  run(command, args = [], options = {}) {
    const display = formatCommand(command, args, options);
    this.commands.push({ command, args, cwd: options.cwd ?? this.cwd });
    this.log(`$ ${display}`);
    if (this.dryRun) {
      return "";
    }
    try {
      execFileSync(command, args, {
        cwd: options.cwd ?? this.cwd,
        stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
        encoding: options.capture ? "utf8" : undefined,
        env: options.env ? { ...process.env, ...options.env } : process.env
      });
    } catch (error) {
      if (options.allowFailure) {
        this.log(`command failed but continuing: ${display}`);
        return "";
      }
      throw error;
    }
    return "";
  }

  capture(command, args = [], options = {}) {
    if (this.dryRun) {
      this.commands.push({ command, args, cwd: options.cwd ?? this.cwd, capture: true });
      this.log(`$ ${[command, ...args].join(" ")}`);
      return "";
    }
    return execFileSync(command, args, {
      cwd: options.cwd ?? this.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: options.env ? { ...process.env, ...options.env } : process.env
    }).trim();
  }

  writeFile(filePath, contents) {
    this.writes.push({ path: filePath, contents });
    this.log(`write ${filePath}`);
    if (this.dryRun) {
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  mkdir(dirPath) {
    this.log(`mkdir -p ${dirPath}`);
    if (!this.dryRun) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  removePath(targetPath, options = {}) {
    this.commands.push({ command: "rm", args: ["-rf", targetPath], cwd: this.cwd, remove: true });
    this.log(`remove ${targetPath}`);
    if (this.dryRun) {
      return;
    }
    fs.rmSync(targetPath, { recursive: true, force: true, ...options });
  }
}

export async function runInstaller(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const home = options.home ?? os.homedir();
  const answers = options.answers ?? {};
  const yes = options.yes ?? false;
  const dryRun = options.dryRun ?? false;
  const runner = options.runner ?? new InstallerRunner({ dryRun, cwd: root });
  const prompt = createPrompter({ answers, yes, dryRun, input: options.input, output: options.output });
  const osRelease = options.osRelease ?? parseOsRelease(readText("/etc/os-release", "ID=unknown\n"));
  assertSupportedPlatform(osRelease);
  const networkInterfaces = options.networkInterfaces ?? os.networkInterfaces();

  const paths = installerPaths({ repoRoot: root, home });
  const commands = commandMap(runner);
  if (options.uninstall) {
    return await runUninstaller({ paths, commands, runner, prompt, dryRun });
  }
  if (options.update) {
    return await runUpdater({ paths, commands, runner, prompt, noStart: options.noStart, networkInterfaces });
  }
  const gpuDetected = options.gpuDetected ?? commands.exists("nvidia-smi");
  const cudaRuntimeReady = options.cudaRuntimeReady ?? detectCudaRuntime(commands);
  const parallelism = options.parallelism ?? defaultParallelism();
  const defaultThreads = defaultCpuThreads(parallelism);

  section("Cloudx installer wizard");
  console.log(`Ubuntu target: ${osRelease.PRETTY_NAME ?? osRelease.VERSION_ID ?? "unknown"}`);
  console.log(`Repository: ${root}`);
  console.log(`Configuration file: ${paths.envPath}`);
  console.log(`ASR model directory: ${paths.modelDir}`);
  console.log(gpuDetected ? "NVIDIA GPU detected with nvidia-smi." : "No NVIDIA GPU detected with nvidia-smi; ASR will default to CPU.");
  if (gpuDetected && !cudaRuntimeReady) {
    console.log("CUDA/cuDNN runtime libraries were not detected, so GPU mode will fail unless they are installed first.");
  }

  section("1/7 Verify Codex CLI");
  await ensureCodex(commands, prompt);

  section("2/7 Collect install choices");
  explainQuestion(
    "Allowed workspace roots",
    "Cloudx can open terminals and files only under these roots. Use ':' to separate multiple roots on Linux, for example '~:/srv/projects'."
  );
  const allowedRoots = await prompt.text("allowedRoots", "Allowed workspace roots", "~");
  explainQuestion("Cloudx HTTPS port", "This is the HTTPS port for the web UI. Keep 3001 unless it is already in use.");
  const port = await prompt.integer("port", "Cloudx HTTPS port", 3001, { min: 1, max: 65_535 });
  explainQuestion(
    "Additional certificate hostnames",
    "Optional names or IPs to include in the generated local certificate, useful for phone or LAN access. Leave blank for localhost and detected local addresses."
  );
  const certHosts = await prompt.text("certificateHosts", "Additional certificate hostnames (comma-separated, blank for none)", "");
  explainQuestion("ASR CPU threads", "Controls how many CPU threads Faster Whisper may use. More threads can improve transcription speed but leaves fewer cores for Codex and builds.");
  const cpuThreads = validateCpuThreads(await prompt.integer("cpuThreads", "ASR CPU threads", defaultThreads, { min: 1, max: parallelism }), parallelism);
  if (gpuDetected) {
    explainQuestion("Use detected NVIDIA GPU", "GPU ASR is faster, but this installer only configures it. CUDA/cuDNN runtime libraries must already be installed.");
  }
  const useGpu = gpuDetected ? await prompt.boolean("useGpu", "NVIDIA GPU detected. Use it for ASR?", false) : false;
  const device = resolveDeviceConfig({ gpuDetected, useGpu, cudaRuntimeReady });
  explainQuestion("Install systemd services", "Writes user-level services so Cloudx and ASR can run in the background instead of being started manually.");
  const installServices = await prompt.boolean("installServices", "Install Cloudx user-level systemd services?", true);
  if (installServices) {
    explainQuestion("Start services now", "Restarts Cloudx and ASR immediately after writing the unit files, then verifies both health endpoints.");
  }
  const startServices = installServices ? !options.noStart && (await prompt.boolean("startServices", "Start Cloudx services after install?", true)) : false;
  if (installServices) {
    explainQuestion("Enable linger", "Lets the user-level services keep running after logout and start before the next interactive login. This uses sudo loginctl enable-linger.");
  }
  const enableLinger = installServices ? await prompt.boolean("enableLinger", "Enable user lingering so services survive logout and can start before login?", true) : false;
  printChoiceSummary({
    allowedRoots,
    port,
    certHosts,
    cpuThreads,
    device,
    installServices,
    startServices,
    enableLinger
  });

  section("3/7 Install Cloudx npm dependencies");
  commands.run("npm", ["ci"]);
  section("4/7 Prepare ASR Python environment and model");
  setupAsr(commands, paths);
  downloadModel(commands, paths);
  section("5/7 Build Cloudx and create HTTPS certificate");
  commands.run("npm", ["run", "build"]);
  commands.run("npm", ["run", "cert:create"], {
    env: certHosts.trim() ? { CLOUDX_CERT_HOSTS: certHosts.trim() } : undefined
  });

  const envConfig = {
    host: "0.0.0.0",
    port,
    allowedRoots,
    dataDir: paths.dataDir,
    modelDir: paths.modelDir,
    language: "en",
    cpuThreads,
    ...device
  };
  section("6/7 Write Cloudx configuration");
  runner.writeFile(paths.envPath, renderEnvFile(envConfig));

  if (installServices) {
    section("7/7 Install user-level systemd services");
    installSystemdServices(commands, runner, paths);
    if (enableLinger) {
      commands.run("sudo", ["loginctl", "enable-linger", os.userInfo().username]);
    }
    commands.run("systemctl", ["--user", "daemon-reload"]);
    commands.run("systemctl", ["--user", "enable", ...SERVICE_NAMES]);
    if (startServices) {
      commands.run("systemctl", ["--user", "restart", ...SERVICE_NAMES]);
      verifyServices(commands, port);
    }
  } else {
    section("7/7 Skip systemd service installation");
    console.log("Cloudx was configured for manual startup with npm run dev.");
  }

  await prompt.close();
  printInstallComplete({ paths, port, installServices, startServices, networkInterfaces });
  return { runner, paths, envConfig, installServices, startServices, enableLinger, urls: cloudxAccessUrls(port, networkInterfaces) };
}

async function runUninstaller({ paths, commands, runner, prompt }) {
  section("Cloudx uninstall wizard");
  console.log("This removes Cloudx-managed local artifacts. It does not remove Node.js, npm, Python, apt packages, or Codex CLI.");
  console.log(`Repository: ${paths.repoRoot}`);
  console.log(`Configuration file: ${paths.envPath}`);
  console.log(`ASR model directory: ${paths.modelDir}`);

  explainQuestion("Remove services", "Stops, disables, and deletes the two user-level systemd units. Choose yes if Cloudx was installed as a background service.");
  const removeServices = await prompt.boolean("removeServices", "Stop, disable, and remove Cloudx user-level systemd services?", true);
  explainQuestion("Remove config", "Deletes ~/.config/cloudx/cloudx.env, which contains the port, roots, ASR model path, and CPU/GPU settings written by the installer.");
  const removeConfig = await prompt.boolean("removeConfig", "Remove Cloudx environment config?", true);
  explainQuestion("Remove ASR virtualenv", "Deletes services/asr/.venv. This frees local Python packages installed for ASR and tests.");
  const removeVenv = await prompt.boolean("removeVenv", "Remove ASR Python virtualenv?", true);
  explainQuestion("Remove runtime data", "Deletes the repo-local .cloudx directory, including generated HTTPS certificates and workspace runtime state.");
  const removeRuntimeData = await prompt.boolean("removeRuntimeData", "Remove local runtime data and generated HTTPS certificates in .cloudx?", false);
  explainQuestion("Remove ASR model", "Deletes the downloaded Faster Whisper large-v3 model cache. Keeping it avoids another large download later.");
  const removeModel = await prompt.boolean("removeModel", "Remove downloaded Faster Whisper large-v3 model?", false);
  explainQuestion("Remove node_modules", "Deletes installed npm packages from this checkout. Keeping it makes future development starts faster.");
  const removeNodeModules = await prompt.boolean("removeNodeModules", "Remove repo node_modules?", false);
  explainQuestion("Disable linger", "Turns off systemd linger for this Linux user. Only choose yes if you do not rely on other user services surviving logout.");
  const disableLinger = await prompt.boolean("disableLinger", "Disable systemd linger for this user?", false);
  printUninstallSummary({ removeServices, removeConfig, removeVenv, removeRuntimeData, removeModel, removeNodeModules, disableLinger });

  if (removeServices) {
    section("1/6 Remove user-level systemd services");
    commands.run("systemctl", ["--user", "stop", ...SERVICE_NAMES], { allowFailure: true });
    commands.run("systemctl", ["--user", "disable", ...SERVICE_NAMES], { allowFailure: true });
    runner.removePath(path.join(paths.systemdDir, "cloudx.service"));
    runner.removePath(path.join(paths.systemdDir, "cloudx-asr.service"));
    commands.run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
    commands.run("systemctl", ["--user", "reset-failed", ...SERVICE_NAMES], { allowFailure: true });
  } else {
    section("1/6 Keep systemd services");
  }

  section("2/6 Remove configuration");
  if (removeConfig) {
    runner.removePath(paths.envPath);
  } else {
    console.log("Keeping Cloudx environment config.");
  }

  section("3/6 Remove local environments and caches");
  if (removeVenv) {
    runner.removePath(paths.venvDir);
  } else {
    console.log("Keeping ASR Python virtualenv.");
  }
  if (removeNodeModules) {
    runner.removePath(path.join(paths.repoRoot, "node_modules"));
  } else {
    console.log("Keeping node_modules.");
  }

  section("4/6 Remove runtime data and models");
  if (removeRuntimeData) {
    runner.removePath(paths.dataDir);
  } else {
    console.log("Keeping .cloudx runtime data and generated HTTPS certificates.");
  }
  if (removeModel) {
    runner.removePath(paths.modelDir);
  } else {
    console.log("Keeping downloaded Faster Whisper model.");
  }

  section("5/6 Linger setting");
  if (disableLinger) {
    commands.run("sudo", ["loginctl", "disable-linger", os.userInfo().username]);
  } else {
    console.log("Leaving systemd linger unchanged.");
  }

  section("6/6 Uninstall complete");
  console.log("Cloudx uninstall complete.");
  await prompt.close();
  return { runner, paths, removed: { removeServices, removeConfig, removeVenv, removeRuntimeData, removeModel, removeNodeModules, disableLinger } };
}

async function runUpdater({ paths, commands, runner, prompt, noStart, networkInterfaces }) {
  section("Cloudx update wizard");
  console.log("This updates an existing Cloudx checkout and local install. It keeps your saved Cloudx environment config.");
  console.log(`Repository: ${paths.repoRoot}`);
  console.log(`Configuration file: ${paths.envPath}`);
  console.log(`ASR model directory: ${paths.modelDir}`);

  const envConfig = readEnvFile(paths.envPath);
  const port = Number.parseInt(envConfig.CLOUDX_PORT ?? "3001", 10);
  const servicesInstalled = SERVICE_NAMES.every((serviceName) => fs.existsSync(path.join(paths.systemdDir, serviceName)));

  section("1/8 Pull latest Cloudx checkout");
  if (process.env.CLOUDX_INSTALL_ALREADY_PULLED === "1") {
    console.log("Checkout was already pulled by install.sh.");
  } else {
    commands.run("git", ["pull", "--ff-only"]);
  }

  section("2/8 Update Codex CLI");
  await updateCodex(commands, prompt);

  section("3/8 Update Cloudx npm dependencies");
  commands.run("npm", ["ci"]);

  section("4/8 Update ASR Python environment and model");
  setupAsr(commands, paths);
  downloadModel(commands, paths);

  section("5/8 Rebuild Cloudx and refresh HTTPS certificate if missing");
  commands.run("npm", ["run", "build"]);
  commands.run("npm", ["run", "cert:create"]);

  section("6/8 Refresh installed systemd service files");
  if (servicesInstalled) {
    installSystemdServices(commands, runner, paths);
    commands.run("systemctl", ["--user", "daemon-reload"]);
  } else {
    console.log("Cloudx user services were not found, so service unit refresh is skipped.");
  }

  const restartServices =
    servicesInstalled &&
    !noStart &&
    (explainQuestion("Restart services", "Restarts Cloudx and ASR after dependencies and service files are updated, then verifies the health endpoints."),
    await prompt.boolean("restartServices", "Restart Cloudx services after update?", true));

  section("7/8 Restart services");
  if (restartServices) {
    commands.run("systemctl", ["--user", "restart", ...SERVICE_NAMES]);
    verifyServices(commands, port);
  } else if (servicesInstalled) {
    console.log("Services were refreshed but not restarted. Restart later with: systemctl --user restart cloudx-asr.service cloudx.service");
  } else {
    console.log("No installed services to restart.");
  }

  section("8/8 Update complete");
  printUpdateComplete({ paths, port, servicesInstalled, restartServices, networkInterfaces });
  await prompt.close();
  return { runner, paths, port, servicesInstalled, restartServices, urls: cloudxAccessUrls(port, networkInterfaces) };
}

function section(title) {
  console.log(`\n==> ${title}`);
}

function explainQuestion(title, detail) {
  console.log(`\n? ${title}`);
  console.log(`  ${detail}`);
}

function printChoiceSummary({ allowedRoots, port, certHosts, cpuThreads, device, installServices, startServices, enableLinger }) {
  console.log("Install choices:");
  console.log(`  allowed roots: ${allowedRoots}`);
  console.log(`  HTTPS port: ${port}`);
  console.log(`  certificate hosts: ${certHosts.trim() || "(default local hosts only)"}`);
  console.log(`  ASR device: ${device.device} (${device.computeType})`);
  console.log(`  ASR CPU threads: ${cpuThreads}`);
  console.log(`  install services: ${installServices ? "yes" : "no"}`);
  if (installServices) {
    console.log(`  start services now: ${startServices ? "yes" : "no"}`);
    console.log(`  enable linger: ${enableLinger ? "yes" : "no"}`);
  }
}

function printUninstallSummary(choices) {
  console.log("Uninstall choices:");
  for (const [key, value] of Object.entries(choices)) {
    console.log(`  ${key}: ${value ? "yes" : "no"}`);
  }
}

function printInstallComplete({ paths, port, installServices, startServices, networkInterfaces }) {
  const urls = cloudxAccessUrls(port, networkInterfaces);
  console.log("Cloudx installer complete.");
  console.log(`  env: ${paths.envPath}`);
  console.log(`  ASR model: ${paths.modelDir}`);
  console.log(startServices ? "  open Cloudx:" : "  after starting Cloudx, open:");
  for (const url of urls) {
    console.log(`    ${url}`);
  }
  if (installServices) {
    console.log("  status: systemctl --user status cloudx.service cloudx-asr.service");
  } else {
    console.log("  run: npm run dev");
  }
}

function printUpdateComplete({ paths, port, servicesInstalled, restartServices, networkInterfaces }) {
  const urls = cloudxAccessUrls(port, networkInterfaces);
  console.log("Cloudx update complete.");
  console.log(`  env: ${paths.envPath}`);
  console.log(`  ASR model: ${paths.modelDir}`);
  console.log(restartServices ? "  open Cloudx:" : "  after starting or restarting Cloudx, open:");
  for (const url of urls) {
    console.log(`    ${url}`);
  }
  if (servicesInstalled) {
    console.log("  status: systemctl --user status cloudx.service cloudx-asr.service");
  } else {
    console.log("  run: npm run dev");
  }
}

function setupAsr(commands, paths) {
  console.log(`Creating or updating Python virtualenv: ${paths.venvDir}`);
  commands.run("python3", ["-m", "venv", "--upgrade-deps", paths.venvDir]);
  console.log("Installing Cloudx ASR, test dependencies, and Hugging Face CLI.");
  commands.run(paths.pipPath, ["install", "-e", `${paths.asrDir}[dev]`, "huggingface_hub[cli]"]);
}

function downloadModel(commands, paths) {
  if (fs.existsSync(path.join(paths.modelDir, "config.json"))) {
    console.log(`Faster Whisper large-v3 model already present at ${paths.modelDir}`);
    return;
  }
  console.log(`Downloading ${ASR_MODEL_ID} to ${paths.modelDir}.`);
  commands.mkdir(paths.modelDir);
  commands.run(paths.hfPath, ["download", ASR_MODEL_ID, "--local-dir", paths.modelDir]);
}

function installSystemdServices(commands, runner, paths) {
  console.log(`Writing user units to ${paths.systemdDir}.`);
  commands.mkdir(paths.systemdDir);
  runner.writeFile(
    path.join(paths.systemdDir, "cloudx-asr.service"),
    renderAsrService({
      repoRoot: paths.repoRoot,
      envPath: paths.envPath,
      uvicornPath: paths.uvicornPath,
      asrDir: paths.asrDir
    })
  );
  runner.writeFile(
    path.join(paths.systemdDir, "cloudx.service"),
    renderCloudxService({
      repoRoot: paths.repoRoot,
      envPath: paths.envPath,
      nodePath: commands.which("node"),
      npmPath: commands.which("npm")
    })
  );
}

function verifyServices(commands, port) {
  console.log("Verifying service enablement and health endpoints.");
  commands.run("systemctl", ["--user", "is-enabled", ...SERVICE_NAMES]);
  try {
    waitForHealth(commands, {
      label: "Cloudx web",
      url: `https://127.0.0.1:${port}/api/health`,
      insecure: true
    });
    waitForHealth(commands, {
      label: "Cloudx ASR",
      url: "http://127.0.0.1:7810/health"
    });
  } catch (error) {
    console.error("Service health verification failed. Recent service state follows.");
    commands.run("systemctl", ["--user", "status", ...SERVICE_NAMES, "--no-pager"], { allowFailure: true });
    commands.run("journalctl", ["--user", "-u", "cloudx.service", "-u", "cloudx-asr.service", "--since", "5 minutes ago", "--no-pager"], { allowFailure: true });
    throw error;
  }
}

function waitForHealth(commands, { label, url, insecure = false }) {
  console.log(`Waiting for ${label} health endpoint: ${url}`);
  const args = [
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    "5",
    "--retry",
    "30",
    "--retry-delay",
    "1",
    "--retry-connrefused"
  ];
  if (insecure) {
    args.push("--insecure");
  }
  args.push(url);
  commands.run("curl", args);
}

async function ensureCodex(commands, prompt) {
  if (!commands.exists("codex")) {
    console.log("Codex CLI was not found. Installing @openai/codex globally with npm.");
    commands.run("npm", ["i", "-g", "@openai/codex@latest"]);
  } else {
    console.log("Codex CLI is already on PATH.");
  }
  commands.run("codex", ["--version"]);
  if (!commands.statusOk("codex", ["login", "status"])) {
    const loginNow = await prompt.boolean("runCodexLogin", "Codex is not authenticated. Run codex login now?", true);
    if (loginNow) {
      commands.run("codex", ["login"]);
      if (!commands.statusOk("codex", ["login", "status"])) {
        throw new Error("Codex login did not complete successfully.");
      }
    } else {
      throw new Error("Codex must be authenticated before Cloudx voice control and Codex tabs can work.");
    }
  }
}

async function updateCodex(commands, prompt) {
  console.log("Updating Codex CLI globally with npm.");
  commands.run("npm", ["i", "-g", "@openai/codex@latest"]);
  commands.run("codex", ["--version"]);
  if (!commands.statusOk("codex", ["login", "status"])) {
    const loginNow = await prompt.boolean("runCodexLogin", "Codex is not authenticated. Run codex login now?", true);
    if (loginNow) {
      commands.run("codex", ["login"]);
      if (!commands.statusOk("codex", ["login", "status"])) {
        throw new Error("Codex login did not complete successfully.");
      }
    } else {
      throw new Error("Codex must be authenticated before Cloudx voice control and Codex tabs can work.");
    }
  }
}

function installerPaths({ repoRoot: root, home }) {
  const asrDir = path.join(root, "services/asr");
  const venvDir = path.join(asrDir, ".venv");
  const configDir = path.join(home, ".config/cloudx");
  return {
    repoRoot: root,
    asrDir,
    venvDir,
    pipPath: path.join(venvDir, "bin/pip"),
    hfPath: path.join(venvDir, "bin/hf"),
    uvicornPath: path.join(venvDir, "bin/uvicorn"),
    modelDir: process.env.CLOUDX_ASR_MODEL_PATH ?? path.join(home, ".cache/cloudx/models/faster-whisper-large-v3"),
    dataDir: path.join(root, ".cloudx"),
    configDir,
    envPath: path.join(configDir, "cloudx.env"),
    systemdDir: path.join(home, ".config/systemd/user")
  };
}

function commandMap(runner) {
  return {
    run(command, args, options) {
      return runner.run(command, args, options);
    },
    mkdir(dirPath) {
      return runner.mkdir(dirPath);
    },
    exists(command) {
      if (runner.dryRun) {
        return command === "codex" || command === "node" || command === "npm" || command === "python3" || command === "curl";
      }
      return spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore" }).status === 0;
    },
    which(command) {
      if (runner.dryRun) {
        return `/usr/bin/${command}`;
      }
      const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`Missing required command: ${command}`);
      }
      return result.stdout.trim();
    },
    statusOk(command, args) {
      if (runner.dryRun) {
        runner.commands.push({ command, args, statusCheck: true, cwd: runner.cwd });
        console.log(`$ ${[command, ...args].join(" ")}`);
        return true;
      }
      return spawnSync(command, args, { cwd: runner.cwd, stdio: "ignore" }).status === 0;
    },
    capture(command, args, options) {
      return runner.capture(command, args, options);
    }
  };
}

function detectCudaRuntime(commands) {
  if (commands.exists("ldconfig")) {
    const output = commands.capture("ldconfig", ["-p"]);
    return output.includes("libcudart") && output.includes("libcudnn");
  }
  return fs.existsSync("/usr/local/cuda/lib64/libcudart.so") && fs.existsSync("/usr/local/cuda/lib64/libcudnn.so");
}

function createPrompter({ answers = {}, yes = false, dryRun = false, input = process.stdin, output = process.stdout }) {
  const rl = !yes && !dryRun ? readline.createInterface({ input, output }) : undefined;
  async function ask(key, label, defaultValue) {
    if (answers[key] !== undefined) {
      return answers[key];
    }
    if (yes || dryRun) {
      return defaultValue;
    }
    const suffix = defaultValue === "" ? "" : ` [${defaultValue}]`;
    const response = await rl.question(`${label}${suffix}: `);
    return response.trim() === "" ? defaultValue : response.trim();
  }
  return {
    async text(key, label, defaultValue) {
      return String(await ask(key, label, defaultValue));
    },
    async integer(key, label, defaultValue, { min, max }) {
      const value = Number.parseInt(String(await ask(key, label, defaultValue)), 10);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${label} must be an integer from ${min} to ${max}.`);
      }
      return value;
    },
    async boolean(key, label, defaultValue) {
      const raw = await ask(key, `${label} ${defaultValue ? "[Y/n]" : "[y/N]"}`, defaultValue ? "yes" : "no");
      if (typeof raw === "boolean") {
        return raw;
      }
      const normalized = String(raw).trim().toLowerCase();
      if (["y", "yes", "true", "1", "on"].includes(normalized)) {
        return true;
      }
      if (["n", "no", "false", "0", "off"].includes(normalized)) {
        return false;
      }
      throw new Error(`${label} must be yes or no.`);
    },
    async close() {
      rl?.close();
    }
  };
}

function readText(filePath, fallback) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function readEnvFile(filePath) {
  const content = readText(filePath, "");
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

function defaultParallelism() {
  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length || 4;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function formatCommand(command, args, options = {}) {
  const envPrefix = options.env
    ? Object.entries(options.env)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : "";
  return [envPrefix, command, ...args].filter(Boolean).join(" ");
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(helpText());
    return;
  }
  const answers = options.answersPath ? JSON.parse(fs.readFileSync(options.answersPath, "utf8")) : {};
  await runInstaller({ ...options, answers });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
