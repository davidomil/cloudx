import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ClaudeResolvedLaunchPolicy } from "@cloudx/shared";
import { ClaudeConversationPolicies } from "./ClaudeConversationPolicies.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const session = "a5570c58-978a-4694-84f9-c67756be3acd";
const policy: ClaudeResolvedLaunchPolicy = { mode: "cloudx-managed", contractVersion: 1, nativeVersion: "2.1.316", exclusiveSkills: true, activation: "next-launch", settingSources: ["user"], includedSources: ["personal instructions", "selected skill snapshots"], excludedSources: ["project", "local", "plugins"], skills: [] };
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-conversation-policy-")); roots.push(root); return { root, store: new ClaudeConversationPolicies(root) }; }

it("pins a conversation's mode and account across restart and rejects silent transitions", async () => {
  const { root, store } = await fixture();
  await store.bind(session, { accountId: "account-a", cwd: "/workspace", policy });
  const restarted = new ClaudeConversationPolicies(root);
  expect(await restarted.resolve({ sessionId: session, savedMode: "native-project", accountId: "account-a", cwd: "/workspace" })).toEqual({ mode: "cloudx-managed", source: "conversation", historical: false });
  await expect(restarted.resolve({ sessionId: session, requestedMode: "native-project", accountId: "account-a", cwd: "/workspace" })).rejects.toThrow("different launch mode");
  await expect(restarted.resolve({ sessionId: session, accountId: "account-b", cwd: "/workspace" })).rejects.toThrow("different account");
  await expect(restarted.resolve({ sessionId: session, accountId: "account-a", cwd: "/other" })).rejects.toThrow("different workspace");
});

it("keeps unrecorded history unverified and refuses to invent a managed history contract", async () => {
  const { store } = await fixture();
  expect(await store.resolve({ sessionId: session, accountId: "account-a", cwd: "/workspace" })).toEqual({ mode: "native-project", source: "default", historical: true });
  await expect(store.resolve({ sessionId: session, savedMode: "cloudx-managed", accountId: "account-a", cwd: "/workspace" })).rejects.toThrow("historical");
  expect(await store.resolve({ sessionId: session, requestedMode: "native-project", savedMode: "cloudx-managed", accountId: "account-a", cwd: "/workspace" })).toEqual({ mode: "native-project", source: "launch", historical: true });
});

it("does not bind an unverified historical conversation as a newly certified policy", async () => {
  const { store } = await fixture();
  await store.bind(session, { accountId: "account-a", cwd: "/workspace", policy, historical: true });
  expect(await store.read(session)).toBeUndefined();
  await expect(store.read("../escape")).rejects.toThrow("exact Claude conversation");
});

it("preserves a bound policy if a mismatched receipt or malformed persisted policy arrives", async () => {
  const { root, store } = await fixture();
  await store.bind(session, { accountId: "account-a", cwd: "/workspace", policy });
  await expect(store.bind(session, { accountId: "account-a", cwd: "/workspace", policy: { ...policy, mode: "native-project", exclusiveSkills: false, settingSources: ["user", "project", "local"] } })).rejects.toThrow("different launch mode");
  const file = path.join(root, "claude-conversation-policies", `${session}.json`);
  const saved = JSON.parse(await fs.readFile(file, "utf8")); saved.policy.settingSources = ["secret-source"];
  await fs.writeFile(file, JSON.stringify(saved));
  await expect(store.read(session)).rejects.toThrow();
});
