import { describe, expect, it } from "vitest";
import {
  CODEX_COMMAND_DETAILS_MAX_COMMAND_BYTES,
  CODEX_COMMAND_DETAILS_MAX_OUTPUT_BYTES,
  CODEX_COMMAND_DETAILS_MAX_TOTAL_BYTES,
  parseCodexCommandDetailsSnapshot,
  type CodexCommandDetailsSnapshot
} from "./codexCommandDetails.js";

const snapshot: CodexCommandDetailsSnapshot = {
  version: 1, tabId: "tab", executionId: "execution", status: "available",
  commands: [{ threadId: "thread", turnId: "turn", id: "item", command: "printf 'a\\nb'\n", cwd: "/tmp",
    status: "completed", output: "a\nb\n", outputTruncated: false, commandTruncated: false, exitCode: 0 }]
};

describe("native command details contract", () => {
  it("preserves command whitespace, escaped text, output, and all execution identities", () => {
    expect(parseCodexCommandDetailsSnapshot(snapshot)).toEqual(snapshot);
  });

  it("permits an explicit unavailable session without an execution binding", () => {
    const unavailable = { version: 1, tabId: "tab", executionId: "", status: "unavailable", commands: [], reason: "No native capture." };
    expect(parseCodexCommandDetailsSnapshot(unavailable)).toEqual(unavailable);
  });

  it.each([
    null, { ...snapshot, version: 2 }, { ...snapshot, executionId: "" }, { ...snapshot, tabId: "" },
    { ...snapshot, commands: {} }, { ...snapshot, status: "unavailable" }, { ...snapshot, reason: 7 },
    { ...snapshot, commands: [...snapshot.commands, ...snapshot.commands] },
    ...[{ threadId: "" }, { turnId: "" }, { id: "" }, { command: 2 }, { cwd: "" }, { status: "running" },
      { output: null }, { exitCode: 1.5 }, { commandTruncated: "false" }, { outputTruncated: undefined }]
      .map(patch => ({ ...snapshot, commands: [{ ...snapshot.commands[0], ...patch }] }))
  ])("rejects malformed or ambiguous serialized details %j", value => {
    expect(() => parseCodexCommandDetailsSnapshot(value)).toThrow();
  });

  it("bounds UTF-8 command and output bytes, recent count, and total retained text", () => {
    expect(() => parseCodexCommandDetailsSnapshot({ ...snapshot, commands: [{ ...snapshot.commands[0], command: "é".repeat(CODEX_COMMAND_DETAILS_MAX_COMMAND_BYTES / 2 + 1) }] })).toThrow("retention");
    expect(() => parseCodexCommandDetailsSnapshot({ ...snapshot, commands: [{ ...snapshot.commands[0], output: "x".repeat(CODEX_COMMAND_DETAILS_MAX_OUTPUT_BYTES + 1) }] })).toThrow("retention");
    expect(() => parseCodexCommandDetailsSnapshot({ ...snapshot, commands: Array.from({ length: 21 }, (_, id) => ({ ...snapshot.commands[0], id: String(id) })) })).toThrow();
    expect(() => parseCodexCommandDetailsSnapshot({ ...snapshot, commands: Array.from({ length: CODEX_COMMAND_DETAILS_MAX_TOTAL_BYTES / CODEX_COMMAND_DETAILS_MAX_OUTPUT_BYTES + 1 }, (_, id) => ({ ...snapshot.commands[0], id: String(id), output: "x".repeat(CODEX_COMMAND_DETAILS_MAX_OUTPUT_BYTES) })) })).toThrow("retention");
  });
});
