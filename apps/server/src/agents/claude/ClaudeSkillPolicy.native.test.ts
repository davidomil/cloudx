import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";

const claude = process.env.CLOUDX_NATIVE_CLAUDE;
const native = it.skipIf(!claude);

type Skill = { name: string; source: string; state: string; advertised: boolean; description: string };

async function skill(directory: string, description: string) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), `---\ndescription: ${description}\n---\nLocal skill fixture.\n`);
}

function nativeControls(child: ChildProcessWithoutNullStreams) {
  let sequence = 0;
  let pendingText = "";
  const responses: unknown[] = [];
  const waiting = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const deadline = setTimeout(() => {
    for (const pending of waiting.values()) pending.reject(new Error("The isolated native skill client exceeded its deadline."));
    child.kill("SIGTERM");
  }, 20_000);
  child.stdout.on("data", chunk => {
    pendingText += String(chunk);
    for (;;) {
      const end = pendingText.indexOf("\n");
      if (end < 0) break;
      const line = pendingText.slice(0, end);
      pendingText = pendingText.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.type !== "control_response") continue;
      responses.push(message.response);
      const pending = waiting.get(message.response.request_id);
      if (!pending) continue;
      waiting.delete(message.response.request_id);
      if (message.response.subtype === "success") pending.resolve(message.response.response);
      else pending.reject(new Error("The isolated native skill control request failed."));
    }
  });
  child.once("close", () => {
    clearTimeout(deadline);
    for (const pending of waiting.values()) pending.reject(new Error("The isolated native skill client exited before replying."));
  });
  return {
    responses,
    request: async (subtype: string) => {
      const requestId = `skill-fixture-${++sequence}`;
      const response = new Promise<Record<string, unknown>>((resolve, reject) => waiting.set(requestId, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype } })}\n`);
      return response;
    }
  };
}

native("keeps selected skill snapshots stable while late unselected personal names, account changes and next-launch revocation stay isolated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-personal-skills-"));
  const providerHome = path.join(root, "home", ".claude");
  const cwd = path.join(root, "project");
  const accountHome = path.join(root, "account-a");
  let modelRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url?.includes("messages")) modelRequests++;
    response.writeHead(400);
    response.end("{}");
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await Promise.all([providerHome, cwd, accountHome].map(directory => fs.mkdir(directory, { recursive: true })));
    await fs.writeFile(path.join(accountHome, ".credentials.json"), "{}");
    await skill(path.join(providerHome, "skills", "notes"), "Selected personal revision one.");
    await skill(path.join(providerHome, "skills", "private"), "Unselected personal fixture.");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The native skill fixture requires a loopback TCP address.");
    const launchEnv = { PATH: process.env.PATH, HOME: path.dirname(providerHome), ANTHROPIC_API_KEY: "fake-local-fixture",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
    const options = { dataDir: path.join(root, "data"), tabId: "first", accountHome, providerHome, cwd, launchEnv,
      executionId: "11111111-1111-4111-8111-111111111111", allowedSkills: ["notes"] };
    const overlay = await materializeClaudeHomeOverlay(options);
    const settings = JSON.parse(await fs.readFile(overlay.settingsPath, "utf8"));
    expect(settings.syncClaudeAiSkills).toBe(false);
    expect((await fs.lstat(path.join(overlay.configDir, "skills", "notes"))).isSymbolicLink()).toBe(false);
    child = spawn(claude!, ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--no-session-persistence", "--settings", overlay.settingsPath], { cwd, env: { ...launchEnv, CLAUDE_CONFIG_DIR: overlay.configDir } });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const controls = nativeControls(child);
    const initialize = await controls.request("initialize");
    expect(initialize.claude_code_version).toBe("2.1.316");
    const skills = async () => (await controls.request("get_skills_dialog")).skills as Skill[];
    const before = await skills();
    expect(before).toEqual(expect.arrayContaining([expect.objectContaining({ name: "notes", source: "user", state: "on", advertised: true })]));
    expect(before.some(entry => entry.name === "private")).toBe(false);
    const cloudx = before.filter(entry => entry.name.startsWith("cloudx-system-"));
    expect(cloudx.length).toBeGreaterThan(0);
    expect(cloudx.every(entry => entry.state === "on" && entry.advertised)).toBe(true);

    await skill(path.join(providerHome, "skills", "late-personal"), "New unselected personal fixture.");
    await skill(path.join(providerHome, "skills", "notes"), "Selected personal revision two.");
    await controls.request("reload_skills");
    const after = await skills();
    expect(after.some(entry => entry.name === "late-personal")).toBe(false);
    expect(after).toEqual(expect.arrayContaining([expect.objectContaining({ name: "notes", description: "Selected personal revision one.", state: "on" })]));

    const accountB = path.join(root, "account-b");
    await fs.mkdir(accountB);
    await fs.writeFile(path.join(accountB, ".credentials.json"), "{}");
    const next = await materializeClaudeHomeOverlay({ ...options, accountHome: accountB, tabId: "next", allowedSkills: [] });
    expect(await fs.readlink(path.join(next.configDir, ".credentials.json"))).toBe(path.join(accountB, ".credentials.json"));
    await expect(fs.stat(path.join(next.configDir, "skills", "notes"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await skills()).some(entry => entry.name === "notes" && entry.state === "on")).toBe(true);
    expect(await fs.readlink(path.join(overlay.configDir, ".credentials.json"))).toBe(path.join(accountHome, ".credentials.json"));

    await skill(path.join(providerHome, "skills", "synced", "account-a", "docx"), "Account A fixture.");
    const synced = await materializeClaudeHomeOverlay({ ...options, tabId: "sync-a", allowedSkills: ["docx"] });
    expect(await fs.readFile(path.join(synced.configDir, "skills", "docx", "SKILL.md"), "utf8")).toContain("Account A fixture.");
    await skill(path.join(providerHome, "skills", "synced", "account-b", "docx"), "Account B collision.");
    await expect(materializeClaudeHomeOverlay({ ...options, accountHome: accountB, tabId: "sync-b", allowedSkills: ["docx"] })).rejects.toThrow("conflicting sources");
    expect((await skills()).some(entry => entry.name === "notes" && entry.state === "on")).toBe(true);
    expect(modelRequests).toBe(0);
    if (process.env.CLOUDX_NATIVE_EVIDENCE_DIR) {
      await fs.mkdir(process.env.CLOUDX_NATIVE_EVIDENCE_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.CLOUDX_NATIVE_EVIDENCE_DIR, "personal-skill-lifecycle.json"), JSON.stringify({ nativeVersion: initialize.claude_code_version,
        nativeSha256: createHash("sha256").update(await fs.readFile(claude!)).digest("hex"), modelRequests,
        scope: "Immutable selected snapshots and preflight only. Does not establish containment of project, nested, add-dir or cd discovery.",
        before, after, responses: controls.responses, stderr }, null, 2));
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child!.once("close", () => resolve()));
      child.stdin.end();
      await closed;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
