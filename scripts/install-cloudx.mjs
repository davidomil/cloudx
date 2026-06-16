#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const ASR_MODEL_ID = "Systran/faster-whisper-large-v3";
export const PYTORCH_CPU_WHEEL_INDEX = "https://download.pytorch.org/whl/cpu";
export const FASTER_WHISPER_CUDA_PIP_PACKAGES = ["nvidia-cublas-cu12", "nvidia-cudnn-cu12==9.*"];
export const SERVICE_NAMES = ["cloudx-asr.service", "cloudx-documentation.service", "cloudx.service"];
export const LEGACY_SERVICE_NAMES = ["cloudx-asr.service", "cloudx.service"];
export const QUARTO_VERSION = "1.9.38";
export const QUARTO_DEB_PATH = `/tmp/quarto-${QUARTO_VERSION}-linux-amd64.deb`;
export const QUARTO_DEB_URL = `https://github.com/quarto-dev/quarto-cli/releases/download/v${QUARTO_VERSION}/quarto-${QUARTO_VERSION}-linux-amd64.deb`;
export const MIN_WORKTREE_GIT_VERSION = "2.36.0";
export const GIT_CORE_PPA = "ppa:git-core/ppa";
export const CUDA_12_MIN_DRIVER_VERSION = "525.60.13";
export const SMALL_GPU_MEMORY_MB = 6 * 1024;
export const WHISPER_CPP_REPO_URL = "https://github.com/ggml-org/whisper.cpp.git";
export const WHISPER_CPP_MODEL = "large-v3-turbo";
export const WHISPER_CPP_VAD_MODEL = "silero-v6.2.0";
export const SAFE_VERBOSE_ENV_KEYS = [
  "CLOUDX_INSTALL_BOOTSTRAPPED",
  "CLOUDX_INSTALL_ALREADY_PULLED",
  "CLOUDX_HOST",
  "CLOUDX_PORT",
  "CLOUDX_LOG_LEVEL",
  "CLOUDX_CERT_HOSTS",
  "CLOUDX_ASR_DEVICE",
  "CLOUDX_ASR_COMPUTE_TYPE",
  "CLOUDX_DOCUMENTATION_URL",
  "CLOUDX_DOCUMENTATION_HOST",
  "CLOUDX_DOCUMENTATION_PORT",
  "CLOUDX_DOCUMENTATION_DATA_DIR",
  "CLOUDX_DOCUMENTATION_ASR_BACKEND",
  "ONEAPI_DEVICE_SELECTOR"
];
export const UBUNTU_APT_PACKAGES = [
  "ca-certificates",
  "curl",
  "gnupg",
  "git",
  "software-properties-common",
  "build-essential",
  "cmake",
  "pciutils",
  "gpg-agent",
  "wget",
  "libreoffice",
  "poppler-utils",
  "ffmpeg",
  "pandoc",
  "texlive-xetex",
  "texlive-latex-recommended",
  "texlive-latex-extra",
  "texlive-fonts-recommended",
  "lmodern",
  "python3",
  "python3-venv",
  "python3-pip",
  "openssl",
  "jq",
  "ripgrep"
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: false,
    answersPath: undefined,
    yes: false,
    lan: false,
    noStart: false,
    uninstall: false,
    update: false,
    verbose: false
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
    } else if (arg === "--lan") {
      options.lan = true;
    } else if (arg === "--no-start") {
      options.noStart = true;
    } else if (arg === "--uninstall") {
      options.uninstall = true;
    } else if (arg === "--update") {
      options.update = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
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
    "The shell bootstrap installs Ubuntu packages, Quarto/Pandoc/TeX PDF rendering, and Node.js/npm when needed.",
    "This Node wizard then installs Cloudx dependencies, Codex CLI, ASR,",
    "the documentation archive indexer, the Faster Whisper model, optional",
    "whisper.cpp documentation ASR, config files, and optional systemd user services.",
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
    "  --lan              Bind Cloudx to 0.0.0.0 for trusted LAN/tailnet access.",
    "  --no-start         Install services without starting them.",
    "  --verbose          Print debugging details for installer commands and captured output.",
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

export function needsQuartoInstall(versionText) {
  return String(versionText).trim().split(/\s+/)[0] !== QUARTO_VERSION;
}

export function parseGitVersion(versionText) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(versionText));
  return match ? [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3] ?? "0", 10)] : undefined;
}

