import { describe, expect, it } from "vitest";

import type { TriggerDefinition } from "@cloudx/plugin-api";

import { TriggerRegistry } from "./TriggerRegistry.js";

const trigger: TriggerDefinition = {
  id: "tester.started",
  owner: { kind: "plugin", pluginId: "tester" },
  title: "Tester Started",
  description: "Emitted by tests.",
  exposures: ["plugin", "automation", "http"],
  payloadSchema: {
    type: "object",
    properties: {
      text: { type: "string" }
    },
    required: ["text"],
    additionalProperties: false
  }
};

describe("TriggerRegistry", () => {
  it("validates and records trigger events before dispatching subscribers", async () => {
    const order: string[] = [];
    const registry = new TriggerRegistry({
      recordEvent: () => {
        order.push("record");
      }
    });
    registry.register(trigger);
    registry.subscribe(() => {
      order.push("subscriber");
    });

    const event = await registry.emit("tester.started", { text: "hello" }, { kind: "plugin", pluginId: "tester", tabId: "tab-1" });

    expect(event).toMatchObject({
      triggerId: "tester.started",
      payload: { text: "hello" },
      source: { kind: "plugin", pluginId: "tester", tabId: "tab-1" }
    });
    expect(order).toEqual(["record", "subscriber"]);
  });

  it("rejects duplicate triggers, invalid payloads, and cross-plugin emission", async () => {
    const registry = new TriggerRegistry();
    registry.register(trigger);

    expect(() => registry.register(trigger)).toThrow("Trigger already registered");
    await expect(registry.emit("tester.started", {}, { kind: "plugin", pluginId: "tester" })).rejects.toThrow("missing required input: text");
    await expect(registry.emit("tester.started", { text: "hello" }, { kind: "plugin", pluginId: "other" })).rejects.toThrow("cannot emit trigger");
  });
});
