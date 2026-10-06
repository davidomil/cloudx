import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentAccountStore } from "./AgentAccountStore.js";
import { createAgentExec, readClaudeExecResult } from "./AgentExec.js";

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-agent-exec-"));
  const claude = path.join(root, "fake-claude");
  const argsLog = path.join(root, "args.txt");
  // Records its arguments and stdin, then answers like `claude -p --output-format json`.
  await fs.writeFile(claude, `#!/bin/sh
printf '%s\\n' "$@" > ${argsLog}
cat > ${argsLog}.stdin
echo "CONFIG=$CLAUDE_CONFIG_DIR KEY=$ANTHROPIC_API_KEY" > ${argsLog}.env
echo '{"type":"result","subtype":"success","is_error":false,"result":"{\\"ok\\":true}","structured_output":{"ok":true}}'
`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: root, CLOUDX_CLAUDE_BIN: claude, ANTHROPIC_API_KEY: "inherited" };
  const accounts = new AgentAccountStore(path.join(root, "data"), env);
  await fs.mkdir(path.join(root, "data"));
  return { root, env, accounts, argsLog };
}

describe("createAgentExec", () => {
  it("runs Claude models on the default Claude account with structured output", async () => {
    const { env, accounts, argsLog, root } = await setup();
    const account = await accounts.create({ providerId: "claude", label: "Work", kind: "subscription" });
    const schema = path.join(root, "schema.json");
    await fs.writeFile(schema, "{\"type\":\"object\"}");
    const codex = vi.fn();
    const exec = createAgentExec(accounts, codex, env);

    await expect(exec("claude-sonnet-5-5", "Plan this", { schemaPath: schema, imagePaths: ["/tmp/shots/a.png"] })).resolves.toBe("{\"ok\":true}");
    expect(codex).not.toHaveBeenCalled();
    const args = (await fs.readFile(argsLog, "utf8")).split("\n");
    expect(args).toEqual(expect.arrayContaining(["-p", "--no-session-persistence", "--model", "claude-sonnet-5-5", "--json-schema", "{\"type\":\"object\"}", "--tools", "Read", "--add-dir", "/tmp/shots"]));
    expect(await fs.readFile(`${argsLog}.stdin`, "utf8")).toContain("- /tmp/shots/a.png");
    // The account home is the config dir and inherited keys do not leak in.
    expect(await fs.readFile(`${argsLog}.env`, "utf8")).toBe(`CONFIG=${accounts.home(account)} KEY=\n`);
  });

  it("keeps other models on Codex", async () => {
    const { env, accounts } = await setup();
    const codex = vi.fn(async () => "codex-result");
    await expect(createAgentExec(accounts, codex, env)("gpt-6.1-sol", "Plan this")).resolves.toBe("codex-result");
    expect(codex).toHaveBeenCalledWith("gpt-6.1-sol", "Plan this", {});
  });

  it("explains a missing Claude account", async () => {
    const { env, accounts } = await setup();
    await expect(createAgentExec(accounts, vi.fn(), env)("claude-haiku-4-5-20251001", "x")).rejects.toThrow("No Claude account is configured");
  });
});

describe("readClaudeExecResult", () => {
  it("reports Claude errors with their message", () => {
    expect(() => readClaudeExecResult("{\"is_error\":true,\"result\":\"Credit balance is too low\"}", 1, "voice planner"))
      .toThrow("voice planner failed in Claude Code: Credit balance is too low");
    expect(() => readClaudeExecResult("not json", 1, "voice planner")).toThrow("did not return Claude Code JSON output (exit 1)");
    expect(readClaudeExecResult("{\"result\":\"plain\"}", 0, "x")).toBe("plain");
  });
});
