import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCodexSelection, updateCodexInstallation } from "./codex-updater.mjs";
import { verifyCodexRuntime } from "../apps/server/src/plugins/CodexRuntimeVerification.js";

const nativeBinary = process.env.CLOUDX_NATIVE_CODEX;
const previousBinary = process.env.CLOUDX_NATIVE_PREVIOUS_CODEX;

describe.skipIf(!nativeBinary)("native Codex update acceptance", () => {
  it.each(["updated", "current"])("reports a candidate as %s only after its real CloudX tab and Forge turn pass", async outcome => {
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
      const original = outcome === "current" ? candidate : "#!/bin/sh\nprintf 'codex-cli 0.0.0\\n'\n";
      await fs.writeFile(entrypoint, original, { mode: 0o755 });
      await fs.symlink(entrypoint, assistantBin);
      const commandLog = path.join(root, "npm-commands");
      await fs.writeFile(path.join(tools, "npm"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(${JSON.stringify(commandLog)}, process.argv[2] + '\\n');
if (process.argv[2] === 'view') console.log(${JSON.stringify(JSON.stringify({ versions: [version], "dist-tags": { latest: version } }))});
else if (process.argv[2] === 'i') {
  const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
  const packageDir = path.join(prefix, 'lib/node_modules/@openai/codex');
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: ${JSON.stringify(version)}, bin: { codex: 'bin/codex.js' } }));
  fs.copyFileSync(${JSON.stringify(candidatePath)}, path.join(packageDir, 'bin/codex.js'));
  fs.symlinkSync(path.join(packageDir, 'bin/codex.js'), path.join(prefix, 'bin/codex'));
} else process.exit(91);
`, { mode: 0o755 });
      let output = "";
      let result;
      try {
        result = await updateCodexInstallation({ assistantBin, prefix, env: { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}` }, onOutput: text => { output += text; } });
      } catch (error) {
        throw new Error(`${error.message}\n${output}`, { cause: error });
      }
      expect(result).toMatchObject({ outcome, installedVersion: version, activeVersion: version, previousVersion: outcome === "current" ? version : "0.0.0" });
      expect(await fs.readFile(commandLog, "utf8")).toBe(outcome === "current" ? "view\n" : "view\ni\n");
      expect(await fs.readFile(entrypoint, "utf8")).toBe(original);
      const selected = readCodexSelection({ assistantBin, prefix });
      expect(selected.active.version).toBe(version);
      if (outcome === "updated") {
        expect(selected.active.assistantBin).not.toBe(assistantBin);
        // Both new tab types resolve the persisted selection; an existing native
        // process completes after they launch, sharing only isolated Codex state.
        await verifyCodexRuntime({ assistantBin, previousAssistantBin: selected.active.assistantBin });
      }
      await expect(fs.stat(path.join(prefix, ".cloudx-codex-update.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 100_000);

  it.skipIf(!previousBinary)("resumes a saved conversation across versions while the previous session stays running", async () => {
    const output = [];
    await verifyCodexRuntime({ assistantBin: nativeBinary, previousAssistantBin: previousBinary, onOutput: text => output.push(text) });
    expect(output.join("")).toContain("Candidate resumed the previous version's saved conversation");
    expect(output.join("")).toContain("Native Forge worker saved its conversation identity");
    expect(output.join("")).toContain("existing previous-version session completed its turn");
  }, 60_000);

  it.skipIf(!previousBinary).each([false, true])("verifies the retained original binary when returning with an incompatible active CLI: %s", async incompatibleActive => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-return-"));
    try {
      const prefix = path.join(root, "npm-prefix");
      const selectedPrefix = path.join(prefix, ".cloudx-codex/installs/11111111-1111-4111-8111-111111111111");
      const launches = path.join(root, "launches");
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
      async function install(installPrefix, binary, label, incompatible = false) {
        const version = incompatible ? "999.0.0" : execFileSync(binary, ["--version"], { encoding: "utf8" }).trim().replace(/^codex-cli /u, "");
        const packageDir = path.join(installPrefix, "lib/node_modules/@openai/codex");
        const assistantBin = path.join(installPrefix, "bin/codex");
        await fs.mkdir(path.join(packageDir, "bin"), { recursive: true });
        await fs.mkdir(path.dirname(assistantBin), { recursive: true });
        await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version, bin: { codex: "bin/codex.js" } }));
        const entry = path.join(packageDir, "bin/codex.js");
        const command = incompatible
          ? `if [ "$1" = '--version' ]; then printf 'codex-cli ${version}\\n'; else exit 42; fi`
          : `exec ${quote(binary)} "$@"`;
        await fs.writeFile(entry, `#!/bin/sh\nprintf '%s\\n' "${label}:$*" >> ${quote(launches)}\n${command}\n`, { mode: 0o755 });
        await fs.symlink(entry, assistantBin);
        return { assistantBin, version };
      }
      const retained = await install(prefix, nativeBinary, "retained");
      const active = await install(selectedPrefix, previousBinary, "active", incompatibleActive);
      const retainedContents = await fs.readFile(retained.assistantBin, "utf8");
      const activeContents = await fs.readFile(active.assistantBin, "utf8");
      await fs.writeFile(path.join(prefix, ".cloudx-codex-selection.json"), JSON.stringify({ schemaVersion: 1, active, previous: retained }));
      const tools = path.join(root, "tools");
      await fs.mkdir(tools);
      await fs.writeFile(path.join(tools, "npm"), `#!${process.execPath}\nif (process.argv[2] !== 'view') process.exit(91);\nconsole.log(${JSON.stringify(JSON.stringify({ versions: [retained.version, active.version], "dist-tags": { latest: active.version } }))});\n`, { mode: 0o755 });
      const options = { assistantBin: retained.assistantBin, prefix, targetVersion: "previous",
        env: { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}` } };
      if (incompatibleActive) {
        await expect(updateCodexInstallation({ ...options, acknowledgeDowngrade: true })).rejects.toMatchObject({ code: "runtime-verification" });
        expect(readCodexSelection(options)).toMatchObject({ active, previous: retained });
        await expect(updateCodexInstallation({ ...options, recoveryMode: true })).rejects.toMatchObject({ code: "downgrade-confirmation" });
        expect(readCodexSelection(options)).toMatchObject({ active, previous: retained });
        await fs.writeFile(launches, "");
      }
      const output = [];
      const result = await updateCodexInstallation({ ...options, acknowledgeDowngrade: true, recoveryMode: incompatibleActive, onOutput: text => output.push(text) });
      expect(result).toMatchObject({ activeVersion: retained.version, previousVerifiedVersion: active.version });
      expect(readCodexSelection({ assistantBin: retained.assistantBin, prefix })).toMatchObject({ active: retained, previous: active });
      const nativeLaunches = (await fs.readFile(launches, "utf8")).split("\n").filter(line => line.includes("app-server"));
      expect(nativeLaunches.filter(line => line.startsWith("retained:"))).toHaveLength(2);
      expect(nativeLaunches.filter(line => line.startsWith("active:"))).toHaveLength(incompatibleActive ? 0 : 2);
      expect(await fs.readFile(retained.assistantBin, "utf8")).toBe(retainedContents);
      expect(await fs.readFile(active.assistantBin, "utf8")).toBe(activeContents);
      expect(output.join("")).toContain("Selected conversation saved before any model prompt");
      expect(output.join("")).toContain("Native Forge worker saved its conversation identity");
      if (incompatibleActive) expect(output.join("")).toContain("Cross-version shared-state compatibility is not checked");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
