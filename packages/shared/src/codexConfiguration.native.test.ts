import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CODEX_CONFIGURATION_CLI_OPTIONS, codexConfigurationCliCatalog, codexConfigurationCliCoverage, type CodexConfigurationVersion } from "./codexConfiguration.js";

const selected = process.env.CLOUDX_CODEX_CONFIGURATION_BIN;

describe.skipIf(!selected)("selected Codex launch-option coverage", () => {
  it("fails when the selected executable exposes a launch option missing from its reviewed catalog", () => {
    const output = execFileSync(selected!, ["--version"], { encoding: "utf8", timeout: 10_000 });
    const version = output.trim().replace(/^codex-cli\s+/, "") as CodexConfigurationVersion;
    const catalog = codexConfigurationCliCatalog(version);
    for (const command of Object.keys(CODEX_CONFIGURATION_CLI_OPTIONS[version])) {
      const help = execFileSync(selected!, [...command.split(" ").slice(1), "--help"], { encoding: "utf8", timeout: 10_000 });
      expect(codexConfigurationCliCoverage(help, command, catalog), command).toEqual([]);
    }
    for (const option of catalog.filter(entry => entry.aliasOf || entry.internal)) {
      expect(() => execFileSync(selected!, [...option.command.split(" ").slice(1), option.flag, "--help"], { encoding: "utf8", timeout: 10_000 }), option.path).not.toThrow();
    }
  });
});
