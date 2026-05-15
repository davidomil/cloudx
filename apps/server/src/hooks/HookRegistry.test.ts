import { describe, expect, it } from "vitest";

import { HookRegistry } from "./HookRegistry.js";

describe("HookRegistry", () => {
  it("registers, lists, validates, and calls hooks", async () => {
    const registry = new HookRegistry();
    registry.register({
      id: "app.echo",
      owner: { kind: "app" },
      title: "Echo",
      description: "Echo input.",
      exposures: ["plugin"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: (input, context) => ({ text: input.text, caller: context.caller.kind })
    });

    expect(registry.list()).toEqual([expect.objectContaining({ id: "app.echo", title: "Echo" })]);
    await expect(registry.call("app.echo", { text: "hi" }, { caller: { kind: "plugin", pluginId: "tester" } })).resolves.toEqual({ text: "hi", caller: "plugin" });
    await expect(registry.call("app.echo", {}, { caller: { kind: "plugin", pluginId: "tester" } })).rejects.toThrow("missing required input: text");
  });

  it("rejects duplicate hooks and unexposed callers", async () => {
    const registry = new HookRegistry();
    const hook = {
      id: "app.internal",
      owner: { kind: "app" as const },
      title: "Internal",
      description: "Internal hook.",
      exposures: ["app" as const],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({ ok: true })
    };
    registry.register(hook);

    expect(() => registry.register(hook)).toThrow("Hook already registered");
    await expect(registry.call("app.internal", {}, { caller: { kind: "plugin", pluginId: "tester" } })).rejects.toThrow("not exposed to plugin callers");
    await expect(registry.call("missing", {}, { caller: { kind: "app" } })).rejects.toThrow("Unknown hook");
  });
});
