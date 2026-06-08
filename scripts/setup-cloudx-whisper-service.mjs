#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cudaPackages = ["nvidia-cublas-cu12", "nvidia-cudnn-cu12==9.*"];
const cuda12MinDriver = "525.60.13";
const smallGpuMemoryMb = 6 * 1024;
const nvidiaLibraryPathPython = "import os, nvidia.cublas.lib, nvidia.cudnn.lib; print(os.path.dirname(nvidia.cublas.lib.__file__) + ':' + os.path.dirname(nvidia.cudnn.lib.__file__))";
const home = os.homedir();
const asrDir = path.join(repoRoot, "services/asr");
const venvDir = path.join(asrDir, ".venv");
const pythonPath = path.join(venvDir, "bin/python");
const pipPath = path.join(venvDir, "bin/pip");
const uvicornPath = path.join(venvDir, "bin/uvicorn");
const documentationIndexerDir = path.join(repoRoot, "services/documentation-indexer");
const documentationVenvDir = path.join(documentationIndexerDir, ".venv");
const documentationPythonPath = path.join(documentationVenvDir, "bin/python");
const documentationPipPath = path.join(documentationVenvDir, "bin/pip");
const documentationIndexerPath = path.join(documentationVenvDir, "bin/cloudx-documentation-indexer");
const modelDir = process.env.CLOUDX_ASR_MODEL_PATH ?? path.join(home, ".cache/cloudx/models/faster-whisper-large-v3");
const configDir = path.join(home, ".config/cloudx");
const systemdDir = path.join(home, ".config/systemd/user");
const envPath = path.join(configDir, "cloudx.env");
const skipModel = process.argv.includes("--skip-model");
const noStart = process.argv.includes("--no-start");
const lan = process.argv.includes("--lan");
const forceCpu = process.argv.includes("--cpu");
const forceGpu = process.argv.includes("--gpu");
const host = lan ? "0.0.0.0" : process.env.CLOUDX_HOST?.trim() || "127.0.0.1";
const npmPath = findCommand("npm");
const nodePath = findCommand("node");
const python = findCommand("python3");
const device = resolveDevice();
const gpuInfo = readNvidiaGpuInfo();
const computeType = device === "cuda" ? gpuComputeType(gpuInfo?.memoryMb) : "int8";
const defaultCpuThreads = Math.max(1, Math.floor((typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length || 4) / 2));
const serviceNames = ["cloudx-asr.service", "cloudx-documentation.service", "cloudx.service"];

ensureRipgrep();
run(python, ["-m", "venv", "--upgrade-deps", venvDir]);
run(pipPath, ["install", "-e", `${asrDir}[dev]`, "huggingface_hub[cli]"]);
run(python, ["-m", "venv", "--upgrade-deps", documentationVenvDir]);
run(documentationPipPath, ["install", "--extra-index-url", "https://download.pytorch.org/whl/cpu", "-e", `${documentationIndexerDir}[dev]`]);
if (device === "cuda") {
  run(pipPath, ["install", ...cudaPackages]);
  run(documentationPipPath, ["install", ...cudaPackages]);
}

if (!skipModel) {
  fs.mkdirSync(modelDir, { recursive: true });
  if (!fs.existsSync(path.join(modelDir, "config.json"))) {
    run(path.join(venvDir, "bin/hf"), ["download", "Systran/faster-whisper-large-v3", "--local-dir", modelDir]);
  } else {
    console.log(`Faster Whisper large-v3 model already present at ${modelDir}`);
  }
}

run(npmPath, ["run", "build"]);
run(npmPath, ["run", "cert:create"]);

fs.mkdirSync(configDir, { recursive: true });
if (isNetworkBind(host)) {
  console.log(networkBindWarning(host));
}
fs.writeFileSync(
  envPath,
  [
    `CLOUDX_HOST=${host}`,
    `CLOUDX_PORT=3001`,
    `CLOUDX_ALLOWED_ROOTS=~`,
    `CLOUDX_DATA_DIR=${path.join(repoRoot, ".cloudx")}`,
    `CLOUDX_ASR_URL=http://127.0.0.1:7810`,
    `CLOUDX_ASR_MODEL_PATH=${modelDir}`,
    `CLOUDX_ASR_DEVICE=${device}`,
    `CLOUDX_ASR_COMPUTE_TYPE=${computeType}`,
    `CLOUDX_ASR_LANGUAGE=en`,
    `CLOUDX_ASR_CPU_THREADS=${defaultCpuThreads}`,
    `CLOUDX_ASR_NUM_WORKERS=1`,
    `CLOUDX_VOICE_DEBUG_TRANSCRIPTS=false`,
    `CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:7820`,
    `CLOUDX_DOCUMENTATION_HOST=127.0.0.1`,
    `CLOUDX_DOCUMENTATION_PORT=7820`,
    `CLOUDX_DOCUMENTATION_DATA_DIR=${path.join(repoRoot, ".cloudx/documentation")}`,
    `CLOUDX_DOCUMENTATION_ASR_BACKEND=faster-whisper`,
    ""
  ].join("\n")
);

