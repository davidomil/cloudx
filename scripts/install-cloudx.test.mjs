import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  CUDA_12_MIN_DRIVER_VERSION,
  FASTER_WHISPER_CUDA_PIP_PACKAGES,
  GIT_CORE_PPA,
  InstallerRunner,
  MIN_WORKTREE_GIT_VERSION,
  PYTORCH_CPU_WHEEL_INDEX,
  QUARTO_DEB_PATH,
  QUARTO_DEB_URL,
  QUARTO_VERSION,
  WHISPER_CPP_MODEL,
  WHISPER_CPP_REPO_URL,
  WHISPER_CPP_VAD_MODEL,
  assertQuartoArchitecture,
  cloudxAccessUrls,
  defaultCpuThreads,
  ensureSupportedGit,
  installUbuntuPrerequisites,
  parseNvidiaGpuInfo,
  needsGitUpgrade,
  needsNodeInstall,
  needsQuartoInstall,
  networkBindWarning,
  normalizeWhisperCppBuild,
  helpText,
  parseGitVersion,
  parseArgs,
  parseNodeMajor,
  parseOsRelease,
  renderAsrService,
  renderCloudxService,
  renderDocumentationService,
  renderEnvFile,
  resolveDeviceConfig,
  runInstaller,
  selectNvidiaGpuInfo,
  shouldAdvertiseLanUrls,
  supportsCuda12Driver,
  toolPathFor,
  ubuntuBootstrapPlan,
  updateEnvFileContent,
  validateCpuThreads
} from "./install-cloudx.mjs";

const TEST_ENV = { PATH: "/usr/bin" };

