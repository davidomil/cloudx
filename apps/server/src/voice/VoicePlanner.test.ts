import { describe, expect, it } from "vitest";

import { buildCodexExecArgs, buildCodexExecLaunch, buildVoicePrompt, compactVoicePromptContext } from "./VoicePlanner.js";

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
    expect(prompt).toContain("hookId");
    expect(prompt).toContain("if the transcript says 'run pink' in a terminal context, infer 'run ping'");
    expect(prompt).toContain("Plugin descriptions, hook descriptions, action descriptions, input schemas, voiceContext, and history are authoritative");
    expect(prompt).toContain("standardized plugin voiceContext");
    expect(prompt).toContain("do not invent plugin capabilities");
    expect(prompt).toContain("exact pane ids");
    expect(prompt).not.toContain("For standard-terminal enter_text");
    expect(prompt).not.toContain("For codex-terminal enter_text");
    expect(prompt).not.toContain("Use workspace-control");
    expect(prompt).not.toContain("set input.text to the full transcript");
  });

  it("compacts oversized workspace context before sending it to Codex exec", () => {
    const longActiveHistory = `${"old active output\n".repeat(2_000)}latest active command`;
    const longInactiveHistory = `${"old inactive output\n".repeat(2_000)}latest inactive command`;
    const prompt = buildVoicePrompt("run tests", {
      activeTabId: "tab-active",
      sessions: [
        {
          tabId: "tab-active",
          active: true,
          history: { text: longActiveHistory },
          voiceContext: {
            kind: "terminal",
            visibleText: "active visible\n".repeat(2_000),
            recentOutput: "active output\n".repeat(2_000)
          }
        },
        {
          tabId: "tab-inactive",
          active: false,
          history: { text: longInactiveHistory },
          voiceContext: {
            kind: "terminal",
            visibleText: "inactive visible\n".repeat(2_000),
            recentOutput: "inactive output\n".repeat(2_000)
          }
        }
      ]
    });

    expect(prompt.length).toBeLessThan(80_000);
    expect(prompt).toContain("contextBudget");
    expect(prompt).toContain("Cloudx voice context truncated");
    expect(prompt).toContain("latest active command");
    expect(prompt).toContain("latest inactive command");
  });
});

describe("compactVoicePromptContext", () => {
  it("keeps active session history larger than inactive session history", () => {
    const context = compactVoicePromptContext({
      sessions: [
        { tabId: "active", active: true, history: { text: "A".repeat(20_000) } },
        { tabId: "inactive", active: false, history: { text: "B".repeat(20_000) } }
      ]
    });

    const sessions = context.sessions as Array<{ history: { text: string } }>;
    expect(sessions[0]!.history.text.length).toBeGreaterThan(sessions[1]!.history.text.length);
    expect(sessions[0]!.history.text).toContain("kept 12000 last chars");
    expect(sessions[1]!.history.text).toContain("kept 2000 last chars");
  });

  it("keeps exact ids while trimming verbose descriptions", () => {
    const context = compactVoicePromptContext({
      hooks: [
        {
          id: "workspace.tabs.create",
          description: "Create tabs. ".repeat(500),
          inputSchema: { type: "object", properties: { pluginId: { type: "string" } } }
        }
      ]
    });

    expect(context).toMatchObject({
      hooks: [
        {
          id: "workspace.tabs.create",
          inputSchema: { type: "object", properties: { pluginId: { type: "string" } } }
        }
      ]
    });
    expect(JSON.stringify(context)).toContain("Cloudx voice context truncated");
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
