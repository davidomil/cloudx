import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  InstallerRunner,
  cloudxAccessUrls,
  defaultCpuThreads,
  installUbuntuPrerequisites,
  needsNodeInstall,
  parseNodeMajor,
  parseOsRelease,
  renderAsrService,
  renderCloudxService,
  renderEnvFile,
  resolveDeviceConfig,
  runInstaller,
  ubuntuBootstrapPlan,
  validateCpuThreads
} from "./install-cloudx.mjs";

describe("install-cloudx helpers", () => {
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
  });

  it("builds the Ubuntu bootstrap command plan", () => {
    const commands = ubuntuBootstrapPlan({ nodeVersionText: "v20.0.0", hasNpm: true });

    expect(commands[0]).toEqual(["sudo", "apt-get", "update"]);
    expect(commands[1]).toContain("build-essential");
    expect(commands).toContainEqual(["sudo", "apt-get", "install", "-y", "nodejs"]);
    expect(commands).toContainEqual(["sh", "-lc", "command -v npm >/dev/null 2>&1 || sudo apt-get install -y npm"]);
    expect(commands).toContainEqual(["node", "-v"]);
    expect(commands).toContainEqual(["npm", "-v"]);
  });

  it("plans npm fallback when Node is current but npm is missing", () => {
    const commands = ubuntuBootstrapPlan({ nodeVersionText: "v22.0.0", hasNpm: false });

    expect(commands).not.toContainEqual(["sudo", "apt-get", "install", "-y", "nodejs"]);
    expect(commands).toContainEqual(["sh", "-lc", "command -v npm >/dev/null 2>&1 || sudo apt-get install -y npm"]);
    expect(commands).toContainEqual(["npm", "-v"]);
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

  it("builds local and LAN access URLs", () => {
    expect(
      cloudxAccessUrls(3001, {
        lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
        eth0: [{ family: "IPv4", internal: false, address: "192.168.8.249" }],
        docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1" }]
      })
    ).toEqual(["https://127.0.0.1:3001", "https://192.168.8.249:3001", "https://172.17.0.1:3001"]);
  });

  it("validates CPU thread choices", () => {
    expect(defaultCpuThreads(12)).toBe(6);
    expect(validateCpuThreads("8", 12)).toBe(8);
    expect(() => validateCpuThreads("0", 12)).toThrow(/CPU threads/);
    expect(() => validateCpuThreads("13", 12)).toThrow(/CPU threads/);
  });

  it("resolves CPU and GPU ASR device configuration", () => {
    expect(resolveDeviceConfig({ gpuDetected: true, useGpu: false, cudaRuntimeReady: false })).toEqual({
      device: "cpu",
      computeType: "int8"
    });
    expect(resolveDeviceConfig({ gpuDetected: true, useGpu: true, cudaRuntimeReady: true })).toEqual({
      device: "cuda",
      computeType: "float16"
    });
    expect(() => resolveDeviceConfig({ gpuDetected: true, useGpu: true, cudaRuntimeReady: false })).toThrow(/CUDA\/cuDNN/);
  });

  it("renders env and systemd units", () => {
    const env = renderEnvFile({
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: "~",
      dataDir: "/repo/.cloudx",
      modelDir: "/home/me/.cache/cloudx/models/faster-whisper-large-v3",
      device: "cpu",
      computeType: "int8",
      language: "en",
      cpuThreads: 6
    });
    expect(env).toContain("CLOUDX_ASR_CPU_THREADS=6");
    expect(env).toContain("CLOUDX_ASR_DEVICE=cpu");

    expect(renderAsrService({ repoRoot: "/repo", envPath: "/home/me/.config/cloudx/cloudx.env", uvicornPath: "/repo/services/asr/.venv/bin/uvicorn", asrDir: "/repo/services/asr" })).toContain(
      "cloudx_asr.main:app"
    );
    expect(renderCloudxService({ repoRoot: "/repo", envPath: "/home/me/.config/cloudx/cloudx.env", nodePath: "/usr/bin/node", npmPath: "/usr/bin/npm" })).toContain(
      "npm run start -w @cloudx/server"
    );
  });
});

