import { describe, expect, it } from "vitest";

import { CodexTerminalPlugin } from "./plugins/CodexTerminalPlugin.js";
import { StandardTerminalPlugin } from "./plugins/StandardTerminalPlugin.js";
import { PluginRegistry } from "./pluginRegistry.js";
import type { TerminalProcess, TerminalProcessFactory } from "./terminal/TerminalProcess.js";

class FakeFactory implements TerminalProcessFactory {
  async spawn(): Promise<TerminalProcess> {
    return {
      onData: () => () => undefined,
      onExit: () => () => undefined,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    };
  }
}

describe("PluginRegistry", () => {
  it("validates voice-exposed action inputs", () => {
    const registry = new PluginRegistry();
    registry.register(new CodexTerminalPlugin(new FakeFactory()));

    expect(() =>
      registry.validateVoiceInput("codex-terminal", "enter_text", {
        text: "hello",
        submit: true
      })
    ).not.toThrow();
  });

  it("rejects inputs not declared by plugin schemas", () => {
    const registry = new PluginRegistry();
    registry.register(new CodexTerminalPlugin(new FakeFactory()));

    expect(() =>
      registry.validateVoiceInput("codex-terminal", "enter_text", {
        text: "hello",
        command: "rm -rf"
      })
    ).toThrow(/does not accept input/);
  });

  it("sanitizes broad structured voice inputs down to the selected action schema", () => {
    const registry = new PluginRegistry();
    registry.register(new CodexTerminalPlugin(new FakeFactory()));

    expect(
      registry.sanitizeVoiceInput("codex-terminal", "enter_text", {
        text: "ls",
        submit: true,
        relativePath: "",
        title: null
      })
    ).toEqual({ text: "ls", submit: true });
  });

  it("still rejects extra inputs for direct plugin actions", () => {
    const registry = new PluginRegistry();
    registry.register(new CodexTerminalPlugin(new FakeFactory()));

    expect(() =>
      registry.validateInput("codex-terminal", "enter_text", {
        text: "hello",
        relativePath: ""
      })
    ).toThrow(/does not accept input/);
  });

  it("exposes the terminal default voice action", () => {
    const registry = new PluginRegistry();
    registry.register(new CodexTerminalPlugin(new FakeFactory()));

    expect(registry.getDefaultVoiceAction("codex-terminal")?.name).toBe("enter_text");
    expect(registry.list()[0]?.actions[0]?.defaultForVoice).toBe(true);
  });

  it("lets plugins opt in to unresolved voice fallback", () => {
    const registry = new PluginRegistry();
    registry.register(new CodexTerminalPlugin(new FakeFactory()));
    registry.register(new StandardTerminalPlugin(new FakeFactory()));

    expect(registry.getUnhandledVoiceAction("codex-terminal")?.name).toBe("enter_text");
    expect(registry.getUnhandledVoiceAction("standard-terminal")).toBeUndefined();
    expect(registry.list().find((plugin) => plugin.id === "codex-terminal")?.actions[0]?.handlesUnhandledVoice).toBe(true);
  });

  it("exposes plugin creation metadata in descriptors", () => {
    const registry = new PluginRegistry();
    registry.register(new CodexTerminalPlugin(new FakeFactory()));

    expect(registry.list()[0]).toMatchObject({
      id: "codex-terminal",
      acronym: "CDX",
      requiresDirectory: true
    });
  });
});
