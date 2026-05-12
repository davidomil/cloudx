import { describe, expect, it } from "vitest";

import { buildCodexExecArgs, buildVoicePrompt } from "./VoicePlanner.js";

describe("buildVoicePrompt", () => {
  it("tells the voice planner to translate shell intents instead of pasting transcripts", () => {
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
    expect(prompt).toContain("transcript 'list directory' becomes input.text 'ls'");
    expect(prompt).toContain("standardized plugin voiceContext");
    expect(prompt).toContain("replace_in_file");
    expect(prompt).toContain("workspace-control.create_tab");
    expect(prompt).toContain("workspace-control.select_pane");
    expect(prompt).toContain("workspace-control.split_pane");
    expect(prompt).toContain("exact pane ids");
    expect(prompt).toContain("Map 'home' to input.cwd '~'");
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
