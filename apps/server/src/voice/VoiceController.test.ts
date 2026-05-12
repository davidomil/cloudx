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
      createDefaultVoiceAction() {
        return undefined;
      },
      async executeVoiceAction(action: { action: string }) {
        executed.push(action.action);
        return { typed: 5 };
      }
    };

    const controller = new VoiceController(sessions as never, planner);
    const result = await controller.handleTranscript("type hello", "tab-1");

    expect(result.accepted).toBe(true);
    expect(executed).toEqual(["enter_text"]);
    expect(result.results[0]?.result).toEqual({ typed: 5 });
  });

  it("routes default-looking transcripts through the planner before executing plugin defaults", async () => {
    const plan: VoiceActionPlan = {
      transcript: "list directory",
      summary: "List the active terminal directory.",
      actions: [{ action: "enter_text", targetTabId: "tab-1", input: { text: "ls", submit: true } }]
    };
    let plannerInput: { transcript: string; context: Record<string, unknown> } | undefined;
    const planner: VoicePlanner = {
      async plan(input) {
        plannerInput = input;
        return plan;
      }
    };
    const executed: unknown[] = [];
    const sessions = {
      createDefaultVoiceAction() {
        throw new Error("default shortcut should not run");
      },
      async buildVoiceContext() {
        return { activeTabId: "tab-1" };
      },
      async executeVoiceAction(action: unknown) {
        executed.push(action);
        return {};
      }
    };

    const controller = new VoiceController(sessions as never, planner);
    const result = await controller.handleTranscript("list directory", "tab-1");

    expect(result.accepted).toBe(true);
    expect(plannerInput?.transcript).toBe("list directory");
    expect(result.plan.actions).toEqual([{ action: "enter_text", targetTabId: "tab-1", input: { text: "ls", submit: true } }]);
    expect(executed).toEqual(result.plan.actions);
  });

  it("sends explicit tab switching requests to the planner", async () => {
    const plan: VoiceActionPlan = {
      transcript: "switch to tab build",
      summary: "Switch tabs.",
      actions: [{ pluginId: "workspace-control", action: "switch_tab", input: { title: "build" } }]
    };
    let plannerCalled = false;
    const planner: VoicePlanner = {
      async plan() {
        plannerCalled = true;
        return plan;
      }
    };
    const sessions = {
      createDefaultVoiceAction() {
        return { action: "enter_text", targetTabId: "tab-1", input: { text: "switch to tab build", submit: true } };
      },
      async buildVoiceContext() {
        return { activeTabId: "tab-1" };
      },
      async executeVoiceAction() {
        return {};
      }
    };

    const controller = new VoiceController(sessions as never, planner);
    const result = await controller.handleTranscript("switch to tab build", "tab-1");

    expect(plannerCalled).toBe(true);
    expect(result.plan.actions[0]?.pluginId).toBe("workspace-control");
  });
});
