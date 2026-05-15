import { describe, expect, it } from "vitest";

import { buildCodexExecArgs, buildCodexExecLaunch, buildVoicePrompt } from "./VoicePlanner.js";

describe("buildVoicePrompt", () => {
  it("keeps plugin-specific behavior in descriptors instead of planner rules", () => {
    const prompt = buildVoicePrompt("list directory", {
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", pluginId: "standard-terminal", title: "Shell" }],
      plugins: [
        {
          id: "standard-terminal",
          actions: [{ name: "enter_text", voiceExposed: true, defaultForVoice: true }]
        }
      ]
    });

    expect(prompt).toContain("Do not blindly paste the transcript");
    expect(prompt).toContain("transcript is ASR output and is often wrong");
    expect(prompt).toContain("read that session's voiceContext and history.text");
    expect(prompt).toContain("handlesUnhandledVoice");
    expect(prompt).toContain("if the transcript says 'run pink' in a terminal context, infer 'run ping'");
    expect(prompt).toContain("Plugin descriptions, action descriptions, input schemas, voiceContext, and history are authoritative");
    expect(prompt).toContain("standardized plugin voiceContext");
    expect(prompt).toContain("do not invent plugin capabilities");
    expect(prompt).toContain("exact pane ids");
    expect(prompt).not.toContain("For standard-terminal enter_text");
    expect(prompt).not.toContain("For codex-terminal enter_text");
    expect(prompt).not.toContain("Use workspace-control");
    expect(prompt).not.toContain("set input.text to the full transcript");
  });
});

describe("buildCodexExecArgs", () => {
  it("forces medium reasoning for the voice planner subprocess", () => {
    expect(buildCodexExecArgs("gpt-5.3-codex-spark", "/schema.json", "/out.json")).toEqual(
      expect.arrayContaining(["-c", 'model_reasoning_effort="medium"', "--model", "gpt-5.3-codex-spark"])
    );
  });
});

describe("buildCodexExecLaunch", () => {
  it("launches Codex exec with the configured assistant binary", () => {
    expect(buildCodexExecLaunch("gpt-5.3-codex-spark", "/schema.json", "/out.json", { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex", SHELL: "/bin/bash" })).toEqual({
      command: "/usr/bin/codex",
      args: [
        "exec",
        "-c",
        "streamable_shell=false",
        "-c",
        'model_reasoning_effort="medium"',
        "--model",
        "gpt-5.3-codex-spark",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--output-schema",
        "/schema.json",
        "--output-last-message",
        "/out.json",
        "-"
      ]
    });
  });
});