export function compareVersions(left, right) {
  const leftVersion = Array.isArray(left) ? left : parseGitVersion(left);
  const rightVersion = Array.isArray(right) ? right : parseGitVersion(right);
  if (!leftVersion || !rightVersion) {
    return leftVersion === rightVersion ? 0 : leftVersion ? 1 : -1;
  }
  for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index += 1) {
    const delta = (leftVersion[index] ?? 0) - (rightVersion[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

export function needsGitUpgrade(versionText, minimumVersion = MIN_WORKTREE_GIT_VERSION) {
  return compareVersions(versionText, minimumVersion) < 0;
}

export function parseNvidiaGpuInfo(output) {
  return String(output)
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", driverVersion = "", memoryText = ""] = line.split(",").map((part) => part.trim());
      const memoryMb = Number.parseInt(memoryText.replace(/[^\d]/g, ""), 10);
      return {
        name,
        driverVersion,
        memoryMb: Number.isFinite(memoryMb) ? memoryMb : undefined
      };
    });
}

export function selectNvidiaGpuInfo(gpus = []) {
  return [...gpus].sort((left, right) => (right.memoryMb ?? 0) - (left.memoryMb ?? 0))[0];
}

export function supportsCuda12Driver(driverVersion) {
  return compareVersions(driverVersion, CUDA_12_MIN_DRIVER_VERSION) >= 0;
}

export function gpuComputeType(memoryMb) {
  return memoryMb === undefined || memoryMb < SMALL_GPU_MEMORY_MB ? "int8_float16" : "float16";
}

export function assertQuartoArchitecture(architecture) {
  const normalized = String(architecture).trim();
  if (normalized !== "amd64") {
    throw new Error(`Cloudx installs the official Quarto linux-amd64 .deb. Detected unsupported architecture: ${normalized || "unknown"}.`);
  }
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

export function resolveDeviceConfig({ gpuDetected, useGpu, cudaRuntimeReady = false, nvidiaGpuInfo }) {
  const cudaDriverReady = nvidiaGpuInfo?.driverVersion ? supportsCuda12Driver(nvidiaGpuInfo.driverVersion) : cudaRuntimeReady;
  const resolvedUseGpu = useGpu ?? (gpuDetected && cudaDriverReady);
  if (resolvedUseGpu && !gpuDetected) {
    throw new Error("GPU mode was requested, but no NVIDIA GPU was detected with nvidia-smi.");
  }
  if (resolvedUseGpu && !cudaDriverReady) {
    throw new Error(`GPU mode was requested, but the NVIDIA driver is missing or older than the CUDA 12 minimum driver ${CUDA_12_MIN_DRIVER_VERSION}.`);
  }
  return resolvedUseGpu ? { device: "cuda", computeType: gpuComputeType(nvidiaGpuInfo?.memoryMb) } : { device: "cpu", computeType: "int8" };
}

export function normalizeWhisperCppBuild(value) {
  const build = String(value || "cpu").trim().toLowerCase();
  if (build !== "cpu" && build !== "sycl") {
    throw new Error("whisper.cpp build must be cpu or sycl.");
  }
  return build;
}

export function parseBooleanChoice(label, value) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["y", "yes", "true", "1", "on"].includes(normalized)) {
    return true;
  }
  if (["n", "no", "false", "0", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${label} must be yes or no.`);
}

export function buildEnvLines(config) {
  const documentationHost = config.documentationHost ?? "127.0.0.1";
  const documentationPort = config.documentationPort ?? 7820;
  const lines = [
    `CLOUDX_HOST=${config.host}`,
    `CLOUDX_PORT=${config.port}`,
    `CLOUDX_LOG_LEVEL=${config.logLevel ?? "info"}`,
    `CLOUDX_ALLOWED_ROOTS=${config.allowedRoots}`,
    `CLOUDX_DATA_DIR=${config.dataDir}`,
    `CLOUDX_ASSISTANT_BIN=${config.assistantBin}`,
    `CLOUDX_TOOL_PATH=${config.toolPath}`,
    `CLOUDX_ASR_URL=http://127.0.0.1:7810`,
    `CLOUDX_ASR_MODEL_PATH=${config.modelDir}`,
    `CLOUDX_ASR_DEVICE=${config.device}`,
    `CLOUDX_ASR_COMPUTE_TYPE=${config.computeType}`,
    `CLOUDX_ASR_LANGUAGE=${config.language}`,
    `CLOUDX_ASR_CPU_THREADS=${config.cpuThreads}`,
    `CLOUDX_ASR_NUM_WORKERS=1`,
    `CLOUDX_VOICE_DEBUG_TRANSCRIPTS=false`,
    `CLOUDX_DOCUMENTATION_URL=${config.documentationUrl ?? `http://${documentationHost}:${documentationPort}`}`,
    `CLOUDX_DOCUMENTATION_HOST=${documentationHost}`,
    `CLOUDX_DOCUMENTATION_PORT=${documentationPort}`,
    `CLOUDX_DOCUMENTATION_DATA_DIR=${config.documentationDataDir ?? path.join(config.dataDir, "documentation")}`,
  ];
  if (config.documentationAsrBackend) {
    lines.push(`CLOUDX_DOCUMENTATION_ASR_BACKEND=${config.documentationAsrBackend}`);
  }
  if (config.whisperCpp) {
    lines.push(
      `CLOUDX_ASR_BACKEND=whisper-cpp`,
      `CLOUDX_ASR_WHISPER_CPP_BIN=${config.whisperCpp.bin}`,
      `CLOUDX_ASR_WHISPER_CPP_MODEL_PATH=${config.whisperCpp.modelPath}`,
      `CLOUDX_ASR_WHISPER_CPP_THREADS=${config.whisperCpp.threads}`,
      `CLOUDX_ASR_WHISPER_CPP_BUILD=${config.whisperCpp.build}`,
      `CLOUDX_ASR_WHISPER_CPP_MODEL=${config.whisperCpp.model}`,
      `CLOUDX_ASR_WHISPER_CPP_VAD=true`,
      `CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH=${config.whisperCpp.vadModelPath}`
    );
    if (config.whisperCpp.build === "sycl") {
      lines.push("ONEAPI_DEVICE_SELECTOR=opencl:gpu");
    }
    lines.push(
      `CLOUDX_DOCUMENTATION_WHISPER_CPP_BIN=${config.whisperCpp.bin}`,
      `CLOUDX_DOCUMENTATION_WHISPER_CPP_MODEL_PATH=${config.whisperCpp.modelPath}`,
      `CLOUDX_DOCUMENTATION_WHISPER_CPP_THREADS=${config.whisperCpp.threads}`,
      `CLOUDX_DOCUMENTATION_WHISPER_CPP_BUILD=${config.whisperCpp.build}`,
      `CLOUDX_DOCUMENTATION_WHISPER_CPP_MODEL=${config.whisperCpp.model}`,
      `CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD=true`,
      `CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD_MODEL_PATH=${config.whisperCpp.vadModelPath}`
    );
  }
  lines.push("");
  return lines;
}

export function renderEnvFile(config) {
  return buildEnvLines(config).join("\n");
}

export function defaultDocumentationConfig(paths) {
  return {
    documentationUrl: "http://127.0.0.1:7820",
    documentationHost: "127.0.0.1",
    documentationPort: 7820,
    documentationDataDir: path.join(paths.dataDir, "documentation")
  };
}

function defaultDocumentationEnvVars(paths) {
  const config = defaultDocumentationConfig(paths);
  return {
    CLOUDX_DOCUMENTATION_URL: config.documentationUrl,
    CLOUDX_DOCUMENTATION_HOST: config.documentationHost,
    CLOUDX_DOCUMENTATION_PORT: String(config.documentationPort),
    CLOUDX_DOCUMENTATION_DATA_DIR: config.documentationDataDir
  };
}

function missingEnvVars(existing, defaults) {
  return Object.fromEntries(Object.entries(defaults).filter(([key]) => !Object.hasOwn(existing, key)));
}

const NVIDIA_LIBRARY_PATH_PYTHON = "import os, nvidia.cublas.lib, nvidia.cudnn.lib; print(os.path.dirname(nvidia.cublas.lib.__file__) + ':' + os.path.dirname(nvidia.cudnn.lib.__file__))";

function cudaLibraryPathExport(pythonPath, deviceExpression) {
  return `if [ "${deviceExpression}" = "cuda" ]; then export LD_LIBRARY_PATH="$(${shellQuote(pythonPath)} -c ${shellQuote(NVIDIA_LIBRARY_PATH_PYTHON)})\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi`;
}

export function renderAsrService({ repoRoot: root, envPath, pythonPath, uvicornPath, asrDir }) {
  const startCommand = [
    cudaLibraryPathExport(pythonPath, "${CLOUDX_ASR_DEVICE:-cpu}"),
    'if [ "${CLOUDX_ASR_BACKEND:-}" = "whisper-cpp" ] && [ -r /opt/intel/oneapi/setvars.sh ]; then source /opt/intel/oneapi/setvars.sh >/dev/null; fi',
    `exec ${shellQuote(uvicornPath)} cloudx_asr.main:app --app-dir ${shellQuote(path.join(asrDir, "src"))} --host 127.0.0.1 --port 7810`
  ].join("; ");
  return [
    "[Unit]",
    "Description=Cloudx local ASR",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${root}`,
    `EnvironmentFile=${envPath}`,
    `ExecStart=/bin/bash -lc ${shellQuote(startCommand)}`,
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
    "After=network-online.target cloudx-asr.service cloudx-documentation.service",
    "Wants=cloudx-asr.service cloudx-documentation.service",
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

export function renderDocumentationService({ repoRoot: root, envPath, documentationPythonPath, documentationIndexerPath }) {
  const startCommand = [
    cudaLibraryPathExport(documentationPythonPath, "${CLOUDX_DOCUMENTATION_ASR_DEVICE:-${CLOUDX_ASR_DEVICE:-cpu}}"),
    `exec ${shellQuote(documentationIndexerPath)}`
  ].join("; ");
  return [
    "[Unit]",
    "Description=Cloudx documentation archive indexer",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${root}`,
    `EnvironmentFile=${envPath}`,
    `ExecStart=/bin/bash -lc ${shellQuote(startCommand)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

export function ubuntuBootstrapPlan({ nodeVersionText = "", hasNpm = false, quartoVersionText = "" } = {}) {
  const nodeInstallNeeded = parseNodeMajor(nodeVersionText) < 22;
  const commands = [
    ["sudo", "apt-get", "update"],
    ["sudo", "apt-get", "install", "-y", ...UBUNTU_APT_PACKAGES]
  ];
  if (needsQuartoInstall(quartoVersionText)) {
    commands.push(["curl", "-fL", "-o", QUARTO_DEB_PATH, QUARTO_DEB_URL]);
    commands.push(["sudo", "apt-get", "install", "-y", QUARTO_DEB_PATH]);
  }
  if (nodeInstallNeeded) {
    commands.push(["sh", "-lc", "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"]);
    commands.push(["sudo", "apt-get", "install", "-y", "nodejs"]);
  }
  if (nodeInstallNeeded || !hasNpm) {
    commands.push(["sh", "-lc", "command -v npm >/dev/null 2>&1 || sudo apt-get install -y npm"]);
  }
  commands.push(["node", "-v"]);
  commands.push(["npm", "-v"]);
  commands.push(["quarto", "--version"]);
  commands.push(["pandoc", "--version"]);
  commands.push(["xelatex", "--version"]);
  commands.push(["lualatex", "--version"]);
  return commands;
}

export function installUbuntuPrerequisites(commands) {
  if (commands.exists("dpkg")) {
    assertQuartoArchitecture(commands.capture("dpkg", ["--print-architecture"]));
  }
  const nodeVersionText = commands.exists("node") ? commands.capture("node", ["-v"]) : "";
  const hasNpm = commands.exists("npm");
  const quartoVersionText = commands.exists("quarto") ? commands.capture("quarto", ["--version"]) : "";
  for (const [command, ...args] of ubuntuBootstrapPlan({ nodeVersionText, hasNpm, quartoVersionText })) {
    commands.run(command, args);
  }
}

export async function ensureSupportedGit(commands, prompt) {
  const versionText = commands.exists("git") ? commands.capture("git", ["--version"]) : "";
  if (!needsGitUpgrade(versionText)) {
    console.log(`Using ${versionText.trim()}.`);
    return { upgraded: false, versionText: versionText.trim() };
  }

  console.log(`Git ${versionText.trim() || "is missing"} is older than Cloudx Worktree Manager requires.`);
  console.log(`Cloudx uses 'git worktree list --porcelain -z', which requires Git ${MIN_WORKTREE_GIT_VERSION} or newer.`);
  explainQuestion("Upgrade Git", `Ubuntu 22.04 packages Git 2.34.x. Add ${GIT_CORE_PPA} and install the current stable Git package now?`);
  const upgradeGit = await prompt.boolean("upgradeGit", `Install newer Git from ${GIT_CORE_PPA}?`, true);
  if (!upgradeGit) {
    console.log("Continuing without upgrading Git. The Worktree Manager will fail until Git is upgraded to 2.36.0 or newer.");
    return { upgraded: false, versionText: versionText.trim(), skipped: true };
  }

  installGitCorePpa(commands);
  const upgradedVersionText = commands.capture("git", ["--version"]);
  if (needsGitUpgrade(upgradedVersionText)) {
    throw new Error(`Git upgrade completed but ${upgradedVersionText.trim() || "git --version"} is still older than ${MIN_WORKTREE_GIT_VERSION}.`);
  }
  console.log(`Using ${upgradedVersionText.trim()}.`);
  return { upgraded: true, versionText: upgradedVersionText.trim() };
}

export function installGitCorePpa(commands) {
  commands.run("sudo", ["apt-get", "install", "-y", "software-properties-common"]);
  commands.run("sudo", ["add-apt-repository", GIT_CORE_PPA, "-y"]);
  commands.run("sudo", ["apt-get", "update"]);
  commands.run("sudo", ["apt-get", "install", "-y", "git"]);
}

export function verifyNodeAndNpm(commands) {
  commands.run("node", ["-v"]);
  commands.run("npm", ["-v"]);
}

export function shouldAdvertiseLanUrls(host) {
  const normalized = String(host).trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

export function networkBindWarning(host, port) {
  return [
    "",
    "======================================================================",
    "WARNING: Cloudx is configured for network access.",
    `CLOUDX_HOST=${host} exposes this shell-controlling service beyond localhost.`,
    "Cloudx can spawn terminals, edit files, proxy dashboards, and transcribe",
    "browser microphone audio when voice is enabled.",
    "Use only on a trusted LAN or private tailnet. Public internet unsupported.",
    `Local URL: https://127.0.0.1:${port}`,
    "======================================================================",
    ""
  ].join("\n");
}

export function cloudxAccessUrls(port, networkInterfaces = os.networkInterfaces(), host = "127.0.0.1") {
  const urls = [`https://127.0.0.1:${port}`];
  if (!shouldAdvertiseLanUrls(host)) {
    return urls;
  }
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
  constructor({ dryRun = false, cwd = repoRoot, log = console.log, verbose = false } = {}) {
    this.dryRun = dryRun;
    this.cwd = cwd;
    this.log = log;
    this.verbose = verbose;
    this.commands = [];
    this.writes = [];
  }

  run(command, args = [], options = {}) {
    const display = formatCommand(command, args, options);
    this.commands.push({ command, args, cwd: options.cwd ?? this.cwd });
    this.log(`$ ${display}`);
    this.logVerboseCommand(options);
    if (this.dryRun) {
      return "";
    }
    if (options.capture) {
      const result = this.spawnCaptured(command, args, options);
      this.logVerboseProcessResult(result);
      if (!processSucceeded(result)) {
        if (options.allowFailure) {
          this.log(`command failed but continuing: ${display}`);
          return "";
        }
        throw commandFailure(command, args, result);
      }
      return "";
    }
    try {
      execFileSync(command, args, {
        cwd: options.cwd ?? this.cwd,
        stdio: "inherit",
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
      this.logVerboseCommand(options);
      return "";
    }
    if (this.verbose) {
      this.log(`$ ${formatCommand(command, args, options)}`);
      this.logVerboseCommand(options);
    }
    const result = this.spawnCaptured(command, args, options);
    this.logVerboseProcessResult(result);
    if (!processSucceeded(result)) {
      throw commandFailure(command, args, result);
    }
    return result.stdout.trim();
  }

  statusOk(command, args = [], options = {}) {
    this.commands.push({ command, args, statusCheck: true, cwd: options.cwd ?? this.cwd });
    if (this.dryRun || this.verbose) {
      this.log(`$ ${[command, ...args].join(" ")}`);
      this.logVerboseCommand(options);
    }
    if (this.dryRun) {
      return true;
    }
    const result = this.verbose
      ? this.spawnCaptured(command, args, options)
      : spawnSync(command, args, { cwd: options.cwd ?? this.cwd, stdio: "ignore", env: options.env ? { ...process.env, ...options.env } : process.env });
    this.logVerboseProcessResult(result);
    return processSucceeded(result);
  }

  writeFile(filePath, contents) {
    this.writes.push({ path: filePath, contents });
    this.log(`write ${filePath}`);
    this.logVerbose(`write bytes: ${Buffer.byteLength(contents, "utf8")}`);
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

  spawnCaptured(command, args, options = {}) {
    return spawnSync(command, args, {
      cwd: options.cwd ?? this.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: options.env ? { ...process.env, ...options.env } : process.env
    });
  }

  logVerboseCommand(options = {}) {
    this.logVerbose(`cwd: ${options.cwd ?? this.cwd}`);
    const safeEnv = safeVerboseEnv(options.env ? { ...process.env, ...options.env } : process.env);
    if (Object.keys(safeEnv).length > 0) {
      this.logVerbose(`env: ${Object.entries(safeEnv).map(([key, value]) => `${key}=${value}`).join(" ")}`);
    }
  }

  logVerboseProcessResult(result) {
    if (!this.verbose) {
      return;
    }
    this.logVerbose(`exit: ${result.error ? result.error.message : result.signal ? `signal ${result.signal}` : result.status ?? 0}`);
    logVerboseBlock(this.log, "stdout", result.stdout);
    logVerboseBlock(this.log, "stderr", result.stderr);
  }

  logVerbose(message) {
    if (this.verbose) {
      this.log(`[verbose] ${message}`);
    }
  }
}

export async function runInstaller(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const answers = options.answers ?? {};
  const yes = options.yes ?? false;
  const dryRun = options.dryRun ?? false;
  const verbose = Boolean(options.verbose) || env.CLOUDX_INSTALL_VERBOSE === "1";
  const runner = options.runner ?? new InstallerRunner({ dryRun, cwd: root, verbose });
  if (verbose) {
    runner.verbose = true;
  }
  const prompt = createPrompter({ answers, yes, dryRun, input: options.input, output: options.output });
  const osRelease = options.osRelease ?? parseOsRelease(readText("/etc/os-release", "ID=unknown\n"));
  assertSupportedPlatform(osRelease);
  const networkInterfaces = options.networkInterfaces ?? os.networkInterfaces();

  const paths = installerPaths({ repoRoot: root, home, env });
  const commands = commandMap(runner);
  if (options.uninstall) {
    return await runUninstaller({ paths, commands, runner, prompt, dryRun });
  }
  section("1/10 Install and verify Ubuntu prerequisites");
  if (env.CLOUDX_INSTALL_BOOTSTRAPPED === "1") {
    console.log("Shell bootstrap already installed Ubuntu packages. Verifying Node.js and npm.");
    verifyNodeAndNpm(commands);
  } else {
    installUbuntuPrerequisites(commands);
  }
  await ensureSupportedGit(commands, prompt);
  if (options.update) {
    return await runUpdater({ paths, commands, runner, prompt, noStart: options.noStart, networkInterfaces, env });
  }
  const gpuDetected = options.gpuDetected ?? commands.exists("nvidia-smi");
  const nvidiaGpuInfo = options.nvidiaGpuInfo ?? (gpuDetected ? detectNvidiaGpuInfo(commands) : undefined);
  const cudaRuntimeReady = options.cudaRuntimeReady ?? detectCudaRuntime(commands);
  const intelGpuDetected = options.intelGpuDetected ?? detectIntelGpu(commands);
  const parallelism = options.parallelism ?? defaultParallelism();
  const defaultThreads = defaultCpuThreads(parallelism);

  section("Cloudx installer wizard");
  console.log(`Ubuntu target: ${osRelease.PRETTY_NAME ?? osRelease.VERSION_ID ?? "unknown"}`);
  console.log(`Repository: ${root}`);
  console.log(`Configuration file: ${paths.envPath}`);
  console.log(`ASR model directory: ${paths.modelDir}`);
  if (gpuDetected && nvidiaGpuInfo) {
    console.log(`NVIDIA GPU detected: ${nvidiaGpuInfo.name || "unknown GPU"}, driver ${nvidiaGpuInfo.driverVersion || "unknown"}, ${nvidiaGpuInfo.memoryMb ?? "unknown"} MB VRAM.`);
  } else {
    console.log("No NVIDIA GPU was detected with nvidia-smi; faster-whisper ASR will use CPU.");
  }
  if (gpuDetected && !cudaRuntimeReady) {
    console.log("System CUDA/cuDNN libraries were not detected; if CUDA ASR is selected, the installer will add the required Python NVIDIA runtime libraries.");
  }
  if (intelGpuDetected) {
    console.log("Intel GPU detected; optional whisper.cpp SYCL ASR can be installed for Intel GPU acceleration. CPU-only and NVIDIA installs do not need whisper.cpp.");
  }

  section("2/10 Verify Codex CLI");
  await ensureCodex(commands, prompt);
  const assistantBin = commands.which("codex");
  const toolPath = toolPathFor(assistantBin, commands.capture("npm", ["prefix", "-g"]), env.PATH);

  section("3/10 Collect install choices");
  explainQuestion(
    "Allowed workspace roots",
    "Cloudx can open terminals and files only under these roots. Use ':' to separate multiple roots on Linux, for example '~:/srv/projects'."
  );
  const allowedRoots = await prompt.text("allowedRoots", "Allowed workspace roots", "~");
  explainQuestion("Cloudx HTTPS port", "This is the HTTPS port for the web UI. Keep 3001 unless it is already in use.");
  const port = await prompt.integer("port", "Cloudx HTTPS port", 3001, { min: 1, max: 65_535 });
  explainQuestion("Network access", "Cloudx binds to localhost by default. Choose network access only for a trusted LAN or private tailnet such as Tailscale.");
  const configuredHost = env.CLOUDX_HOST?.trim() || "127.0.0.1";
  const bindLan = options.lan || (await prompt.boolean("bindLan", "Bind Cloudx to 0.0.0.0 for trusted LAN/tailnet access?", shouldAdvertiseLanUrls(configuredHost)));
  const host = bindLan ? "0.0.0.0" : shouldAdvertiseLanUrls(configuredHost) ? "127.0.0.1" : configuredHost;
  if (shouldAdvertiseLanUrls(host)) {
    console.log(networkBindWarning(host, port));
  }
  explainQuestion(
    "Additional certificate hostnames",
    "Optional names or IPs to include in the generated local certificate, useful for phone or LAN access. Leave blank for localhost and detected local addresses."
  );
  const certHosts = await prompt.text("certificateHosts", "Additional certificate hostnames (comma-separated, blank for none)", "");
  explainQuestion("ASR CPU threads", "Controls how many CPU threads Faster Whisper may use. More threads can improve transcription speed but leaves fewer cores for Codex and builds.");
  const cpuThreads = validateCpuThreads(await prompt.integer("cpuThreads", "ASR CPU threads", defaultThreads, { min: 1, max: parallelism }), parallelism);
  if (answers.useGpu !== undefined) {
    explainQuestion("NVIDIA GPU override", "The installer automatically uses CUDA when NVIDIA and CUDA/cuDNN are ready. The useGpu answer can still force CPU or require GPU.");
  }
  const useGpu = answers.useGpu === undefined ? undefined : parseBooleanChoice("useGpu", answers.useGpu);
  const device = resolveDeviceConfig({ gpuDetected, useGpu, cudaRuntimeReady, nvidiaGpuInfo });
  if (device.device === "cuda") {
    console.log(`faster-whisper ASR will use CUDA with ${device.computeType}.`);
  }
  explainQuestion("Optional whisper.cpp ASR", "Faster Whisper is the default ASR backend and covers CPU-only and NVIDIA CUDA installs. Install whisper.cpp only when you explicitly want the alternate compiled backend, mainly SYCL for Intel Arc after oneAPI and GPU device access are available.");
  const installWhisperCpp = await prompt.boolean("installWhisperCpp", "Install optional whisper.cpp alternate ASR backend?", false);
  const whisperCpp = installWhisperCpp
    ? {
        build: normalizeWhisperCppBuild(await prompt.text("whisperCppBuild", "whisper.cpp build backend (cpu or sycl)", intelGpuDetected ? "sycl" : "cpu")),
        model: await prompt.text("whisperCppModel", "whisper.cpp GGML model", WHISPER_CPP_MODEL),
        threads: cpuThreads
      }
    : undefined;
  explainQuestion("Install systemd services", "Writes user-level services so Cloudx, ASR, and the documentation indexer can run in the background instead of being started manually.");
  const installServices = await prompt.boolean("installServices", "Install Cloudx user-level systemd services?", true);
  if (installServices) {
    explainQuestion("Start services now", "Restarts Cloudx, ASR, and the documentation indexer immediately after writing the unit files, then verifies their health endpoints.");
  }
  const startServices = installServices ? !options.noStart && (await prompt.boolean("startServices", "Start Cloudx services after install?", true)) : false;
  if (installServices) {
    explainQuestion("Enable linger", "Lets the user-level services keep running after logout and start before the next interactive login. This uses sudo loginctl enable-linger.");
  }
  const enableLinger = installServices ? await prompt.boolean("enableLinger", "Enable user lingering so services survive logout and can start before login?", true) : false;
  printChoiceSummary({
    allowedRoots,
    host,
    port,
    certHosts,
    cpuThreads,
    device,
    whisperCpp,
    installServices,
    startServices,
    enableLinger
  });

  section("4/10 Install Cloudx npm dependencies");
  commands.run("npm", ["ci"]);
  section("5/10 Prepare ASR Python environment and model");
  setupAsr(commands, paths);
  downloadModel(commands, paths);
  section("6/10 Prepare documentation archive Python environment");
  setupDocumentationIndexer(commands, paths);
  if (device.device === "cuda") {
    setupFasterWhisperCuda(commands, paths);
  }
  section("7/10 Prepare optional whisper.cpp alternate ASR backend");
  if (whisperCpp) {
    setupWhisperCpp(commands, paths, whisperCpp);
  } else {
    console.log("Skipping optional whisper.cpp backend; Faster Whisper remains active.");
  }
  section("8/10 Build Cloudx and create HTTPS certificate");
  commands.run("npm", ["run", "build"]);
  commands.run("npm", ["run", "cert:create"], {
    env: certHosts.trim() ? { CLOUDX_CERT_HOSTS: certHosts.trim() } : undefined
  });

  const envConfig = {
    host,
    port,
    allowedRoots,
    dataDir: paths.dataDir,
    assistantBin,
    toolPath,
    modelDir: paths.modelDir,
    ...defaultDocumentationConfig(paths),
    language: "en",
    cpuThreads,
    documentationAsrBackend: whisperCpp ? "whisper-cpp" : "faster-whisper",
    whisperCpp: whisperCpp ? whisperCppEnv(paths, whisperCpp) : undefined,
    ...device
  };
  section("9/10 Write Cloudx configuration");
  runner.writeFile(paths.envPath, renderEnvFile(envConfig));

  if (installServices) {
    section("10/10 Install user-level systemd services");
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
    section("10/10 Skip systemd service installation");
    console.log("Cloudx was configured for manual startup with npm run dev.");
  }

  await prompt.close();
  printInstallComplete({ paths, host, port, installServices, startServices, networkInterfaces });
  return { runner, paths, envConfig, installServices, startServices, enableLinger, urls: cloudxAccessUrls(port, networkInterfaces, host) };
}

async function runUninstaller({ paths, commands, runner, prompt }) {
  section("Cloudx uninstall wizard");
  console.log("This removes Cloudx-managed local artifacts. It does not remove Node.js, npm, Python, apt packages, or Codex CLI.");
  console.log(`Repository: ${paths.repoRoot}`);
  console.log(`Configuration file: ${paths.envPath}`);
  console.log(`ASR model directory: ${paths.modelDir}`);

  explainQuestion("Remove services", "Stops, disables, and deletes the Cloudx user-level systemd units. Choose yes if Cloudx was installed as a background service.");
  const removeServices = await prompt.boolean("removeServices", "Stop, disable, and remove Cloudx user-level systemd services?", true);
  explainQuestion("Remove config", "Deletes ~/.config/cloudx/cloudx.env, which contains the port, roots, ASR model path, and CPU/GPU settings written by the installer.");
  const removeConfig = await prompt.boolean("removeConfig", "Remove Cloudx environment config?", true);
  explainQuestion("Remove Python virtualenvs", "Deletes Cloudx-managed Python virtualenvs for ASR and the documentation archive indexer.");
  const removeVenv = await prompt.boolean("removeVenv", "Remove Cloudx Python virtualenvs?", true);
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
    runner.removePath(path.join(paths.systemdDir, "cloudx-documentation.service"));
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
    runner.removePath(paths.documentationVenvDir);
  } else {
    console.log("Keeping Cloudx Python virtualenvs.");
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

async function runUpdater({ paths, commands, runner, prompt, noStart, networkInterfaces, env }) {
  section("Cloudx update wizard");
  console.log("This updates an existing Cloudx checkout and local install. It keeps your saved Cloudx environment config.");
  console.log(`Repository: ${paths.repoRoot}`);
  console.log(`Configuration file: ${paths.envPath}`);
  console.log(`ASR model directory: ${paths.modelDir}`);

  const envConfig = readEnvFile(paths.envPath);
  const port = Number.parseInt(envConfig.CLOUDX_PORT ?? "3001", 10);
  const host = envConfig.CLOUDX_HOST ?? "127.0.0.1";
  const servicesInstalled =
    SERVICE_NAMES.some((serviceName) => fs.existsSync(path.join(paths.systemdDir, serviceName))) ||
    LEGACY_SERVICE_NAMES.every((serviceName) => fs.existsSync(path.join(paths.systemdDir, serviceName)));

  section("2/10 Pull latest Cloudx checkout");
  if (env.CLOUDX_INSTALL_ALREADY_PULLED === "1") {
    console.log("Checkout was already pulled by install.sh.");
  } else {
    commands.run("git", ["pull", "--ff-only"]);
  }

  section("3/10 Update Codex CLI");
  await updateCodex(commands, prompt);
  const assistantBin = commands.which("codex");
  runner.writeFile(
    paths.envPath,
    updateEnvFileContent(readText(paths.envPath, ""), {
      CLOUDX_ASSISTANT_BIN: assistantBin,
      CLOUDX_TOOL_PATH: toolPathFor(assistantBin, commands.capture("npm", ["prefix", "-g"]), env.PATH),
      ...missingEnvVars(envConfig, defaultDocumentationEnvVars(paths))
    })
  );

  section("4/10 Update Cloudx npm dependencies");
  commands.run("npm", ["ci"]);

  section("5/10 Update ASR Python environment and model");
  setupAsr(commands, paths);
  downloadModel(commands, paths);

  section("6/10 Update documentation archive Python environment");
  setupDocumentationIndexer(commands, paths);
  if ((envConfig.CLOUDX_ASR_DEVICE ?? "cpu") === "cuda" || (envConfig.CLOUDX_DOCUMENTATION_ASR_DEVICE ?? "cpu") === "cuda") {
    setupFasterWhisperCuda(commands, paths);
  }

  section("7/10 Update optional whisper.cpp alternate ASR backend");
  if (envConfig.CLOUDX_DOCUMENTATION_ASR_BACKEND === "whisper-cpp") {
    setupWhisperCpp(commands, paths, {
      build: envConfig.CLOUDX_DOCUMENTATION_WHISPER_CPP_BUILD ?? "cpu",
      model: envConfig.CLOUDX_DOCUMENTATION_WHISPER_CPP_MODEL ?? WHISPER_CPP_MODEL,
      threads: Number.parseInt(envConfig.CLOUDX_DOCUMENTATION_WHISPER_CPP_THREADS ?? envConfig.CLOUDX_ASR_CPU_THREADS ?? String(defaultCpuThreads()), 10)
    });
  } else {
    console.log("No whisper.cpp alternate ASR backend configured; Faster Whisper remains active.");
  }

  section("8/10 Rebuild Cloudx and refresh HTTPS certificate if missing");
  commands.run("npm", ["run", "build"]);
  commands.run("npm", ["run", "cert:create"]);

  section("9/10 Refresh installed systemd service files");
  if (servicesInstalled) {
    installSystemdServices(commands, runner, paths);
    commands.run("systemctl", ["--user", "daemon-reload"]);
  } else {
    console.log("Cloudx user services were not found, so service unit refresh is skipped.");
  }

  const restartServices =
    servicesInstalled &&
    !noStart &&
    (explainQuestion("Restart services", "Restarts Cloudx, ASR, and the documentation indexer after dependencies and service files are updated, then verifies the health endpoints."),
    await prompt.boolean("restartServices", "Restart Cloudx services after update?", true));

  section("10/10 Restart services");
  if (restartServices) {
    commands.run("systemctl", ["--user", "restart", ...SERVICE_NAMES]);
    verifyServices(commands, port);
  } else if (servicesInstalled) {
    console.log(`Services were refreshed but not restarted. Restart later with: systemctl --user restart ${SERVICE_NAMES.join(" ")}`);
  } else {
    console.log("No installed services to restart.");
  }

  section("Update complete");
  printUpdateComplete({ paths, host, port, servicesInstalled, restartServices, networkInterfaces });
  await prompt.close();
  return { runner, paths, port, servicesInstalled, restartServices, urls: cloudxAccessUrls(port, networkInterfaces, host) };
}

function section(title) {
  console.log(`\n==> ${title}`);
}

function explainQuestion(title, detail) {
  console.log(`\n? ${title}`);
  console.log(`  ${detail}`);
}

function printChoiceSummary({ allowedRoots, host, port, certHosts, cpuThreads, device, whisperCpp, installServices, startServices, enableLinger }) {
  console.log("Install choices:");
  console.log(`  allowed roots: ${allowedRoots}`);
  console.log(`  bind host: ${host}`);
  console.log(`  HTTPS port: ${port}`);
  console.log(`  certificate hosts: ${certHosts.trim() || "(default local hosts only)"}`);
  console.log(`  ASR device: ${device.device} (${device.computeType})`);
  console.log(`  ASR CPU threads: ${cpuThreads}`);
  console.log(`  ASR backend: ${whisperCpp ? `whisper.cpp (${whisperCpp.build}, ${whisperCpp.model})` : "faster-whisper"}`);
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

function printInstallComplete({ paths, host, port, installServices, startServices, networkInterfaces }) {
  if (shouldAdvertiseLanUrls(host)) {
    console.log(networkBindWarning(host, port));
  }
  const urls = cloudxAccessUrls(port, networkInterfaces, host);
  console.log("Cloudx installer complete.");
  console.log(`  env: ${paths.envPath}`);
  console.log(`  ASR model: ${paths.modelDir}`);
  console.log(startServices ? "  open Cloudx:" : "  after starting Cloudx, open:");
  for (const url of urls) {
    console.log(`    ${url}`);
  }
  if (installServices) {
    console.log(`  status: systemctl --user status ${SERVICE_NAMES.join(" ")}`);
  } else {
    console.log("  run: npm run dev");
  }
}

function printUpdateComplete({ paths, host, port, servicesInstalled, restartServices, networkInterfaces }) {
  if (shouldAdvertiseLanUrls(host)) {
    console.log(networkBindWarning(host, port));
  }
  const urls = cloudxAccessUrls(port, networkInterfaces, host);
  console.log("Cloudx update complete.");
  console.log(`  env: ${paths.envPath}`);
  console.log(`  ASR model: ${paths.modelDir}`);
  console.log(restartServices ? "  open Cloudx:" : "  after starting or restarting Cloudx, open:");
  for (const url of urls) {
    console.log(`    ${url}`);
  }
  if (servicesInstalled) {
    console.log(`  status: systemctl --user status ${SERVICE_NAMES.join(" ")}`);
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

function setupDocumentationIndexer(commands, paths) {
  console.log(`Creating or updating Python virtualenv: ${paths.documentationVenvDir}`);
  commands.run("python3", ["-m", "venv", "--upgrade-deps", paths.documentationVenvDir]);
  console.log("Installing Cloudx documentation archive indexer and extraction dependencies.");
  commands.run(paths.documentationPipPath, [
    "install",
    "--extra-index-url",
    PYTORCH_CPU_WHEEL_INDEX,
    "-e",
    `${paths.documentationIndexerDir}[dev]`
  ]);
}

function setupFasterWhisperCuda(commands, paths) {
  console.log("Installing faster-whisper NVIDIA CUDA runtime libraries into Cloudx Python virtualenvs.");
  commands.run(paths.pipPath, ["install", ...FASTER_WHISPER_CUDA_PIP_PACKAGES]);
  commands.run(paths.documentationPipPath, ["install", ...FASTER_WHISPER_CUDA_PIP_PACKAGES]);
}

function setupWhisperCpp(commands, paths, config) {
  const build = normalizeWhisperCppBuild(config.build);
  const buildDir = whisperCppBuildDir(paths, build);
  console.log(`Preparing whisper.cpp ${build} build in ${paths.whisperCppDir}.`);
  if (build === "sycl") {
    installWhisperCppSyclPrerequisites(commands);
  }
  if (fs.existsSync(path.join(paths.whisperCppDir, ".git"))) {
    commands.run("git", ["-C", paths.whisperCppDir, "pull", "--ff-only"]);
  } else {
    commands.mkdir(path.dirname(paths.whisperCppDir));
    commands.run("git", ["clone", "--depth", "1", WHISPER_CPP_REPO_URL, paths.whisperCppDir]);
  }
  if (build === "sycl") {
    commands.run("bash", [
      "-lc",
      [
        "source /opt/intel/oneapi/setvars.sh >/dev/null",
        `cmake -B ${shellQuote(buildDir)} -S ${shellQuote(paths.whisperCppDir)} -DGGML_SYCL=ON -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx`,
        `cmake --build ${shellQuote(buildDir)} -j --config Release --target whisper-cli`
      ].join(" && ")
    ]);
  } else {
    commands.run("cmake", ["-B", buildDir, "-S", paths.whisperCppDir]);
    commands.run("cmake", ["--build", buildDir, "-j", "--config", "Release", "--target", "whisper-cli"]);
  }
  commands.mkdir(paths.whisperCppModelDir);
  commands.run("bash", [path.join(paths.whisperCppDir, "models/download-ggml-model.sh"), config.model, paths.whisperCppModelDir]);
  commands.run("bash", [path.join(paths.whisperCppDir, "models/download-vad-model.sh"), WHISPER_CPP_VAD_MODEL, paths.whisperCppModelDir]);
}

function installWhisperCppSyclPrerequisites(commands) {
  console.log("Installing Intel oneAPI/SYCL prerequisites for whisper.cpp.");
  commands.run("bash", [
    "-lc",
    "wget -O- https://apt.repos.intel.com/intel-gpg-keys/GPG-PUB-KEY-INTEL-SW-PRODUCTS.PUB | gpg --dearmor | sudo tee /usr/share/keyrings/oneapi-archive-keyring.gpg > /dev/null"
  ]);
  commands.run("bash", [
    "-lc",
    "echo 'deb [signed-by=/usr/share/keyrings/oneapi-archive-keyring.gpg] https://apt.repos.intel.com/oneapi all main' | sudo tee /etc/apt/sources.list.d/oneAPI.list > /dev/null"
  ]);
  commands.run("sudo", ["apt-get", "update"]);
  commands.run("sudo", [
    "apt-get",
    "install",
    "-y",
    "intel-oneapi-compiler-dpcpp-cpp",
    "intel-oneapi-mkl-sycl-devel",
    "intel-opencl-icd",
    "libze-intel-gpu1",
    "libze1",
    "libze-dev",
    "clinfo"
  ]);
}

function whisperCppBuildDir(paths, build) {
  return path.join(paths.whisperCppDir, build === "sycl" ? "build-sycl" : "build");
}

function whisperCppEnv(paths, config) {
  const model = config.model || WHISPER_CPP_MODEL;
  const build = normalizeWhisperCppBuild(config.build);
  return {
    bin: path.join(whisperCppBuildDir(paths, build), "bin/whisper-cli"),
    modelPath: path.join(paths.whisperCppModelDir, `ggml-${model}.bin`),
    vadModelPath: path.join(paths.whisperCppModelDir, `ggml-${WHISPER_CPP_VAD_MODEL}.bin`),
    threads: config.threads,
    build,
    model
  };
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
      pythonPath: paths.pythonPath,
      uvicornPath: paths.uvicornPath,
      asrDir: paths.asrDir
    })
  );
  runner.writeFile(
    path.join(paths.systemdDir, "cloudx-documentation.service"),
    renderDocumentationService({
      repoRoot: paths.repoRoot,
      envPath: paths.envPath,
      documentationPythonPath: paths.documentationPythonPath,
      documentationIndexerPath: paths.documentationIndexerPath
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
    waitForHealth(commands, {
      label: "Cloudx documentation indexer",
      url: "http://127.0.0.1:7820/health"
    });
  } catch (error) {
    console.error("Service health verification failed. Recent service state follows.");
    commands.run("systemctl", ["--user", "status", ...SERVICE_NAMES, "--no-pager"], { allowFailure: true });
    commands.run("journalctl", ["--user", ...SERVICE_NAMES.flatMap((serviceName) => ["-u", serviceName]), "--since", "5 minutes ago", "--no-pager"], { allowFailure: true });
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
  commands.capture("curl", args);
  console.log(`  ${label} health ok.`);
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

function installerPaths({ repoRoot: root, home, env = process.env }) {
  const asrDir = path.join(root, "services/asr");
  const venvDir = path.join(asrDir, ".venv");
  const documentationIndexerDir = path.join(root, "services/documentation-indexer");
  const documentationVenvDir = path.join(documentationIndexerDir, ".venv");
  const whisperCppDir = env.CLOUDX_WHISPER_CPP_DIR ?? path.join(home, ".local/share/cloudx/whisper.cpp");
  const whisperCppModelDir = env.CLOUDX_WHISPER_CPP_MODEL_DIR ?? path.join(home, ".cache/cloudx/models/whisper.cpp");
  const configDir = path.join(home, ".config/cloudx");
  return {
    repoRoot: root,
    asrDir,
    venvDir,
    pythonPath: path.join(venvDir, "bin/python"),
    pipPath: path.join(venvDir, "bin/pip"),
    hfPath: path.join(venvDir, "bin/hf"),
    uvicornPath: path.join(venvDir, "bin/uvicorn"),
    documentationIndexerDir,
    documentationVenvDir,
    documentationPythonPath: path.join(documentationVenvDir, "bin/python"),
    documentationPipPath: path.join(documentationVenvDir, "bin/pip"),
    documentationIndexerPath: path.join(documentationVenvDir, "bin/cloudx-documentation-indexer"),
    whisperCppDir,
    whisperCppModelDir,
    modelDir: env.CLOUDX_ASR_MODEL_PATH ?? path.join(home, ".cache/cloudx/models/faster-whisper-large-v3"),
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
        return command === "codex" || command === "node" || command === "npm" || command === "python3" || command === "curl" || command === "git";
      }
      if (runner.verbose) {
        runner.log(`$ command -v ${command}`);
        runner.logVerboseCommand();
      }
      const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
        stdio: runner.verbose ? ["ignore", "pipe", "pipe"] : "ignore",
        encoding: runner.verbose ? "utf8" : undefined
      });
      runner.logVerboseProcessResult(result);
      return processSucceeded(result);
    },
    which(command) {
      if (runner.dryRun) {
        return `/usr/bin/${command}`;
      }
      if (runner.verbose) {
        runner.log(`$ command -v ${command}`);
        runner.logVerboseCommand();
      }
      const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { encoding: "utf8" });
      runner.logVerboseProcessResult(result);
      if (result.status !== 0) {
        throw new Error(`Missing required command: ${command}`);
      }
      return result.stdout.trim();
    },
    statusOk(command, args) {
      return runner.statusOk(command, args);
    },
    capture(command, args, options) {
      if (runner.dryRun && command === "git" && args?.[0] === "--version") {
        runner.commands.push({ command, args, cwd: runner.cwd, capture: true });
        runner.log("$ git --version");
        runner.logVerboseCommand(options);
        return `git version ${MIN_WORKTREE_GIT_VERSION}`;
      }
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

function detectNvidiaGpuInfo(commands) {
  const output = commands.capture("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"]);
  return selectNvidiaGpuInfo(parseNvidiaGpuInfo(output));
}

function detectIntelGpu(commands) {
  if (!commands.exists("lspci")) {
    return false;
  }
  const output = commands.capture("lspci", []);
  return /intel.*(arc|dg2)|dg2.*intel/i.test(output);
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
      return parseBooleanChoice(label, raw);
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

export function updateEnvFileContent(content, updates) {
  const seen = new Set();
  const lines = content.split(/\r?\n/).filter((line, index, allLines) => index < allLines.length - 1 || line !== "");
  const updatedLines = lines.map((line) => {
    const separator = line.indexOf("=");
    if (separator === -1 || line.trim().startsWith("#")) {
      return line;
    }
    const key = line.slice(0, separator);
    if (!Object.hasOwn(updates, key)) {
      return line;
    }
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      updatedLines.push(`${key}=${value}`);
    }
  }
  return `${updatedLines.join("\n")}\n`;
}

export function toolPathFor(commandPath, npmPrefix, currentPath = "") {
  const entries = [];
  if (path.isAbsolute(commandPath)) {
    entries.push(path.dirname(commandPath));
  }
  if (npmPrefix) {
    entries.push(path.join(npmPrefix, "bin"));
  }
  entries.push(...String(currentPath).split(path.delimiter).filter(Boolean));
  return [...new Set(entries)].join(path.delimiter);
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
        .filter(([key]) => SAFE_VERBOSE_ENV_KEYS.includes(key))
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : "";
  return [envPrefix, command, ...args].filter(Boolean).join(" ");
}

function safeVerboseEnv(env) {
  return Object.fromEntries(SAFE_VERBOSE_ENV_KEYS.filter((key) => env[key]).map((key) => [key, env[key]]));
}

function processSucceeded(result) {
  return !result.error && result.status === 0 && !result.signal;
}

function commandFailure(command, args, result) {
  const reason = result.error?.message ?? (result.signal ? `signal ${result.signal}` : `exit code ${result.status ?? "unknown"}`);
  const error = new Error(`Command failed (${reason}): ${[command, ...args].join(" ")}`);
  error.status = result.status;
  error.signal = result.signal;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  return error;
}

function logVerboseBlock(log, label, value) {
  const text = String(value ?? "").trimEnd();
  if (!text) {
    return;
  }
  log(`[verbose] ${label}:`);
  for (const line of text.split(/\r?\n/)) {
    log(`  ${line}`);
  }
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
    const verbose = process.env.CLOUDX_INSTALL_VERBOSE === "1" || process.argv.includes("--verbose");
    console.error(verbose && error instanceof Error && error.stack ? error.stack : error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
