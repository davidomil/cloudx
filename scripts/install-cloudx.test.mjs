import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  CUDA_12_MIN_DRIVER_VERSION,
  CODEX_CLI_VERSION,
  CLOUDX_NPM_GLOBAL_DIR,
  GIT_CORE_PPA,
  InstallerRunner,
  MIN_WORKTREE_GIT_VERSION,
  NODESOURCE_CONFLICTING_APT_PACKAGES,
  QUARTO_DEB_PATH,
  QUARTO_DEB_URL,
  QUARTO_VERSION,
  SERVER_RUNTIME_SCHEMA_FILES,
  UV_VERSION,
  WHISPER_CPP_MODEL,
  WHISPER_CPP_REPO_URL,
  WHISPER_CPP_VAD_MODEL,
  assertQuartoArchitecture,
  cloudxAccessUrls,
  codexCliBin,
  codexNpmEnv,
  defaultCpuThreads,
  ensureSupportedGit,
  installServerRuntimeSchemas,
  installUbuntuPrerequisites,
  parseNvidiaGpuInfo,
  needsGitUpgrade,
  needsNodeInstall,
  needsQuartoInstall,
  normalizeWhisperCppBuild,
  helpText,
  parseGitVersion,
  parseArgs,
  parseNodeMajor,
  parseOsRelease,
  preferSystemNodePath,
  renderAsrService,
  renderCloudxService,
  renderDocumentationService,
  renderEnvFile,
  resolveDeviceConfig,
  runInstaller,
  selectNvidiaGpuInfo,
  systemNodePath,
  supportsCuda12Driver,
  toolPathFor,
  ubuntuBootstrapPlan,
  ubuntuPrerequisiteVerificationPlan,
  updateEnvFileContent,
  updateHostFromEnvConfig,
  validateCpuThreads,
} from "./install-cloudx.mjs";

const TEST_ENV = { PATH: "/usr/bin" };
const TEST_CODEX_PREFIX = path.join("/home/me", CLOUDX_NPM_GLOBAL_DIR);
const TEST_CODEX_BIN = path.join(TEST_CODEX_PREFIX, "bin/codex");

function runtimeSchemaDistPaths(root) {
  return SERVER_RUNTIME_SCHEMA_FILES.map((relativePath) =>
    path.join(root, "apps/server/dist", relativePath),
  );
}

function expectRuntimeSchemaWrites(runner, root) {
  expect(runner.writes.map((write) => write.path)).toEqual(
    expect.arrayContaining(runtimeSchemaDistPaths(root)),
  );
}

