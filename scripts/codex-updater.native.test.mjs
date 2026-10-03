import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updateCodexInstallation } from "./codex-updater.mjs";
import { readCodexSelection, resolveSelectedCodexCommand } from "./codex-selection.mjs";

const nativeBinary = process.env.CLOUDX_NATIVE_CODEX;

describe.skipIf(!nativeBinary)("native Codex update acceptance", () => {
  it.each(["updated", "current"])("reports a candidate as %s only after its real CloudX tab and synthetic provider turn pass", async outcome => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-update-"));
    try {
      const version = execFileSync(nativeBinary, ["--version"], { encoding: "utf8" }).trim().replace(/^codex-cli /u, "");
      const prefix = path.join(root, "npm-prefix");
      const packageDir = path.join(prefix, "lib/node_modules/@openai/codex");
      const assistantBin = path.join(prefix, "bin/codex");
      const tools = path.join(root, "tools");
      await Promise.all([path.join(packageDir, "bin"), path.dirname(assistantBin), tools].map(directory => fs.mkdir(directory, { recursive: true })));
      const manifestPath = path.join(packageDir, "package.json");
      const candidatePath = path.join(root, "candidate");
      const entrypoint = path.join(packageDir, "bin/codex.js");
      const candidate = `#!/bin/sh\nexec '${nativeBinary.replaceAll("'", "'\\''")}' "$@"\n`;
      await fs.writeFile(candidatePath, candidate, { mode: 0o755 });
      await fs.writeFile(manifestPath, JSON.stringify({ name: "@openai/codex", version: outcome === "current" ? version : "0.0.0", bin: { codex: "bin/codex.js" } }));
      await fs.writeFile(entrypoint, outcome === "current" ? candidate : "#!/bin/sh\nprintf 'codex-cli 0.0.0\\n'\n", { mode: 0o755 });
      await fs.symlink(entrypoint, assistantBin);
      const commandLog = path.join(root, "npm-commands");
      await fs.writeFile(path.join(tools, "npm"), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(commandLog)}, process.argv[2] + '\\n');
if (process.argv[2] === 'view') console.log(JSON.stringify({versions: [${JSON.stringify(version)}], 'dist-tags': {latest: ${JSON.stringify(version)}}}));
else if (process.argv[2] === 'i') {
  const path = require('node:path');
  const candidatePrefix = process.argv[process.argv.indexOf('--prefix') + 1];
  const candidatePackage = path.join(candidatePrefix, 'lib/node_modules/@openai/codex');
  fs.mkdirSync(path.join(candidatePackage, 'bin'), {recursive: true});
  fs.mkdirSync(path.join(candidatePrefix, 'bin'), {recursive: true});
  const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(manifestPath)}, 'utf8'));
  manifest.version = ${JSON.stringify(version)};
  fs.writeFileSync(path.join(candidatePackage, 'package.json'), JSON.stringify(manifest));
  fs.copyFileSync(${JSON.stringify(candidatePath)}, path.join(candidatePackage, 'bin/codex.js'));
  fs.symlinkSync(path.join(candidatePackage, 'bin/codex.js'), path.join(candidatePrefix, 'bin/codex'));
} else process.exit(91);
`, { mode: 0o755 });
      let output = "";
      let result;
      try {
        result = await updateCodexInstallation({ assistantBin, prefix, env: {
          HOME: path.join(root, "home"), CODEX_HOME: path.join(root, "shared-state"), CLOUDX_DATA_DIR: path.join(root, "data"),
          PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}`,
        }, onOutput: text => { output += text; } });
      } catch (error) {
        throw new Error(`${error.message}\n${output}`, { cause: error });
      }
      expect(result).toEqual({ outcome, installedVersion: version, activeVersion: version, previousVersion: null });
      const selected = readCodexSelection(prefix).active;
      expect(resolveSelectedCodexCommand(assistantBin)).toBe(selected.assistantBin);
      expect(selected.version).toBe(version);
      expect(JSON.parse(await fs.readFile(manifestPath, "utf8")).version).toBe(outcome === "current" ? version : "0.0.0");
      expect(selected.assistantBin === assistantBin).toBe(outcome === "current");
      expect(output).toContain("Resumed Forge turn matched the selected thread, native completion and final shutdown.");
      expect(await fs.readFile(commandLog, "utf8")).toBe(outcome === "current" ? "view\n" : "view\ni\n");
      await expect(fs.stat(path.join(prefix, ".cloudx-codex-update.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 70_000);
});

it.skipIf(!nativeBinary)("rejects an incompatible original-prefix rollback after A to B and probes the exact previous binary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-rollback-"));
  try {
    const versionA = "0.0.1";
    const versionB = execFileSync(nativeBinary, ["--version"], { encoding: "utf8" }).trim().replace(/^codex-cli /u, "");
    const prefix = path.join(root, "prefix");
    const assistantBin = path.join(prefix, "bin/codex");
    const packageDir = path.join(prefix, "lib/node_modules/@openai/codex");
    const tools = path.join(root, "tools");
    const sharedStateHome = path.join(root, "shared-state");
    const commandLog = path.join(root, "launches");
    const rejectA = path.join(root, "reject-original");
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    await Promise.all([path.join(packageDir, "bin"), path.dirname(assistantBin), tools, sharedStateHome].map(directory => fs.mkdir(directory, { recursive: true })));
    const wrapper = (label, version) => [
      "#!/bin/sh",
      `if [ "$1" = --version ]; then printf 'codex-cli ${version}\\n'; exit; fi`,
      `printf '${label}\\n' >> ${quote(commandLog)}`,
      ...(label === "A" ? [`if [ -f ${quote(rejectA)} ]; then exit 86; fi`] : []),
      `exec ${quote(nativeBinary)} "$@"`, ""
    ].join("\n");
    const manifest = version => JSON.stringify({ name: "@openai/codex", version, bin: { codex: "bin/codex.js" } });
    await fs.writeFile(path.join(packageDir, "package.json"), manifest(versionA));
    await fs.writeFile(path.join(packageDir, "bin/codex.js"), wrapper("A", versionA), { mode: 0o700 });
    await fs.symlink(path.join(packageDir, "bin/codex.js"), assistantBin);
    await fs.writeFile(path.join(tools, "npm"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === 'view') console.log(JSON.stringify({versions: [${JSON.stringify(versionA)}, ${JSON.stringify(versionB)}], 'dist-tags': {latest: ${JSON.stringify(versionB)}}}));
else if (process.argv[2] === 'i') {
  const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
  const packageDir = path.join(prefix, 'lib/node_modules/@openai/codex');
  fs.mkdirSync(path.join(packageDir, 'bin'), {recursive: true});
  fs.mkdirSync(path.join(prefix, 'bin'), {recursive: true});
  fs.writeFileSync(path.join(packageDir, 'package.json'), ${JSON.stringify(manifest(versionB))});
  fs.writeFileSync(path.join(packageDir, 'bin/codex.js'), ${JSON.stringify(wrapper("B", versionB))}, {mode: 0o700});
  fs.symlinkSync(path.join(packageDir, 'bin/codex.js'), path.join(prefix, 'bin/codex'));
} else process.exit(91);
`, { mode: 0o700 });
    const env = { PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}`, HOME: path.join(root, "home"), CODEX_HOME: sharedStateHome, CLOUDX_DATA_DIR: path.join(root, "data") };
    const options = { assistantBin, prefix, env };
    await expect(updateCodexInstallation({ ...options, targetVersion: versionA })).resolves.toMatchObject({ outcome: "current", activeVersion: versionA });
    await expect(updateCodexInstallation({ ...options, targetVersion: versionB })).resolves.toMatchObject({ outcome: "updated", activeVersion: versionB, previousVersion: versionA });
    const selected = readCodexSelection(prefix);
    expect(selected.previous.assistantBin).toBe(assistantBin);
    expect((await fs.readFile(commandLog, "utf8")).trim().split("\n")).toEqual(["A", "A", "A", "A", "B", "B", "B", "B"]);
    await fs.writeFile(rejectA, "Startup incompatibility introduced after A was originally verified.\n");
    await fs.writeFile(commandLog, "");

    await expect(updateCodexInstallation({ ...options, targetVersion: versionA })).rejects.toMatchObject({ code: "runtime-verification", usableVersion: versionB });

    expect(readCodexSelection(prefix)).toEqual(selected);
    expect(resolveSelectedCodexCommand(assistantBin)).toBe(selected.active.assistantBin);
    const rejectedLaunches = (await fs.readFile(commandLog, "utf8")).trim().split("\n");
    expect(rejectedLaunches.length).toBeGreaterThan(0);
    expect(new Set(rejectedLaunches)).toEqual(new Set(["A"]));
    await expect(fs.stat(path.join(prefix, ".cloudx-codex-update.lock"))).rejects.toMatchObject({ code: "ENOENT" });

    execFileSync("python3", ["-I", "-S", "-c", "import sqlite3, sys; sqlite3.connect(sys.argv[1]).close()", path.join(sharedStateHome, "state_5.sqlite")]);
    await fs.writeFile(commandLog, "");
    const { verifyCodexRuntime } = await import("./codex-runtime-verification.mjs");
    await expect(verifyCodexRuntime({ assistantBin: selected.active.assistantBin, previousAssistantBin: assistantBin, env, sharedStateHome })).rejects.toThrow("did not save a selected conversation");
    const compatibilityLaunches = (await fs.readFile(commandLog, "utf8")).trim().split("\n");
    expect(compatibilityLaunches.slice(0, 8)).toEqual(Array(8).fill("B"));
    expect(compatibilityLaunches.slice(8)).toContain("A");
    expect(readCodexSelection(prefix)).toEqual(selected);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 70_000);
