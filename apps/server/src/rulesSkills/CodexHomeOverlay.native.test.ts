import { spawn, execFileSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@cloudx/shared";
import { AppServerClient, StdioAppServerTransport, type AppServerTransport } from "../appServer/AppServerClient.js";
import { CLOUDX_CODEX_CONFIGURATION_ARGS, materializeCodexTemplate } from "../plugins/CodexTerminalPlugin.js";
import { CodexStateSources } from "../plugins/CodexStateSources.js";
import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";
import { DurableTerminalProcessFactory, terminalSocketPath } from "../terminal/DurableTerminalProcess.js";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { TerminalBroker } from "../terminal/TerminalBroker.js";
import type { TerminalProcess } from "../terminal/TerminalProcess.js";
import { SessionStateStore } from "../workspace/SessionStateStore.js";
import { cloudxSystemSkillFilePath, RulesSkillsCatalogService, type ResolvedPersonalityTemplate } from "./RulesSkillsCatalogService.js";

const codex = process.env.CLOUDX_NATIVE_CODEX;

it.skipIf(!codex)("discovers the exact selected/system/default catalog without traversing dependencies and keeps canonical resources usable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-skills-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const cwd = path.join(root, "workspace");
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: codex };
  const sources = new CodexStateSources(data, env);
  const skill = path.join(data, "rules-skills/skills/dependency-heavy");
  const builtin = path.join(home, "skills/.system/imagegen");
  const resolved: ResolvedPersonalityTemplate = {
    source: "tab", template: { id: "test", name: "Test", color: "green", ruleIds: [], skillIds: ["dependency-heavy"] }, rules: [],
    skills: [{ id: "dependency-heavy", name: "Dependency heavy", description: "Exercise bounded discovery.", scope: "user" }]
  };
  const children: Array<{ client: AppServerClient; stopped: Promise<unknown> }> = [];
  try {
    await fs.mkdir(cwd, { recursive: true });
    for (const source of [skill, builtin]) {
      await fs.mkdir(path.join(source, "scripts"), { recursive: true });
      await fs.mkdir(path.join(source, "assets"));
      await fs.mkdir(path.join(source, "references"));
      await fs.mkdir(path.join(source, "agents"));
      await fs.writeFile(path.join(source, "SKILL.md"), `---\nname: ${path.basename(source)}\ndescription: Exercise bounded discovery.\n---\nRun scripts/check.cjs and read references/guide.md.\n`);
      await fs.writeFile(path.join(source, "agents/openai.yaml"), 'interface:\n  display_name: "Bounded skill"\n  short_description: "Exercise bounded discovery"\n  icon_small: "./assets/icon.svg"\npolicy:\n  allow_implicit_invocation: false\n');
      await fs.writeFile(path.join(source, "assets/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      await fs.writeFile(path.join(source, "references/guide.md"), "Original reference");
      await fs.mkdir(path.join(source, "node_modules/runtime"), { recursive: true });
      await fs.writeFile(path.join(source, "node_modules/runtime/index.js"), 'module.exports = "runtime available";');
      await fs.writeFile(path.join(source, "scripts/check.cjs"), 'console.log(require("runtime") + ": " + require("fs").readFileSync(require("path").join(__dirname, "../references/guide.md"), "utf8"));');
    }
    // More directories than the native 2,000-directory budget, including a dependency-owned skill.
    for (let offset = 0; offset < 2100; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, async (_, index) => {
        const dir = path.join(skill, "node_modules", `dependency-${offset + index}`);
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};");
      }));
    }
    await fs.writeFile(path.join(skill, "node_modules/dependency-0/SKILL.md"), "---\nname: unwanted\ndescription: Dependency owned.\n---\n");
    await fs.mkdir(path.join(skill, ".venv/lib"), { recursive: true });
    await fs.writeFile(path.join(skill, ".venv/lib/SKILL.md"), "---\nname: unwanted-env\ndescription: Environment owned.\n---\n");
    await fs.writeFile(path.join(home, "config.toml"), 'model_provider = "synthetic"\n[model_providers.synthetic]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');

    const inspect = async (tabId: string, resetCodexHome = true) => {
      const launch = await materializeCodexTemplate(resolved, env, { dataDir: data, sources, tabId, cwd, resetOverlay: resetCodexHome });
      const overlay = launch.overlay!;
      // No directory links may let native discovery walk into the source trees.
      const entries = await fs.readdir(path.join(overlay.codexHome, "skills"), { recursive: true });
      expect(entries.length).toBeLessThan(50);
      for (const entry of entries) {
        const file = path.join(overlay.codexHome, "skills", entry);
        if ((await fs.lstat(file)).isSymbolicLink()) expect((await fs.stat(file)).isFile()).toBe(true);
      }
      const stderrPath = path.join(root, `${tabId}.stderr`);
      const log = await fs.open(stderrPath, "w");
      const native = spawn(codex!, ["app-server", "--listen", "stdio://"], { cwd, env: { ...env, ...launch.env }, stdio: ["pipe", "pipe", log.fd] });
      await log.close();
      const stopped = new Promise(resolve => native.once("close", resolve));
      const transport = new StdioAppServerTransport({ process: native as ChildProcessByStdio<Writable, Readable, null>, stop: () => { native.kill("SIGKILL"); } });
      const client = new AppServerClient(transport);
      children.push({ client, stopped });
      await client.initialize();
      const inventory = await client.request("skills/list", { cwds: [cwd], forceReload: true }) as { data: Array<{ skills: Array<{ name: string; path: string; interface: { displayName: string; iconSmall: string } }>; errors: unknown[] }> };
      expect(inventory.data).toHaveLength(1);
      expect(inventory.data[0].errors).toEqual([]);
      const expectedPaths = overlay.skillPaths;
      expect(inventory.data[0].skills.map(item => item.path).sort()).toEqual(expectedPaths.sort());
      expect(inventory.data[0].skills.map(item => item.name)).not.toContain("unwanted");
      for (const name of ["dependency-heavy", "imagegen"]) {
        const discovered = inventory.data[0].skills.find(item => item.name === name)!;
        expect(discovered.interface.displayName).toBe("Bounded skill");
        const source = name === "imagegen" ? builtin : skill;
        expect(await fs.readFile(discovered.path, "utf8")).toContain(JSON.stringify(path.join(source, "SKILL.md")));
        expect(await fs.readFile(discovered.interface.iconSmall, "utf8")).toContain("<svg");
        expect(await fs.readFile(path.join(source, "assets/icon.svg"), "utf8")).toContain("<svg");
        expect(execFileSync(process.execPath, [path.join(source, "scripts/check.cjs")], { encoding: "utf8" })).toBe("runtime available: Original reference\n");
      }
      client.close();
      await stopped;
      expect(await fs.readFile(stderrPath, "utf8")).not.toMatch(/traversal limit|failed to (walk|scan)/i);
      return overlay;
    };
    const first = await inspect("ordinary");
    await fs.writeFile(path.join(first.codexHome, ".cloudx-conversation.json"), "selection retained");
    await inspect("ordinary"); // exact-session recovery rematerializes the same owned view
    await inspect("ordinary", false); // template refresh
    await inspect("forge-worker"); // Forge uses the same materializer with its own tab binding
    expect(await fs.readFile(path.join(first.codexHome, ".cloudx-conversation.json"), "utf8")).toBe("selection retained");
    await fs.rm(path.join(first.codexHome, "skills"), { recursive: true });
    expect(await fs.readFile(path.join(skill, "node_modules/dependency-0/SKILL.md"), "utf8")).toContain("unwanted");
  } finally {
    for (const child of children) child.client.close();
    await Promise.all(children.map(child => child.stopped));
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it.skipIf(!codex || process.platform !== "linux")("refreshes legacy skills during production startup while preserving the native broker process and conversation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-restore-skills-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const cwd = path.join(root, "workspace");
  const env = { PATH: process.env.PATH!, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: codex! };
  const sources = new CodexStateSources(data, env);
  const catalog = new RulesSkillsCatalogService(data);
  const selected = path.join(catalog.catalogRoot(), "skills", "dependency-heavy");
  const builtin = path.join(home, "skills", ".system", "imagegen");
  const config = loadConfig({
    CLOUDX_DATA_DIR: data, CLOUDX_ALLOWED_ROOTS: root, CLOUDX_LOG_LEVEL: "silent",
    CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9", CLOUDX_TRUSTED_ORIGINS: "http://localhost"
  });
  const socketPath = terminalSocketPath(data);
  const nativeFactory = new NodePtyTerminalProcessFactory();
  let nativeOutput = "";
  const spawnNative = vi.fn(async (...args: Parameters<NodePtyTerminalProcessFactory["spawn"]>) => {
    const terminal = await nativeFactory.spawn(...args);
    terminal.onData(chunk => { nativeOutput += chunk; });
    return terminal;
  });
  const broker = new TerminalBroker(socketPath, { spawn: spawnNative });
  let original: TerminalProcess | undefined;
  let client: AppServerClient | undefined;
  let app: FastifyInstance | undefined;
  let brokerStarted = false;
  try {
    await fs.mkdir(cwd, { recursive: true });
    for (const source of [selected, builtin]) await seedNativeResourceSkill(source);
    const unselected = path.join(catalog.catalogRoot(), "skills", "unselected");
    await seedNativeResourceSkill(unselected);
    for (let offset = 0; offset < 2100; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => fs.mkdir(path.join(selected, "node_modules", `dependency-${offset + index}`))));
    }
    const dependencySkill = path.join(selected, "node_modules", "dependency-0", "SKILL.md");
    await fs.writeFile(dependencySkill, "---\nname: unwanted\ndescription: Dependency owned.\n---\n");
    await fs.writeFile(path.join(home, "config.toml"), 'model = "cloudx-native"\nmodel_provider = "synthetic"\n[model_providers.synthetic]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');
    const template = { id: "selected", name: "Selected", color: "green", ruleIds: [], skillIds: ["dependency-heavy"] };
    await catalog.saveTemplate(template);
    const tab: WorkspaceTab = {
      id: "native-restore", pluginId: "codex-terminal", title: "Preserved native session", cwd, status: "running",
      pluginMetadata: { "rules-skills": { selectedTemplateId: template.id } },
      indicator: { color: "green", label: "Selected", updatedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
    };
    const resolved = (await catalog.resolveFor(tab))!;
    const launch = await materializeCodexTemplate(resolved, env, { dataDir: data, sources, tabId: tab.id, cwd });
    const overlay = launch.overlay!;
    const systemResource = path.join(path.dirname(cloudxSystemSkillFilePath(catalog.catalogRoot(), "create-cloudx-skill")), "references/original.md");
    await fs.mkdir(path.dirname(systemResource));
    await fs.writeFile(systemResource, "Original system reference");
    const sourceSkills = [selected, builtin, unselected, ...overlay.systemSkills.map(skill => path.dirname(cloudxSystemSkillFilePath(catalog.catalogRoot(), skill.id)))];
    const originalInstructions = await Promise.all(sourceSkills.map(source => fs.readFile(path.join(source, "SKILL.md"), "utf8")));
    const bindingPath = path.join(overlay.codexHome, ".cloudx-source.json");
    const binding = await fs.readFile(bindingPath, "utf8");
    for (const file of overlay.skillPaths) {
      const directory = path.dirname(file);
      const [group, id] = path.relative(path.join(overlay.codexHome, "skills"), directory).split(path.sep);
      const source = group === "cloudx" ? selected : group === "cloudx-exceptions" ? builtin : path.dirname(cloudxSystemSkillFilePath(catalog.catalogRoot(), id!));
      await fs.rm(directory, { recursive: true });
      await fs.symlink(source, directory, "dir");
      expect((await fs.lstat(directory)).isSymbolicLink()).toBe(true);
    }

    await broker.start();
    brokerStarted = true;
    const terminalFactory = new DurableTerminalProcessFactory(socketPath, nativeFactory);
    original = await terminalFactory.spawn("/bin/bash", [
      "--noprofile", "--norc", "-c", 'printf "NATIVE_PID=%s\\n" "$$"; exec "$@"', "native-skills", codex!,
      ...CLOUDX_CODEX_CONFIGURATION_ARGS, "app-server", "--listen", "ws://127.0.0.1:0"
    ], { cwd, env: launch.env, cols: 100, rows: 30, sessionId: tab.id });
    await vi.waitFor(() => expect(stripVTControlCharacters(nativeOutput)).toMatch(/listening on: ws:\/\/127\.0\.0\.1:\d+/), { timeout: 5_000 });
    const endpoint = /listening on: (ws:\/\/127\.0\.0\.1:\d+)/.exec(stripVTControlCharacters(nativeOutput))![1]!;
    const pid = Number(/NATIVE_PID=(\d+)/.exec(nativeOutput)![1]);
    const websocket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      websocket.once("open", resolve);
      websocket.once("error", reject);
    });
    client = new AppServerClient(new NativeWebSocketTransport(websocket));
    await client.initialize();
    const conversation = await client.request("thread/start", { cwd, model: "cloudx-native", modelProvider: "synthetic" }) as { thread: { id: string } };
    await client.request("skills/list", { cwds: [cwd], forceReload: true });
    await vi.waitFor(() => expect(nativeOutput).toMatch(/skills scan reached its traversal limit/));
    const beforeRestoreOutput = nativeOutput.length;
    const executionId = randomUUID();
    const receiptPath = path.join(overlay.codexHome, ".cloudx-conversation.json");
    const receipt = JSON.stringify({ version: 2, authority: "selected", tabId: tab.id, executionId, sessionId: conversation.thread.id, cwd });
    await fs.writeFile(receiptPath, receipt);
    const durablePaths = ["sessions", "archived_sessions", "thread-writer-locks", ".tmp/rollout-maintenance.lock"];
    const durableIdentity = await Promise.all(durablePaths.map(async name => {
      const target = path.join(overlay.codexHome, name);
      const stat = await fs.stat(target);
      return { target: await fs.realpath(target), dev: stat.dev, ino: stat.ino };
    }));
    const initialInput = {
      prompt: "Do not replay this work", codexExecutionId: executionId, codexRecovered: false,
      resume: { mode: "session", sessionId: conversation.thread.id }, model: "cloudx-native", reasoningEffort: "max"
    };
    await new SessionStateStore(data).save({ version: 1, activeTabId: tab.id, sessions: [{ tab, initialInput }] });
    original.detach!();
    const producer = await spawnNative.mock.results[0]!.value;
    const write = vi.spyOn(producer, "write");
    const kill = vi.spyOn(producer, "kill");
    const terminate = vi.spyOn(producer, "terminate");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const services = buildServices(config);
    app = await buildServer(config, services);
    const restored = services.sessions.getSession(tab.id);
    expect(services.sessions.getTab(tab.id).status).toBe("running");
    const inventory = await client.request("skills/list", { cwds: [cwd], forceReload: true }) as { data: Array<{ skills: Array<{ name: string; path: string }>; errors: unknown[] }> };
    expect(inventory.data).toHaveLength(1);
    expect(inventory.data[0]!.errors).toEqual([]);
    const store = await services.rulesSkills!.list();
    expect(store.systemSkills.map(skill => skill.id)).toContain("documentation-search");
    const expectedPaths = [
      path.join(overlay.codexHome, "skills/cloudx/dependency-heavy/SKILL.md"),
      ...store.systemSkills.map(skill => path.join(overlay.codexHome, "skills/cloudx-system", skill.id, "SKILL.md")),
      path.join(overlay.codexHome, "skills/cloudx-exceptions/imagegen/SKILL.md")
    ];
    expect(inventory.data[0]!.skills.map(skill => skill.path).sort()).toEqual(expectedPaths.sort());
    for (const name of ["unwanted", "unselected"]) expect(inventory.data[0]!.skills.map(skill => skill.name)).not.toContain(name);
    const entries = await fs.readdir(path.join(overlay.codexHome, "skills"), { recursive: true });
    expect(entries.length).toBeLessThanOrEqual(3 + expectedPaths.length * 7);
    for (const entry of entries) {
      const file = path.join(overlay.codexHome, "skills", entry);
      if ((await fs.lstat(file)).isSymbolicLink()) expect((await fs.stat(file)).isFile()).toBe(true);
    }
    expect(nativeOutput.slice(beforeRestoreOutput)).not.toMatch(/traversal limit|failed to (walk|scan)/i);
    expect(await client.request("thread/read", { threadId: conversation.thread.id })).toMatchObject({ thread: { id: conversation.thread.id } });
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(spawnNative).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    expect(restored.restoreInput?.()).toMatchObject({
      ...initialInput, codexRuntimeContext: { pluginRuntime: { "rules-skills": { personalityTemplate: { source: "tab", template } } } }
    });
    expect((await new SessionStateStore(data).read())!.sessions[0]!.initialInput).toEqual(restored.restoreInput?.());
    expect(await fs.readFile(receiptPath, "utf8")).toBe(receipt);
    expect(await fs.readFile(bindingPath, "utf8")).toBe(binding);
    expect((await fs.readdir(overlay.codexHome)).filter(name => name.startsWith(".cloudx-generated-"))).toEqual([]);
    expect(await Promise.all(durablePaths.map(async name => {
      const target = path.join(overlay.codexHome, name);
      const stat = await fs.stat(target);
      return { target: await fs.realpath(target), dev: stat.dev, ino: stat.ino };
    }))).toEqual(durableIdentity);
    for (const source of [selected, builtin, unselected]) {
      expect(execFileSync(process.execPath, [path.join(source, "scripts/check.cjs")], { encoding: "utf8" })).toBe("runtime available: Original reference\n");
    }
    expect(await fs.readFile(systemResource, "utf8")).toBe("Original system reference");
    expect(await Promise.all(sourceSkills.map(source => fs.readFile(path.join(source, "SKILL.md"), "utf8")))).toEqual(originalInstructions);
    expect(await fs.readFile(dependencySkill, "utf8")).toContain("unwanted");
  } finally {
    client?.close();
    original?.detach?.();
    await app?.close();
    if (brokerStarted) await broker.stop();
    await sources.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(path.dirname(socketPath), { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

async function seedNativeResourceSkill(source: string): Promise<void> {
  await fs.mkdir(path.join(source, "scripts"), { recursive: true });
  await fs.mkdir(path.join(source, "references"));
  await fs.mkdir(path.join(source, "node_modules/runtime"), { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), `---\nname: ${path.basename(source)}\ndescription: Exercise bounded discovery.\n---\nRun scripts/check.cjs and read references/guide.md.\n`);
  await fs.writeFile(path.join(source, "references/guide.md"), "Original reference");
  await fs.writeFile(path.join(source, "node_modules/runtime/index.js"), 'module.exports = "runtime available";');
  await fs.writeFile(path.join(source, "scripts/check.cjs"), 'console.log(require("runtime") + ": " + require("fs").readFileSync(require("path").join(__dirname, "../references/guide.md"), "utf8"));');
}

class NativeWebSocketTransport implements AppServerTransport {
  constructor(private readonly socket: WebSocket) {}
  send(message: Record<string, unknown>): void { this.socket.send(JSON.stringify(message)); }
  onMessage(listener: (message: Record<string, unknown>) => void): void {
    this.socket.on("message", data => listener(JSON.parse(data.toString()) as Record<string, unknown>));
  }
  onError(listener: (error: Error) => void): void {
    this.socket.on("error", listener);
    this.socket.on("close", () => listener(new Error("Native test app-server connection closed.")));
  }
  close(): void { this.socket.close(); }
}
