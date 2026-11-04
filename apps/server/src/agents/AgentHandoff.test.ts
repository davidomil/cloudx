import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readAgentTranscript, writeAgentHandoff } from "./AgentHandoff.js";

async function entries(provider: "codex" | "claude", file: string) {
  const result = [];
  for await (const entry of readAgentTranscript(provider, file)) result.push(entry);
  return result;
}

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
    expect(await entries("codex", file)).toEqual([
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
    expect(await entries("claude", file)).toEqual([
      { role: "user", text: "Add a test" },
      { role: "assistant", text: "Adding it." },
      { role: "tool", text: "Bash: npm test" }
    ]);
  });

  it("hands off a transcript above the former 64 MiB cap without loading its old records", async () => {
    const file = await transcript([]);
    const handle = await fs.open(file, "w");
    const padding = `${JSON.stringify({ type: "reasoning", text: "x".repeat(1024 * 1024) })}\n`;
    try {
      for (let index = 0; index < 65; index++) await handle.write(padding);
      await handle.write(JSON.stringify({ type: "user", message: { content: "Continue the retained conversation" } }));
    } finally { await handle.close(); }
    try {
      expect((await fs.stat(file)).size).toBeGreaterThan(64 * 1024 * 1024);
      const handoff = await writeAgentHandoff({ cwd: path.dirname(file), from: { providerId: "claude" }, to: { providerId: "codex", accountLabel: "A" }, entries: readAgentTranscript("claude", file) });
      expect(await fs.readFile(handoff.path, "utf8")).toContain("Continue the retained conversation");
      expect((await fs.stat(file)).size).toBeGreaterThan(64 * 1024 * 1024);
    } finally { await fs.rm(path.dirname(file), { recursive: true, force: true }); }
  });

  it("discards oversized records incrementally and resumes at the next record", async () => {
    const file = await transcript([]);
    try {
      await fs.writeFile(file, `${"x".repeat(5 * 1024 * 1024)}\n${JSON.stringify({ type: "user", message: { content: "After the oversized record" } })}`);
      expect(await entries("claude", file)).toEqual([{ role: "user", text: "After the oversized record" }]);
    } finally { await fs.rm(path.dirname(file), { recursive: true, force: true }); }
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

  it("bounds the handoff while consuming every streamed entry and reports the exact omitted count", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-handoff-stream-"));
    let consumed = 0;
    async function* conversation() {
      for (let index = 0; index < 5000; index++) {
        consumed++;
        yield { role: "user" as const, text: `message-${String(index).padStart(4, "0")} ${"x".repeat(990)}` };
      }
    }
    try {
      const handoff = await writeAgentHandoff({ cwd, from: { providerId: "claude" }, to: { providerId: "codex", accountLabel: "A" }, entries: conversation() });
      const content = await fs.readFile(handoff.path, "utf8");
      const retained = content.match(/### User\n/gu)?.length ?? 0;
      expect(consumed).toBe(5000);
      expect(content).toContain(`_${5000 - retained} earlier entries omitted._`);
      expect(content).toContain("message-4999");
      expect(content).not.toContain("message-0000");
      expect(content.length).toBeLessThan(82_000);
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  });
});