fs.mkdirSync(systemdDir, { recursive: true });
fs.writeFileSync(
  path.join(systemdDir, "cloudx-asr.service"),
  [
    "[Unit]",
    "Description=Cloudx local Faster Whisper ASR",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${repoRoot}`,
    `EnvironmentFile=${envPath}`,
    `ExecStart=/bin/bash -lc ${shellQuote([
      cudaLibraryPathExport(pythonPath, "${CLOUDX_ASR_DEVICE:-cpu}"),
      `exec ${shellQuote(uvicornPath)} cloudx_asr.main:app --app-dir ${shellQuote(path.join(asrDir, "src"))} --host 127.0.0.1 --port 7810`
    ].join("; "))}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n")
);
fs.writeFileSync(
  path.join(systemdDir, "cloudx-documentation.service"),
  [
    "[Unit]",
    "Description=Cloudx documentation archive indexer",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${repoRoot}`,
    `EnvironmentFile=${envPath}`,
    `ExecStart=/bin/bash -lc ${shellQuote([
      cudaLibraryPathExport(documentationPythonPath, "${CLOUDX_DOCUMENTATION_ASR_DEVICE:-${CLOUDX_ASR_DEVICE:-cpu}}"),
      `exec ${shellQuote(documentationIndexerPath)}`
    ].join("; "))}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n")
);
fs.writeFileSync(
  path.join(systemdDir, "cloudx.service"),
  [
    "[Unit]",
    "Description=Cloudx web workbench",
    "After=network-online.target cloudx-asr.service cloudx-documentation.service",
    "Wants=cloudx-asr.service cloudx-documentation.service",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${repoRoot}`,
    `EnvironmentFile=${envPath}`,
    `ExecStartPre=${nodePath} ${path.join(repoRoot, "scripts/create-local-cert.mjs")}`,
    `ExecStart=${npmPath} run start -w @cloudx/server`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillSignal=SIGINT",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n")
);

run("systemctl", ["--user", "daemon-reload"]);
run("systemctl", ["--user", "enable", ...serviceNames]);
if (!noStart) {
  run("systemctl", ["--user", "restart", ...serviceNames]);
}

console.log("Cloudx whisper service setup complete.");
console.log(`  env: ${envPath}`);
console.log(`  ASR model: ${modelDir}`);
console.log(`  Cloudx URL: https://127.0.0.1:3001`);
console.log(`  status: systemctl --user status ${serviceNames.join(" ")}`);

function isNetworkBind(value) {
  const normalized = String(value).trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function networkBindWarning(value) {
  return [
    "",
    "======================================================================",
    "WARNING: Cloudx is configured for network access.",
    `CLOUDX_HOST=${value} exposes this shell-controlling service beyond localhost.`,
    "Use only on a trusted LAN or private tailnet. Public internet unsupported.",
    "======================================================================",
    ""
  ].join("\n");
}

function resolveDevice() {
  if (forceCpu && forceGpu) {
    throw new Error("Use only one of --cpu or --gpu.");
  }
  if (forceCpu) {
    return "cpu";
  }
  if (forceGpu) {
    assertCuda12Driver();
    return "cuda";
  }
  if (spawnSync("nvidia-smi", [], { stdio: "ignore" }).status !== 0) {
    return "cpu";
  }
  return supportsCuda12Driver(readNvidiaGpuInfo()?.driverVersion) ? "cuda" : "cpu";
}

function readNvidiaGpuInfo() {
  const result = spawnSync("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8" });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [name = "", driverVersion = "", memoryText = ""] = line.split(",").map((part) => part.trim());
      const memoryMb = Number.parseInt(memoryText.replace(/[^\d]/g, ""), 10);
      return { name, driverVersion, memoryMb: Number.isFinite(memoryMb) ? memoryMb : undefined };
    })
    .sort((left, right) => (right.memoryMb ?? 0) - (left.memoryMb ?? 0))[0];
}

function supportsCuda12Driver(driverVersion) {
  return compareVersions(driverVersion, cuda12MinDriver) >= 0;
}

function assertCuda12Driver() {
  const driverVersion = readNvidiaGpuInfo()?.driverVersion;
  if (!supportsCuda12Driver(driverVersion)) {
    throw new Error(`GPU mode requires an NVIDIA driver compatible with CUDA 12. Install driver ${cuda12MinDriver} or newer.`);
  }
}

function gpuComputeType(memoryMb) {
  return memoryMb === undefined || memoryMb < smallGpuMemoryMb ? "int8_float16" : "float16";
}

function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
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

function parseVersion(value) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value));
  return match ? [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3] ?? "0", 10)] : undefined;
}

function cudaLibraryPathExport(pythonExecutable, deviceExpression) {
  return `if [ "${deviceExpression}" = "cuda" ]; then export LD_LIBRARY_PATH="$(${shellQuote(pythonExecutable)} -c ${shellQuote(nvidiaLibraryPathPython)})\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function findCommand(name) {
  const result = spawnSync("sh", ["-lc", `command -v ${name}`], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Missing required command: ${name}`);
  }
  return result.stdout.trim();
}

function ensureRipgrep() {
  const existing = spawnSync("sh", ["-lc", "command -v rg"], { encoding: "utf8" });
  if (existing.status === 0) {
    console.log(`ripgrep already available: ${existing.stdout.trim()}`);
    return;
  }
  if (spawnSync("sh", ["-lc", "command -v apt-get"], { stdio: "ignore" }).status === 0) {
    run("sudo", ["apt-get", "update"]);
    run("sudo", ["apt-get", "install", "-y", "ripgrep"]);
    return;
  }
  throw new Error("Missing required command: rg. Install ripgrep with your system package manager, for example `sudo apt install ripgrep` on Debian/Ubuntu.");
}

function run(command, args) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { cwd: repoRoot, stdio: "inherit" });
}
