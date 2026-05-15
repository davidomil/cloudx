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
    noStart: false
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
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown installer option: ${arg}`);
    }
  }
  return options;
}

export function helpText() {
  return [
    "Cloudx installer wizard",
    "",
    "Usage: ./install.sh [options]",
    "       node scripts/install-cloudx.mjs [options]",
    "",
    "Options:",
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

export class InstallerRunner {
  constructor({ dryRun = false, cwd = repoRoot, log = console.log } = {}) {
    this.dryRun = dryRun;
    this.cwd = cwd;
    this.log = log;
    this.commands = [];
    this.writes = [];
  }

  run(command, args = [], options = {}) {
    const display = [command, ...args].join(" ");
    this.commands.push({ command, args, cwd: options.cwd ?? this.cwd });
    this.log(`$ ${display}`);
    if (this.dryRun) {
      return "";
    }
    execFileSync(command, args, {
      cwd: options.cwd ?? this.cwd,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: options.capture ? "utf8" : undefined,
      env: options.env ? { ...process.env, ...options.env } : process.env
    });
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

  const paths = installerPaths({ repoRoot: root, home });
  const commands = commandMap(runner);
  const gpuDetected = options.gpuDetected ?? commands.exists("nvidia-smi");
  const cudaRuntimeReady = options.cudaRuntimeReady ?? detectCudaRuntime(commands);
  const parallelism = options.parallelism ?? defaultParallelism();
  const defaultThreads = defaultCpuThreads(parallelism);

  console.log("Cloudx installer wizard");
  console.log(`Ubuntu target: ${osRelease.PRETTY_NAME ?? osRelease.VERSION_ID ?? "unknown"}`);

  await ensureCodex(commands, prompt);

  const allowedRoots = await prompt.text("allowedRoots", "Allowed workspace roots", "~");
  const port = await prompt.integer("port", "Cloudx HTTPS port", 3001, { min: 1, max: 65_535 });
  const certHosts = await prompt.text("certificateHosts", "Additional certificate hostnames (comma-separated, blank for none)", "");
  const cpuThreads = validateCpuThreads(await prompt.integer("cpuThreads", "ASR CPU threads", defaultThreads, { min: 1, max: parallelism }), parallelism);
  const useGpu = gpuDetected ? await prompt.boolean("useGpu", "NVIDIA GPU detected. Use it for ASR?", false) : false;
  const device = resolveDeviceConfig({ gpuDetected, useGpu, cudaRuntimeReady });
  const installServices = await prompt.boolean("installServices", "Install Cloudx user-level systemd services?", true);
  const startServices = installServices ? !options.noStart && (await prompt.boolean("startServices", "Start Cloudx services after install?", true)) : false;
  const enableLinger = installServices ? await prompt.boolean("enableLinger", "Enable user lingering so services survive logout and can start before login?", true) : false;

  commands.run("npm", ["ci"]);
  setupAsr(commands, paths);
  downloadModel(commands, paths);
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
  runner.writeFile(paths.envPath, renderEnvFile(envConfig));

  if (installServices) {
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
  }

  await prompt.close();
  console.log("Cloudx installer complete.");
  console.log(`  env: ${paths.envPath}`);
  console.log(`  ASR model: ${paths.modelDir}`);
  if (installServices) {
    console.log("  status: systemctl --user status cloudx.service cloudx-asr.service");
  } else {
    console.log("  run: npm run dev");
  }
  return { runner, paths, envConfig, installServices, startServices, enableLinger };
}

function setupAsr(commands, paths) {
  commands.run("python3", ["-m", "venv", "--upgrade-deps", paths.venvDir]);
  commands.run(paths.pipPath, ["install", "-e", `${paths.asrDir}[dev]`, "huggingface_hub[cli]"]);
}

function downloadModel(commands, paths) {
  if (fs.existsSync(path.join(paths.modelDir, "config.json"))) {
    console.log(`Faster Whisper large-v3 model already present at ${paths.modelDir}`);
    return;
  }
  commands.mkdir(paths.modelDir);
  commands.run(paths.hfPath, ["download", ASR_MODEL_ID, "--local-dir", paths.modelDir]);
}

function installSystemdServices(commands, runner, paths) {
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
  commands.run("systemctl", ["--user", "is-enabled", ...SERVICE_NAMES]);
  commands.run("curl", ["-fsSk", `https://127.0.0.1:${port}/api/health`]);
  commands.run("curl", ["-fsS", "http://127.0.0.1:7810/health"]);
}

async function ensureCodex(commands, prompt) {
  if (!commands.exists("codex")) {
    commands.run("npm", ["i", "-g", "@openai/codex@latest"]);
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

function defaultParallelism() {
  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length || 4;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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
