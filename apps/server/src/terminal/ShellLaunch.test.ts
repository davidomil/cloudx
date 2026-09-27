import { afterEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildInteractiveShellLaunch, buildLoginShellCommandLaunch, buildToolEnv, resolveAssistantCommand, shellQuote } from "./ShellLaunch.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("ShellLaunch", () => {
  it("starts bash terminals as login shells", () => {
    expect(buildInteractiveShellLaunch({ SHELL: "/bin/bash" })).toEqual({
      command: "/bin/bash",
      args: ["-l"]
    });
  });

  it("runs commands through bash login shell so user PATH setup is loaded", () => {
    expect(buildLoginShellCommandLaunch("codex", ["exec", "--model", "gpt-5.3-codex-spark"], { SHELL: "/bin/bash" })).toEqual({
      command: "/bin/bash",
      args: ["-lc", "exec codex exec --model gpt-5.3-codex-spark"]
    });
  });

  it("falls back to direct command launch for unsupported shells", () => {
    expect(buildLoginShellCommandLaunch("codex", [], { SHELL: "/usr/bin/nu" })).toEqual({
      command: "codex",
      args: []
    });
  });

  it("prefers the installer-recorded assistant binary path", () => {
    expect(resolveAssistantCommand({ CLOUDX_ASSISTANT_BIN: "/opt/bin/claude" })).toBe("/opt/bin/claude");
    expect(resolveAssistantCommand({}, "claude")).toBe("claude");
    expect(resolveAssistantCommand({})).toBe("codex");
  });

  it("reads each new launch's selected binary without replacing the configured base or an unrelated shell command", () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-launch-selection-"));
    directories.push(prefix);
    const base = path.join(prefix, "bin/codex");
    const candidate = path.join(prefix, ".cloudx-codex/installs/11111111-1111-4111-8111-111111111111/bin/codex");
    for (const [binary, version] of [[base, "0.153.4"], [candidate, "0.155.1"]]) {
      const packageDir = path.join(path.dirname(path.dirname(binary)), "lib/node_modules/@openai/codex");
      fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version, bin: { codex: "bin/codex.js" } }));
      fs.writeFileSync(path.join(packageDir, "bin/codex.js"), "fixture", { mode: 0o755 });
      fs.symlinkSync(path.join(packageDir, "bin/codex.js"), binary);
    }
    const env = { CLOUDX_ASSISTANT_BIN: base };
    expect(resolveAssistantCommand(env)).toBe(base);
    fs.writeFileSync(path.join(prefix, ".cloudx-codex-selection.json"), JSON.stringify({
      schemaVersion: 1, active: { version: "0.155.1", assistantBin: candidate }, previous: null
    }));
    expect(resolveAssistantCommand(env)).toBe(candidate);
    expect(env.CLOUDX_ASSISTANT_BIN).toBe(base);
    expect(resolveAssistantCommand({ CLOUDX_ASSISTANT_BIN: "codex", CLOUDX_NPM_GLOBAL_DIR: prefix })).toBe("codex");
    fs.writeFileSync(path.join(prefix, ".cloudx-codex-selection.json"), JSON.stringify({
      schemaVersion: 1, active: { version: "0.153.4", assistantBin: base }, previous: { version: "0.155.1", assistantBin: candidate }
    }));
    expect(resolveAssistantCommand(env)).toBe(base);
  });

  it("fails a launch clearly when its persisted selection is corrupt", () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-launch-selection-"));
    directories.push(prefix);
    fs.writeFileSync(path.join(prefix, ".cloudx-codex-selection.json"), "{");
    expect(() => resolveAssistantCommand({ CLOUDX_ASSISTANT_BIN: path.join(prefix, "bin/codex") })).toThrow(/selection/i);
    expect(buildToolEnv({ CLOUDX_ASSISTANT_BIN: path.join(prefix, "bin/codex"), PATH: "/usr/bin" }).PATH).toBe(`${prefix}/bin:/usr/bin`);
  });

  it("builds a child env with configured tool paths before the inherited path", () => {
    const env = buildToolEnv({
      CLOUDX_ASSISTANT_BIN: "/opt/assistant/bin/codex",
      CLOUDX_TOOL_PATH: ["/home/me/.local/bin", "/opt/assistant/bin"].join(path.delimiter),
      PATH: ["/usr/bin", "/opt/assistant/bin"].join(path.delimiter)
    });

    expect(env.PATH?.split(path.delimiter)).toEqual(["/home/me/.local/bin", "/opt/assistant/bin", "/usr/bin"]);
  });

  it("quotes shell command arguments with spaces and quotes", () => {
    expect(shellQuote("/tmp/with space/it's.json")).toBe("'/tmp/with space/it'\\''s.json'");
  });
});