describe("install-cloudx helpers", () => {
  it("pins the supported Codex CLI release literally", () => {
    expect(CODEX_CLI_VERSION).toBe("0.153.4");
  });

  it.each([
    [
      "an explicit wildcard bind with a trusted origin",
      {
        CLOUDX_HOST: "0.0.0.0",
        CLOUDX_TRUSTED_ORIGINS: "https://192.168.8.250:3001",
      },
      "0.0.0.0",
    ],
    ["a wildcard bind without trusted origins", { CLOUDX_HOST: "0.0.0.0" }, "127.0.0.1"],
    ["an IPv6 wildcard", { CLOUDX_HOST: "::", CLOUDX_TRUSTED_ORIGINS: "https://cloudx.example" }, "127.0.0.1"],
    ["an arbitrary address", { CLOUDX_HOST: "192.168.8.250", CLOUDX_TRUSTED_ORIGINS: "https://cloudx.example" }, "127.0.0.1"],
    ["an arbitrary hostname", { CLOUDX_HOST: "cloudx.example", CLOUDX_TRUSTED_ORIGINS: "https://cloudx.example" }, "127.0.0.1"],
  ])("selects the safe update host for %s", (_label, envConfig, expected) => {
    expect(updateHostFromEnvConfig(envConfig)).toBe(expected);
  });

  it("documents attended defaults for noninteractive no-start and answer-file installs", () => {
    const setup = fs.readFileSync(
      path.join(process.cwd(), "docs/SETUP.md"),
      "utf8",
    );

    expect(setup).toContain("./install.sh --no-start --yes");
    expect(setup).toContain(
      "node scripts/install-cloudx.mjs --answers ./answers.json --yes",
    );
  });

  it("documents trusted tailnet origin and restart before starting Tailscale Serve", () => {
    const security = fs.readFileSync(
      path.join(process.cwd(), "docs/SECURITY_MODEL.md"),
      "utf8",
    );
    const section = security.slice(
      security.indexOf("## Authenticated Tailnet Access"),
      security.indexOf("## Reverse Proxy Guidance"),
    );
    const trustedOrigin = section.indexOf(
      "CLOUDX_TRUSTED_ORIGINS=https://build-host.example.ts.net",
    );
    const restart = section.indexOf("systemctl --user restart cloudx.service");
    const serve = section.indexOf(
      "tailscale serve --bg https+insecure://localhost:3001",
    );

    expect(trustedOrigin).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(trustedOrigin);
    expect(serve).toBeGreaterThan(restart);
    expect(section).toMatch(/tailnet grants or ACLs/u);
  });

  it("documents the exact ASR CPU thread range accepted by production", () => {
    const setup = fs.readFileSync(
      path.join(process.cwd(), "docs/SETUP.md"),
      "utf8",
    );
    const row = setup.match(/- `CLOUDX_ASR_CPU_THREADS`:[^\n]*(?:\n  [^\n]*)?/u)?.[0];

    expect(row).toContain("from `1` through `32`");
    expect(row).not.toContain("from `0`");
  });

  it("runs documentation setup with only the installer-owned pinned uv executable", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "cloudx-documentation-setup-home-"),
    );
    const logPath = path.join(home, "uv-args.log");
    const uvPath = path.join(home, ".local/share/cloudx/uv/bin/uv");
    fs.mkdirSync(path.dirname(uvPath), { recursive: true });
    fs.writeFileSync(
      uvPath,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CLOUDX_TEST_UV_LOG"\n',
    );
    fs.chmodSync(uvPath, 0o755);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );

    try {
      execFileSync(
        "/bin/sh",
        ["-c", packageJson.scripts["documentation:setup"]],
        {
          cwd: process.cwd(),
          env: {
            HOME: home,
            PATH: "/cloudx-test-path-without-uv",
            CLOUDX_TEST_UV_LOG: logPath,
          },
          stdio: "pipe",
        },
      );

      expect(fs.readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
        "sync",
        "--locked",
        "--project",
        "services/documentation-indexer",
        "--extra",
        "dev",
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("parses and advertises verbose installer diagnostics", () => {
    expect(parseArgs(["--dry-run", "--update", "--verbose"])).toMatchObject({
      dryRun: true,
      update: true,
      verbose: true,
    });
    expect(helpText()).toContain("--verbose");
    expect(helpText()).not.toContain("--lan");
    expect(() => parseArgs(["--lan"])).toThrow(
      "Unknown installer option: --lan",
    );
  });

  it("parses Ubuntu os-release files", () => {
    expect(
      parseOsRelease(
        'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\n',
      ),
    ).toMatchObject({
      ID: "ubuntu",
      VERSION_ID: "24.04",
      PRETTY_NAME: "Ubuntu 24.04.4 LTS",
    });
  });

  it("decides when Node needs to be installed", () => {
    expect(parseNodeMajor("v22.22.3")).toBe(22);
    expect(needsNodeInstall("v20.20.2", "10.0.0")).toBe(true);
    expect(needsNodeInstall("v22.22.3", "")).toBe(true);
    expect(needsNodeInstall("v24.15.0", "11.0.0")).toBe(false);
    expect(needsQuartoInstall(QUARTO_VERSION)).toBe(false);
    expect(needsQuartoInstall("1.8.25")).toBe(true);
    expect(() => assertQuartoArchitecture("arm64")).toThrow(/linux-amd64/);
  });

  it("copies server runtime schemas into dist after the TypeScript build", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "cloudx-install-schemas-"),
    );
    const runner = new InstallerRunner({ cwd: root, log: () => undefined });
    try {
      for (const relativePath of SERVER_RUNTIME_SCHEMA_FILES) {
        const sourcePath = path.join(root, "apps/server/src", relativePath);
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, `{"schema":"${relativePath}"}`);
      }

      installServerRuntimeSchemas(runner, { repoRoot: root });

      for (const relativePath of SERVER_RUNTIME_SCHEMA_FILES) {
        expect(
          fs.readFileSync(
            path.join(root, "apps/server/dist", relativePath),
            "utf8",
          ),
        ).toBe(`{"schema":"${relativePath}"}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds the Ubuntu bootstrap command plan", () => {
    const commands = ubuntuBootstrapPlan({
      nodeVersionText: "v20.0.0",
      npmVersionText: "10.0.0",
    });

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
    expect(commands).toContainEqual([
      "curl",
      "-fL",
      "-o",
      QUARTO_DEB_PATH,
      QUARTO_DEB_URL,
    ]);
    expect(commands).toContainEqual([
      "sudo",
      "apt-get",
      "install",
      "-y",
      QUARTO_DEB_PATH,
    ]);
    expect(commands).toContainEqual([
      "sudo",
      "apt-get",
      "remove",
      "-y",
      ...NODESOURCE_CONFLICTING_APT_PACKAGES,
    ]);
    expect(commands).toContainEqual([
      "sudo",
      "apt-get",
      "install",
      "-y",
      "nodejs",
    ]);
    expect(ubuntuPrerequisiteVerificationPlan()).toEqual([
      ["node", "-v"],
      ["npm", "-v"],
      ["quarto", "--version"],
      ["pandoc", "--version"],
      ["xelatex", "--version"],
      ["lualatex", "--version"],
    ]);
  });

  it("skips the Quarto .deb download when the pinned version is already installed", () => {
    const commands = ubuntuBootstrapPlan({
      nodeVersionText: "v22.0.0",
      npmVersionText: "10.0.0",
      quartoVersionText: QUARTO_VERSION,
    });

    expect(commands).not.toContainEqual([
      "curl",
      "-fL",
      "-o",
      QUARTO_DEB_PATH,
      QUARTO_DEB_URL,
    ]);
    expect(commands).not.toContainEqual([
      "sudo",
      "apt-get",
      "install",
      "-y",
      QUARTO_DEB_PATH,
    ]);
  });

  it("plans NodeSource repair when Node is current but npm cannot run", () => {
    const commands = ubuntuBootstrapPlan({
      nodeVersionText: "v25.8.1",
      npmVersionText: "",
    });

    expect(commands).toContainEqual([
      "sh",
      "-lc",
      "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -",
    ]);
    expect(commands).toContainEqual([
      "sudo",
      "apt-get",
      "remove",
      "-y",
      "libnode-dev",
    ]);
    expect(commands).toContainEqual([
      "sudo",
      "apt-get",
      "install",
      "-y",
      "nodejs",
    ]);
  });

  it("detects Git versions that are too old for worktree porcelain NUL output", () => {
    expect(parseGitVersion("git version 2.34.1")).toEqual([2, 34, 1]);
    expect(needsGitUpgrade("git version 2.34.1")).toBe(true);
    expect(needsGitUpgrade(`git version ${MIN_WORKTREE_GIT_VERSION}`)).toBe(
      false,
    );
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
          if (
            command === "sudo" &&
            args[0] === "apt-get" &&
            args.at(-1) === "git"
          ) {
            gitVersion = "git version 2.53.0";
          }
        },
      },
      {
        boolean: async (key) => {
          expect(key).toBe("upgradeGit");
          return true;
        },
      },
    );

    expect(result).toMatchObject({
      upgraded: true,
      versionText: "git version 2.53.0",
    });
    expect(planned).toEqual([
      ["sudo", "apt-get", "install", "-y", "software-properties-common"],
      ["sudo", "add-apt-repository", GIT_CORE_PPA, "-y"],
      ["sudo", "apt-get", "update"],
      ["sudo", "apt-get", "install", "-y", "git"],
    ]);
  });

  it("fails an unsupported Git prerequisite when the operator declines the upgrade", async () => {
    const planned = [];

    await expect(ensureSupportedGit(
      {
        exists: () => true,
        capture: () => "git version 2.34.1",
        run: (command, args) => planned.push([command, ...args]),
      },
      { boolean: async () => false },
    )).rejects.toThrow(/Git .*2\.34\.1.*2\.36\.0|unsupported Git/i);

    expect(planned).toEqual([]);
  });

  it("does not prompt to upgrade an already supported Git", async () => {
    const prompt = { boolean: vi.fn() };

    await expect(ensureSupportedGit(
      {
        exists: () => true,
        capture: () => `git version ${MIN_WORKTREE_GIT_VERSION}`,
        run: vi.fn(),
      },
      prompt,
    )).resolves.toMatchObject({ upgraded: false });

    expect(prompt.boolean).not.toHaveBeenCalled();
  });

  it("checks current Node and npm before building a direct wizard bootstrap plan", () => {
    const runner = new InstallerRunner({
      dryRun: true,
      cwd: "/repo",
      log: () => undefined,
    });

    installUbuntuPrerequisites({
      exists: (command) => command === "npm",
      capture: () => "",
      run: runner.run.bind(runner),
    });

    expect(
      runner.commands.map((command) => [command.command, ...command.args]),
    ).toEqual(
      expect.arrayContaining([
        ["sudo", "apt-get", "remove", "-y", "libnode-dev"],
        ["sudo", "apt-get", "install", "-y", "nodejs"],
        ["node", "-v"],
        ["npm", "-v"],
      ]),
    );
  });

  it("repairs a broken npm even when the current Node version is new enough", () => {
    const planned = [];
    const env = { PATH: "/usr/local/bin:/usr/bin" };

    installUbuntuPrerequisites(
      {
        exists: (command) => command === "node" || command === "npm",
        capture: (command, args, options = {}) => {
          if (command === "node" && args[0] === "-v") {
            return options.env?.PATH === systemNodePath(env.PATH)
              ? "v22.0.0"
              : "v25.8.1";
          }
          if (command === "npm" && args[0] === "-v") {
            if (options.env?.PATH === systemNodePath(env.PATH)) {
              return "10.9.0";
            }
            throw new Error("Cannot find module 'semver'");
          }
          return "";
        },
        run: (command, args) => planned.push([command, ...args]),
      },
      env,
    );

    expect(planned).toEqual(
      expect.arrayContaining([
        [
          "sh",
          "-lc",
          "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -",
        ],
        ["sudo", "apt-get", "remove", "-y", "libnode-dev"],
        ["sudo", "apt-get", "install", "-y", "nodejs"],
        ["node", "-v"],
        ["npm", "-v"],
      ]),
    );
    expect(env.PATH).toBe(systemNodePath("/usr/local/bin:/usr/bin"));
  });

  it("prefers the system Node path only when that Node and npm pair works", () => {
    const env = { PATH: "/usr/local/bin:/usr/bin" };
    const commands = {
      capture: (command, args, options = {}) => {
        expect(options.env?.PATH).toBe(
          systemNodePath("/usr/local/bin:/usr/bin"),
        );
        if (command === "node") {
          return "v22.0.0";
        }
        if (command === "npm") {
          return "10.9.0";
        }
        return "";
      },
    };

    expect(preferSystemNodePath(commands, env)).toBe(true);
    expect(env.PATH).toBe("/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin");
  });

  it("builds local-only access URLs by default", () => {
    expect(cloudxAccessUrls(3001)).toEqual(["https://127.0.0.1:3001"]);
  });

  it("validates CPU thread choices", () => {
    expect(defaultCpuThreads(12)).toBe(6);
    expect(validateCpuThreads("8", 12)).toBe(8);
    expect(() => validateCpuThreads("0", 12)).toThrow(/CPU threads/);
    expect(() => validateCpuThreads("13", 12)).toThrow(/CPU threads/);
  });

  it("resolves CPU and GPU ASR device configuration", () => {
    const t400 = selectNvidiaGpuInfo(
      parseNvidiaGpuInfo("NVIDIA T400, 595.57.01, 4096"),
    );
    expect(t400).toMatchObject({
      name: "NVIDIA T400",
      driverVersion: "595.57.01",
      memoryMb: 4096,
    });
    expect(supportsCuda12Driver(t400.driverVersion)).toBe(true);
    expect(supportsCuda12Driver("520.61.05")).toBe(false);
    expect(CUDA_12_MIN_DRIVER_VERSION).toBe("525.60.13");
    expect(
      resolveDeviceConfig({ gpuDetected: true, nvidiaGpuInfo: t400 }),
    ).toEqual({
      device: "cuda",
      computeType: "int8_float16",
    });
    expect(
      resolveDeviceConfig({
        gpuDetected: true,
        nvidiaGpuInfo: {
          name: "RTX",
          driverVersion: "595.57.01",
          memoryMb: 12_288,
        },
      }),
    ).toEqual({
      device: "cuda",
      computeType: "float16",
    });
    expect(
      resolveDeviceConfig({ gpuDetected: true, cudaRuntimeReady: false }),
    ).toEqual({
      device: "cpu",
      computeType: "int8",
    });
    expect(
      resolveDeviceConfig({
        gpuDetected: true,
        useGpu: false,
        cudaRuntimeReady: false,
      }),
    ).toEqual({
      device: "cpu",
      computeType: "int8",
    });
    expect(
      resolveDeviceConfig({
        gpuDetected: true,
        useGpu: true,
        cudaRuntimeReady: true,
      }),
    ).toEqual({
      device: "cuda",
      computeType: "int8_float16",
    });
    expect(() =>
      resolveDeviceConfig({
        gpuDetected: true,
        useGpu: true,
        nvidiaGpuInfo: {
          name: "Old NVIDIA",
          driverVersion: "520.61.05",
          memoryMb: 8192,
        },
      }),
    ).toThrow(/CUDA 12 minimum/);
    expect(normalizeWhisperCppBuild("SYCL")).toBe("sycl");
    expect(() => normalizeWhisperCppBuild("vulkan")).toThrow(/cpu or sycl/);
  });

  it("renders env and systemd units", () => {
    const env = renderEnvFile({
      host: "127.0.0.1",
      port: 3001,
      allowedRoots: "~",
      dataDir: "/repo/.cloudx",
      assistantBin: "/usr/bin/codex",
      toolPath: "/usr/bin",
      modelDir: "/home/me/.cache/cloudx/models/faster-whisper-large-v3",
      device: "cpu",
      computeType: "int8",
      language: "en",
      cpuThreads: 6,
    });
    expect(env).toContain("CLOUDX_ASR_CPU_THREADS=6");
    expect(env).toContain("CLOUDX_ASR_DEVICE=cpu");
    expect(env).toContain("CLOUDX_LOG_LEVEL=info");
    expect(env).toContain("CLOUDX_ASSISTANT_BIN=/usr/bin/codex");
    expect(env).toContain("CLOUDX_TOOL_PATH=/usr/bin");
    expect(env).toContain("CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:7820");
    expect(env).toContain("CLOUDX_DOCUMENTATION_HOST=127.0.0.1");
    expect(env).toContain(
      "CLOUDX_DOCUMENTATION_DATA_DIR=/repo/.cloudx/documentation",
    );
    expect(env).not.toContain("CLOUDX_CODEX_BIN");

    expect(
      renderAsrService({
        repoRoot: "/repo",
        envPath: "/home/me/.config/cloudx/cloudx.env",
        pythonPath: "/repo/services/asr/.venv/bin/python",
        uvicornPath: "/repo/services/asr/.venv/bin/uvicorn",
        asrDir: "/repo/services/asr",
      }),
    ).toContain("cloudx_asr.main:app");
    expect(
      renderAsrService({
        repoRoot: "/repo",
        envPath: "/home/me/.config/cloudx/cloudx.env",
        pythonPath: "/repo/services/asr/.venv/bin/python",
        uvicornPath: "/repo/services/asr/.venv/bin/uvicorn",
        asrDir: "/repo/services/asr",
      }),
    ).toContain("nvidia.cublas.lib");
    expect(
      renderCloudxService({
        repoRoot: "/repo",
        envPath: "/home/me/.config/cloudx/cloudx.env",
        nodePath: "/usr/bin/node",
        npmPath: "/usr/bin/npm",
      }),
    ).toContain("npm run start -w @cloudx/server");
    expect(
      renderCloudxService({
        repoRoot: "/repo",
        envPath: "/home/me/.config/cloudx/cloudx.env",
        nodePath: "/usr/bin/node",
        npmPath: "/usr/bin/npm",
      }),
    ).toContain("Wants=cloudx-asr.service cloudx-documentation.service");
    expect(
      renderDocumentationService({
        repoRoot: "/repo",
        envPath: "/home/me/.config/cloudx/cloudx.env",
        documentationPythonPath:
          "/repo/services/documentation-indexer/.venv/bin/python",
        documentationIndexerPath:
          "/repo/services/documentation-indexer/.venv/bin/cloudx-documentation-indexer",
      }),
    ).toContain("cloudx-documentation-indexer");
  });

  it("updates existing env files without dropping user choices", () => {
    expect(
      updateEnvFileContent(
        "CLOUDX_PORT=3001\nCLOUDX_ASSISTANT_BIN=/old/codex\n",
        { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex" },
      ),
    ).toBe("CLOUDX_PORT=3001\nCLOUDX_ASSISTANT_BIN=/usr/bin/codex\n");
    expect(
      updateEnvFileContent("CLOUDX_PORT=3001\n", {
        CLOUDX_ASSISTANT_BIN: "/usr/bin/codex",
      }),
    ).toBe("CLOUDX_PORT=3001\nCLOUDX_ASSISTANT_BIN=/usr/bin/codex\n");
  });

  it("builds tool path entries from the assistant command and npm global prefix", () => {
    expect(
      toolPathFor(
        "/home/me/.npm-global/bin/codex",
        "/usr",
        `/opt/homebrew/bin${path.delimiter}/usr/bin`,
      ),
    ).toBe(
      `/home/me/.npm-global/bin${path.delimiter}/usr/bin${path.delimiter}/opt/homebrew/bin`,
    );
    expect(toolPathFor("/usr/bin/codex", "/usr")).toBe("/usr/bin");
  });

  it("uses a Cloudx-owned npm prefix for Codex CLI installs", () => {
    const paths = { npmGlobalDir: TEST_CODEX_PREFIX };

    expect(codexCliBin(paths)).toBe(TEST_CODEX_BIN);
    expect(
      codexNpmEnv(paths, {
        PATH: "/usr/local/bin:/usr/bin",
        npm_config_prefix: "/usr/local/lib/node_modules/node",
      }),
    ).toMatchObject({
      NPM_CONFIG_PREFIX: TEST_CODEX_PREFIX,
      npm_config_prefix: TEST_CODEX_PREFIX,
      PATH: `${path.join(TEST_CODEX_PREFIX, "bin")}:/usr/local/bin:/usr/bin`,
    });
  });

  it("prints verbose cwd, safe env, stdout, and stderr for captured commands", () => {
    const logs = [];
    const runner = new InstallerRunner({
      cwd: "/tmp",
      log: (line) => logs.push(line),
      verbose: true,
    });

    const output = runner.capture(
      process.execPath,
      ["-e", "console.log('probe stdout'); console.error('probe stderr')"],
      {
        env: {
          CLOUDX_HOST: "127.0.0.1",
          CLOUDX_LOG_LEVEL: "debug",
          SECRET_TOKEN: "do-not-print",
        },
      },
    );

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
    const runner = new InstallerRunner({
      cwd: "/tmp",
      log: (line) => logs.push(line),
      verbose: true,
    });

    expect(() =>
      runner.capture(process.execPath, [
        "-e",
        "console.log('before failure'); console.error('failure detail'); process.exit(7)",
      ]),
    ).toThrow(/exit code 7/);
    const logText = logs.join("\n");
    expect(logText).toContain("[verbose] stdout:\n  before failure");
    expect(logText).toContain("[verbose] stderr:\n  failure detail");
  });

  it("keeps captured output quiet by default", () => {
    const logs = [];
    const runner = new InstallerRunner({
      cwd: "/tmp",
      log: (line) => logs.push(line),
    });

    expect(
      runner.capture(process.execPath, ["-e", "console.log('quiet stdout')"]),
    ).toBe("quiet stdout");
    expect(logs.join("\n")).not.toContain("[verbose]");
  });

  it("routes status probes through verbose runner diagnostics", () => {
    const logs = [];
    const runner = new InstallerRunner({
      cwd: "/tmp",
      log: (line) => logs.push(line),
      verbose: true,
    });

    expect(
      runner.statusOk(process.execPath, [
        "-e",
        "console.error('status stderr'); process.exit(9)",
      ]),
    ).toBe(false);
    const logText = logs.join("\n");
    expect(logText).toContain("$ ");
    expect(logText).toContain("[verbose] cwd: /tmp");
    expect(logText).toContain("[verbose] stderr:\n  status stderr");
  });

  it("accepts verbose in the shell bootstrap and forwards it to the Node wizard", () => {
    const shellScript = fs.readFileSync(
      path.join(process.cwd(), "install.sh"),
      "utf8",
    );

    execFileSync("bash", ["-n", "install.sh"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    expect(shellScript).toContain('elif [[ "$arg" == "--verbose" ]]; then');
    expect(shellScript).toContain("export CLOUDX_INSTALL_VERBOSE=1");
    expect(shellScript).toContain("set -x");
    expect(shellScript).toContain('exec node scripts/install-cloudx.mjs "$@"');
  });
});

describe("runInstaller prerequisites", () => {
  it("stops the production installer before later work when an unsupported Git upgrade is declined", async () => {
    class RecordingInstallerRunner extends InstallerRunner {
      constructor() {
        super({ dryRun: false, cwd: "/repo", log: () => undefined });
        this.trace = [];
      }

      run(command, args = [], options = {}) {
        this.trace.push(`run ${[command, ...args].join(" ")}`);
        this.commands.push({ command, args, cwd: options.cwd ?? this.cwd });
        return "";
      }

      capture(command, args = [], options = {}) {
        this.trace.push(`capture ${[command, ...args].join(" ")}`);
        this.commands.push({ command, args, cwd: options.cwd ?? this.cwd, capture: true });
        if (command === "git" && args.length === 1 && args[0] === "--version") {
          return "git version 2.34.1";
        }
        throw new Error(`unexpected capture: ${[command, ...args].join(" ")}`);
      }

      statusOk(command, args = []) {
        this.trace.push(`statusOk ${[command, ...args].join(" ")}`);
        return false;
      }

      writeFile(filePath, contents) {
        this.trace.push(`writeFile ${filePath}`);
        this.writes.push({ path: filePath, contents });
      }

      mkdir(dirPath) {
        this.trace.push(`mkdir ${dirPath}`);
      }

      removePath(targetPath) {
        this.trace.push(`removePath ${targetPath}`);
      }

      spawnCaptured(command, args = []) {
        this.trace.push(`spawnCaptured ${[command, ...args].join(" ")}`);
        throw new Error("production reached the real subprocess primitive");
      }
    }

    const runner = new RecordingInstallerRunner();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let fulfillment = "pending";
    const install = runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: { ...TEST_ENV, CLOUDX_INSTALL_BOOTSTRAPPED: "1" },
      dryRun: false,
      yes: true,
      runner,
      osRelease: {
        ID: "ubuntu",
        VERSION_ID: "24.04",
        PRETTY_NAME: "Ubuntu 24.04 LTS",
      },
      gpuDetected: false,
      cudaRuntimeReady: false,
      intelGpuDetected: false,
      parallelism: 12,
      answers: { upgradeGit: false },
      networkInterfaces: {
        eth0: [{ family: "IPv4", internal: false, address: "192.0.2.249" }],
      },
    }).then((value) => {
      fulfillment = "fulfilled";
      return value;
    });

    try {
      await expect(install).rejects.toThrow(
        `Cloudx requires Git ${MIN_WORKTREE_GIT_VERSION} or newer; the unsupported Git upgrade was declined.`,
      );
      expect(fulfillment).toBe("pending");
      expect(runner.trace).toEqual([
        "run node -v",
        "run npm -v",
        "capture git --version",
      ]);
      expect(runner.commands).toEqual([
        { command: "node", args: ["-v"], cwd: "/repo" },
        { command: "npm", args: ["-v"], cwd: "/repo" },
        {
          command: "git",
          args: ["--version"],
          cwd: "/repo",
          capture: true,
        },
      ]);
      expect(runner.writes).toEqual([]);
      expect(runner.trace.join("\n")).not.toMatch(
        /statusOk|writeFile|mkdir|removePath|spawnCaptured|npm (?:i|ci|run)|\buv\b|\bhf\b|cert|systemctl|curl|service/iu,
      );
      expect(consoleLog.mock.calls.flat().join("\n")).not.toMatch(
        /Cloudx (?:installer|update) complete/u,
      );
    } finally {
      consoleLog.mockRestore();
    }
  });
});

describe("runInstaller dry-run", () => {
  it("plans a CPU install without services", async () => {
    const runner = new InstallerRunner({
      dryRun: true,
      cwd: "/repo",
      log: () => undefined,
    });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      runner,
      osRelease: {
        ID: "ubuntu",
        VERSION_ID: "24.04",
        PRETTY_NAME: "Ubuntu 24.04 LTS",
      },
      gpuDetected: false,
      cudaRuntimeReady: false,
      parallelism: 12,
      answers: {
        installServices: false,
        runCodexLogin: true,
      },
      networkInterfaces: {
        eth0: [{ family: "IPv4", internal: false, address: "192.0.2.249" }],
      },
    });

    expect(result.installServices).toBe(false);
    expect(result.urls).toEqual(["https://127.0.0.1:3001"]);
    expect(result.envConfig).toMatchObject({
      host: "127.0.0.1",
      device: "cpu",
      computeType: "int8",
      cpuThreads: 6,
      documentationUrl: "http://127.0.0.1:7820",
    });
    expect(
      runner.commands.map((command) => [command.command, ...command.args]),
    ).toEqual(
      expect.arrayContaining([
        ["node", "-v"],
        ["npm", "-v"],
        [
          "npm",
          "i",
          "-g",
          "--prefix",
          TEST_CODEX_PREFIX,
          "@openai/codex@0.153.4",
        ],
        [TEST_CODEX_BIN, "--version"],
        ["npm", "ci"],
        ["python3", "-m", "venv", "/home/me/.local/share/cloudx/uv"],
        [
          "/home/me/.local/share/cloudx/uv/bin/pip",
          "install",
          `uv==${UV_VERSION}`,
        ],
        ["/home/me/.local/share/cloudx/uv/bin/uv", "--version"],
        [
          "/home/me/.local/share/cloudx/uv/bin/uv",
          "sync",
          "--locked",
          "--project",
          "/repo/services/asr",
          "--extra",
          "dev",
        ],
        [
          "/home/me/.local/share/cloudx/uv/bin/uv",
          "sync",
          "--locked",
          "--project",
          "/repo/services/documentation-indexer",
          "--extra",
          "dev",
        ],
        [
          "/repo/services/asr/.venv/bin/hf",
          "download",
          "Systran/faster-whisper-large-v3",
          "--local-dir",
          "/home/me/.cache/cloudx/models/faster-whisper-large-v3",
        ],
        ["npm", "run", "build"],
      ]),
    );
    const env = runner.writes.find(
      (write) => write.path === "/home/me/.config/cloudx/cloudx.env",
    )?.contents;
    expect(env).toContain(`CLOUDX_ASSISTANT_BIN=${TEST_CODEX_BIN}`);
    expect(env).toContain(
      `CLOUDX_TOOL_PATH=${path.join(TEST_CODEX_PREFIX, "bin")}:/usr/bin`,
    );
    expect(env).toContain("CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:7820");
    expect(
      runner.commands.find(
        (command) =>
          command.command.endsWith("/uv") &&
          command.args.includes("/repo/services/asr"),
      )?.env,
    ).toEqual({ UV_PROJECT_ENVIRONMENT: "/repo/services/asr/.venv" });
    expect(
      runner.commands.find(
        (command) =>
          command.command.endsWith("/uv") &&
          command.args.includes("/repo/services/documentation-indexer"),
      )?.env,
    ).toEqual({
      UV_PROJECT_ENVIRONMENT: "/repo/services/documentation-indexer/.venv",
    });
    expectRuntimeSchemaWrites(runner, "/repo");
  });

  it("plans an auto-detected NVIDIA T400 install with CUDA ASR libraries", async () => {
    const runner = new InstallerRunner({
      dryRun: true,
      cwd: "/repo",
      log: () => undefined,
    });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      runner,
      osRelease: {
        ID: "ubuntu",
        VERSION_ID: "22.04",
        PRETTY_NAME: "Ubuntu 22.04 LTS",
      },
      gpuDetected: true,
      nvidiaGpuInfo: {
        name: "NVIDIA T400",
        driverVersion: "595.57.01",
        memoryMb: 4096,
      },
      cudaRuntimeReady: false,
      parallelism: 12,
      answers: {
        installServices: false,
        runCodexLogin: true,
      },
    });

    const planned = runner.commands.map((command) => [
      command.command,
      ...command.args,
    ]);
    expect(result.envConfig).toMatchObject({
      device: "cuda",
      computeType: "int8_float16",
    });
    expect(planned).toContainEqual([
      "/home/me/.local/share/cloudx/uv/bin/uv",
      "sync",
      "--locked",
      "--project",
      "/repo/services/asr",
      "--extra",
      "dev",
      "--extra",
      "cuda",
    ]);
    expect(planned).toContainEqual([
      "/home/me/.local/share/cloudx/uv/bin/uv",
      "sync",
      "--locked",
      "--project",
      "/repo/services/documentation-indexer",
      "--extra",
      "dev",
      "--extra",
      "cuda",
    ]);
    const env = runner.writes.find(
      (write) => write.path === "/home/me/.config/cloudx/cloudx.env",
    )?.contents;
    expect(env).toContain("CLOUDX_ASR_DEVICE=cuda");
    expect(env).toContain("CLOUDX_ASR_COMPUTE_TYPE=int8_float16");
  });

  it("always replaces a stale network bind with the loopback boundary", async () => {
    const runner = new InstallerRunner({
      dryRun: true,
      cwd: "/repo",
      log: () => undefined,
    });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: { ...TEST_ENV, CLOUDX_HOST: "0.0.0.0" },
      dryRun: true,
      yes: true,
      runner,
      osRelease: {
        ID: "ubuntu",
        VERSION_ID: "24.04",
        PRETTY_NAME: "Ubuntu 24.04 LTS",
      },
      gpuDetected: false,
      cudaRuntimeReady: false,
      parallelism: 12,
      answers: { installServices: false, runCodexLogin: true },
      networkInterfaces: {
        eth0: [{ family: "IPv4", internal: false, address: "192.0.2.249" }],
      },
    });

    expect(result.envConfig.host).toBe("127.0.0.1");
    expect(result.urls).toEqual(["https://127.0.0.1:3001"]);
  });

  it("plans optional whisper.cpp documentation ASR installation", async () => {
    const runner = new InstallerRunner({
      dryRun: true,
      cwd: "/repo",
      log: () => undefined,
    });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      runner,
      osRelease: {
        ID: "ubuntu",
        VERSION_ID: "24.04",
        PRETTY_NAME: "Ubuntu 24.04 LTS",
      },
      gpuDetected: false,
      cudaRuntimeReady: false,
      intelGpuDetected: true,
      parallelism: 12,
      answers: {
        installWhisperCpp: true,
        whisperCppBuild: "sycl",
        installServices: false,
        runCodexLogin: true,
      },
    });

    const planned = runner.commands.map((command) => [
      command.command,
      ...command.args,
    ]);
    expect(result.envConfig.documentationAsrBackend).toBe("whisper-cpp");
    expect(result.envConfig.whisperCpp).toMatchObject({
      build: "sycl",
      model: WHISPER_CPP_MODEL,
      bin: "/home/me/.local/share/cloudx/whisper.cpp/build-sycl/bin/whisper-cli",
      modelPath:
        "/home/me/.cache/cloudx/models/whisper.cpp/ggml-large-v3-turbo.bin",
      vadModelPath:
        "/home/me/.cache/cloudx/models/whisper.cpp/ggml-silero-v6.2.0.bin",
    });
    expect(planned).toContainEqual([
      "bash",
      "-lc",
      "wget -O- https://apt.repos.intel.com/intel-gpg-keys/GPG-PUB-KEY-INTEL-SW-PRODUCTS.PUB | gpg --dearmor | sudo tee /usr/share/keyrings/oneapi-archive-keyring.gpg > /dev/null",
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
      "clinfo",
    ]);
    expect(planned).toContainEqual([
      "git",
      "clone",
      "--depth",
      "1",
      WHISPER_CPP_REPO_URL,
      "/home/me/.local/share/cloudx/whisper.cpp",
    ]);
    expect(planned).toContainEqual([
      "bash",
      "-lc",
      "source /opt/intel/oneapi/setvars.sh >/dev/null && cmake -B '/home/me/.local/share/cloudx/whisper.cpp/build-sycl' -S '/home/me/.local/share/cloudx/whisper.cpp' -DGGML_SYCL=ON -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx && cmake --build '/home/me/.local/share/cloudx/whisper.cpp/build-sycl' -j --config Release --target whisper-cli",
    ]);
    expect(planned).toContainEqual([
      "bash",
      "/home/me/.local/share/cloudx/whisper.cpp/models/download-ggml-model.sh",
      "large-v3-turbo",
      "/home/me/.cache/cloudx/models/whisper.cpp",
    ]);
    expect(planned).toContainEqual([
      "bash",
      "/home/me/.local/share/cloudx/whisper.cpp/models/download-vad-model.sh",
      WHISPER_CPP_VAD_MODEL,
      "/home/me/.cache/cloudx/models/whisper.cpp",
    ]);
    const env = runner.writes.find(
      (write) => write.path === "/home/me/.config/cloudx/cloudx.env",
    )?.contents;
    expect(env).toContain("CLOUDX_DOCUMENTATION_ASR_BACKEND=whisper-cpp");
    expect(env).toContain("CLOUDX_DOCUMENTATION_WHISPER_CPP_BUILD=sycl");
    expect(env).toContain("CLOUDX_ASR_BACKEND=whisper-cpp");
    expect(env).toContain(
      "CLOUDX_ASR_WHISPER_CPP_MODEL_PATH=/home/me/.cache/cloudx/models/whisper.cpp/ggml-large-v3-turbo.bin",
    );
    expect(env).toContain("CLOUDX_ASR_WHISPER_CPP_VAD=true");
    expect(env).toContain(
      "CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH=/home/me/.cache/cloudx/models/whisper.cpp/ggml-silero-v6.2.0.bin",
    );
    expect(env).toContain("CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD=true");
    expect(env).toContain(
      "CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD_MODEL_PATH=/home/me/.cache/cloudx/models/whisper.cpp/ggml-silero-v6.2.0.bin",
    );
    expect(env).toContain("ONEAPI_DEVICE_SELECTOR=opencl:gpu");
  });

  it("plans service install, linger, and verification when services start", async () => {
    const runner = new InstallerRunner({
      dryRun: true,
      cwd: "/repo",
      log: () => undefined,
    });

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
        runCodexLogin: true,
      },
    });

    const planned = runner.commands.map((command) => [
      command.command,
      ...command.args,
    ]);
    expect(planned).toContainEqual([
      "sudo",
      "loginctl",
      "enable-linger",
      os.userInfo().username,
    ]);
    expect(planned).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "cloudx-asr.service",
      "cloudx-documentation.service",
      "cloudx.service",
    ]);
    expect(planned).toContainEqual([
      "systemctl",
      "--user",
      "restart",
      "cloudx-asr.service",
      "cloudx-documentation.service",
      "cloudx.service",
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
      "--insecure",
      "https://127.0.0.1:3001/api/ready",
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
      "http://127.0.0.1:7810/ready",
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
      "http://127.0.0.1:7820/ready",
    ]);
    expect(
      runner.commands.find(
        (command) =>
          command.command === "curl" &&
          command.args.includes("https://127.0.0.1:3001/api/ready"),
      )?.capture,
    ).toBe(true);
    expect(runner.writes.map((write) => write.path)).toEqual(
      expect.arrayContaining([
        "/home/me/.config/systemd/user/cloudx.service",
        "/home/me/.config/systemd/user/cloudx-asr.service",
        "/home/me/.config/systemd/user/cloudx-documentation.service",
      ]),
    );
  });

  it("plans a conservative uninstall by default", async () => {
    const runner = new InstallerRunner({
      dryRun: true,
      cwd: "/repo",
      log: () => undefined,
    });

    const result = await runInstaller({
      repoRoot: "/repo",
      home: "/home/me",
      env: TEST_ENV,
      dryRun: true,
      yes: true,
      uninstall: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
    });

    const planned = runner.commands.map((command) => [
      command.command,
      ...command.args,
    ]);
    expect(result.removed).toMatchObject({
      removeServices: true,
      removeConfig: false,
      removeVenv: true,
      removeRuntimeData: false,
      removeModel: false,
      removeNodeModules: false,
      disableLinger: false,
    });
    expect(planned).toEqual(
      expect.arrayContaining([
        [
          "systemctl",
          "--user",
          "stop",
          "cloudx-asr.service",
          "cloudx-documentation.service",
          "cloudx.service",
        ],
        [
          "systemctl",
          "--user",
          "disable",
          "cloudx-asr.service",
          "cloudx-documentation.service",
          "cloudx.service",
        ],
        ["rm", "-rf", "/home/me/.config/systemd/user/cloudx.service"],
        ["rm", "-rf", "/home/me/.config/systemd/user/cloudx-asr.service"],
        [
          "rm",
          "-rf",
          "/home/me/.config/systemd/user/cloudx-documentation.service",
        ],
        ["rm", "-rf", "/home/me/.local/share/cloudx/uv"],
        ["rm", "-rf", "/repo/services/asr/.venv"],
        ["rm", "-rf", "/repo/services/documentation-indexer/.venv"],
      ]),
    );
    expect(planned).not.toContainEqual([
      "rm",
      "-rf",
      "/home/me/.cache/cloudx/models/faster-whisper-large-v3",
    ]);
    expect(planned).not.toContainEqual([
      "rm",
      "-rf",
      "/home/me/.config/cloudx/cloudx.env",
    ]);
    expect(planned).not.toContainEqual(["rm", "-rf", "/repo/node_modules"]);
  });

  it("plans optional uninstall removals when selected", async () => {
    const runner = new InstallerRunner({
      dryRun: true,
      cwd: "/repo",
      log: () => undefined,
    });

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
        removeConfig: true,
        removeRuntimeData: true,
        removeModel: true,
        removeNodeModules: true,
        disableLinger: true,
      },
    });

    const planned = runner.commands.map((command) => [
      command.command,
      ...command.args,
    ]);
    expect(planned).toEqual(
      expect.arrayContaining([
        ["rm", "-rf", "/repo/.cloudx"],
        ["rm", "-rf", "/home/me/.config/cloudx/cloudx.env"],
        ["rm", "-rf", "/home/me/.cache/cloudx/models/faster-whisper-large-v3"],
        ["rm", "-rf", "/repo/node_modules"],
        ["sudo", "loginctl", "disable-linger", os.userInfo().username],
      ]),
    );
  });

  it("does not remove any installer-owned artifact when stopping an active service fails", async () => {
    class StopFailingRunner extends InstallerRunner {
      capture(command, args, options) {
        if (command === "systemctl" && args.includes("show")) {
          return "LoadState=loaded\nActiveState=active";
        }
        return super.capture(command, args, options);
      }

      run(command, args = [], options = {}) {
        this.commands.push({ command, args, cwd: options.cwd ?? this.cwd });
        if (command === "systemctl" && args.includes("stop")) {
          if (options.allowFailure) {
            return "";
          }
          throw new Error("systemctl stop failed");
        }
        return "";
      }
    }

    const runner = new StopFailingRunner({
      cwd: "/repo",
      log: () => undefined,
    });

    await expect(
      runInstaller({
        repoRoot: "/repo",
        home: "/home/me",
        env: TEST_ENV,
        yes: true,
        uninstall: true,
        runner,
        osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
      }),
    ).rejects.toThrow("systemctl stop failed");

    expect(runner.commands).toEqual([
      {
        command: "systemctl",
        args: ["--user", "stop", ...[
          "cloudx-asr.service",
          "cloudx-documentation.service",
          "cloudx.service",
        ]],
        cwd: "/repo",
      },
    ]);
    expect(runner.commands.some((command) => command.remove)).toBe(false);
  });

  it("plans an update from main that preserves configuration and verifies its services", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-update-repo-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-update-home-"));
    const runner = new InstallerRunner({
      dryRun: true,
      cwd: root,
      log: () => undefined,
    });
    runner.inspect = (command, args) => {
      if (command === "git") {
        if (args.includes("--show-toplevel")) return root;
        if (args[0] === "status") return "";
        if (args[0] === "remote") return "/fixture/origin.git";
        return "a".repeat(40);
      }
      const service = args[2];
      if (!fs.existsSync(path.join(home, ".config/systemd/user", service))) return "LoadState=not-found";
      return [
        "LoadState=loaded",
        "NeedDaemonReload=no",
        `WorkingDirectory=${root}`,
        `FragmentPath=${path.join(home, ".config/systemd/user", service)}`,
        `EnvironmentFiles=${path.join(home, ".config/cloudx/cloudx.env")} (ignore_errors=no)`,
      ].join("\n");
    };
    fs.mkdirSync(path.join(home, ".config/cloudx"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config/systemd/user"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".config/cloudx/cloudx.env"),
      "CLOUDX_HOST=0.0.0.0\nCLOUDX_PORT=3443\nCLOUDX_TRUSTED_ORIGINS=https://192.168.8.250:3443\nCLOUDX_ASR_DEVICE=cuda\nCLOUDX_ASR_COMPUTE_TYPE=int8_float16\nCLOUDX_DOCUMENTATION_URL=http://127.0.0.1:9000\nCLOUDX_DOCUMENTATION_PORT=9000\n",
    );
    fs.writeFileSync(
      path.join(home, ".config/systemd/user/cloudx.service"),
      "",
    );
    fs.writeFileSync(
      path.join(home, ".config/systemd/user/cloudx-asr.service"),
      "",
    );
    const codexPrefix = path.join(home, CLOUDX_NPM_GLOBAL_DIR);
    const codexBin = path.join(codexPrefix, "bin/codex");

    const result = await runInstaller({
      repoRoot: root,
      home,
      env: {
        ...TEST_ENV,
        npm_config_prefix: "/usr/local/lib/node_modules/node",
      },
      dryRun: true,
      yes: true,
      update: true,
      runner,
      osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
      answers: {
        runCodexLogin: true,
        restartServices: true,
      },
      networkInterfaces: {
        eth0: [{ family: "IPv4", internal: false, address: "192.0.2.249" }],
      },
    });

    const planned = runner.commands.map((command) => [
      command.command,
      ...command.args,
    ]);
    expect(result).toMatchObject({
      port: 3443,
      servicesInstalled: true,
      restartServices: true,
    });
    expect(result.urls).toEqual(["https://127.0.0.1:3443"]);
    const updatedEnv = runner.writes.find(
      (write) => write.path === path.join(home, ".config/cloudx/cloudx.env"),
    )?.contents;
    expect(updatedEnv).toContain(`CLOUDX_ASSISTANT_BIN=${codexBin}`);
    expect(updatedEnv).toContain(
      `CLOUDX_TOOL_PATH=${path.join(codexPrefix, "bin")}:/usr/bin`,
    );
    expect(updatedEnv).toContain("CLOUDX_HOST=0.0.0.0");
    expect(updatedEnv).toContain(
      "CLOUDX_TRUSTED_ORIGINS=https://192.168.8.250:3443",
    );
    expect(updatedEnv).toContain("CLOUDX_ASR_DEVICE=cuda");
    expect(updatedEnv).toContain("CLOUDX_ASR_COMPUTE_TYPE=int8_float16");
    expect(updatedEnv).toContain(
      "CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:9000",
    );
    expect(updatedEnv).not.toContain(
      "CLOUDX_DOCUMENTATION_URL=http://127.0.0.1:7820",
    );
    expect(updatedEnv).toContain(
      `CLOUDX_DOCUMENTATION_DATA_DIR=${path.join(root, ".cloudx/documentation")}`,
    );
    expect(updatedEnv).not.toContain("CLOUDX_CODEX_BIN");
    expectRuntimeSchemaWrites(runner, root);
    expect(planned).toEqual(
      expect.arrayContaining([
        ["node", "-v"],
        ["npm", "-v"],
        [
          "git",
          "fetch",
          "--no-tags",
          "origin",
          "+refs/heads/main:refs/remotes/origin/main",
        ],
        ["git", "merge", "--ff-only", "--no-edit", "refs/remotes/origin/main"],
        ["npm", "i", "-g", "--prefix", codexPrefix, "@openai/codex@0.153.4"],
        [codexBin, "--version"],
        ["npm", "ci"],
        ["python3", "-m", "venv", path.join(home, ".local/share/cloudx/uv")],
        [
          path.join(home, ".local/share/cloudx/uv/bin/pip"),
          "install",
          `uv==${UV_VERSION}`,
        ],
        [path.join(home, ".local/share/cloudx/uv/bin/uv"), "--version"],
        [
          path.join(home, ".local/share/cloudx/uv/bin/uv"),
          "sync",
          "--locked",
          "--project",
          path.join(root, "services/asr"),
          "--extra",
          "dev",
          "--extra",
          "cuda",
        ],
        [
          path.join(home, ".local/share/cloudx/uv/bin/uv"),
          "sync",
          "--locked",
          "--project",
          path.join(root, "services/documentation-indexer"),
          "--extra",
          "dev",
          "--extra",
          "cuda",
        ],
        ["npm", "run", "build"],
        ["npm", "run", "cert:create"],
        ["systemctl", "--user", "daemon-reload"],
        [
          "systemctl",
          "--user",
          "restart",
          "cloudx-asr.service",
          "cloudx-documentation.service",
          "cloudx.service",
        ],
      ]),
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
      "https://127.0.0.1:3443/api/ready",
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
      "http://127.0.0.1:7810/ready",
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
      "http://127.0.0.1:9000/ready",
    ]);
    expect(
      runner.commands.find(
        (command) =>
          command.command === "curl" &&
          command.args.includes("https://127.0.0.1:3443/api/ready"),
      )?.capture,
    ).toBe(true);
    expect(runner.writes.map((write) => write.path)).toEqual(
      expect.arrayContaining([
        path.join(home, ".config/systemd/user/cloudx.service"),
        path.join(home, ".config/systemd/user/cloudx-asr.service"),
        path.join(home, ".config/systemd/user/cloudx-documentation.service"),
      ]),
    );
  });
});