describe("runInstaller dry-run", () => {
  it("plans a CPU install without services", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
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
        eth0: [{ family: "IPv4", internal: false, address: "192.168.8.249" }]
      }
    });

    expect(result.installServices).toBe(false);
    expect(result.urls).toEqual(["https://127.0.0.1:3001", "https://192.168.8.249:3001"]);
    expect(result.envConfig).toMatchObject({ device: "cpu", computeType: "int8", cpuThreads: 6 });
    expect(runner.commands.map((command) => [command.command, ...command.args])).toEqual(
      expect.arrayContaining([
        ["node", "-v"],
        ["npm", "-v"],
        ["npm", "ci"],
        ["/repo/services/asr/.venv/bin/hf", "download", "Systran/faster-whisper-large-v3", "--local-dir", "/home/me/.cache/cloudx/models/faster-whisper-large-v3"],
        ["npm", "run", "build"]
      ])
    );
    expect(runner.writes.some((write) => write.path === "/home/me/.config/cloudx/cloudx.env")).toBe(true);
  });

  it("plans service install, linger, and verification when services start", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
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
    expect(planned).toContainEqual(["systemctl", "--user", "enable", "cloudx-asr.service", "cloudx.service"]);
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
    expect(runner.commands.find((command) => command.command === "curl" && command.args.includes("https://127.0.0.1:3001/api/health"))?.capture).toBe(true);
    expect(runner.writes.map((write) => write.path)).toEqual(
      expect.arrayContaining(["/home/me/.config/systemd/user/cloudx.service", "/home/me/.config/systemd/user/cloudx-asr.service"])
    );
  });

  it("plans a conservative uninstall by default", async () => {
    const runner = new InstallerRunner({ dryRun: true, cwd: "/repo", log: () => undefined });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
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
        ["systemctl", "--user", "stop", "cloudx-asr.service", "cloudx.service"],
        ["systemctl", "--user", "disable", "cloudx-asr.service", "cloudx.service"],
        ["rm", "-rf", "/home/me/.config/systemd/user/cloudx.service"],
        ["rm", "-rf", "/home/me/.config/systemd/user/cloudx-asr.service"],
        ["rm", "-rf", "/home/me/.config/cloudx/cloudx.env"],
        ["rm", "-rf", "/repo/services/asr/.venv"]
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
    fs.writeFileSync(path.join(home, ".config/cloudx/cloudx.env"), "CLOUDX_PORT=3443\n");
    fs.writeFileSync(path.join(home, ".config/systemd/user/cloudx.service"), "");
    fs.writeFileSync(path.join(home, ".config/systemd/user/cloudx-asr.service"), "");

    const result = await runInstaller({
      repoRoot: root,
      home,
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
        eth0: [{ family: "IPv4", internal: false, address: "192.168.8.249" }]
      }
    });

    const planned = runner.commands.map((command) => [command.command, ...command.args]);
    expect(result).toMatchObject({ port: 3443, servicesInstalled: true, restartServices: true });
    expect(result.urls).toEqual(["https://127.0.0.1:3443", "https://192.168.8.249:3443"]);
    expect(planned).toEqual(
      expect.arrayContaining([
        ["node", "-v"],
        ["npm", "-v"],
        ["git", "pull", "--ff-only"],
        ["npm", "i", "-g", "@openai/codex@latest"],
        ["npm", "ci"],
        [path.join(root, "services/asr/.venv/bin/pip"), "install", "-e", `${path.join(root, "services/asr")}[dev]`, "huggingface_hub[cli]"],
        ["npm", "run", "build"],
        ["npm", "run", "cert:create"],
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "restart", "cloudx-asr.service", "cloudx.service"]
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
    expect(runner.commands.find((command) => command.command === "curl" && command.args.includes("https://127.0.0.1:3443/api/health"))?.capture).toBe(true);
    expect(runner.writes.map((write) => write.path)).toEqual(
      expect.arrayContaining([path.join(home, ".config/systemd/user/cloudx.service"), path.join(home, ".config/systemd/user/cloudx-asr.service")])
    );
  });
});
