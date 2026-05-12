import { describe, expect, it } from "vitest";

import type { VoiceActionPlan } from "@cloudx/shared";

import { VoiceController } from "./VoiceController.js";
import type { VoicePlanner } from "./VoicePlanner.js";

describe("VoiceController", () => {
  it("executes planner actions through the session store", async () => {
    const plan: VoiceActionPlan = {
      transcript: "type hello",
      summary: "type into active tab",
      actions: [{ action: "enter_text", targetTabId: "tab-1", input: { text: "hello" } }]
    };
    const planner: VoicePlanner = {
      async plan() {
        return plan;
      }
    };
    const executed: string[] = [];
    const sessions = {
      async buildVoiceContext() {
        return { activeTabId: "tab-1" };
      },
      async executeVoiceAction(action: { action: string }) {
        executed.push(action.action);
        return {};
      }
    };

    const controller = new VoiceController(sessions as never, planner);
    const result = await controller.handleTranscript("type hello", "tab-1");

    expect(result.accepted).toBe(true);
    expect(executed).toEqual(["enter_text"]);
  });
});
