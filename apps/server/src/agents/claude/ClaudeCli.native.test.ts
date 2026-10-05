import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { AgentAccountStore } from "../AgentAccountStore.js";
import { runAgentCli } from "../agentCli.js";
import { materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";

// Contract checks against a real Claude Code binary. They make no model
// requests, so CI runs them without credentials.
const claude = process.env.CLOUDX_NATIVE_CLAUDE;

it.skipIf(!claude)("native Claude Code accepts every flag CloudX passes", async () => {
  const help = await runAgentCli(claude!, ["--help"], { timeoutMs: 30_000 });
  expect(help.code).toBe(0);
  for (const flag of ["--settings", "--add-dir", "--dangerously-skip-permissions", "--permission-mode", "--model", "--effort",
    "--resume", "--continue", "--session-id", "--output-format", "--json-schema", "--no-session-persistence", "--tools",
    "--setting-sources", "--strict-mcp-config"])
    expect(help.stdout, flag).toContain(flag);
  for (const mode of ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]) expect(help.stdout).toContain(mode);
});

it.skipIf(!claude)("native Claude Code reports login state for an isolated account home", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-claude-"));
  try {
    const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), CLOUDX_CLAUDE_BIN: claude };
    await fs.mkdir(env.HOME);
    await fs.mkdir(path.join(root, "data"));
    const accounts = new AgentAccountStore(path.join(root, "data"), env);
    const account = await accounts.create({ providerId: "claude", label: "CI", kind: "subscription" });
    expect(await accounts.verify(account.id)).toMatchObject({ loggedIn: false });

    const overlay = await materializeClaudeHomeOverlay({
      dataDir: path.join(root, "data"), tabId: "native", accountHome: accounts.home(account),
      providerHome: path.join(env.HOME, ".claude"), executionId: "0b8a3c1e-1111-4222-8333-944455556666", cwd: root
    });
    const status = await runAgentCli(claude!, ["auth", "status", "--json"], { env: { ...env, CLAUDE_CONFIG_DIR: overlay.configDir }, timeoutMs: 30_000 });
    expect(JSON.parse(status.stdout)).toMatchObject({ loggedIn: false, configDirectory: overlay.configDir, projectsDirectory: path.join(overlay.configDir, "projects") });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
