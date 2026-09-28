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
