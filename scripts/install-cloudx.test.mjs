import { describe, expect, it } from "vitest";

import {
  InstallerRunner,
  defaultCpuThreads,
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
      }
    });

    expect(result.installServices).toBe(false);
    expect(result.envConfig).toMatchObject({ device: "cpu", computeType: "int8", cpuThreads: 6 });
    expect(runner.commands.map((command) => [command.command, ...command.args])).toEqual(
      expect.arrayContaining([
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
    expect(planned).toContainEqual(["curl", "-fsSk", "https://127.0.0.1:3001/api/health"]);
    expect(runner.writes.map((write) => write.path)).toEqual(
      expect.arrayContaining(["/home/me/.config/systemd/user/cloudx.service", "/home/me/.config/systemd/user/cloudx-asr.service"])
    );
  });
});
