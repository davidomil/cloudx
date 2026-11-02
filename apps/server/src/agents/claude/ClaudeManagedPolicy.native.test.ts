import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { materializeClaudeHomeOverlay, type ClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";
import { inspectClaudeNativeSettings } from "./ClaudeNativeSettings.js";
import { CLAUDE_MANAGED_SOURCE_ENV_KEYS } from "./ClaudeManagedPolicy.js";
import { buildEnforcedLoginShellLaunch } from "../../terminal/ShellLaunch.js";

const claude = process.env.CLOUDX_NATIVE_CLAUDE;
const native = it.skipIf(!claude);
const run = promisify(execFile);
type Skill = { name: string; source: string; state: string; advertised: boolean; description: string };
async function write(file: string, content: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
async function skill(directory: string, name: string, revision = "one") { await write(path.join(directory, name, "SKILL.md"), `---\ndescription: ${name} revision ${revision}\n---\n${name.toUpperCase().replace(/-/gu, "_")}_BODY_${revision}\n`); }

function client(overlay: ClaudeHomeOverlay, cwd: string, env: NodeJS.ProcessEnv, extra: string[] = []) {
  const args = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--settings", overlay.settingsPath, ...overlay.configurationArgs, ...extra];
  const launch = overlay.launchPolicy.mode === "cloudx-managed" ? buildEnforcedLoginShellLaunch(claude!, args, { ...env, CLAUDE_CONFIG_DIR: overlay.configDir },
    { set: { CLAUDE_CONFIG_DIR: overlay.configDir, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY!, ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL! }, unset: CLAUDE_MANAGED_SOURCE_ENV_KEYS })
    : { command: claude!, args, env: { ...env, CLAUDE_CONFIG_DIR: overlay.configDir } };
  const child = spawn(launch.command, launch.args, { cwd, env: launch.env });
  let buffer = "", stderr = "", sequence = 0;
  const pending = new Map<string, { resolve: (response: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const responses: unknown[] = [];
  const timeout = setTimeout(() => { for (const request of pending.values()) request.reject(new Error(`Native managed-policy control timed out: ${stderr}`)); child.kill(); }, 25_000);
  child.stderr.on("data", value => { stderr += String(value); });
  child.stdout.on("data", value => { buffer += String(value); for (;;) {
    const end = buffer.indexOf("\n"); if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
    const message = JSON.parse(line);
    if (message.type !== "control_response") continue;
    responses.push(message.response); const request = pending.get(message.response.request_id); if (!request) continue;
    pending.delete(message.response.request_id);
    if (message.response.subtype === "success") request.resolve(message.response.response);
    else request.reject(new Error(JSON.stringify(message.response)));
  } });
  child.once("close", () => { clearTimeout(timeout); for (const request of pending.values()) request.reject(new Error(`Native policy client exited: ${stderr}`)); });
  return { args, responses, stderr: () => stderr, child,
    request: (subtype: string, input: Record<string, unknown> = {}) => {
      const request_id = `policy-${++sequence}`;
      const response = new Promise<Record<string, unknown>>((resolve, reject) => pending.set(request_id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ type: "control_request", request_id, request: { subtype, ...input } })}\n`); return response;
    }, close: async () => { if (child.exitCode !== null || child.signalCode !== null) return; const closed = new Promise<void>(resolve => child.once("close", () => resolve())); child.stdin.end(); await closed; }
  };
}

native("native 2.1.316 contains late synced, project, nested, add-dir and plugin arrivals while selected snapshots and CloudX skills remain usable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-managed-native-"));
  const providerHome = path.join(root, "home", ".claude"), cwd = path.join(root, "project"), accountHome = path.join(root, "account"), added = path.join(root, "added"), nested = path.join(cwd, "nested");
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.writeHead(400); response.end("{}"); });
  let active: ReturnType<typeof client> | undefined;
  try {
    await Promise.all([providerHome, cwd, accountHome, added, nested].map(directory => fs.mkdir(directory, { recursive: true })));
    await skill(path.join(providerHome, "skills"), "notes");
    await skill(path.join(providerHome, "skills", "synced", "account-one"), "docx");
    await skill(path.join(cwd, ".claude", "skills"), "project-old");
    await skill(path.join(added, ".claude", "skills"), "added-old");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const env = { PATH: process.env.PATH, HOME: path.dirname(providerHome), ANTHROPIC_API_KEY: "fake-local-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
    const options = { dataDir: path.join(root, "data"), tabId: "first", executionId: "11111111-1111-4111-8111-111111111111", accountHome, providerHome, cwd, launchEnv: env, nativeVersion: "2.1.316", launchMode: "cloudx-managed" as const, allowedSkills: ["notes", "docx"] };
    const overlay = await materializeClaudeHomeOverlay(options);
    const profile = path.join(root, "hostile-bash-env");
    await write(profile, `export CLAUDE_CODE_PLUGIN_DIRS=${JSON.stringify(path.join(root, "late-plugin"))}
export CLAUDE_CODE_HOST_SKILL_CATALOG='{"skills":["late-personal"]}'
export CLAUDE_CODE_PLUGIN_CACHE_DIR=${JSON.stringify(path.join(providerHome, "plugins"))}
`);
    active = client(overlay, cwd, { ...env, SHELL: "/bin/bash", BASH_ENV: profile }, ["--add-dir", added]);
    const initialize = await active.request("initialize"); expect(initialize.claude_code_version).toBe("2.1.316");
    expect((initialize.commands as { name: string }[]).some(command => command.name === "doctor")).toBe(false);
    const skills = async () => (await active!.request("get_skills_dialog")).skills as Skill[];
    const before = await skills();
    expect(before.filter(entry => entry.state !== "off").map(entry => entry.name).sort()).toEqual(overlay.launchPolicy.skills.map(entry => entry.name).sort());
    await skill(path.join(providerHome, "skills", "synced", "account-one"), "late-synced");
    await skill(path.join(providerHome, "skills"), "late-personal");
    await skill(path.join(providerHome, "skills"), "notes", "two");
    await skill(path.join(providerHome, "skills", "synced", "account-one"), "docx", "two");
    await skill(path.join(cwd, ".claude", "skills"), "late-project");
    await skill(path.join(nested, ".claude", "skills"), "late-nested");
    await skill(path.join(added, ".claude", "skills"), "late-added");
    await write(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "late@fixture": true }, extraKnownMarketplaces: { fixture: { source: { source: "directory", path: path.join(root, "marketplace") } } } }));
    await write(path.join(providerHome, "settings.json"), JSON.stringify({ enabledPlugins: { "late@fixture": true } }));
    await write(path.join(providerHome, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "late@fixture": [{ scope: "user", installPath: path.join(root, "late-plugin"), version: "1.0.0" }] } }));
    await write(path.join(root, "late-plugin", ".claude-plugin", "plugin.json"), '{"name":"late","version":"1.0.0"}');
    await skill(path.join(root, "late-plugin", "skills"), "late-plugin");
    await active.request("reload_plugins"); await active.request("reload_skills");
    const after = await skills();
    expect(after.filter(entry => entry.state !== "off").map(entry => entry.name).sort()).toEqual(overlay.launchPolicy.skills.map(entry => entry.name).sort());
    expect(after.find(entry => entry.name === "notes")!.description).toBe("notes revision one");
    expect(after.find(entry => entry.name === "docx")!.description).toBe("docx revision one");
    expect((await fs.lstat(path.join(overlay.configDir, "plugins"))).isFile()).toBe(true);
    const trust = await active.request("set_cwd", { path: nested });
    expect(trust).toMatchObject({ status: "needs_trust", directory: nested });
    const relocation = await active.request("set_cwd", { path: nested, trust_accepted: true, trusted_directory: trust.directory });
    expect(relocation).toMatchObject({ status: "ok", cwd: nested });
    await active.request("reload_plugins"); await active.request("reload_skills");
    expect((await skills()).filter(entry => entry.state !== "off").map(entry => entry.name).sort()).toEqual(overlay.launchPolicy.skills.map(entry => entry.name).sort());
    await active.close(); active = undefined;
    // Starting at a newly discovered target also retains the immutable source contract.
    for (const target of [nested, added]) {
      active = client(overlay, target, env); await active.request("initialize");
      const atTarget = await skills();
      expect(atTarget.filter(entry => entry.state !== "off").map(entry => entry.name).sort()).toEqual(overlay.launchPolicy.skills.map(entry => entry.name).sort());
      await active.close(); active = undefined;
    }
    await fs.unlink(path.join(cwd, ".claude", "settings.local.json"));
    await write(path.join(providerHome, "settings.json"), "{}");
    const next = await materializeClaudeHomeOverlay({ ...options, tabId: "next", allowedSkills: ["docx"] });
    active = client(next, cwd, env); await active.request("initialize");
    const nextSkills = await skills();
    expect(nextSkills.find(entry => entry.name === "docx")!.description).toBe("docx revision two");
    expect(nextSkills.some(entry => entry.name === "notes")).toBe(false);
    await active.close(); active = undefined;
    expect(await fs.readFile(path.join(overlay.configDir, "skills", "notes", "SKILL.md"), "utf8")).toContain("NOTES_BODY_one");
    await skill(path.join(providerHome, "skills", "synced", "account-two"), "docx");
    await expect(materializeClaudeHomeOverlay({ ...options, tabId: "ambiguous", allowedSkills: ["docx"] })).rejects.toThrow("conflicting sources");
    await write(path.join(root, "marketplace", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "fixture", owner: { name: "Local fixture" }, plugins: [{ name: "late", source: "./late" }] }));
    const install = await run(claude!, ["plugin", "marketplace", "add", path.join(root, "marketplace")], { cwd, env: { ...env, CLAUDE_CONFIG_DIR: overlay.configDir }, timeout: 10_000 }).then(result => ({ ...result, code: 0 }), error => ({ stdout: error.stdout as string, stderr: error.stderr as string, code: error.code as number }));
    expect(install.code).not.toBe(0);
    expect((await fs.lstat(path.join(overlay.configDir, "plugins"))).isFile()).toBe(true);
    expect(install.stdout + install.stderr).toMatch(/ENOTDIR|not a directory/u);
    expect(requests).toBe(0);
    if (process.env.CLOUDX_NATIVE_EVIDENCE_DIR) {
      await fs.mkdir(process.env.CLOUDX_NATIVE_EVIDENCE_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.CLOUDX_NATIVE_EVIDENCE_DIR, "managed-discovery.json"), JSON.stringify({ nativeVersion: initialize.claude_code_version, nativeSha256: createHash("sha256").update(await fs.readFile(claude!)).digest("hex"), requests, policy: overlay.launchPolicy, before, after }, null, 2));
    }
  } finally { await active?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
}, 50_000);

native("native managed launches expand allowed personal, synced and CloudX skills and disclose the narrower instruction scope beside a native-project control", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-managed-invocation-"));
  const providerHome = path.join(root, "home", ".claude"), cwd = path.join(root, "project"), accountHome = path.join(root, "account");
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    if (request.url?.includes("count_tokens")) { response.setHeader("content-type", "application/json"); response.end('{"input_tokens":1}'); return; }
    if (!request.url?.includes("messages")) { response.writeHead(404); response.end(); return; }
    requests.push(JSON.parse(body));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Local fixture complete." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  try {
    await Promise.all([providerHome, cwd, accountHome].map(directory => fs.mkdir(directory, { recursive: true })));
    await skill(path.join(providerHome, "skills"), "notes");
    for (const name of ["doctor", "checkup", "design"]) await skill(path.join(providerHome, "skills"), name);
    await skill(path.join(providerHome, "skills", "synced", "account-one"), "docx");
    await write(path.join(providerHome, "CLAUDE.md"), "PERSONAL_INSTRUCTIONS_MARKER\n");
    await write(path.join(cwd, "CLAUDE.md"), "PROJECT_INSTRUCTIONS_MARKER\n");
    await write(path.join(cwd, ".claude", "rules", "fixture.md"), "PROJECT_RULES_MARKER\n");
    await write(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ language: "french" }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const env = { PATH: process.env.PATH, HOME: path.dirname(providerHome), ANTHROPIC_API_KEY: "fake-local-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
    const options = { dataDir: path.join(root, "data"), tabId: "managed", executionId: "11111111-1111-4111-8111-111111111111", accountHome, providerHome, cwd, launchEnv: env, nativeVersion: "2.1.316", allowedSkills: ["notes", "docx", "doctor", "checkup", "design"], trustProject: true };
    const managed = await materializeClaudeHomeOverlay({ ...options, launchMode: "cloudx-managed" });
    // A local instruction arriving after this launch's preflight is still outside the native source set.
    await write(path.join(cwd, "CLAUDE.local.md"), "LOCAL_INSTRUCTIONS_MARKER\n");
    const invoke = async (overlay: ClaudeHomeOverlay, prompt: string) => {
      const start = requests.length;
      const args = ["--print", "--no-session-persistence", "--output-format", "json", "--model", "claude-sonnet-4-6", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", overlay.settingsPath, "--append-system-prompt-file", overlay.instructionsPath, ...overlay.configurationArgs, "--", prompt];
      const result = await run(claude!, args, { cwd, env: { ...env, CLAUDE_CONFIG_DIR: overlay.configDir }, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
      expect(JSON.parse(result.stdout)).toMatchObject({ is_error: false });
      expect(requests.length).toBeGreaterThan(start);
      return JSON.stringify(requests.slice(start));
    };
    const personal = await invoke(managed, "/notes");
    expect(personal).toContain("NOTES_BODY_one");
    const synced = await invoke(managed, "/docx");
    expect(synced).toContain("DOCX_BODY_one");
    for (const name of ["doctor", "checkup", "design"]) expect(await invoke(managed, `/${name}`)).toContain(`${name.toUpperCase()}_BODY_one`);
    const cloudxSkill = managed.launchPolicy.skills.find(entry => entry.origin === "cloudx-system")!;
    const cloudx = await invoke(managed, `/${cloudxSkill.name}`);
    expect(cloudx).toContain(`Base directory for this skill: ${path.join(managed.configDir, "skills", cloudxSkill.name)}`);
    expect(cloudx).toContain("# Create CloudX Skill");
    expect(cloudx).toContain("CloudX Claude Session Instructions");
    const memory = await invoke(managed, "Observe local instruction fixture.");
    expect(memory).toContain("PERSONAL_INSTRUCTIONS_MARKER");
    expect(memory).not.toContain("PROJECT_INSTRUCTIONS_MARKER");
    expect(memory).not.toContain("PROJECT_RULES_MARKER");
    expect(memory).not.toContain("LOCAL_INSTRUCTIONS_MARKER");
    expect(memory).not.toContain("Always respond in french");
    const nativeProject = await materializeClaudeHomeOverlay({ ...options, tabId: "native", launchMode: "native-project" });
    const nativeMemory = await invoke(nativeProject, "Observe local instruction fixture.");
    for (const marker of ["PERSONAL_INSTRUCTIONS_MARKER", "PROJECT_INSTRUCTIONS_MARKER", "PROJECT_RULES_MARKER", "LOCAL_INSTRUCTIONS_MARKER", "Always respond in french"])
      expect(nativeMemory).toContain(marker);
    await skill(path.join(cwd, ".claude", "skills"), cloudxSkill.name, "project-collision");
    const collision = await invoke(nativeProject, `/${cloudxSkill.name}`);
    expect(collision).toContain(`Base directory for this skill: ${path.join(nativeProject.configDir, "skills", cloudxSkill.name)}`);
    expect(collision).toContain("# Create CloudX Skill");
    expect(collision).not.toContain("_BODY_project-collision");
    expect(nativeProject.launchPolicy).toMatchObject({ mode: "native-project", exclusiveSkills: false, settingSources: ["user", "project", "local"] });
    if (process.env.CLOUDX_NATIVE_EVIDENCE_DIR) {
      await fs.mkdir(process.env.CLOUDX_NATIVE_EVIDENCE_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.CLOUDX_NATIVE_EVIDENCE_DIR, "managed-invocations.json"), JSON.stringify({ nativeVersion: "2.1.316", nativeSha256: createHash("sha256").update(await fs.readFile(claude!)).digest("hex"), requests, policy: managed.launchPolicy, nativeProjectPolicy: nativeProject.launchPolicy }, null, 2));
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
}, 50_000);

native("managed source scope excludes project MCP configuration while Native project keeps its prompt commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-managed-mcp-"));
  const cwd = path.join(root, "project"), providerHome = path.join(root, "personal"), accountHome = path.join(root, "account");
  let active: ReturnType<typeof client> | undefined;
  try {
    await Promise.all([cwd, providerHome, accountHome].map(directory => fs.mkdir(directory)));
    const server = path.join(root, "mcp-fixture.mjs");
    const observations = path.join(root, "mcp-calls.jsonl");
    await write(server, `import readline from 'node:readline'; import fs from 'node:fs';\nfor await (const line of readline.createInterface({input:process.stdin})) { const request=JSON.parse(line); fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify(request)+'\\n'); if(request.id===undefined)continue; const result=request.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{prompts:{}},serverInfo:{name:'fixture',version:'1'}}:request.method==='prompts/list'?{prompts:[{name:'unselected-mcp-prompt',description:'Outside selected skill set'}]}:request.method==='tools/list'?{tools:[]}:request.method==='resources/list'?{resources:[]}:request.method==='prompts/get'?{messages:[{role:'user',content:{type:'text',text:'UNSELECTED_MCP_BODY'}}]}:{}; console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result})); }`);
    await write(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server] } } }));
    await write(path.join(providerHome, "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
    const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), ANTHROPIC_API_KEY: "fake-local-only", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
    const overlay = await materializeClaudeHomeOverlay({ dataDir: path.join(root, "data"), tabId: "mcp", cwd, providerHome, accountHome, executionId: "11111111-1111-4111-8111-111111111111", nativeVersion: "2.1.316", launchMode: "cloudx-managed", launchEnv: env, trustProject: true });
    active = client(overlay, cwd, env); await active.request("initialize");
    await active.request("reload_plugins");
    const skills = (await active.request("get_skills_dialog")).skills as Skill[];
    expect(skills.some(entry => entry.source === "mcp")).toBe(false);
    await expect(fs.stat(observations)).rejects.toMatchObject({ code: "ENOENT" });
    await active.close(); active = undefined;
    const nativeProject = await materializeClaudeHomeOverlay({ dataDir: path.join(root, "data"), tabId: "native-mcp", cwd, providerHome, accountHome, executionId: "11111111-1111-4111-8111-111111111111", nativeVersion: "2.1.316", launchMode: "native-project", launchEnv: env, trustProject: true });
    active = client(nativeProject, cwd, env); const nativeInit = await active.request("initialize"); const nativeReload = await active.request("reload_plugins");
    expect((nativeInit.commands as { name: string }[]).some(command => command.name === "doctor")).toBe(true);
    const nativeSkills = (await active.request("get_skills_dialog")).skills as Skill[];

    if (process.env.CLOUDX_NATIVE_EVIDENCE_DIR) {
      await fs.mkdir(process.env.CLOUDX_NATIVE_EVIDENCE_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.CLOUDX_NATIVE_EVIDENCE_DIR, "managed-mcp.json"), JSON.stringify({ skills, nativeSkills, nativeInit, nativeReload, stderr: active.stderr(), observations: await fs.readFile(observations, "utf8").catch(() => "not started") }, null, 2));
    }
    expect(nativeReload.mcpServers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "fixture", status: "connected", scope: "project" })]));
    expect(nativeReload.commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: "fixture:unselected-mcp-prompt (MCP)" })]));
    expect(await fs.readFile(observations, "utf8")).toContain("prompts/list");
  } finally { await active?.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 35_000);


native("managed preflight rejects disabled personal hooks despite an enabling excluded project setting, before any native prompt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-hook-sources-"));
  const providerHome = path.join(root, "personal"), accountHome = path.join(root, "account"), cwd = path.join(root, "project");
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.writeHead(400); response.end("{}"); });
  try {
    await Promise.all([providerHome, accountHome, cwd].map(directory => fs.mkdir(directory)));
    await write(path.join(providerHome, "settings.json"), '{"disableAllHooks":true}');
    await write(path.join(cwd, ".claude", "settings.json"), '{"disableAllHooks":false}');
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const env = { PATH: process.env.PATH, HOME: root, ANTHROPIC_API_KEY: "fake-local-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as {port:number}).port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
    const options = { dataDir: path.join(root, "data"), tabId: "rejected", providerHome, accountHome, cwd, executionId: "11111111-1111-4111-8111-111111111111", nativeVersion: "2.1.316", launchEnv: env };
    await expect(materializeClaudeHomeOverlay({ ...options, launchMode: "cloudx-managed" })).rejects.toThrow("disableAllHooks");
    await expect(fs.stat(path.join(options.dataDir, "claude-launches"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(requests).toBe(0);
    // Read the real native source merge without sending a prompt/model request.
    const settingsPath = path.join(root, "probe.json"); await write(settingsPath, "{}");
    const probe = { command: claude!, settingsPath, cwd, env: { ...env, CLAUDE_CONFIG_DIR: providerHome } };
    const managed = await inspectClaudeNativeSettings({ ...probe, configurationArgs: ["--setting-sources", "user"] });
    const nativeProject = await inspectClaudeNativeSettings(probe);
    expect(managed.version).toBe("2.1.316");
    expect(managed.hooks.policy).toMatchObject({ allDisabled: true });
    expect(nativeProject.hooks.policy).toMatchObject({ allDisabled: false });
    expect(requests).toBe(0);
    expect(await fs.readFile(path.join(providerHome, "settings.json"), "utf8")).toBe('{"disableAllHooks":true}');
    expect(await fs.readFile(path.join(cwd, ".claude", "settings.json"), "utf8")).toBe('{"disableAllHooks":false}');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);

native.each(["settings.json", "settings.local.json"])("Native project rejects required skill suppression in loaded %s before launch while the native control advertises it", async file => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-skill-sources-"));
  const providerHome = path.join(root, "personal"), accountHome = path.join(root, "account"), cwd = path.join(root, "project");
  let active: ReturnType<typeof client> | undefined;
  try {
    await Promise.all([providerHome, accountHome, cwd].map(directory => fs.mkdir(directory)));
    const dataDir = path.join(root, "data");
    await write(path.join(dataDir, "rules-skills", "skills", "template-owned", "SKILL.md"), "---\ndescription: Selected template fixture.\n---\nTemplate body.");
    const resolved = { source: "tab" as const, template: { id: "template", name: "Template", color: "green" as const, ruleIds: [], skillIds: ["template-owned"] }, rules: [], skills: [{ id: "template-owned", name: "Template owned", description: "Selected fixture" }] };
    const env = { PATH: process.env.PATH, HOME: root, ANTHROPIC_API_KEY: "fake-local-only", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
    const options = { dataDir, tabId: "control", providerHome, accountHome, cwd, executionId: "11111111-1111-4111-8111-111111111111", nativeVersion: "2.1.316", launchMode: "native-project" as const, launchEnv: env, resolved };
    const overlay = await materializeClaudeHomeOverlay(options);
    active = client(overlay, cwd, env); await active.request("initialize");
    const before = (await active.request("get_skills_dialog")).skills as Skill[];
    await active.close(); active = undefined;
    const source = path.join(cwd, ".claude", file);
    for (const name of ["cloudx-system-create-cloudx-skill", "cloudx-template-owned"]) {
      expect(before.find(skill => skill.name === name)).toMatchObject({ state: "on", advertised: true });
      const original = JSON.stringify({ skillOverrides: { [name]: "off" } });
      await write(source, original);
      await expect(materializeClaudeHomeOverlay({ ...options, tabId: "rejected" })).rejects.toThrow(`disables required CloudX skill ${name}`);
      await expect(fs.stat(path.join(options.dataDir, "claude-launches", "rejected"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(source, "utf8")).toBe(original);
      // The existing fixture demonstrates actual native suppression without model work.
      active = client(overlay, cwd, env); await active.request("initialize");
      const after = (await active.request("get_skills_dialog")).skills as Skill[];
      expect(after.find(skill => skill.name === name)).toMatchObject({ state: "off", advertised: false });
      await active.close(); active = undefined;
    }
  } finally { await active?.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
