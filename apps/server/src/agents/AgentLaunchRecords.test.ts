import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentLaunchRecords } from "./AgentLaunchRecords.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-launch-record-"));
  roots.push(root);
  const config = path.join(root, "config.json");
  await fs.writeFile(config, '{"apiKey":"synthetic-credential"}');
  const input = {
    providerId: "claude" as const, tabId: "tab-1", executionId: "execution-1", command: "/vendor/claude",
    version: "2.1.316 (Claude Code)", accountId: "account-1", cwd: root,
    args: ["--settings", config, "--model", "claude-opus-5-5", "-c", 'token="synthetic-argument-secret"', "--", "private initial prompt"],
    env: { ANTHROPIC_API_KEY: "synthetic-environment-secret" }, enforcedEnvironmentKeys: ["ANTHROPIC_API_KEY"], configurationPaths: [config],
  };
  return { root, config, input, records: new AgentLaunchRecords(root) };
}

it("preserves launch identity and source fingerprints through restart without saving prompts or credentials", async () => {
  const f = await fixture();
  const recorded = await f.records.record(f.input);
  expect(recorded).toMatchObject({
    providerId: "claude", accountId: "account-1", executionId: "execution-1", version: "2.1.316",
    arguments: ["--settings", f.config, "--model", "claude-opus-5-5", "-c", "[omitted]", "--", "[omitted]"],
    environmentKeys: ["ANTHROPIC_API_KEY"], configurationSources: [{ path: f.config, state: "file", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }],
  });
  expect(await new AgentLaunchRecords(f.root).read("tab-1", "claude")).toEqual(recorded);
  const text = await fs.readFile(path.join(f.root, "agent-launch-records/claude-tab-1.json"), "utf8");
  for (const secret of ["synthetic-credential", "synthetic-argument-secret", "synthetic-environment-secret", "private initial prompt"]) expect(text).not.toContain(secret);
  expect((await fs.stat(path.join(f.root, "agent-launch-records/claude-tab-1.json"))).mode & 0o777).toBe(0o600);
});

it("keeps historical account/version/configuration observations until a new execution is recorded", async () => {
  const f = await fixture();
  const before = await f.records.record(f.input);
  await fs.writeFile(f.config, '{"new":true}');
  expect(await f.records.read("tab-1", "claude")).toEqual(before);
  const next = await f.records.record({ ...f.input, accountId: "account-2", executionId: "execution-2", version: undefined });
  expect(next).toMatchObject({ accountId: "account-2", executionId: "execution-2", version: null });
  expect(next.configurationSources[0]!.sha256).not.toBe(before.configurationSources[0]!.sha256);
  expect(await f.records.read("tab-1", "codex")).toBeUndefined();
});

it("reports inaccessible, linked and oversized sources without reading their content", async () => {
  const f = await fixture();
  const link = path.join(f.root, "linked.json");
  const large = path.join(f.root, "large.json");
  const missing = path.join(f.root, "missing.json");
  await fs.symlink(f.config, link);
  await fs.writeFile(large, "x".repeat(524_289));
  const record = await f.records.record({ ...f.input, configurationPaths: [missing, link, large, f.root] });
  expect(record.configurationSources).toEqual([
    { path: missing, state: "missing" }, { path: link, state: "unobserved" }, { path: large, state: "unobserved" }, { path: f.root, state: "unobserved" },
  ]);
});

it("refuses unsafe record owners, symbolic-link files and changed serialized identities", async () => {
  const f = await fixture();
  await expect(f.records.record({ ...f.input, tabId: "../other" })).rejects.toThrow(/Invalid/);
  await expect(f.records.read("../other", "claude")).rejects.toThrow(/Invalid/);
  const recorded = await f.records.record(f.input);
  const file = path.join(f.root, "agent-launch-records/claude-tab-1.json");
  await fs.writeFile(file, JSON.stringify({ ...recorded, tabId: "someone-else" }));
  await expect(f.records.read("tab-1", "claude")).rejects.toThrow(/identity/);
  await fs.unlink(file);
  await fs.symlink(f.config, file);
  await expect(f.records.read("tab-1", "claude")).rejects.toThrow(/symbolic link/);
  await expect(f.records.record(f.input)).rejects.toThrow(/symbolic link/);
  expect(await fs.readFile(f.config, "utf8")).toContain("synthetic-credential");
});

it("refuses a replaced storage directory and malformed serialized source data", async () => {
  const f = await fixture();
  const recorded = await f.records.record(f.input);
  const file = path.join(f.root, "agent-launch-records/claude-tab-1.json");
  await fs.writeFile(file, JSON.stringify({ ...recorded, configurationSources: [{ path: f.config, state: "file", sha256: "invalid" }] }));
  await expect(f.records.read("tab-1", "claude")).rejects.toThrow(/Invalid/);
  await fs.rm(path.dirname(file), { recursive: true });
  await fs.symlink(f.root, path.dirname(file));
  await expect(f.records.record(f.input)).rejects.toThrow(/symbolic link/);
});

it("omits inline settings, secret-bearing unknown arguments and remote connection targets", async () => {
  const f = await fixture();
  const observed = await f.records.record({ ...f.input, args: ["--settings", '{"apiKey":"inline-secret"}', "--remote", "ws://localhost?token=remote-secret", "--secret=unknown-secret", "--model", "invalid model secret"] });
  expect(observed.arguments).toEqual(["--settings", "[omitted]", "--remote", "[omitted]", "[omitted]", "--model", "[omitted]"]);
  expect(JSON.stringify(await f.records.read("tab-1", "claude"))).not.toContain("secret");
});


it("preserves the execution's resolved mode and source snapshots while leaving older policy unobserved", async () => {
  const f = await fixture();
  expect((await f.records.record(f.input)).claudeLaunchPolicy).toBeUndefined();
  const policy = { mode: "cloudx-managed" as const, contractVersion: 1 as const, nativeVersion: "2.1.316", exclusiveSkills: true, activation: "next-launch" as const,
    settingSources: ["user"], includedSources: ["personal instructions"], excludedSources: ["project", "local", "plugins"],
    skills: [{ name: "notes", origin: "personal" as const, nativeSource: "user" as const, sourcePath: "/personal/skills/notes", sha256: "b".repeat(64) }] };
  const saved = await f.records.record({ ...f.input, args: ["--setting-sources", "user"], claudeLaunchPolicy: policy, claudeLaunchModeSource: "saved" });
  expect(await new AgentLaunchRecords(f.root).read("tab-1", "claude")).toMatchObject({ claudeLaunchPolicy: policy, claudeLaunchModeSource: "saved", arguments: ["--setting-sources", "user"] });
  const file = path.join(f.root, "agent-launch-records/claude-tab-1.json");
  await fs.writeFile(file, JSON.stringify({ ...saved, claudeLaunchPolicy: { ...policy, settingSources: ["user", "project"] } }));
  await expect(f.records.read("tab-1", "claude")).rejects.toThrow("Invalid recorded Claude launch policy");
  await expect(f.records.record({ ...f.input, providerId: "codex", claudeLaunchPolicy: policy, claudeLaunchModeSource: "saved" })).rejects.toThrow("Invalid agent launch record");
});
