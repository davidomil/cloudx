#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const asrDir = path.join(repoRoot, "services/asr");
const venvDir = path.join(asrDir, ".venv");
const pythonPath = path.join(venvDir, "bin/python");
const pipPath = path.join(venvDir, "bin/pip");
const uvicornPath = path.join(venvDir, "bin/uvicorn");
const modelDir = process.env.CLOUDX_ASR_MODEL_PATH ?? path.join(home, ".cache/cloudx/models/faster-whisper-large-v3");
const configDir = path.join(home, ".config/cloudx");
const systemdDir = path.join(home, ".config/systemd/user");
const envPath = path.join(configDir, "cloudx.env");
const skipModel = process.argv.includes("--skip-model");
const noStart = process.argv.includes("--no-start");
const forceCpu = process.argv.includes("--cpu");
const forceGpu = process.argv.includes("--gpu");
const npmPath = findCommand("npm");
const nodePath = findCommand("node");
const python = findCommand("python3");
const device = resolveDevice();
const computeType = device === "cuda" ? "float16" : "int8";
const defaultCpuThreads = Math.max(1, Math.floor((typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length || 4) / 2));

ensureRipgrep();
run(python, ["-m", "venv", "--upgrade-deps", venvDir]);
run(pipPath, ["install", "-e", `${asrDir}[dev]`, "huggingface_hub[cli]"]);

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
fs.writeFileSync(
  envPath,
  [
    `CLOUDX_HOST=0.0.0.0`,
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
    `ExecStart=${uvicornPath} cloudx_asr.main:app --app-dir ${path.join(asrDir, "src")} --host 127.0.0.1 --port 7810`,
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
    "After=network-online.target cloudx-asr.service",
    "Wants=cloudx-asr.service",
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
run("systemctl", ["--user", "enable", "cloudx-asr.service", "cloudx.service"]);
if (!noStart) {
  run("systemctl", ["--user", "restart", "cloudx-asr.service", "cloudx.service"]);
}

console.log("Cloudx whisper service setup complete.");
console.log(`  env: ${envPath}`);
console.log(`  ASR model: ${modelDir}`);
console.log("  status: systemctl --user status cloudx.service cloudx-asr.service");

function resolveDevice() {
  if (forceCpu && forceGpu) {
    throw new Error("Use only one of --cpu or --gpu.");
  }
  if (forceCpu) {
    return "cpu";
  }
  if (forceGpu) {
    return "cuda";
  }
  return spawnSync("nvidia-smi", [], { stdio: "ignore" }).status === 0 ? "cuda" : "cpu";
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
