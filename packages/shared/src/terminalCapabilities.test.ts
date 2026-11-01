import { describe, expect, it } from "vitest";
import { parseTerminalCapabilities } from "./terminalCapabilities.js";

describe("live terminal capabilities", () => {
  it.each(["codex", "claude"])("accepts an explicit per-execution capability for %s", providerId => {
    const capability = { tabId: "agent", providerId, executionId: "execution", commandCapture: providerId === "codex" };
    expect(parseTerminalCapabilities(capability)).toEqual(capability);
  });
  it.each([{}, { tabId: "agent", commandCapture: "true" }, { tabId: "agent", commandCapture: false, providerId: "other" }, { tabId: "agent", commandCapture: false, executionId: "" }])("rejects invalid capabilities %j", value => expect(() => parseTerminalCapabilities(value)).toThrow());
});
