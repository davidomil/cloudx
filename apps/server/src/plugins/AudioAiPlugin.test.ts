import type { HookCallContext } from "@cloudx/plugin-api";
import { describe, expect, it, vi } from "vitest";

import type { VoiceController } from "../voice/VoiceController.js";
import { AudioAiPlugin } from "./AudioAiPlugin.js";

const hookContext: HookCallContext = { caller: { kind: "plugin", pluginId: "audio-ai" } };

describe("AudioAiPlugin", () => {
  it("rejects submitted transcripts when voice commands are disabled", async () => {
    const voice = { handleTranscript: vi.fn() } as unknown as VoiceController;
    const plugin = new AudioAiPlugin(() => voice, () => false);
    const hook = plugin.hooks.find((candidate) => candidate.id === "audio-ai.submitTranscript");

    await expect(hook!.execute({ transcript: "open terminal" }, hookContext)).rejects.toThrow("Voice commands are disabled in Cloudx settings.");
    expect(voice.handleTranscript).not.toHaveBeenCalled();
  });

  it("submits transcripts to the voice controller when enabled", async () => {
    const result = {
      accepted: true,
      plan: { transcript: "open terminal", summary: "Open terminal", actions: [] },
      results: []
    };
    const voice = { handleTranscript: vi.fn(async () => result) } as unknown as VoiceController;
    const plugin = new AudioAiPlugin(() => voice, () => true);
    const hook = plugin.hooks.find((candidate) => candidate.id === "audio-ai.submitTranscript");

    await expect(hook!.execute({ transcript: " open terminal ", activeTabId: "tab-1", clientContext: { activeWindowId: "window-1" } }, hookContext)).resolves.toEqual(result);
    expect(voice.handleTranscript).toHaveBeenCalledWith("open terminal", "tab-1", { activeWindowId: "window-1" }, { source: "audio-ai-hook" });
  });
});
