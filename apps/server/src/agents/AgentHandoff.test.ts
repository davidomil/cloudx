import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readAgentTranscript, writeAgentHandoff } from "./AgentHandoff.js";

async function transcript(lines: unknown[]): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-transcript-"));
  const file = path.join(directory, "session.jsonl");
  await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n{broken\n`);
  return file;
}

describe("readAgentTranscript", () => {
  it("reads Codex rollouts without injected context or reasoning", async () => {
    const file = await transcript([
      { type: "session_meta", payload: { id: "x" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the parser" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: [] } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"cmd\":\"npm test\"}" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed." }] } }
    ]);
    expect(await readAgentTranscript("codex", file)).toEqual([
      { role: "user", text: "Fix the parser" },
      { role: "tool", text: "shell: {\"cmd\":\"npm test\"}" },
      { role: "assistant", text: "Fixed." }
    ]);
  });

  it("reads Claude transcripts with tool calls summarized", async () => {
    const file = await transcript([
      { type: "queue-operation", operation: "enqueue" },
      { type: "user", message: { role: "user", content: "Add a test" } },
      { type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>x</system-reminder>" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Adding it." }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }
    ]);
    expect(await readAgentTranscript("claude", file)).toEqual([
      { role: "user", text: "Add a test" },
      { role: "assistant", text: "Adding it." },
      { role: "tool", text: "Bash: npm test" }
    ]);
  });
});

describe("writeAgentHandoff", () => {
  it("writes the conversation under .cloudx/handoffs and returns a prompt that points to it", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-handoff-"));
    const handoff = await writeAgentHandoff({
      cwd,
      from: { providerId: "codex", accountLabel: "Work", sessionId: "s-1" },
      to: { providerId: "claude", accountLabel: "Personal" },
      entries: [{ role: "user", text: "Fix the parser" }, { role: "assistant", text: "Fixed." }],
      now: new Date("2026-10-05T12:00:00.000Z")
    });
    expect(handoff.path).toBe(path.join(cwd, ".cloudx", "handoffs", "2026-10-05T12-00-00-000Z-codex-to-claude.md"));
    const content = await fs.readFile(handoff.path, "utf8");
    expect(content).toContain("# CloudX handoff from Codex to Claude");
    expect(content).toContain("Previous runner: Codex, account Work, session s-1");
    expect(content).toContain("(git status unavailable)");
    expect(content).toContain("### User\n\nFix the parser");
    expect(handoff.prompt).toContain(handoff.path);
    expect((await fs.stat(handoff.path)).mode & 0o777).toBe(0o600);
  });

  it("keeps the most recent entries when the conversation exceeds the budget", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-handoff-"));
    const entries = Array.from({ length: 40 }, (_, index) => ({ role: "assistant" as const, text: `${index} ${"x".repeat(5_000)}` }));
    const content = await fs.readFile((await writeAgentHandoff({ cwd, from: { providerId: "claude" }, to: { providerId: "codex", accountLabel: "A" }, entries })).path, "utf8");
    expect(content).toContain("earlier entries omitted");
    expect(content).toContain("39 xxx");
    expect(content).not.toContain("\n0 xxx");
  });
});
