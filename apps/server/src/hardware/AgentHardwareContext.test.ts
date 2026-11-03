import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentOwner } from "@cloudx/shared";

import { AgentHardwareContext, hardwareLaunchEnv } from "./AgentHardwareContext.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-context-"));
  directories.push(dataDir);
  let owner: AgentOwner | undefined = { kind: "agent", tabId: "agent-1", providerId: "codex", executionId: "execution-1" };
  const contexts = new AgentHardwareContext({ dataDir, endpoint: () => "http://127.0.0.1:3400/api/hardware/agent", binding: () => owner });
  return { contexts, owner: () => owner!, replace: (next?: AgentOwner) => { owner = next; } };
}

it("gives each native execution a private locator and revokes the original capability", async () => {
  const f = await fixture();
  const original = await f.contexts.prepare("agent-1");
  expect(original).toBeDefined();
  const firstPath = f.contexts.contextPath(f.owner());
  expect((await fs.stat(firstPath)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.dirname(firstPath))).mode & 0o777).toBe(0o700);
  expect(await f.contexts.authenticate({ tabId: "agent-1", executionId: "execution-1", capability: original!.capability })).toEqual(f.owner());
  expect((await f.contexts.prepare("agent-1"))!.capability).toBe(original!.capability);
  f.replace({ ...f.owner(), executionId: "execution-2" });
  const replacement = await f.contexts.prepare("agent-1");
  expect(f.contexts.contextPath(f.owner())).not.toBe(firstPath);
  expect(replacement!.capability).not.toBe(original!.capability);
  await expect(f.contexts.authenticate({ tabId: "agent-1", executionId: "execution-1", capability: original!.capability })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("authenticates the complete worker attempt and rejects guessed identities", async () => {
  const f = await fixture();
  f.replace({ ...f.owner(), ownerPluginId: "forge", workerId: "worker-1", logicalRunId: "worker-1", attemptId: "attempt-1" });
  const locator = (await f.contexts.prepare("agent-1"))!;
  await expect(f.contexts.authenticate({ tabId: "other", executionId: locator.owner.executionId, capability: locator.capability })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(f.contexts.authenticate({ tabId: "agent-1", executionId: locator.owner.executionId, capability: "0".repeat(64) })).rejects.toMatchObject({ code: "FORBIDDEN" });
  f.replace({ ...f.owner(), attemptId: "attempt-2" });
  await expect(f.contexts.authenticate({ tabId: "agent-1", executionId: locator.owner.executionId, capability: locator.capability })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("derives launch environment from the exact execution and retains unrelated runtime contributions", async () => {
  const f = await fixture();
  const tab = { id: "agent-1", pluginId: "codex-terminal" } as Parameters<AgentHardwareContext["augmentRuntimeContext"]>[0];
  const runtime = await f.contexts.augmentRuntimeContext(tab, { pluginRuntime: { other: { value: 1 } } });
  expect(runtime.pluginRuntime?.other).toEqual({ value: 1 });
  expect(hardwareLaunchEnv(runtime, "execution-1").CLOUDX_HARDWARE_CONTEXT).toBe(f.contexts.contextPath(f.owner()));
  expect(hardwareLaunchEnv(undefined, "execution-1")).toEqual({});
  expect(() => hardwareLaunchEnv(runtime)).toThrow("execution");
  await f.contexts.revoke("agent-1");
  await expect(f.contexts.authenticate({ tabId: "agent-1", executionId: "execution-1", capability: "0".repeat(64) })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("rejects unsafe locator directories and nonlocal endpoints", async () => {
  const f = await fixture();
  const directory = f.contexts.contextDirectory("agent-1");
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.symlink(os.tmpdir(), directory);
  await expect(f.contexts.prepare("agent-1")).rejects.toThrow("private directory");
  const unsafe = new AgentHardwareContext({ dataDir: path.dirname(directory), endpoint: () => "https://example.org/hardware", binding: () => f.owner() });
  await expect(unsafe.prepare("agent-1")).rejects.toThrow("local");
});

it("rechecks the exact execution after reading an asynchronous locator", async () => {
  const f = await fixture();
  const original = f.owner();
  let authenticating = false;
  let lookups = 0;
  const directory = path.dirname(path.dirname(f.contexts.contextDirectory(original.tabId)));
  const contexts = new AgentHardwareContext({ dataDir: directory, endpoint: () => "http://127.0.0.1:3400/api/hardware/agent",
    binding: () => authenticating && ++lookups > 1 ? { ...original, executionId: "replacement" } : original });
  const locator = (await contexts.prepare(original.tabId))!;
  authenticating = true;
  await expect(contexts.authenticate({ tabId: original.tabId, executionId: original.executionId, capability: locator.capability })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
