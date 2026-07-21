import { describe, expect, it, vi } from "vitest";

import type { TriggerDefinition } from "@cloudx/plugin-api";
import type { TriggerEvent } from "@cloudx/shared";

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
      eventId: { type: "string" },
      text: { type: "string" }
    },
    required: ["eventId", "text"],
    additionalProperties: false
  }
};

describe("TriggerRegistry", () => {
  it("validates and records trigger events before dispatching subscribers", async () => {
    const order: string[] = [];
    const recorded: TriggerEvent[] = [];
    const dispatched: TriggerEvent[] = [];
    const registry = new TriggerRegistry({
      recordEvent: (event) => {
        recorded.push(event);
        order.push("record");
      }
    });
    registry.register(trigger);
    registry.subscribe((event) => {
      dispatched.push(event);
      order.push("subscriber");
    });

    const event = await registry.emit("tester.started", { eventId: "event-1", text: "hello" }, { kind: "plugin", pluginId: "tester", tabId: "tab-1" });

    expect(event).toMatchObject({
      id: "plugin:tester:tester.started:event-1",
      triggerId: "tester.started",
      payload: { eventId: "event-1", text: "hello" },
      source: { kind: "plugin", pluginId: "tester", tabId: "tab-1" }
    });
    expect(recorded).toEqual([event]);
    expect(dispatched).toEqual([event]);
    expect(order).toEqual(["record", "subscriber"]);
  });

  it.each([undefined, "", "   "])("rejects plugin eventId %j before recording or dispatching", async (eventId) => {
    const recordEvent = vi.fn();
    const subscriber = vi.fn();
    const registry = new TriggerRegistry({ recordEvent });
    registry.register(trigger);
    registry.subscribe(subscriber);
    const payload = eventId === undefined ? { text: "hello" } : { eventId, text: "hello" };

    await expect(registry.emit("tester.started", payload, { kind: "plugin", pluginId: "tester" })).rejects.toThrow();

    expect(recordEvent).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("rejects duplicate triggers, invalid payloads, and cross-plugin emission", async () => {
    const registry = new TriggerRegistry();
    registry.register(trigger);

    expect(() => registry.register(trigger)).toThrow("Trigger already registered");
    await expect(registry.emit("tester.started", { eventId: "event-1" }, { kind: "plugin", pluginId: "tester" })).rejects.toThrow("missing required payload: text");
    await expect(registry.emit("tester.started", { eventId: "event-1", text: "hello" }, { kind: "plugin", pluginId: "other" })).rejects.toThrow("cannot emit trigger");
  });
});
