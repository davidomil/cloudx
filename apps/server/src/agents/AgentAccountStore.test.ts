import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentAccountStore } from "./AgentAccountStore.js";

// Fake provider CLIs record their arguments and report login state from the
// files in the home they were pointed at.
async function fakeClis(root: string): Promise<NodeJS.ProcessEnv> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  const codex = path.join(bin, "fake-codex");
  await fs.writeFile(codex, `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "codex-cli 0.0.1";;
  "login status") if [ -f "$CODEX_HOME/auth.json" ]; then echo "Logged in using an API key"; exit 0; else echo "Not logged in"; exit 1; fi;;
  "login --with-api-key") read key; printf '{"OPENAI_API_KEY":"%s"}' "$key" > "$CODEX_HOME/auth.json";;
  *) exit 2;;
esac
`, { mode: 0o755 });
  const claude = path.join(bin, "fake-claude");
  await fs.writeFile(claude, `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "9.9.9 (Claude Code)";;
  "auth status")
    if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":true,"authMethod":"api_key"}';
    elif [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}';
    else echo '{"loggedIn":false,"authMethod":"none"}'; fi;;
  *) exit 2;;
esac
`, { mode: 0o755 });
  return { PATH: process.env.PATH, HOME: path.join(root, "home"), CLOUDX_ASSISTANT_BIN: codex, CLOUDX_CLAUDE_BIN: claude };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-agent-accounts-"));
  const env = await fakeClis(root);
  await fs.mkdir(env.HOME!, { recursive: true });
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);
  return { root, env, dataDir, store: new AgentAccountStore(dataDir, env) };
}

describe("AgentAccountStore", () => {
  it("imports existing provider logins once as default accounts", async () => {
    const { env, dataDir, store } = await setup();
    await fs.mkdir(path.join(env.HOME!, ".codex"));
    await fs.writeFile(path.join(env.HOME!, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: {} }));

    const accounts = await store.list();
    expect(accounts).toEqual([expect.objectContaining({ id: "codex-home", providerId: "codex", kind: "subscription", imported: true, isDefault: true })]);
    expect(store.home(accounts[0]!)).toBe(path.join(env.HOME!, ".codex"));

    await store.delete("codex-home");
    expect(await new AgentAccountStore(dataDir, env).list()).toEqual([]);
    await expect(fs.stat(path.join(env.HOME!, ".codex", "auth.json"))).resolves.toBeTruthy();
  });

  it.each([
    ["codex", ".codex/auth.json", { auth_mode: "apikey", OPENAI_API_KEY: "sk-test", tokens: null }, "api-key"],
    ["codex", ".codex/auth.json", { OPENAI_API_KEY: "sk-test" }, "api-key"],
    ["codex", ".codex/auth.json", { auth_mode: "chatgptAuthTokens", tokens: {} }, "subscription"],
    ["codex", ".codex/auth.json", {}, undefined],
    ["claude", ".claude/.credentials.json", { claudeAiOauth: { accessToken: "token" } }, "subscription"],
    ["claude", ".claude/.credentials.json", {}, undefined]
  ])("imports an existing %s login by its authentication method: %s %j", async (providerId, file, content, kind) => {
    const { env, store } = await setup();
    await fs.mkdir(path.dirname(path.join(env.HOME!, file)), { recursive: true });
    await fs.writeFile(path.join(env.HOME!, file), JSON.stringify(content));
    const imported = (await store.list()).filter(account => account.providerId === providerId);
    expect(imported.map(account => account.kind)).toEqual(kind ? [kind] : []);
  });

  it("creates private account homes and keeps one default per provider", async () => {
    const { store } = await setup();
    const first = await store.create({ providerId: "claude", label: "Work", kind: "subscription" });
    const second = await store.create({ providerId: "claude", label: "Personal", kind: "subscription" });
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect((await fs.stat(store.home(first))).mode & 0o777).toBe(0o700);

    await store.setDefault(second.id);
    expect((await store.resolve("claude")).id).toBe(second.id);
    await store.delete(second.id);
    expect((await store.resolve("claude")).id).toBe(first.id);
    await expect(fs.stat(store.home(second))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.resolve("codex")).rejects.toThrow("No Codex account is configured");
    await expect(store.resolve("codex", first.id)).rejects.toThrow("belongs to Claude");
  });

  it("stores API keys only in the account home and never in account records", async () => {
    const { dataDir, store } = await setup();
    const claude = await store.create({ providerId: "claude", label: "API", kind: "api-key", apiKey: "sk-ant-test-key" });
    const codex = await store.create({ providerId: "codex", label: "API", kind: "api-key", apiKey: "sk-openai-test" });

    expect(claude).toMatchObject({ loggedIn: true, authMethod: "api_key" });
    expect(codex).toMatchObject({ loggedIn: true });
    const records = await fs.readFile(path.join(dataDir, "agent-accounts.json"), "utf8");
    expect(records).not.toContain("sk-ant-test-key");
    expect(records).not.toContain("sk-openai-test");
    expect(JSON.stringify(await store.state())).not.toContain("sk-ant");
    expect(await store.launchEnv(claude)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test-key" });
    expect((await fs.stat(path.join(store.home(claude), ".cloudx-api-key"))).mode & 0o777).toBe(0o600);
  });

  it("verifies subscription logins with the provider CLI against the account home", async () => {
    const { store } = await setup();
    const account = await store.create({ providerId: "claude", label: "Work", kind: "subscription" });
    expect(await store.verify(account.id)).toMatchObject({ loggedIn: false });
    await fs.writeFile(path.join(store.home(account), ".credentials.json"), "{}");
    expect(await store.verify(account.id)).toMatchObject({ loggedIn: true, authMethod: "claude.ai" });
    const login = await store.loginCommand(account.id);
    expect(login).toMatchObject({ args: ["auth", "login"], env: { CLAUDE_CONFIG_DIR: store.home(account) } });
    expect(login.env.CLAUDECODE).toBeUndefined();
  });

  it("reports provider installation without requiring accounts", async () => {
    const { dataDir, env } = await setup();
    const state = await new AgentAccountStore(dataDir, { ...env, CLOUDX_CLAUDE_BIN: "/nonexistent/claude" }).state();
    expect(state.providers).toEqual([
      expect.objectContaining({ providerId: "codex", installed: true, version: "codex-cli 0.0.1" }),
      expect.objectContaining({ providerId: "claude", installed: false })
    ]);
  });

  it("rejects invalid labels and keys", async () => {
    const { store } = await setup();
    await expect(store.create({ providerId: "claude", label: " ", kind: "subscription" })).rejects.toThrow("label is required");
    await expect(store.create({ providerId: "claude", label: "Key", kind: "api-key", apiKey: "has space" })).rejects.toThrow("format is invalid");
    expect(await store.list()).toEqual([]);
  });
});
