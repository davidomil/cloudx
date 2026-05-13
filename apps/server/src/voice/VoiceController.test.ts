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
    const result = await controller.handleTranscript("list directory", "tab-1", { activePaneId: "pane-2" });

    expect(result.accepted).toBe(true);
    expect(plannerInput?.transcript).toBe("list directory");
    expect(plannerInput?.context).toMatchObject({ client: { activePaneId: "pane-2" } });
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

  it("uses a newly created tab as the fallback target for following voice actions", async () => {
    const plan: VoiceActionPlan = {
      transcript: "open a terminal and ping google",
      summary: "Create a terminal then run ping.",
      actions: [
        { pluginId: "workspace-control", action: "create_tab", input: { targetPluginId: "standard-terminal" } },
        { pluginId: "standard-terminal", action: "enter_text", input: { text: "ping google.com", submit: true } }
      ]
    };
    const planner: VoicePlanner = {
      async plan() {
        return plan;
      }
    };
    const fallbacks: Array<string | undefined> = [];
    const sessions = {
      async buildVoiceContext() {
        return { activeTabId: undefined };
      },
      async executeVoiceAction(action: { action: string }, fallbackTabId?: string) {
        fallbacks.push(fallbackTabId);
        if (action.action === "create_tab") {
          return { activeTabId: "new-terminal", tab: { id: "new-terminal" } };
        }
        return { typed: "ping google.com" };
      }
    };

    const controller = new VoiceController(sessions as never, planner);
    const result = await controller.handleTranscript("open a terminal and ping google");

    expect(result.accepted).toBe(true);
    expect(fallbacks).toEqual([undefined, "new-terminal"]);
    expect(result.results[1]).toMatchObject({ action: "enter_text", targetTabId: "new-terminal", ok: true });
  });

  it("logs transcript, planner, and action events with request correlation", async () => {
    const plan: VoiceActionPlan = {
      transcript: "list directory",
      summary: "List files.",
      actions: [{ pluginId: "standard-terminal", action: "enter_text", targetTabId: "tab-1", input: { text: "ls", submit: true } }]
    };
    const entries: Array<{ fields: Record<string, unknown>; message?: string }> = [];
    const planner: VoicePlanner = {
      async plan() {
        return plan;
      }
    };
    const sessions = {
      async buildVoiceContext() {
        return { activeTabId: "tab-1", tabs: [{ id: "tab-1", title: "Shell", pluginId: "standard-terminal" }] };
      },
      async executeVoiceAction() {
        return { typed: 2, echoed: "ls" };
      }
    };
    const logger = {
      info(fields: Record<string, unknown>, message?: string) {
        entries.push({ fields, message });
      },
      warn(fields: Record<string, unknown>, message?: string) {
        entries.push({ fields, message });
      },
      error(fields: Record<string, unknown>, message?: string) {
        entries.push({ fields, message });
      }
    };

    const controller = new VoiceController(sessions as never, planner, undefined, logger, { includeText: true });
    const result = await controller.handleTranscript("list directory", "tab-1", undefined, { voiceRequestId: "voice-1", source: "test" });

    expect(result.accepted).toBe(true);
    expect(entries.map((entry) => entry.fields.event)).toEqual([
      "voice_transcript_received",
      "voice_context_built",
      "voice_plan_received",
      "voice_action_started",
      "voice_action_completed",
      "voice_execution_completed"
    ]);
    expect(entries.every((entry) => entry.fields.voiceRequestId === "voice-1")).toBe(true);
    expect(entries[0]?.fields).toMatchObject({ transcript: "list directory" });
    expect(entries[3]?.fields).toMatchObject({ input: { text: "ls", submit: true } });
    expect(entries[4]?.fields).toMatchObject({ result: { typed: 2, echoed: "ls" } });
  });
});
