import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { ClaudeResolvedLaunchPolicy } from "@cloudx/shared";
import { assertClaudeConversationNavigationCompatibility, ClaudeConversationPolicies } from "./ClaudeConversationPolicies.js";
import { runAgentCli } from "../agentCli.js";

const { guardConversationEvent } = await import(new URL("../../../helpers/claude-conversation-policy.mjs", import.meta.url).href);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const SESSION = "a5570c58-978a-4694-84f9-c67756be3acd";
const OTHER = "b5570c58-978a-4694-84f9-c67756be3acd";
const EXECUTION = "c5570c58-978a-4694-84f9-c67756be3acd";
const HOOK = fileURLToPath(new URL("../../../helpers/claude-hook-receipt.mjs", import.meta.url));
const managed: ClaudeResolvedLaunchPolicy = { mode: "cloudx-managed", contractVersion: 1, nativeVersion: "2.1.316", exclusiveSkills: true, activation: "next-launch", settingSources: ["user"], includedSources: ["personal"], excludedSources: ["project", "local"], skills: [] };
const native: ClaudeResolvedLaunchPolicy = { ...managed, mode: "native-project", exclusiveSkills: false, settingSources: ["user", "project", "local"] };
async function fixture(policy = managed) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-conversation-navigation-")); roots.push(root);
  const configDir = path.join(root, "launch"); await fs.mkdir(configDir);
  const store = new ClaudeConversationPolicies(root);
  await store.prepareExecution(configDir, { tabId: "tab", executionId: EXECUTION, accountId: "account-a", cwd: root, policy });
  const event = (event: string, sessionId = SESSION, source?: string, cwd = root) => guardConversationEvent(configDir, EXECUTION, event, { session_id: sessionId, cwd, ...(source ? { source } : {}) });
  return { root, store, configDir, event };
}

it("binds new and cleared conversation identities before the model prompt", async () => {
  const f = await fixture();
  expect(f.event("SessionStart", SESSION, "startup")).toMatchObject({ historical: false });
  expect(await f.store.read(SESSION)).toMatchObject({ accountId: "account-a", policy: managed });
  expect(f.event("UserPromptSubmit")).toMatchObject({ historical: false });
  expect(f.event("SessionStart", OTHER, "clear")).toMatchObject({ historical: false });
  expect(f.event("UserPromptSubmit", OTHER)).toMatchObject({ historical: false });
  expect(await f.store.read(OTHER)).toMatchObject({ policy: managed });
});

it("rejects unknown resumed history in managed mode before creating its policy or turn", async () => {
  const f = await fixture();
  expect(() => f.event("SessionStart", SESSION, "resume")).toThrow("historical");
  expect(() => f.event("UserPromptSubmit")).toThrow("historical");
  expect(await f.store.read(SESSION)).toBeUndefined();
  expect(() => f.event("UserPromptSubmit", OTHER)).toThrow("historical");
});

it("keeps native resumed history unverified but binds a later clear as new", async () => {
  const f = await fixture(native);
  expect(f.event("SessionStart", SESSION, "resume")).toMatchObject({ historical: true });
  expect(f.event("UserPromptSubmit")).toMatchObject({ historical: true });
  expect(await f.store.read(SESSION)).toBeUndefined();
  f.event("SessionStart", OTHER, "clear");
  expect(await f.store.read(OTHER)).toMatchObject({ policy: native });
});

it.each(["mode", "account", "workspace"])("blocks native resume across a different recorded %s", async difference => {
  const f = await fixture(native);
  await f.store.bind(SESSION, { accountId: difference === "account" ? "account-b" : "account-a", cwd: difference === "workspace" ? path.join(f.root, "other") : f.root, policy: difference === "mode" ? managed : native });
  expect(() => f.event("SessionStart", SESSION, "resume")).toThrow();
  expect(() => f.event("UserPromptSubmit")).toThrow();
});

it("rejects stale execution bindings and malformed or symlinked records", async () => {
  const f = await fixture();
  expect(() => guardConversationEvent(f.configDir, OTHER, "UserPromptSubmit", { session_id: SESSION, cwd: f.root })).toThrow("execution");
  f.event("SessionStart", SESSION, "startup");
  const target = path.join(f.root, "claude-conversation-policies", `${SESSION}.json`);
  await fs.writeFile(target, "{broken"); expect(() => f.event("UserPromptSubmit")).toThrow();
  await fs.unlink(target); await fs.symlink(path.join(f.root, "missing"), target);
  expect(() => f.event("UserPromptSubmit")).toThrow();
});

it("blocks the actual native prompt hook with exit 2 without requiring a Forge turn binding", async () => {
  const f = await fixture();
  const payload = { session_id: SESSION, cwd: f.root, source: "resume", prompt: "private-task-never-log" };
  const run = (event: string) => runAgentCli(process.execPath, [HOOK, f.configDir, "tab", EXECUTION, event], { stdin: JSON.stringify(payload) });
  expect((await run("SessionStart")).code).toBe(0);
  const prompt = await run("UserPromptSubmit");
  expect(prompt.code).toBe(2); expect(prompt.stderr).toContain("conversation policy");
  expect(prompt.stderr).not.toContain(payload.prompt);
  expect(await f.store.read(SESSION)).toBeUndefined();
  await expect(fs.stat(path.join(f.configDir, ".cloudx-turn.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("marks actual historical Native project receipts and never binds their old policy", async () => {
  const f = await fixture(native);
  for (const event of ["SessionStart", "UserPromptSubmit"]) expect((await runAgentCli(process.execPath, [HOOK, f.configDir, "tab", EXECUTION, event], {
    stdin: JSON.stringify({ session_id: SESSION, cwd: f.root, source: "resume" }),
  })).code).toBe(0);
  expect(JSON.parse(await fs.readFile(path.join(f.configDir, ".cloudx-conversation.json"), "utf8"))).toMatchObject({ historicalClaudeConversation: true });
  expect(await f.store.read(SESSION)).toBeUndefined();
});

it.each(["process", "user", "managed"])("rejects unverified automatic continuation from %s before launch", async source => {
  const f = await fixture();
  const key = "CLAUDE_CODE_RESUME_INTERRUPTED_TURN";
  const user = path.join(f.root, "personal", "settings.json"); const managed = path.join(f.root, "managed-settings.json");
  await fs.mkdir(path.dirname(user));
  if (source !== "process") await fs.writeFile(source === "user" ? user : managed, JSON.stringify({ env: { [key]: "1" } }));
  await expect(assertClaudeConversationNavigationCompatibility({ providerHome: path.dirname(user), mode: "native-project", env: source === "process" ? { [key]: "1" } : {} }, [managed])).rejects.toThrow(key);
});