describe("install-cloudx helpers", () => {
  it("parses and advertises verbose installer diagnostics", () => {
    expect(parseArgs(["--dry-run", "--update", "--verbose"])).toMatchObject({
      dryRun: true,
      update: true,
      verbose: true
    });
    expect(helpText()).toContain("--verbose");
  });

  it("parses Ubuntu os-release files", () => {
    expect(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\n')).toMatchObject({
      ID: "ubuntu",
      VERSION_ID: "24.04",
      PRETTY_NAME: "Ubuntu 24.04.4 LTS"
    });
  });

  it("decides when Node needs to be installed", () => {
    expect(parseNodeMajor("v22.22.3")).toBe(22);
    expect(needsNodeInstall("v20.20.2", true)).toBe(true);
    expect(needsNodeInstall("v22.22.3", false)).toBe(true);
    expect(needsNodeInstall("v24.15.0", true)).toBe(false);
    expect(needsQuartoInstall(QUARTO_VERSION)).toBe(false);
    expect(needsQuartoInstall("1.8.25")).toBe(true);
    expect(() => assertQuartoArchitecture("arm64")).toThrow(/linux-amd64/);
  });

  it("builds the Ubuntu bootstrap command plan", () => {
    const commands = ubuntuBootstrapPlan({ nodeVersionText: "v20.0.0", hasNpm: true });

    expect(commands[0]).toEqual(["sudo", "apt-get", "update"]);
    expect(commands[1]).toContain("build-essential");
    expect(commands[1]).toContain("cmake");
    expect(commands[1]).toContain("pciutils");
    expect(commands[1]).toContain("gpg-agent");
    expect(commands[1]).toContain("wget");
    expect(commands[1]).toContain("libreoffice");
    expect(commands[1]).toContain("poppler-utils");
    expect(commands[1]).toContain("ffmpeg");
    expect(commands[1]).toContain("pandoc");
    expect(commands[1]).toContain("software-properties-common");
    expect(commands[1]).toContain("texlive-xetex");
    expect(commands[1]).toContain("jq");
    expect(commands).toContainEqual(["curl", "-fL", "-o", QUARTO_DEB_PATH, QUARTO_DEB_URL]);
    expect(commands).toContainEqual(["sudo", "apt-get", "install", "-y", QUARTO_DEB_PATH]);
    expect(commands).toContainEqual(["sudo", "apt-get", "install", "-y", "nodejs"]);
    expect(commands).toContainEqual(["sh", "-lc", "command -v npm >/dev/null 2>&1 || sudo apt-get install -y npm"]);
    expect(commands).toContainEqual(["node", "-v"]);
    expect(commands).toContainEqual(["npm", "-v"]);
    expect(commands).toContainEqual(["quarto", "--version"]);
    expect(commands).toContainEqual(["pandoc", "--version"]);
    expect(commands).toContainEqual(["xelatex", "--version"]);
    expect(commands).toContainEqual(["lualatex", "--version"]);
  });

  it("skips the Quarto .deb download when the pinned version is already installed", () => {
    const commands = ubuntuBootstrapPlan({ nodeVersionText: "v22.0.0", hasNpm: true, quartoVersionText: QUARTO_VERSION });

    expect(commands).not.toContainEqual(["curl", "-fL", "-o", QUARTO_DEB_PATH, QUARTO_DEB_URL]);
    expect(commands).not.toContainEqual(["sudo", "apt-get", "install", "-y", QUARTO_DEB_PATH]);
    expect(commands).toContainEqual(["quarto", "--version"]);
  });

  it("plans npm fallback when Node is current but npm is missing", () => {
    const commands = ubuntuBootstrapPlan({ nodeVersionText: "v22.0.0", hasNpm: false });

    expect(commands).not.toContainEqual(["sudo", "apt-get", "install", "-y", "nodejs"]);
    expect(commands).toContainEqual(["sh", "-lc", "command -v npm >/dev/null 2>&1 || sudo apt-get install -y npm"]);
    expect(commands).toContainEqual(["npm", "-v"]);
  });

  it("detects Git versions that are too old for worktree porcelain NUL output", () => {
    expect(parseGitVersion("git version 2.34.1")).toEqual([2, 34, 1]);
    expect(needsGitUpgrade("git version 2.34.1")).toBe(true);
    expect(needsGitUpgrade(`git version ${MIN_WORKTREE_GIT_VERSION}`)).toBe(false);
    expect(needsGitUpgrade("git version 2.53.0")).toBe(false);
  });

  it("offers the Git stable PPA when the installed Git is too old", async () => {
    const planned = [];
    let gitVersion = "git version 2.34.1";

    const result = await ensureSupportedGit(
      {
        exists: (command) => command === "git",
        capture: () => gitVersion,
        run: (command, args) => {
          planned.push([command, ...args]);
          if (command === "sudo" && args[0] === "apt-get" && args.at(-1) === "git") {
            gitVersion = "git version 2.53.0";
          }
        }
      },
      {
        boolean: async (key) => {
          expect(key).toBe("upgradeGit");
          return true;
        }
      }
    );

    expect(result).toMatchObject({ upgraded: true, versionText: "git version 2.53.0" });
    expect(planned).toEqual([
      ["sudo", "apt-get", "install", "-y", "software-properties-common"],
      ["sudo", "add-apt-repository", GIT_CORE_PPA, "-y"],
      ["sudo", "apt-get", "update"],
      ["sudo", "apt-get", "install", "-y", "git"]
    ]);
  });

  it("checks current Node and npm before building a direct wizard bootstrap plan", () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    installUbuntuPrerequisites({
      exists: (command) => command === "npm",
      capture: () => "",
      run: runner.run.bind(runner)
    });

    expect(runner.commands.map((command) => [command.command, ...command.args])).toEqual(
      expect.arrayContaining([
        ["sudo", "apt-get", "install", "-y", "nodejs"],
        ["sh", "-lc", "command -v npm >/dev/null 2>&1 || sudo apt-get install -y npm"],
        ["node", "-v"],
        ["npm", "-v"]
      ])
    );
  });

  it("builds local-only access URLs by default", () => {
    expect(
      cloudxAccessUrls(3001, {
        lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
        eth0: [{ family: "IPv4", internal: false, address: "192.0.2.249" }]
      })
    ).toEqual(["https://127.0.0.1:3001"]);
  });

  it("builds LAN access URLs for network-facing hosts", () => {
    expect(
      cloudxAccessUrls(3001, {
        lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
        eth0: [{ family: "IPv4", internal: false, address: "192.0.2.249" }],
        docker0: [{ family: "IPv4", internal: false, address: "198.51.100.17" }]
      }, "0.0.0.0")
    ).toEqual(["https://127.0.0.1:3001", "https://192.0.2.249:3001", "https://198.51.100.17:3001"]);
    expect(shouldAdvertiseLanUrls("127.0.0.1")).toBe(false);
    expect(shouldAdvertiseLanUrls("::")).toBe(true);
    expect(networkBindWarning("0.0.0.0", 3001)).toContain("Public internet unsupported");
  });

  it("validates CPU thread choices", () => {
    expect(defaultCpuThreads(12)).toBe(6);
    expect(validateCpuThreads("8", 12)).toBe(8);
    expect(() => validateCpuThreads("0", 12)).toThrow(/CPU threads/);
    expect(() => validateCpuThreads("13", 12)).toThrow(/CPU threads/);
  });

  it("resolves CPU and GPU ASR device configuration", () => {
    const t400 = selectNvidiaGpuInfo(parseNvidiaGpuInfo("NVIDIA T400, 595.57.01, 4096"));
    expect(t400).toMatchObject({ name: "NVIDIA T400", driverVersion: "595.57.01", memoryMb: 4096 });
    expect(supportsCuda12Driver(t400.driverVersion)).toBe(true);
    expect(supportsCuda12Driver("520.61.05")).toBe(false);
    expect(CUDA_12_MIN_DRIVER_VERSION).toBe("525.60.13");
    expect(resolveDeviceConfig({ gpuDetected: true, nvidiaGpuInfo: t400 })).toEqual({
      device: "cuda",
      computeType: "int8_float16"
    });
    expect(resolveDeviceConfig({ gpuDetected: true, nvidiaGpuInfo: { name: "RTX", driverVersion: "595.57.01", memoryMb: 12_288 } })).toEqual({
      device: "cuda",
      computeType: "float16"
    });
    expect(resolveDeviceConfig({ gpuDetected: true, cudaRuntimeReady: false })).toEqual({
      device: "cpu",
      computeType: "int8"
    });
    expect(resolveDeviceConfig({ gpuDetected: true, useGpu: false, cudaRuntimeReady: false })).toEqual({
      device: "cpu",
      computeType: "int8"
    });
    expect(resolveDeviceConfig({ gpuDetected: true, useGpu: true, cudaRuntimeReady: true })).toEqual({
      device: "cuda",
      computeType: "int8_float16"
    });
    expect(() => resolveDeviceConfig({ gpuDetected: true, useGpu: true, nvidiaGpuInfo: { name: "Old NVIDIA", driverVersion: "520.61.05", memoryMb: 8192 } })).toThrow(/CUDA 12 minimum/);
    expect(normalizeWhisperCppBuild("SYCL")).toBe("sycl");
    expect(() => normalizeWhisperCppBuild("vulkan")).toThrow(/cpu or sycl/);
  });

  it("renders env and systemd units", () => {
    const env = renderEnvFile({
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: "~",
      dataDir: "/repo/.cloudx",
      assistantBin: "/usr/bin/codex",
      toolPath: "/usr/bin",
      modelDir: "/home/me/.cache/cloudx/models/faster-whisper-large-v3",
      device: "cpu",
      computeType: "int8",
      language: "en",
      cpuThreads: 6
    });
    expect(env).toContain("CLOUDX_ASR_CPU_THREADS=6");
    expect(env).toContain("CLOUDX_ASR_DEVICE=cpu");
    expect(env).toContain("CLOUDX_LOG_LEVEL=info");
    expect(env).toContain("CLOUDX_ASSISTANT_BIN=/usr/bin/codex");
    expect(env).toContain("CLOUDX_TOOL_PATH=/usr/bin");
    expect(env).toContain("CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:7820");
    expect(env).toContain("CLOUDX_DOCUMENTATION_HOST=127.0.0.1");
    expect(env).toContain("CLOUDX_DOCUMENTATION_DATA_DIR=/repo/.cloudx/documentation");
    expect(env).not.toContain("CLOUDX_CODEX_BIN");

    expect(renderAsrService({ repoRoot: "/repo", envPath: "/home/me/.config/cloudx/cloudx.env", pythonPath: "/repo/services/asr/.venv/bin/python", uvicornPath: "/repo/services/asr/.venv/bin/uvicorn", asrDir: "/repo/services/asr" })).toContain(
      "cloudx_asr.main:app"
    );
    expect(renderAsrService({ repoRoot: "/repo", envPath: "/home/me/.config/cloudx/cloudx.env", pythonPath: "/repo/services/asr/.venv/bin/python", uvicornPath: "/repo/services/asr/.venv/bin/uvicorn", asrDir: "/repo/services/asr" })).toContain(
      "nvidia.cublas.lib"
    );
    expect(renderCloudxService({ repoRoot: "/repo", envPath: "/home/me/.config/cloudx/cloudx.env", nodePath: "/usr/bin/node", npmPath: "/usr/bin/npm" })).toContain(
      "npm run start -w @cloudx/server"
    );
    expect(renderCloudxService({ repoRoot: "/repo", envPath: "/home/me/.config/cloudx/cloudx.env", nodePath: "/usr/bin/node", npmPath: "/usr/bin/npm" })).toContain(
      "Wants=cloudx-asr.service cloudx-documentation.service"
    );
    expect(renderDocumentationService({ repoRoot: "/repo", envPath: "/home/me/.config/cloudx/cloudx.env", documentationPythonPath: "/repo/services/documentation-indexer/.venv/bin/python", documentationIndexerPath: "/repo/services/documentation-indexer/.venv/bin/cloudx-documentation-indexer" })).toContain(
      "cloudx-documentation-indexer"
    );
  });

  it("updates existing env files without dropping user choices", () => {
    expect(updateEnvFileContent("CLOUDX_PORT=3001\nCLOUDX_ASSISTANT_BIN=/old/codex\n", { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex" })).toBe(
      "CLOUDX_PORT=3001\nCLOUDX_ASSISTANT_BIN=/usr/bin/codex\n"
    );
    expect(updateEnvFileContent("CLOUDX_PORT=3001\n", { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex" })).toBe("CLOUDX_PORT=3001\nCLOUDX_ASSISTANT_BIN=/usr/bin/codex\n");
  });

  it("builds tool path entries from the assistant command and npm global prefix", () => {
    expect(toolPathFor("/home/me/.npm-global/bin/codex", "/usr", `/opt/homebrew/bin${path.delimiter}/usr/bin`)).toBe(
      `/home/me/.npm-global/bin${path.delimiter}/usr/bin${path.delimiter}/opt/homebrew/bin`
    );
    expect(toolPathFor("/usr/bin/codex", "/usr")).toBe("/usr/bin");
  });

  it("prints verbose cwd, safe env, stdout, and stderr for captured commands", () => {
    const logs = [];
    const runner = new InstallerRunner({ cwd: "/tmp", log: (line) => logs.push(line), verbose: true });

    const output = runner.capture(process.execPath, ["-e", "console.log('probe stdout'); console.error('probe stderr')"], {
      env: {
        CLOUDX_HOST: "127.0.0.1",
        CLOUDX_LOG_LEVEL: "debug",
        SECRET_TOKEN: "do-not-print"
      }
    });

    expect(output).toBe("probe stdout");
    const logText = logs.join("\n");
    expect(logText).toContain("[verbose] cwd: /tmp");
    expect(logText).toContain("[verbose] env: CLOUDX_HOST=127.0.0.1");
    expect(logText).toContain("CLOUDX_LOG_LEVEL=debug");
    expect(logText).not.toContain("SECRET_TOKEN");
    expect(logText).toContain("[verbose] stdout:\n  probe stdout");
    expect(logText).toContain("[verbose] stderr:\n  probe stderr");
  });

  it("prints captured stdout and stderr before throwing in verbose mode", () => {
    const logs = [];
    const runner = new InstallerRunner({ cwd: "/tmp", log: (line) => logs.push(line), verbose: true });

    expect(() => runner.capture(process.execPath, ["-e", "console.log('before failure'); console.error('failure detail'); process.exit(7)"])).toThrow(/exit code 7/);
    const logText = logs.join("\n");
    expect(logText).toContain("[verbose] stdout:\n  before failure");
    expect(logText).toContain("[verbose] stderr:\n  failure detail");
  });

  it("keeps captured output quiet by default", () => {
    const logs = [];
    const runner = new InstallerRunner({ cwd: "/tmp", log: (line) => logs.push(line) });

    expect(runner.capture(process.execPath, ["-e", "console.log('quiet stdout')"])).toBe("quiet stdout");
    expect(logs.join("\n")).not.toContain("[verbose]");
  });

  it("routes status probes through verbose runner diagnostics", () => {
    const logs = [];
    const runner = new InstallerRunner({ cwd: "/tmp", log: (line) => logs.push(line), verbose: true });

    expect(runner.statusOk(process.execPath, ["-e", "console.error('status stderr'); process.exit(9)"])).toBe(false);
    const logText = logs.join("\n");
    expect(logText).toContain("$ ");
    expect(logText).toContain("[verbose] cwd: /tmp");
    expect(logText).toContain("[verbose] stderr:\n  status stderr");
  });

  it("accepts verbose in the shell bootstrap and forwards it to the Node wizard", () => {
    const shellScript = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");

    execFileSync("bash", ["-n", "install.sh"], { cwd: process.cwd(), stdio: "pipe" });
    expect(shellScript).toContain('elif [[ "$arg" == "--verbose" ]]; then');
    expect(shellScript).toContain("export CLOUDX_INSTALL_VERBOSE=1");
    expect(shellScript).toContain("set -x");
    expect(shellScript).toContain('exec node scripts/install-cloudx.mjs "$@"');
  });
});

describe("runInstaller dry-run", () => {
  it("plans a CPU install without services", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04", PRETTY_NAME: "Ubuntu 24.04 LTS" },
      gpuDetected: false,
      cudaRuntimeReady: false,
      parallelism: 12,
      answers: {
        installServices: false,
        runCodexLogin: true
      },
      networkInterfaces: {
        eth0: [{ family: "IPv4", internal: false, address: "192.0.2.249" }]
      }
    });

    expect(result.installServices).toBe(false);
    expect(result.urls).toEqual(["https://127.0.0.1:3001"]);
    expect(result.envConfig).toMatchObject({ host: "127.0.0.1", device: "cpu", computeType: "int8", cpuThreads: 6, documentationUrl: "http://127.0.0.1:7820" });
    expect(runner.commands.map((command) => [command.command, ...command.args])).toEqual(
      expect.arrayContaining([
        ["node", "-v"],
        ["npm", "-v"],
        ["npm", "ci"],
        ["python3", "-m", "venv", "--upgrade-deps", "/repo/services/documentation-indexer/.venv"],
        [
          "/repo/services/documentation-indexer/.venv/bin/pip",
          "install",
          "--extra-index-url",
          PYTORCH_CPU_WHEEL_INDEX,
          "-e",
          "/repo/services/documentation-indexer[dev]"
        ],
        ["/repo/services/asr/.venv/bin/hf", "download", "Systran/faster-whisper-large-v3", "--local-dir", "/home/me/.cache/cloudx/models/faster-whisper-large-v3"],
        ["npm", "run", "build"]
      ])
    );
    const env = runner.writes.find((write) => write.path === "/home/me/.config/cloudx/cloudx.env")?.contents;
    expect(env).toContain("CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:7820");
  });

  it("plans an auto-detected NVIDIA T400 install with CUDA ASR libraries", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "22.04", PRETTY_NAME: "Ubuntu 22.04 LTS" },
      gpuDetected: true,
      nvidiaGpuInfo: { name: "NVIDIA T400", driverVersion: "595.57.01", memoryMb: 4096 },
      cudaRuntimeReady: false,
      parallelism: 12,
      answers: {
        installServices: false,
        runCodexLogin: true
      }
    });

    const planned = runner.commands.map((command) => [command.command, ...command.args]);
    expect(result.envConfig).toMatchObject({ device: "cuda", computeType: "int8_float16" });
    expect(planned).toContainEqual(["/repo/services/asr/.venv/bin/pip", "install", ...FASTER_WHISPER_CUDA_PIP_PACKAGES]);
    expect(planned).toContainEqual(["/repo/services/documentation-indexer/.venv/bin/pip", "install", ...FASTER_WHISPER_CUDA_PIP_PACKAGES]);
    const env = runner.writes.find((write) => write.path === "/home/me/.config/cloudx/cloudx.env")?.contents;
    expect(env).toContain("CLOUDX_ASR_DEVICE=cuda");
    expect(env).toContain("CLOUDX_ASR_COMPUTE_TYPE=int8_float16");
  });

  it("uses an explicit LAN bind when requested", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      lan: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04", PRETTY_NAME: "Ubuntu 24.04 LTS" },
      gpuDetected: false,
      cudaRuntimeReady: false,
      parallelism: 12,
      answers: {
        installServices: false,
        runCodexLogin: true
      },
      networkInterfaces: {
        eth0: [{ family: "IPv4", internal: false, address: "192.0.2.249" }]
      }
    });

    expect(result.envConfig.host).toBe("0.0.0.0");
    expect(result.urls).toEqual(["https://127.0.0.1:3001", "https://192.0.2.249:3001"]);
  });

  it("uses the installer LAN prompt for trusted tailnet access", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04", PRETTY_NAME: "Ubuntu 24.04 LTS" },
      gpuDetected: false,
      cudaRuntimeReady: false,
      parallelism: 12,
      answers: {
        bindLan: true,
        installServices: false,
        runCodexLogin: true
      },
      networkInterfaces: {
        tailscale0: [{ family: "IPv4", internal: false, address: "100.64.0.24" }]
      }
    });

    expect(result.envConfig.host).toBe("0.0.0.0");
    expect(result.urls).toEqual(["https://127.0.0.1:3001", "https://100.64.0.24:3001"]);
  });

  it("can return an existing network bind environment to localhost", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: { ...TEST_ENV, CLOUDX_HOST: "0.0.0.0" },
      dryRun: true,
      yes: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04", PRETTY_NAME: "Ubuntu 24.04 LTS" },
      gpuDetected: false,
      cudaRuntimeReady: false,
      parallelism: 12,
      answers: {
        bindLan: false,
        installServices: false,
        runCodexLogin: true
      },
      networkInterfaces: {
        eth0: [{ family: "IPv4", internal: false, address: "192.0.2.249" }]
      }
    });

    expect(result.envConfig.host).toBe("127.0.0.1");
    expect(result.urls).toEqual(["https://127.0.0.1:3001"]);
  });

  it("plans optional whisper.cpp documentation ASR installation", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04", PRETTY_NAME: "Ubuntu 24.04 LTS" },
      gpuDetected: false,
      cudaRuntimeReady: false,
      intelGpuDetected: true,
      parallelism: 12,
      answers: {
        installWhisperCpp: true,
        whisperCppBuild: "sycl",
        installServices: false,
        runCodexLogin: true
      }
    });

    const planned = runner.commands.map((command) => [command.command, ...command.args]);
    expect(result.envConfig.documentationAsrBackend).toBe("whisper-cpp");
    expect(result.envConfig.whisperCpp).toMatchObject({
      build: "sycl",
      model: WHISPER_CPP_MODEL,
      bin: "/home/me/.local/share/cloudx/whisper.cpp/build-sycl/bin/whisper-cli",
      modelPath: "/home/me/.cache/cloudx/models/whisper.cpp/ggml-large-v3-turbo.bin",
      vadModelPath: "/home/me/.cache/cloudx/models/whisper.cpp/ggml-silero-v6.2.0.bin"
    });
    expect(planned).toContainEqual([
      "bash",
      "-lc",
      "wget -O- https://apt.repos.intel.com/intel-gpg-keys/GPG-PUB-KEY-INTEL-SW-PRODUCTS.PUB | gpg --dearmor | sudo tee /usr/share/keyrings/oneapi-archive-keyring.gpg > /dev/null"
    ]);
    expect(planned).toContainEqual([
      "sudo",
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
    expect(planned).toContainEqual(["git", "clone", "--depth", "1", WHISPER_CPP_REPO_URL, "/home/me/.local/share/cloudx/whisper.cpp"]);
    expect(planned).toContainEqual([
      "bash",
      "-lc",
      "source /opt/intel/oneapi/setvars.sh >/dev/null && cmake -B '/home/me/.local/share/cloudx/whisper.cpp/build-sycl' -S '/home/me/.local/share/cloudx/whisper.cpp' -DGGML_SYCL=ON -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx && cmake --build '/home/me/.local/share/cloudx/whisper.cpp/build-sycl' -j --config Release --target whisper-cli"
    ]);
    expect(planned).toContainEqual([
      "bash",
      "/home/me/.local/share/cloudx/whisper.cpp/models/download-ggml-model.sh",
      "large-v3-turbo",
      "/home/me/.cache/cloudx/models/whisper.cpp"
    ]);
    expect(planned).toContainEqual([
      "bash",
      "/home/me/.local/share/cloudx/whisper.cpp/models/download-vad-model.sh",
      WHISPER_CPP_VAD_MODEL,
      "/home/me/.cache/cloudx/models/whisper.cpp"
    ]);
    const env = runner.writes.find((write) => write.path === "/home/me/.config/cloudx/cloudx.env")?.contents;
    expect(env).toContain("CLOUDX_DOCUMENTATION_ASR_BACKEND=whisper-cpp");
    expect(env).toContain("CLOUDX_DOCUMENTATION_WHISPER_CPP_BUILD=sycl");
    expect(env).toContain("CLOUDX_ASR_BACKEND=whisper-cpp");
    expect(env).toContain("CLOUDX_ASR_WHISPER_CPP_MODEL_PATH=/home/me/.cache/cloudx/models/whisper.cpp/ggml-large-v3-turbo.bin");
    expect(env).toContain("CLOUDX_ASR_WHISPER_CPP_VAD=true");
    expect(env).toContain("CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH=/home/me/.cache/cloudx/models/whisper.cpp/ggml-silero-v6.2.0.bin");
    expect(env).toContain("CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD=true");
    expect(env).toContain("CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD_MODEL_PATH=/home/me/.cache/cloudx/models/whisper.cpp/ggml-silero-v6.2.0.bin");
    expect(env).toContain("ONEAPI_DEVICE_SELECTOR=opencl:gpu");
  });

  it("plans service install, linger, and verification when services start", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
      gpuDetected: true,
      cudaRuntimeReady: true,
      parallelism: 16,
      answers: {
        useGpu: true,
        installServices: true,
        startServices: true,
        enableLinger: true,
        runCodexLogin: true
      }
    });

    const planned = runner.commands.map((command) => [command.command, ...command.args]);
    expect(planned).toContainEqual(["sudo", "loginctl", "enable-linger", process.env.USER ?? "david"]);
    expect(planned).toContainEqual(["systemctl", "--user", "enable", "cloudx-asr.service", "cloudx-documentation.service", "cloudx.service"]);
    expect(planned).toContainEqual(["systemctl", "--user", "restart", "cloudx-asr.service", "cloudx-documentation.service", "cloudx.service"]);
    expect(planned).toContainEqual([
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "5",
      "--retry",
      "30",
      "--retry-delay",
      "1",
      "--retry-connrefused",
      "--insecure",
      "https://127.0.0.1:3001/api/health"
    ]);
    expect(planned).toContainEqual([
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "5",
      "--retry",
      "30",
      "--retry-delay",
      "1",
      "--retry-connrefused",
      "http://127.0.0.1:7820/health"
    ]);
    expect(runner.commands.find((command) => command.command === "curl" && command.args.includes("https://127.0.0.1:3001/api/health"))?.capture).toBe(true);
    expect(runner.writes.map((write) => write.path)).toEqual(
      expect.arrayContaining(["/home/me/.config/systemd/user/cloudx.service", "/home/me/.config/systemd/user/cloudx-asr.service", "/home/me/.config/systemd/user/cloudx-documentation.service"])
    );
  });

  it("plans a conservative uninstall by default", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      uninstall: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04" }
    });

    const planned = runner.commands.map((command) => [command.command, ...command.args]);
    expect(result.removed).toMatchObject({
      removeServices: true,
      removeConfig: true,
      removeVenv: true,
      removeRuntimeData: false,
      removeModel: false,
      removeNodeModules: false,
      disableLinger: false
    });
    expect(planned).toEqual(
      expect.arrayContaining([
        ["systemctl", "--user", "stop", "cloudx-asr.service", "cloudx-documentation.service", "cloudx.service"],
        ["systemctl", "--user", "disable", "cloudx-asr.service", "cloudx-documentation.service", "cloudx.service"],
        ["rm", "-rf", "/home/me/.config/systemd/user/cloudx.service"],
        ["rm", "-rf", "/home/me/.config/systemd/user/cloudx-asr.service"],
        ["rm", "-rf", "/home/me/.config/systemd/user/cloudx-documentation.service"],
        ["rm", "-rf", "/home/me/.config/cloudx/cloudx.env"],
        ["rm", "-rf", "/repo/services/asr/.venv"],
        ["rm", "-rf", "/repo/services/documentation-indexer/.venv"]
      ])
    );
    expect(planned).not.toContainEqual(["rm", "-rf", "/home/me/.cache/cloudx/models/faster-whisper-large-v3"]);
    expect(planned).not.toContainEqual(["rm", "-rf", "/repo/node_modules"]);
  });

  it("plans optional uninstall removals when selected", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      uninstall: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
      answers: {
        removeRuntimeData: true,
        removeModel: true,
        removeNodeModules: true,
        disableLinger: true
      }
    });

    const planned = runner.commands.map((command) => [command.command, ...command.args]);
    expect(planned).toEqual(
      expect.arrayContaining([
        ["rm", "-rf", "/repo/.cloudx"],
        ["rm", "-rf", "/home/me/.cache/cloudx/models/faster-whisper-large-v3"],
        ["rm", "-rf", "/repo/node_modules"],
        ["sudo", "loginctl", "disable-linger", process.env.USER ?? "david"]
      ])
    );
  });

  it("plans an update that pulls, refreshes dependencies, services, and health checks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-update-repo-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-update-home-"));
    const runner = new InstallerRunner({ dryRun: true, cwd: root, log: () => undefined });
    fs.mkdirSync(path.join(home, ".config/cloudx"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config/systemd/user"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/cloudx/cloudx.env"), "CLOUDX_PORT=3443\nCLOUDX_ASR_DEVICE=cuda\nCLOUDX_ASR_COMPUTE_TYPE=int8_float16\nCLOUDX_DOCUMENTATION_URL=http://127.0.0.1:9000\n");
    fs.writeFileSync(path.join(home, ".config/systemd/user/cloudx.service"), "");
    fs.writeFileSync(path.join(home, ".config/systemd/user/cloudx-asr.service"), "");

    const result = await runInstaller({
      repoRoot: root,
      home,
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      update: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
      answers: {
        runCodexLogin: true,
        restartServices: true
      },
      networkInterfaces: {
        eth0: [{ family: "IPv4", internal: false, address: "192.0.2.249" }]
      }
    });

    const planned = runner.commands.map((command) => [command.command, ...command.args]);
    expect(result).toMatchObject({ port: 3443, servicesInstalled: true, restartServices: true });
    expect(result.urls).toEqual(["https://127.0.0.1:3443"]);
    const updatedEnv = runner.writes.find((write) => write.path === path.join(home, ".config/cloudx/cloudx.env"))?.contents;
    expect(updatedEnv).toContain("CLOUDX_ASSISTANT_BIN=/usr/bin/codex");
    expect(updatedEnv).toContain("CLOUDX_TOOL_PATH=/usr/bin");
    expect(updatedEnv).toContain("CLOUDX_ASR_DEVICE=cuda");
    expect(updatedEnv).toContain("CLOUDX_ASR_COMPUTE_TYPE=int8_float16");
    expect(updatedEnv).toContain("CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:9000");
    expect(updatedEnv).not.toContain("CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:7820");
    expect(updatedEnv).toContain(`CLOUDX_DOCUMENTATION_DATA_DIR=${path.join(root, ".cloudx/documentation")}`);
    expect(updatedEnv).not.toContain("CLOUDX_CODEX_BIN");
    expect(planned).toEqual(
      expect.arrayContaining([
        ["node", "-v"],
        ["npm", "-v"],
        ["git", "pull", "--ff-only"],
        ["npm", "i", "-g", "@openai/codex@latest"],
        ["npm", "ci"],
        [path.join(root, "services/asr/.venv/bin/pip"), "install", "-e", `${path.join(root, "services/asr")}[dev]`, "huggingface_hub[cli]"],
        ["python3", "-m", "venv", "--upgrade-deps", path.join(root, "services/documentation-indexer/.venv")],
        [
          path.join(root, "services/documentation-indexer/.venv/bin/pip"),
          "install",
          "--extra-index-url",
          PYTORCH_CPU_WHEEL_INDEX,
          "-e",
          `${path.join(root, "services/documentation-indexer")}[dev]`
        ],
        [path.join(root, "services/asr/.venv/bin/pip"), "install", ...FASTER_WHISPER_CUDA_PIP_PACKAGES],
        [path.join(root, "services/documentation-indexer/.venv/bin/pip"), "install", ...FASTER_WHISPER_CUDA_PIP_PACKAGES],
        ["npm", "run", "build"],
        ["npm", "run", "cert:create"],
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "restart", "cloudx-asr.service", "cloudx-documentation.service", "cloudx.service"]
      ])
    );
    expect(planned).toContainEqual([
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "5",
      "--retry",
      "30",
      "--retry-delay",
      "1",
      "--retry-connrefused",
      "--insecure",
      "https://127.0.0.1:3443/api/health"
    ]);
    expect(planned).toContainEqual([
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "5",
      "--retry",
      "30",
      "--retry-delay",
      "1",
      "--retry-connrefused",
      "http://127.0.0.1:7820/health"
    ]);
    expect(runner.commands.find((command) => command.command === "curl" && command.args.includes("https://127.0.0.1:3443/api/health"))?.capture).toBe(true);
    expect(runner.writes.map((write) => write.path)).toEqual(
      expect.arrayContaining([path.join(home, ".config/systemd/user/cloudx.service"), path.join(home, ".config/systemd/user/cloudx-asr.service"), path.join(home, ".config/systemd/user/cloudx-documentation.service")])
    );
  });
});
