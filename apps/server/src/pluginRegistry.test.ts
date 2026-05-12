import { describe, expect, it } from "vitest";

import { CodexTerminalPlugin } from "./plugins/CodexTerminalPlugin.js";
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
});
