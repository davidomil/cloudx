import { describe, expect, it } from "vitest";

import path from "node:path";

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
