import { describe, expect, it, onTestFinished } from "vitest";

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { buildInteractiveShellLaunch, buildLoginShellCommandLaunch, buildToolEnv, resolveAssistantCommand, shellQuote } from "./ShellLaunch.js";

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

  it("reads the exact selected binary for each launch and after a service restart", () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-launch-selection-"));
    onTestFinished(() => fs.rmSync(prefix, { recursive: true, force: true }));
    const configured = path.join(prefix, "bin/codex");
    const first = { version: "0.155.1", assistantBin: path.join(prefix, ".cloudx-codex/first/bin/codex") };
    const second = { version: "0.157.1", assistantBin: path.join(prefix, ".cloudx-codex/second/bin/codex") };
    for (const release of [first, second]) {
      const packageDir = path.join(path.dirname(path.dirname(release.assistantBin)), "lib/node_modules/@openai/codex");
      fs.mkdirSync(path.dirname(release.assistantBin), { recursive: true });
      fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version: release.version, bin: { codex: "bin/codex.js" } }));
      fs.writeFileSync(path.join(packageDir, "bin/codex.js"), "#!/bin/sh\n", { mode: 0o700 });
      fs.symlinkSync(path.join(packageDir, "bin/codex.js"), release.assistantBin);
    }
    const env = { CLOUDX_ASSISTANT_BIN: configured, PATH: "/usr/bin" };
    const save = (active: typeof first, previous: typeof first | null) => fs.writeFileSync(
      path.join(prefix, ".cloudx-codex-selection.json"), JSON.stringify({ schemaVersion: 1, active, previous })
    );
    save(first, null);
    const existingCommand = resolveAssistantCommand(env);
    expect(existingCommand).toBe(first.assistantBin);
    save(second, first);
    expect(resolveAssistantCommand(env)).toBe(second.assistantBin);
    expect(resolveAssistantCommand({ ...env })).toBe(second.assistantBin);
    expect(buildToolEnv(env).PATH?.split(path.delimiter)).toContain(path.dirname(configured));
    expect(existingCommand).toBe(first.assistantBin);
    expect(fs.readFileSync(first.assistantBin, "utf8")).toBe("#!/bin/sh\n");
  });

  it("keeps unrelated tools available when a damaged Codex selection blocks native launches", () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-invalid-selection-"));
    onTestFinished(() => fs.rmSync(prefix, { recursive: true, force: true }));
    fs.writeFileSync(path.join(prefix, ".cloudx-codex-selection.json"), "invalid");
    const env = { CLOUDX_ASSISTANT_BIN: path.join(prefix, "bin/codex"), PATH: "/usr/bin" };
    expect(buildToolEnv(env).PATH).toBe(`${path.join(prefix, "bin")}${path.delimiter}/usr/bin`);
    expect(() => resolveAssistantCommand(env)).toThrow("saved Codex selection is invalid");
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
