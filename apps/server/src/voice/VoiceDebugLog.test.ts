import { describe, expect, it } from "vitest";

import { actionLogFields, transcriptLogFields } from "./VoiceDebugLog.js";

describe("voice debug log helpers", () => {
  it("redacts transcript text by default while keeping correlation fields", () => {
    const fields = transcriptLogFields("list directory");

    expect(fields).toMatchObject({
      transcriptChars: 14,
      transcriptSha256: expect.any(String)
    });
    expect(fields).not.toHaveProperty("transcript");
  });

  it("includes raw transcript text only when debug text logging is enabled", () => {
    expect(transcriptLogFields("list directory", true)).toMatchObject({
      transcript: "list directory",
      transcriptChars: 14
    });
  });

  it("redacts action text by default but can include full action input for debugging", () => {
    const action = {
      pluginId: "standard-terminal",
      action: "enter_text",
      input: { text: "rg; git; gh", submit: true },
      reason: "ASR produced a toolchain list."
    };

    expect(actionLogFields(action)).toMatchObject({
      pluginId: "standard-terminal",
      action: "enter_text",
      reasonChars: 30,
      input: {
        text: { type: "string", chars: 11, sha256: expect.any(String) },
        submit: true
      }
    });
    expect(actionLogFields(action, true)).toMatchObject({
      reason: "ASR produced a toolchain list.",
      input: { text: "rg; git; gh", submit: true }
    });
  });
});
