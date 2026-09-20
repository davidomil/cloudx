import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { renderAsrService, renderDocumentationService } from "./install-cloudx.mjs";

function launcherFixture(kind, { namespace = true, libraries = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-launcher-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  const executableDir = path.join(root, "a space ' quote $USER %i \\ path");
  fs.mkdirSync(executableDir);
  const python = path.join(executableDir, "python");
  fs.symlinkSync(execFileSync("which", ["python3"], { encoding: "utf8" }).trim(), python);
  const launcher = path.join(executableDir, "service");
  fs.writeFileSync(launcher, '#!/bin/sh\nprintf "%s" "$LD_LIBRARY_PATH"\n', { mode: 0o700 });
  const packageDirs = [path.join(root, "packages-one"), path.join(root, "packages-two")];
  const libraryPaths = [];
  if (libraries) {
    for (const name of ["cublas", "cudnn"]) {
      for (const directory of namespace ? packageDirs : packageDirs.slice(0, 1)) {
        const library = path.join(directory, "nvidia", name, "lib");
        fs.mkdirSync(library, { recursive: true });
        if (!namespace) fs.writeFileSync(path.join(library, "__init__.py"), "");
        libraryPaths.push(library);
      }
    }
  }
  const envPath = path.join(root, "cloudx.env");
  fs.writeFileSync(envPath, "");
  const unit = kind === "ASR"
    ? renderAsrService({ repoRoot: root, envPath, pythonPath: python, uvicornPath: launcher, asrDir: executableDir })
    : renderDocumentationService({ repoRoot: root, envPath, documentationPythonPath: python, documentationIndexerPath: launcher });
  const unitPath = path.join(root, "launcher.service");
  fs.writeFileSync(unitPath, unit);
  return { unitPath, libraryPaths, pythonPath: packageDirs.join(":"), root, runtimeDir };
}

function runSystemdLauncher(fixture, env) {
  const verificationEnv = { ...process.env, SYSTEMD_LOG_LEVEL: "debug", XDG_RUNTIME_DIR: fixture.runtimeDir };
  delete verificationEnv.DBUS_SESSION_BUS_ADDRESS;
  const verified = spawnSync("systemd-analyze", ["--user", "--man=no", "verify", fixture.unitPath], {
    encoding: "utf8",
    env: verificationEnv,
  });
  expect(verified.status, verified.stderr).toBe(0);
  const command = /Command Line: (.+)/.exec(verified.stdout)?.[1];
  expect(command).toBeDefined();
  const argv = JSON.parse(execFileSync("/bin/bash", [
    "-c", `python3 -c 'import json, sys; print(json.dumps(sys.argv[1:]))' ${command}`,
  ], { encoding: "utf8" }));
  expect(argv).toHaveLength(3);
  expect(argv.slice(0, 2)).toEqual(["/bin/bash", "-lc"]);
  // Verification resolves unit specifiers; execution turns escaped dollars back into shell syntax.
  const script = argv[2].replaceAll("$$", "$");
  return spawnSync(argv[0], [argv[1], script], {
    encoding: "utf8",
    cwd: fixture.root,
    env: { ...process.env, CLOUDX_ASR_BACKEND: "faster-whisper", PYTHONPATH: fixture.pythonPath, ...env },
  });
}

it.each([
  ["ASR", true], ["ASR", false], ["Documentation", true], ["Documentation", false],
])("launches %s with NVIDIA namespace packages=%s and quoted executable paths", (kind, namespace) => {
  const fixture = launcherFixture(kind, { namespace });
  const result = runSystemdLauncher(fixture, {
    CLOUDX_ASR_DEVICE: "cuda",
    CLOUDX_DOCUMENTATION_ASR_DEVICE: "cuda",
    LD_LIBRARY_PATH: "/existing/libraries",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe([...fixture.libraryPaths, "/existing/libraries"].join(":"));
});

it.each(["ASR", "Documentation"])("launches %s on CPU without importing NVIDIA packages", (kind) => {
  const fixture = launcherFixture(kind, { libraries: false });
  const result = runSystemdLauncher(fixture, {
    CLOUDX_ASR_DEVICE: kind === "Documentation" ? "cuda" : "cpu",
    CLOUDX_DOCUMENTATION_ASR_DEVICE: "cpu",
    LD_LIBRARY_PATH: "/existing/libraries",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("/existing/libraries");
});

it.each(["ASR", "Documentation"])("stops %s before launching when required NVIDIA packages are missing", (kind) => {
  const fixture = launcherFixture(kind, { libraries: false });
  const result = runSystemdLauncher(fixture, {
    CLOUDX_ASR_DEVICE: "cuda",
    CLOUDX_DOCUMENTATION_ASR_DEVICE: "cuda",
    LD_LIBRARY_PATH: "/existing/libraries",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("ModuleNotFoundError");
  expect(result.stdout).toBe("");
});

it("inherits the ASR CUDA choice for documentation without appending an empty library path", () => {
  const fixture = launcherFixture("Documentation");
  const result = runSystemdLauncher(fixture, {
    CLOUDX_ASR_DEVICE: "cuda",
    CLOUDX_DOCUMENTATION_ASR_DEVICE: "",
    LD_LIBRARY_PATH: "",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(fixture.libraryPaths.join(":"));
});
