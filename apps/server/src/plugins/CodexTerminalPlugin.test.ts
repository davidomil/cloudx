import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "smol-toml";

import { CODEX_REASONING_EFFORTS, type TabIndicatorUpdate, type WorkspaceTab } from "@cloudx/shared";
import { PluginSessionNotStartedError } from "@cloudx/plugin-api";

import { CLOUDX_CODEX_DEFAULT_ARGS, CODEX_CLOSE_ON_EXIT_GRACE_MS, CODEX_TERMINAL_ACTIONS, CodexTerminalPlugin, CodexTerminalSession, DEFAULT_TERMINAL_REPLAY_BYTES, TERMINAL_ACTIONS, TerminalShellIntegrationParser, buildCodexLaunchArgs, codexResumeInput, materializeCodexTemplate } from "./CodexTerminalPlugin.js";
import type { TerminalProcess, TerminalProcessFactory } from "../terminal/TerminalProcess.js";
import { CodexStateSources } from "./CodexStateSources.js";

class FakeTerminalProcess implements TerminalProcess {
  written = "";
  killed = false;
  readonly resizes: Array<[cols: number, rows: number]> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void {
    this.exitListener = listener;
    return () => {
      this.exitListener = undefined;
    };
  }

  write(data: string): void {
    this.written += data;
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed = true;
    this.exitListener?.({ exitCode: 130 });
  }

  async terminate(): Promise<void> { this.kill(); }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  exit(exitCode: number): void {
    this.exitListener?.({ exitCode });
  }
}

class CapturingFactory implements TerminalProcessFactory {
  spawns = 0;
  command: string | undefined;
  args: string[] | undefined;
  env: NodeJS.ProcessEnv | undefined;
  process: FakeTerminalProcess | undefined;

  async spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }): Promise<TerminalProcess> {
    this.spawns += 1;
    this.command = command;
    this.args = args;
    this.env = options.env;
    this.process = new FakeTerminalProcess();
    return this.process;
  }
}

const tab: WorkspaceTab = {
  id: "tab-1",
  pluginId: "codex-terminal",
  title: "Test",
  cwd: "/tmp",
  status: "running",
  indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

describe("CodexTerminalPlugin", () => {
  it("waits for the host's prepared conversation before resuming its exact thread", async () => {
    await withProjectTrustFixture(async ({ root, home, factory, plugin }) => {
      vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
      let release!: (id: string) => void;
      const ready = new Promise<string>(resolve => { release = resolve; });
      const prepareCodexSession = vi.fn(async launch => {
        expect(factory.spawns).toBe(0);
        expect(launch).toMatchObject({ tabId: tab.id, cwd: root, command: "/usr/bin/codex" });
        expect(await fs.realpath(path.join(launch.env.CODEX_HOME!, "sessions"))).toBe(path.join(home, "sessions"));
        expect(launch.configurationArgs).toContain("--disable");
        expect(launch.configurationArgs).not.toContain("--yolo");
        expect(launch.configurationArgs).not.toContain("--add-dir");
        return ready;
      });
      const creation = plugin.createSession({
        tab, cwd: root, prepareCodexSession,
        controls: { setTabIndicator: () => undefined, closeTab: () => undefined },
        initialInput: { prompt: "Review the next commit.", model: "gpt-6-astra", reasoningEffort: "max" }
      });
      void creation.catch(() => undefined);
      await vi.waitFor(() => expect(prepareCodexSession).toHaveBeenCalledOnce());
      expect(factory.spawns).toBe(0);
      release("01a08470-d118-7b72-b1df-439e72e5c744");
      await creation;
      expect(factory.args?.at(-1)).toContain("resume 01a08470-d118-7b72-b1df-439e72e5c744 -- 'Review the next commit.'");
      expect(factory.args?.at(-1)).toContain("--model gpt-6-astra");
      expect(factory.args?.at(-1)).toContain('model_reasoning_effort="max"');
    });
  });

  it("preserves an unresolved host conversation error without starting the TUI", async () => {
    await withProjectTrustFixture(async ({ root, factory, plugin }) => {
      const failure = new Error("Conversation process ownership is unresolved.");
      await expect(plugin.createSession({
        tab, cwd: root, prepareCodexSession: async () => { throw failure; },
        controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
      })).rejects.toBe(failure);
      expect(factory.spawns).toBe(0);
    });
  });

  it.each([
    [17, "failed", "Terminal exited with code 17."],
    [0, "completed", "Terminal exited cleanly."]
  ] as const)("retains exit code %s and its detail before status observers subscribe", async (exitCode, status, statusMessage) => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);
    process.exit(exitCode);

    expect(session.snapshot()).toMatchObject({ status, statusMessage });
    const observer = vi.fn();
    session.onStatusChange(observer);
    await session.handleAction("stop", {});
    expect(observer).toHaveBeenCalledWith("stopped", "Terminal was stopped.");
    expect(session.snapshot()).toMatchObject({ status: "stopped", statusMessage: "Terminal was stopped." });
  });

  it.each([0, 1])("retains an owned session after exit code %s until its owner verifies termination", async (exitCode) => {
    await withProjectTrustFixture(async ({ root, factory, plugin }) => {
      const closeTab = vi.fn();
      const session = await plugin.createSession({
        tab: { ...tab, ownerPluginId: "forge" }, cwd: root,
        controls: { setTabIndicator: () => undefined, closeTab }
      });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + CODEX_CLOSE_ON_EXIT_GRACE_MS + 1);
      factory.process!.exit(exitCode);

      expect(closeTab).not.toHaveBeenCalled();
      expect(session.snapshot().status).toBe(exitCode === 0 ? "completed" : "failed");
      const terminate = vi.spyOn(factory.process!, "terminate");
      await expect(session.handleAction("stop", {})).resolves.toEqual({ stopped: true });
      expect(terminate).toHaveBeenCalledOnce();
      expect(session.snapshot().status).toBe("stopped");
      expect(closeTab).not.toHaveBeenCalled();
    });
  });

  it("automatically closes a public Codex session after normal exit", async () => {
    await withProjectTrustFixture(async ({ root, factory, plugin }) => {
      const closeTab = vi.fn();
      await plugin.createSession({ tab, cwd: root, controls: { setTabIndicator: () => undefined, closeTab } });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + CODEX_CLOSE_ON_EXIT_GRACE_MS + 1);
      factory.process!.exit(0);

      expect(closeTab).toHaveBeenCalledExactlyOnceWith("Codex exited cleanly.");
    });
  });

  it("trusts only the authorized project in its overlay and reauthorizes template updates", async () => {
    await withProjectTrustFixture(async ({ root, home, factory, plugin }) => {
      const authorizeProjectTrust = vi.fn(async () => root);
      const original = stringify({ projects: { "/other-project": { trust_level: "untrusted" } } });
      await fs.writeFile(path.join(home, "config.toml"), original);
      const session = await plugin.createSession({ tab, cwd: root, authorizeProjectTrust, controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });
      const configPath = path.join(factory.env!.CODEX_HOME!, "config.toml");
      const expectedProjects = { "/other-project": { trust_level: "untrusted" }, [root]: { trust_level: "trusted" } };
      expect(parse(await fs.readFile(configPath, "utf8")).projects).toEqual(expectedProjects);
      await session.applyRuntimeContext!({});
      expect(authorizeProjectTrust).toHaveBeenCalledTimes(2);
      expect(parse(await fs.readFile(configPath, "utf8")).projects).toEqual(expectedProjects);
      expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(original);
      expect(factory.spawns).toBe(1);
      expect(factory.args?.join(" ")).toContain("--yolo");
      authorizeProjectTrust.mockRejectedValueOnce(new Error("Repository consent was revoked."));
      await expect(session.applyRuntimeContext!({})).rejects.toThrow("Repository consent was revoked.");
      session.stop?.();
    });
  });

  it.each(["untrusted", "invalid-table", "invalid-project", "invalid-trust"])("refuses project trust when source policy is %s", async (policy) => {
    await withProjectTrustFixture(async ({ root, home, factory, plugin }) => {
      const project = policy === "invalid-project" ? "invalid" : { trust_level: policy === "invalid-trust" ? "invalid" : "untrusted" };
      const original = stringify({ projects: policy === "invalid-table" ? "invalid" : { [root]: project } });
      await fs.writeFile(path.join(home, "config.toml"), original);
      const creation = plugin.createSession({ tab, cwd: root, authorizeProjectTrust: async () => root, controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });
      await expect(creation).rejects.toThrow(policy === "untrusted" || policy === "invalid-trust" ? /untrusted/ : /TOML table/);
      await expect(creation).rejects.toBeInstanceOf(PluginSessionNotStartedError);
      expect(factory.spawns).toBe(0);
      expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(original);
    });
  });

  it("identifies a rejected trust grant as a session that never started", async () => {
    await withProjectTrustFixture(async ({ root, factory, plugin }) => {
      const cause = new Error("Repository consent is required.");
      const creation = plugin.createSession({ tab, cwd: root, authorizeProjectTrust: async () => { throw cause; }, controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });
      await expect(creation).rejects.toBeInstanceOf(PluginSessionNotStartedError);
      await expect(creation).rejects.toMatchObject({ message: cause.message, cause });
      expect(factory.spawns).toBe(0);
    });
  });

  it("rejects a trust grant for a different directory before starting Codex", async () => {
    await withProjectTrustFixture(async ({ root, factory, plugin }) => {
      await expect(plugin.createSession({ tab, cwd: root, authorizeProjectTrust: async () => path.dirname(root), controls: { setTabIndicator: () => undefined, closeTab: () => undefined } })).rejects.toThrow(/working directory/);
      expect(factory.spawns).toBe(0);
    });
  });

  it("leaves ordinary and spoofed Codex launches without a project trust grant", async () => {
    await withProjectTrustFixture(async ({ root, factory, plugin }) => {
      const session = await plugin.createSession({
        tab: { ...tab, pluginMetadata: { "forge-workers": { workerId: "spoofed", trustedProjectPath: root } } },
        cwd: root, initialInput: { trustedProjectPath: root, authorizeProjectTrust: root },
        controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
      });
      expect(parse(await fs.readFile(path.join(factory.env!.CODEX_HOME!, "config.toml"), "utf8")).projects).toBeUndefined();
      session.stop?.();
    });
  });

  it("requires an isolated Codex overlay to authorize project trust", async () => {
    await expect(materializeCodexTemplate(undefined, {}, { cwd: "/tmp", authorizeProjectTrust: async () => "/tmp" })).rejects.toThrow(/overlay/);
  });

  it.each(["config", "binding"])("settles a launch deadline while %s open is held, without later writes or spawn", async (stage) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-held-launch-"));
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    await seedImagegenSkill(home);
    const configPath = path.join(await fs.realpath(home), "config.toml");
    const sourceConfig = 'model_provider = "openai"\nmodel_reasoning_effort = "xhigh"\n';
    await fs.writeFile(configPath, sourceConfig);
    vi.stubEnv("CODEX_HOME", home);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    let closed = 0;
    const write = vi.fn();
    const rename = vi.fn(fs.rename);
    const mkdir = vi.fn(fs.mkdir);
    const sources = new CodexStateSources(data, { CODEX_HOME: home }, { fs: { ...fs, rename, mkdir: mkdir as typeof fs.mkdir, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if ((stage === "config" && args[0] === configPath) || (stage === "binding" && String(args[0]).includes(".cloudx-binding-"))) {
        const close = handle.close.bind(handle);
        const writeFile = handle.writeFile.bind(handle);
        handle.close = async () => { closed += 1; await close(); };
        handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => { write(); return writeFile(...values); };
        held = true;
        enter();
        await gate;
        held = false;
      }
      return handle;
    } } });
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, data, sources);
    vi.useFakeTimers();
    let outcome: string | undefined;
    const creation = plugin.createSession({ tab, cwd: root, controls: { setTabIndicator: () => undefined, closeTab: () => undefined } }).then(() => { outcome = "accepted"; }, (error: Error) => { outcome = error.message; });
    try {
      await entered;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toMatch(/cancelled or timed out/);
      expect(held).toBe(true);
      const directories = mkdir.mock.calls.length;
      release();
      await creation;
      await sources.dispose();
      expect(closed).toBe(1);
      expect(write).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(mkdir).toHaveBeenCalledTimes(directories);
      expect(factory.spawns).toBe(0);
      expect(await fs.readFile(configPath, "utf8")).toBe(sourceConfig);
      if (stage === "binding") expect(await fs.readdir(sources.viewPath(tab.id))).toEqual([]);
      else await expect(fs.stat(sources.viewPath(tab.id))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
      await creation;
      await sources.dispose().catch(() => undefined);
      vi.useRealTimers();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, "", " \t", "/explicit/state", " relative/state "])("defaults SQLite state only for absent/blank environment %j at the real factory", async (override) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-shared-factory-"));
    const home = path.join(root, "home", ".codex");
    await seedImagegenSkill(home);
    vi.stubEnv("HOME", path.dirname(home));
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("CODEX_SQLITE_HOME", override);
    const factory = new CapturingFactory();
    const data = path.join(root, "data");
    const sources = new CodexStateSources(data, process.env);
    const open = vi.spyOn(fs, "open");
    try {
      const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, data, sources);
      await plugin.createSession({ tab, cwd: root, controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });
      expect(factory.env?.CODEX_SQLITE_HOME).toBe(override?.trim() ? override : await fs.realpath(home));
      expect(factory.env?.CODEX_HOME).toBe(path.join(data, "codex-launches", tab.id));
      expect(open.mock.calls.some(([file]) => /\.sqlite(?:$|[-_])/u.test(String(file)))).toBe(false);
      expect(await fs.readdir(factory.env!.CODEX_HOME!)).not.toContain("state_5.sqlite");
      for (const name of ["sessions", "archived_sessions", "session_index.jsonl", "thread-writer-locks", ".tmp/rollout-maintenance.lock"]) {
        expect(await fs.realpath(path.join(factory.env!.CODEX_HOME!, name))).toBe(await fs.realpath(path.join(home, name)));
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["shared", "legacy:b2xkLWE"])("rejects removed source selection %s before creating a launch or child", async (sourceId) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-removed-source-"));
    const data = path.join(root, "data");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, data);
    try {
      await expect(plugin.createSession({ tab, cwd: root, controls: { setTabIndicator: () => undefined, closeTab: () => undefined }, initialInput: { resume: { mode: "last", sourceId } } })).rejects.toThrow(/no longer supported/);
      expect(factory.spawns).toBe(0);
      await expect(fs.stat(data)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps shared history and native index replacement across factory restart and isolated runtime updates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-selected-factory-"));
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    await seedImagegenSkill(home);
    await fs.mkdir(path.join(home, "sessions"), { recursive: true });
    await fs.writeFile(path.join(home, "sessions", "private.jsonl"), "private synthetic history\n");
    await fs.writeFile(path.join(home, "state_5.sqlite"), "opaque synthetic bytes: never opened\n");
    await fs.writeFile(path.join(home, "session_index.jsonl"), "home index\n");
    await fs.writeFile(path.join(home, "config.toml"), 'model = "explicit-home-model"\n');
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("CODEX_SQLITE_HOME", "");
    const factory = new CapturingFactory();
    const sources = new CodexStateSources(data, process.env);
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, data, sources);
    const controls = { setTabIndicator: () => undefined, closeTab: () => undefined };
    try {
      const first = await plugin.createSession({ tab, cwd: root, controls, initialInput: { resume: { mode: "session", sessionId: "synthetic-stable-thread" } } });
      const selectedProcess = factory.process;
      const view = factory.env!.CODEX_HOME!;
      expect(factory.env?.CODEX_SQLITE_HOME).toBe(await fs.realpath(home));
      expect(parse(await fs.readFile(path.join(view, "config.toml"), "utf8")).model).toBe("explicit-home-model");
      const binding = await fs.readFile(path.join(view, ".cloudx-source.json"), "utf8");
      const writer = await fs.stat(path.join(view, "thread-writer-locks"));
      const nativeIndex = path.join(view, "native-index.tmp");
      await fs.writeFile(nativeIndex, "native renamed index\n");
      await fs.rename(nativeIndex, path.join(view, "session_index.jsonl"));
      await fs.writeFile(path.join(view, "native.log"), "retain native output\n");
      await plugin.createSession({ tab: { ...tab, id: "tab-2" }, cwd: root, controls });
      const otherView = factory.env!.CODEX_HOME!;
      const otherConfig = await fs.readFile(path.join(otherView, "config.toml"), "utf8");
      expect((await fs.stat(path.join(otherView, "thread-writer-locks"))).ino).toBe(writer.ino);
      const strictLinks = vi.spyOn(fs, "symlink");
      await first.applyRuntimeContext?.({ pluginRuntime: { "rules-skills": { personalityTemplate: { source: "tab", template: { id: "changed", name: "Changed", color: "green", ruleIds: ["one"], skillIds: [] }, rules: [{ id: "one", description: "One", text: "Apply this synthetic rule." }], skills: [] } } } });
      expect(factory.spawns).toBe(2);
      expect(selectedProcess?.killed).toBe(false);
      expect(strictLinks.mock.calls.some(([, destination]) => /(?:sessions|thread-writer-locks|session_index|maintenance)/u.test(String(destination)))).toBe(false);
      expect(await fs.readFile(path.join(otherView, "config.toml"), "utf8")).toBe(otherConfig);
      await plugin.createSession({ tab, cwd: root, controls });
      expect(factory.env?.CODEX_SQLITE_HOME).toBe(await fs.realpath(home));
      expect(await fs.readFile(path.join(view, ".cloudx-source.json"), "utf8")).toBe(binding);
      expect(await fs.readFile(path.join(view, "session_index.jsonl"), "utf8")).toBe("native renamed index\n");
      expect(await fs.readFile(path.join(home, "session_index.jsonl"), "utf8")).toBe("home index\n");
      expect(await fs.readFile(path.join(home, "state_5.sqlite"), "utf8")).toBe("opaque synthetic bytes: never opened\n");
      expect(await fs.readFile(path.join(view, "native.log"), "utf8")).toBe("retain native output\n");
      expect((await fs.stat(path.join(view, "thread-writer-locks"))).ino).toBe(writer.ino);
      expect(factory.spawns).toBe(3);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["../state/./db", "state", "/absolute/state", "~", "~/state"])("normalizes only ordinary relative source sqlite_home %s", async (sqliteHome) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-sqlite-config-"));
    const home = path.join(root, "home");
    await seedImagegenSkill(home);
    const original = `sqlite_home = ${JSON.stringify(sqliteHome)}\n`;
    await fs.writeFile(path.join(home, "config.toml"), original);
    try {
      const launch = await materializeCodexTemplate(undefined, { CODEX_HOME: home, CODEX_SQLITE_HOME: " caller-relative " }, { dataDir: path.join(root, "data"), tabId: "selected" });
      expect(launch.env.CODEX_SQLITE_HOME).toBe(" caller-relative ");
      const expected = path.isAbsolute(sqliteHome) || sqliteHome.startsWith("~") ? sqliteHome : path.resolve(await fs.realpath(home), sqliteHome);
      expect(parse(await fs.readFile(path.join(launch.overlay!.codexHome, "config.toml"), "utf8")).sqlite_home).toBe(expected);
      expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(original);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps the diagnosed binding on spawn failure and rejects wrong durable links before another spawn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-spawn-failure-"));
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    await seedImagegenSkill(home);
    vi.stubEnv("CODEX_HOME", home);
    const factory = new CapturingFactory();
    const spawn = vi.spyOn(factory, "spawn").mockRejectedValue(new Error("synthetic spawn failure"));
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, data);
    const input = { tab, cwd: root, controls: { setTabIndicator: () => undefined, closeTab: () => undefined } };
    try {
      await expect(plugin.createSession(input)).rejects.toThrow("synthetic spawn failure");
      const view = path.join(data, "codex-launches", tab.id);
      expect(JSON.parse(await fs.readFile(path.join(view, ".cloudx-source.json"), "utf8"))).toMatchObject({ version: 1, sourceId: "shared", home: await fs.realpath(home) });
      expect((await fs.readdir(view)).filter((name) => name.startsWith(".cloudx-generated-"))).toEqual([]);
      await fs.unlink(path.join(view, "sessions"));
      await fs.mkdir(path.join(view, "sessions"));
      await expect(plugin.createSession(input)).rejects.toThrow(/durable view/);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("creates simultaneous first views with the same state and coordination inodes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-concurrent-views-"));
    const home = path.join(root, "home");
    await seedImagegenSkill(home);
    const dataDir = path.join(root, "data");
    try {
      const launches = await Promise.all(["one", "two"].map((tabId) => materializeCodexTemplate(undefined, { CODEX_HOME: home }, { dataDir, tabId })));
      for (const name of ["sessions", "archived_sessions", "session_index.jsonl", "thread-writer-locks", ".tmp/rollout-maintenance.lock"]) {
        const stats = await Promise.all(launches.map((launch) => fs.stat(path.join(launch.overlay!.codexHome, name))));
        expect(stats.map((stat) => [stat.dev, stat.ino])).toEqual([[stats[0]!.dev, stats[0]!.ino], [stats[0]!.dev, stats[0]!.ino]]);
      }
      const privateTmp = await Promise.all(launches.map((launch) => fs.stat(path.join(launch.overlay!.codexHome, ".tmp"))));
      expect(privateTmp[0]!.ino).not.toBe(privateTmp[1]!.ino);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["EPERM", "ENOSPC"])("fails strict durable-link creation without copying after %s", async (code) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-link-failure-"));
    const home = path.join(root, "home");
    const dataDir = path.join(root, "data");
    await seedImagegenSkill(home);
    const originalSymlink = fs.symlink.bind(fs);
    const link = vi.spyOn(fs, "symlink").mockImplementation(async (...args) => {
      if (String(args[1]).endsWith("/sessions")) throw Object.assign(new Error("synthetic strict link failure"), { code });
      return originalSymlink(...args);
    });
    const copy = vi.spyOn(fs, "cp");
    try {
      await expect(materializeCodexTemplate(undefined, { CODEX_HOME: home }, { dataDir, tabId: "failure" })).rejects.toMatchObject({ code });
      expect(link).toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(await fs.readdir(path.join(dataDir, "codex-launches", "failure"))).toEqual([".cloudx-source.json"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps real New launch discovery outside 100 and 100000 ordinary-file project trees", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-project-discovery-"));
    const home = path.join(root, "home", ".codex");
    const data = path.join(root, "data");
    await seedImagegenSkill(home);
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("HOME", path.dirname(home));
    vi.stubEnv("CODEX_SQLITE_HOME", "");
    const sources = new CodexStateSources(data, process.env);
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, data, sources);
    try {
      for (const count of [100, 100_000]) {
        const project = path.join(root, `project-${count}`);
        const ordinary = path.join(project, "ordinary");
        await fs.mkdir(ordinary, { recursive: true });
        await fs.mkdir(path.join(project, ".git"));
        const skill = path.join(project, ".agents", "skills", "visible");
        await fs.mkdir(skill, { recursive: true });
        await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: visible\ndescription: Same skill topology.\n---\nSynthetic skill.\n");
        let next = 0;
        await Promise.all(Array.from({ length: 32 }, async () => {
          while (next < count) await fs.writeFile(path.join(ordinary, `file-${next++}`), "");
        }));
        expect(await fs.readdir(ordinary)).toHaveLength(count);
        const readdir = vi.spyOn(fs, "readdir");
        const opendir = vi.spyOn(fs, "opendir");
        await plugin.createSession({ tab: { ...tab, id: `project-${count}` }, cwd: project, controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });
        expect([...readdir.mock.calls, ...opendir.mock.calls].some(([directory]) => String(directory).includes("/ordinary") || String(directory).endsWith("/codex-homes"))).toBe(false);
        expect(await fs.readFile(path.join(factory.env!.CODEX_HOME!, "config.toml"), "utf8")).toContain(await fs.realpath(path.join(skill, "SKILL.md")));
        readdir.mockRestore();
        opendir.mockRestore();
      }
      expect(factory.spawns).toBe(2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it("launches Codex through the user's login shell", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory);

    await plugin.createSession({ tab, cwd: "/tmp", controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });

    expect(factory.command).toBe("/bin/bash");
    expect(factory.args).toEqual(["-lc", `exec /usr/bin/codex ${CLOUDX_CODEX_DEFAULT_ARGS.join(" ")}`]);
  });

  it("launches Codex resume for requested sessions", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory);

    await plugin.createSession({
      tab,
      cwd: "/tmp",
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined },
      initialInput: { resume: { mode: "last", all: true, includeNonInteractive: true } }
    });

    expect(factory.args).toEqual(["-lc", `exec /usr/bin/codex ${CLOUDX_CODEX_DEFAULT_ARGS.join(" ")} resume --last --all --include-non-interactive`]);
  });

  it("quotes Codex resume session names through the login shell", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory);

    await plugin.createSession({
      tab,
      cwd: "/tmp",
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined },
      initialInput: { resume: { mode: "session", sessionId: "release fix thread" } }
    });

    expect(factory.args).toEqual(["-lc", `exec /usr/bin/codex ${CLOUDX_CODEX_DEFAULT_ARGS.join(" ")} resume 'release fix thread'`]);
  });

  it("launches resolved template rules and skills through a Codex home overlay", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-overlay-"));
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-base-codex-home-"));
    vi.stubEnv("CODEX_HOME", codexHome);
    await seedImagegenSkill(codexHome);
    await fs.writeFile(path.join(codexHome, "AGENTS.md"), [
      "Prefer direct answers.",
      "",
      "## CloudX System Rules",
      "",
      "- Stale generated system rule.",
      "",
      "## CloudX Template: Old",
      "",
      "- Stale generated template rule.",
      "",
      "## Local Notes",
      "",
      "Keep local notes."
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(codexHome, "auth.json"), "{\"auth\":\"linked\"}\n", "utf8");
    await fs.writeFile(path.join(codexHome, ".credentials.json"), "{\"mcp\":\"linked\"}\n", "utf8");
    await fs.mkdir(path.join(codexHome, "sessions", "2026", "05", "15"), { recursive: true });
    await fs.writeFile(path.join(codexHome, "sessions", "2026", "05", "15", "rollout-session.jsonl"), "session\n", "utf8");
    await seedSkill(dataDir, "code-review", "Code Review", "Review code.", "Code review skill instructions.");
    await seedSystemRule(dataDir, "documentation-ingest-evidence", "Ingest evidence.", "Download evidence into the documentation archive.");
    await seedSystemSkill(dataDir, "documentation-search", "Documentation Search", "Search documentation.", "Documentation search skill instructions.");
    await fs.mkdir(path.join(dataDir, "rules-skills", "system-skills", "documentation-search", "scripts"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "rules-skills", "system-skills", "documentation-search", "scripts", "cloudx-doc.mjs"), "console.log('helper');\n", "utf8");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, dataDir);

    await plugin.createSession({
      tab,
      cwd: "/tmp",
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined },
      runtimeContext: {
        pluginRuntime: {
          "rules-skills": {
            personalityTemplate: {
              source: "tab",
              template: {
                id: "review",
                name: "Review",
                color: "yellow",
                ruleIds: ["review-carefully"],
                skillIds: ["code-review"]
              },
              rules: [{ id: "review-carefully", description: "Review carefully.", text: "Review carefully." }],
              skills: [{ id: "code-review", name: "Code Review", description: "Review code.", instructions: "Code review skill instructions." }]
            }
          }
        }
      }
    });

    expect(factory.args?.[0]).toBe("-lc");
    expect(factory.args?.[1]).toContain("exec /usr/bin/codex");
    expect(factory.args?.[1]).toContain("--add-dir");
    expect(factory.args?.[1]).not.toContain("Review carefully.");
    expect(factory.args?.[1]).not.toContain("Code review skill instructions.");
    expect(factory.env).toMatchObject({
      CLOUDX_PERSONALITY_TEMPLATE_ID: "review",
      CLOUDX_PERSONALITY_TEMPLATE_NAME: "Review",
      CLOUDX_PERSONALITY_INJECTION: "codex-home-overlay",
      CLOUDX_SYSTEM_RULE_IDS: "documentation-ingest-evidence",
      CLOUDX_ENABLED_RULE_IDS: "review-carefully",
      CLOUDX_ENABLED_SKILL_IDS: "code-review"
    });
    expect(factory.env?.CODEX_HOME).toContain(path.join(dataDir, "codex-launches", "tab-1"));
    expect(factory.env?.CLOUDX_RULES_SKILLS_DIR).toBe(path.join(dataDir, "rules-skills"));
    const overlayConfig = await fs.readFile(path.join(factory.env!.CODEX_HOME!, "config.toml"), "utf8");
    expect(overlayConfig).toContain("skills/cloudx/code-review/SKILL.md");
    expect(overlayConfig).toContain("skills/cloudx-system/create-cloudx-skill/SKILL.md");
    expect(overlayConfig).toContain("skills/cloudx-system/documentation-search/SKILL.md");
    expect(overlayConfig).toContain("skills/cloudx-exceptions/imagegen/SKILL.md");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "skills", "cloudx", "code-review", "SKILL.md"), "utf8")).resolves.toContain("Code review skill instructions.");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "skills", "cloudx-system", "create-cloudx-skill", "SKILL.md"), "utf8")).resolves.toContain("Create CloudX Skill");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "skills", "cloudx-system", "documentation-search", "SKILL.md"), "utf8")).resolves.toContain("Documentation search skill instructions.");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "skills", "cloudx-system", "documentation-search", "scripts", "cloudx-doc.mjs"), "utf8")).resolves.toContain("helper");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "skills", "cloudx-exceptions", "imagegen", "SKILL.md"), "utf8")).resolves.toContain("Image generation instructions.");
    const overlayInstructions = await fs.readFile(path.join(factory.env!.CODEX_HOME!, "AGENTS.override.md"), "utf8");
    expect(overlayInstructions).toContain("Prefer direct answers.");
    expect(overlayInstructions).toContain("Keep local notes.");
    expect(overlayInstructions).toContain("CloudX System Rules");
    expect(overlayInstructions).toContain("Download evidence into the documentation archive.");
    expect(overlayInstructions).toContain("Review carefully.");
    expect(overlayInstructions).not.toContain("Stale generated system rule.");
    expect(overlayInstructions).not.toContain("Stale generated template rule.");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "auth.json"), "utf8")).resolves.toBe("{\"auth\":\"linked\"}\n");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, ".credentials.json"), "utf8")).resolves.toBe("{\"mcp\":\"linked\"}\n");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "sessions", "2026", "05", "15", "rollout-session.jsonl"), "utf8")).resolves.toBe("session\n");
  });

  it.each([undefined, "gpt-5.3-codex"])("projects the default or explicit model %j and valid provider/effort preferences through the factory", async (model) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-default-model-"));
    const codexHome = path.join(root, "base");
    await seedImagegenSkill(codexHome);
    const sourceConfig = [
      ...(model ? [`model = "${model}"`] : []),
      'model_reasoning_effort = "xhigh"',
      'model_provider = "openai"',
      '[tui]',
      'animations = false',
    ].join("\n");
    await fs.writeFile(path.join(codexHome, "config.toml"), sourceConfig);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, path.join(root, "data"));
    try {
      await plugin.createSession({ tab, cwd: root, controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });
      const generated = parse(await fs.readFile(path.join(factory.env!.CODEX_HOME!, "config.toml"), "utf8"));
      expect(generated).toMatchObject({
        ...parse(sourceConfig),
        model: model ?? "gpt-6-astra",
        model_reasoning_effort: "xhigh",
        features: { apps: false, memories: false, plugins: false },
      });
      // CapturingFactory proves projection, not native loading or model availability.
      expect(factory.args?.join(" ")).not.toMatch(/--profile|--model|(?:^| )-m(?: |$)/u);
      await expect(fs.readFile(path.join(codexHome, "config.toml"), "utf8")).resolves.toBe(sourceConfig);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["xhigh", "max"])("launches the selected model with %s effort above inherited Codex preferences", async (reasoningEffort) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-model-selection-"));
    const home = path.join(root, "home");
    await seedImagegenSkill(home);
    const inherited = 'model = "gpt-5.3-codex"\nmodel_reasoning_effort = "medium"\n';
    await fs.writeFile(path.join(home, "config.toml"), inherited);
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, path.join(root, "data"));
    try {
      const session = await plugin.createSession({ tab, cwd: root, controls: { setTabIndicator: () => undefined, closeTab: () => undefined }, initialInput: { model: "gpt-6-astra", reasoningEffort, prompt: "Inspect the assigned work." } });
      expect(factory.spawns).toBe(1);
      expect(factory.command).toBe("/bin/bash");
      expect(factory.args?.[1]).toContain(`--model gpt-6-astra --config 'model_reasoning_effort="${reasoningEffort}"' -- 'Inspect the assigned work.'`);
      expect(parse(await fs.readFile(path.join(factory.env!.CODEX_HOME!, "config.toml"), "utf8"))).toMatchObject({ model: "gpt-5.3-codex", model_reasoning_effort: "medium" });
      expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(inherited);
      session.stop?.();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { model: "" }, { model: "bad model" }, { model: "-model" }, { model: "a".repeat(129) }, { model: "bad\0model" }, { model: "x;command" }, { model: 42 }, { model: null },
    { reasoningEffort: "" }, { reasoningEffort: "MAX" }, { reasoningEffort: "none" }, { reasoningEffort: "bad\0effort" }, { reasoningEffort: 42 }, { reasoningEffort: null }
  ])("rejects invalid model preferences %j before overlay work or spawning", async (initialInput) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-invalid-model-selection-"));
    const data = path.join(root, "data");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, data);
    const authorizeProjectTrust = vi.fn(async () => { throw new Error("Unexpected overlay work"); });
    try {
      const creation = plugin.createSession({ tab, cwd: root, authorizeProjectTrust, controls: { setTabIndicator: () => undefined, closeTab: () => undefined }, initialInput });
      await expect(creation).rejects.toBeInstanceOf(PluginSessionNotStartedError);
      await expect(creation).rejects.toThrow(/Codex (model|reasoning effort)/);
      await expect(creation).rejects.toMatchObject({ cause: expect.any(Error) });
      expect(authorizeProjectTrust).not.toHaveBeenCalled();
      expect(factory.spawns).toBe(0);
      await expect(fs.stat(data)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("preserves a legacy profile selector in projection only, without claiming native acceptance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-profile-projection-"));
    const codexHome = path.join(root, "base");
    await seedImagegenSkill(codexHome);
    const source = 'profile = "project"\n[profiles.project]\nmodel = "gpt-5.3-codex"\n';
    await fs.writeFile(path.join(codexHome, "config.toml"), source);
    try {
      const launch = await materializeCodexTemplate(undefined, { CODEX_HOME: codexHome }, { dataDir: path.join(root, "data"), tabId: "legacy-selector" });
      expect(parse(await fs.readFile(path.join(launch.overlay!.codexHome, "config.toml"), "utf8"))).toMatchObject(parse(source));
      expect(launch.args.join(" ")).not.toContain("--profile");
      expect(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")).toBe(source);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([undefined, "", " \n"])("defaults the model with missing or empty source config %j", async (source) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-empty-model-"));
    const codexHome = path.join(root, "base");
    await seedImagegenSkill(codexHome);
    if (source !== undefined) {
      await fs.writeFile(path.join(codexHome, "config.toml"), source);
    }
    try {
      const launch = await materializeCodexTemplate(undefined, { CODEX_HOME: codexHome }, { dataDir: path.join(root, "data"), tabId: "empty" });
      const config = parse(await fs.readFile(path.join(launch.overlay!.codexHome, "config.toml"), "utf8"));
      expect(config.model).toBe("gpt-6-astra");
      expect(config.model_reasoning_effort).toBeUndefined();
      if (source === undefined) {
        await expect(fs.stat(path.join(codexHome, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readFile(path.join(codexHome, "config.toml"), "utf8")).resolves.toBe(source);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid source TOML before spawning the terminal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-invalid-model-"));
    const codexHome = path.join(root, "base");
    await seedImagegenSkill(codexHome);
    const source = 'model = "unterminated';
    await fs.writeFile(path.join(codexHome, "config.toml"), source);
    vi.stubEnv("CODEX_HOME", codexHome);
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, path.join(root, "data"));
    try {
      await expect(plugin.createSession({ tab, cwd: root, controls: { setTabIndicator: () => undefined, closeTab: () => undefined } })).rejects.toThrow();
      expect(factory.process).toBeUndefined();
      await expect(fs.readFile(path.join(codexHome, "config.toml"), "utf8")).resolves.toBe(source);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("materializes resolved template fields into a Codex home overlay", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-materialized-overlay-"));
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-materialized-base-"));
    await seedImagegenSkill(codexHome);
    await seedSkill(dataDir, "reviewer", "Reviewer", "Reviewer skill.", "Reviewer skill instructions.");
    await seedSkill(dataDir, "testing", "Testing", "Testing skill.", "Testing skill instructions.");
    await fs.writeFile(path.join(codexHome, "config.toml"), [
      "model = \"gpt-5.3-codex\"",
      'model_reasoning_effort = "high"',
      "",
      "# CloudX generated skill enablement for this Codex tab.",
      "",
      "[[skills.config]]",
      'path = "/stale/cloudx-system/documentation-answer/SKILL.md"',
      "enabled = true"
    ].join("\n"), "utf8");
    const launch = await materializeCodexTemplate(
      {
        source: "window",
        template: {
          id: "review",
          name: "Review",
          color: "red",
          ruleIds: ["correctness"],
          skillIds: ["reviewer", "testing"]
        },
        rules: [{ id: "correctness", description: "Find correctness issues.", text: "Find correctness issues." }],
        skills: [
          { id: "reviewer", name: "Reviewer", description: "Reviewer skill.", instructions: "Reviewer skill instructions." },
          { id: "testing", name: "Testing", description: "Testing skill.", instructions: "Testing skill instructions." }
        ]
      },
      { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex", CUSTOM_ENV: "1", CODEX_HOME: codexHome },
      { dataDir, tabId: "tab-99" }
    );

    expect(launch.command).toBe("/usr/bin/codex");
    expect(launch.args).toEqual([...CLOUDX_CODEX_DEFAULT_ARGS, "--add-dir", path.join(dataDir, "rules-skills")]);
    expect(launch.overlay?.codexHome).toBe(path.join(dataDir, "codex-launches", "tab-99"));
    const overlayConfig = await fs.readFile(path.join(launch.overlay!.codexHome, "config.toml"), "utf8");
    expect(overlayConfig).toContain("model = \"gpt-5.3-codex\"");
    expect(parse(overlayConfig).model_reasoning_effort).toBe("high");
    expect(overlayConfig).toContain("skills/cloudx/reviewer/SKILL.md");
    expect(overlayConfig).toContain("skills/cloudx/testing/SKILL.md");
    expect(overlayConfig).not.toContain("documentation-answer");
    expect(overlayConfig).not.toContain("/stale/cloudx-system");
    await expect(fs.readFile(path.join(launch.overlay!.codexHome, "skills", "cloudx", "reviewer", "SKILL.md"), "utf8")).resolves.toContain("Reviewer skill instructions.");
    await expect(fs.readFile(path.join(launch.overlay!.codexHome, "skills", "cloudx", "testing", "SKILL.md"), "utf8")).resolves.toContain("Testing skill instructions.");
    expect(launch.env).toMatchObject({
      CUSTOM_ENV: "1",
      CLOUDX_PERSONALITY_TEMPLATE_ID: "review",
      CLOUDX_PERSONALITY_TEMPLATE_NAME: "Review",
      CLOUDX_PERSONALITY_INJECTION: "codex-home-overlay",
      CLOUDX_ENABLED_RULE_IDS: "correctness",
      CLOUDX_ENABLED_SKILL_IDS: "reviewer,testing"
    });
    expect(launch.voiceSummary).toContain("Review");
  });

  it("can update a materialized Codex home overlay without deleting existing runtime state", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-live-overlay-"));
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-live-base-"));
    await seedImagegenSkill(codexHome);
    await seedSkill(dataDir, "reviewer", "Reviewer", "Reviewer skill.", "Reviewer skill instructions.");
    await seedSkill(dataDir, "tester", "Tester", "Tester skill.", "Tester skill instructions.");
    const first = await materializeCodexTemplate(
      {
        source: "default",
        template: { id: "review", name: "Review", color: "yellow", ruleIds: [], skillIds: ["reviewer"] },
        rules: [],
        skills: [{ id: "reviewer", name: "Reviewer", description: "Reviewer skill.", instructions: "Reviewer skill instructions." }]
      },
      { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex", CODEX_HOME: codexHome },
      { dataDir, tabId: "tab-live" }
    );
    const sessionState = path.join(first.overlay!.codexHome, "sessions", "current.jsonl");
    const firstConfig = parse(await fs.readFile(path.join(first.overlay!.codexHome, "config.toml"), "utf8"));
    expect(firstConfig.model).toBe("gpt-6-astra");
    expect(firstConfig.model_reasoning_effort).toBeUndefined();
    await fs.mkdir(path.dirname(sessionState), { recursive: true });
    await fs.writeFile(sessionState, "keep me\n", "utf8");
    await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.3-codex"\nmodel_reasoning_effort = "xhigh"\n');

    const second = await materializeCodexTemplate(
      {
        source: "default",
        template: { id: "test", name: "Test", color: "green", ruleIds: [], skillIds: ["tester"] },
        rules: [],
        skills: [{ id: "tester", name: "Tester", description: "Tester skill.", instructions: "Tester skill instructions." }]
      },
      { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex", CODEX_HOME: codexHome },
      { dataDir, tabId: "tab-live", resetOverlay: false }
    );

    await expect(fs.readFile(sessionState, "utf8")).resolves.toBe("keep me\n");
    expect(parse(await fs.readFile(path.join(second.overlay!.codexHome, "config.toml"), "utf8"))).toMatchObject({
      model: "gpt-5.3-codex",
      model_reasoning_effort: "xhigh",
      features: { apps: false, memories: false, plugins: false },
    });
    await expect(fs.readFile(path.join(second.overlay!.codexHome, "skills", "cloudx", "tester", "SKILL.md"), "utf8")).resolves.toContain("Tester skill instructions.");
    await expect(fs.stat(path.join(second.overlay!.codexHome, "skills", "cloudx", "reviewer", "SKILL.md"))).rejects.toThrow();
    await expect(fs.readFile(path.join(second.overlay!.codexHome, "config.toml"), "utf8")).resolves.not.toContain("skills/cloudx/reviewer/SKILL.md");
  });

  it("does not create an overlay when no data directory is provided", async () => {
    const launch = await materializeCodexTemplate(undefined, { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex" });

    expect(launch.command).toBe("/usr/bin/codex");
    expect(launch.args).toEqual(CLOUDX_CODEX_DEFAULT_ARGS);
    expect(launch.overlay).toBeUndefined();
    expect(launch.env.CLOUDX_PERSONALITY_TEMPLATE_ID).toBeUndefined();
  });

  it("builds Codex resume args from tab initial input", () => {
    expect(buildCodexLaunchArgs(["--add-dir", "/tmp/rules"], { resume: { mode: "picker", all: true } })).toEqual(["--add-dir", "/tmp/rules", "resume", "--all"]);
    expect(buildCodexLaunchArgs([], { resume: { mode: "session", sessionId: "session-example" } })).toEqual([
      "resume",
      "session-example"
    ]);
    expect(codexResumeInput({ resume: { mode: "new" } })).toBeUndefined();
    expect(() => codexResumeInput({ resume: { mode: "session", sessionId: " " } })).toThrow("Codex resume session id is required.");
    expect(() => codexResumeInput({ resume: { mode: "picker", all: "true" } })).toThrow("Codex resume all must be a boolean.");
    expect(() => codexResumeInput({ resume: { mode: "last", includeNonInteractive: "true" } })).toThrow("Codex resume includeNonInteractive must be a boolean.");
    expect(codexResumeInput({ resume: { mode: "picker" } })).toEqual({ mode: "picker", sessionId: undefined, all: false, includeNonInteractive: false });
    for (const sourceId of ["shared", "legacy:b2xkLWE", "", null]) {
      expect(() => codexResumeInput({ resume: { mode: "picker", sourceId } })).toThrow(/no longer supported/);
    }
  });

  it("passes an initial prompt as one positional argument without interpreting control text", () => {
    const prompt = "Review this change\nKeep `literal` and $(text) intact.";
    expect(buildCodexLaunchArgs(["--yolo"], { prompt })).toEqual(["--yolo", "--", prompt]);
    expect(buildCodexLaunchArgs([], { prompt, resume: { mode: "session", sessionId: "owned-session" } })).toEqual(["resume", "owned-session", "--", prompt]);
    expect(() => buildCodexLaunchArgs([], { prompt: "\0bad" })).toThrow("without null bytes");
    expect(() => buildCodexLaunchArgs([], { prompt: 123 })).toThrow("non-empty string");
    expect(() => buildCodexLaunchArgs([], { prompt, resume: { mode: "last" } })).toThrow("exact session id");
  });

  it.each(CODEX_REASONING_EFFORTS)("puts explicit %s effort and model before resume and prompt arguments", (reasoningEffort) => {
    const base = ["--add-dir", "/tmp/rules"];
    const options = { model: "gpt-6-astra", reasoningEffort };
    const flags = ["--model", "gpt-6-astra", "--config", `model_reasoning_effort="${reasoningEffort}"`];
    expect(buildCodexLaunchArgs(base, options)).toEqual([...base, ...flags]);
    expect(buildCodexLaunchArgs(base, { ...options, prompt: "Do the work" })).toEqual([...base, ...flags, "--", "Do the work"]);
    expect(buildCodexLaunchArgs(base, { ...options, resume: { mode: "last" } })).toEqual([...base, ...flags, "resume", "--last"]);
    expect(buildCodexLaunchArgs(base, { ...options, resume: { mode: "session", sessionId: "owned-session" }, prompt: "Continue" })).toEqual([...base, ...flags, "resume", "owned-session", "--", "Continue"]);
    expect(base).toEqual(["--add-dir", "/tmp/rules"]);
  });

  it("leaves omitted preferences inherited and supports independent model or effort choices", () => {
    expect(buildCodexLaunchArgs(["--yolo"])).toEqual(["--yolo"]);
    expect(buildCodexLaunchArgs([], { model: "provider/model:version-1.0" })).toEqual(["--model", "provider/model:version-1.0"]);
    expect(buildCodexLaunchArgs([], { model: "a".repeat(128) })).toEqual(["--model", "a".repeat(128)]);
    expect(buildCodexLaunchArgs([], { reasoningEffort: "max" })).toEqual(["--config", 'model_reasoning_effort="max"']);
  });

  it("does not acknowledge stop until the terminal process tree is quiescent", async () => {
    const process = new FakeTerminalProcess();
    let finish!: () => void;
    process.terminate = () => new Promise<void>((resolve) => { finish = resolve; });
    const session = new CodexTerminalSession(tab, process);
    let completed = false;
    const stopped = Promise.resolve(session.handleAction("stop", {})).then((result) => { completed = true; return result; });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    await expect(stopped).resolves.toEqual({ stopped: true });
    expect(session.snapshot().status).toBe("stopped");
  });

  it("exposes Codex readiness waiting only on Codex terminal actions", () => {
    expect(CODEX_TERMINAL_ACTIONS.find((action) => action.name === "wait_until_ready")).toMatchObject({
      automationExposed: true,
      automationSafety: "read"
    });
    expect(TERMINAL_ACTIONS.find((action) => action.name === "wait_until_ready")).toBeUndefined();
  });

  it("injects updated rules and skills into a running Codex terminal without stopping it", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-live-update-"));
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-live-home-"));
    vi.stubEnv("CODEX_HOME", codexHome);
    await seedImagegenSkill(codexHome);
    await seedSkill(dataDir, "tester", "Tester", "Tester skill.", "Tester skill instructions.");
    await seedSystemRule(dataDir, "documentation-ingest-evidence", "Ingest evidence.", "Download evidence into the documentation archive.");
    await seedSystemSkill(dataDir, "documentation-search", "Documentation Search", "Search documentation.", "Documentation search skill instructions.");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory, DEFAULT_TERMINAL_REPLAY_BYTES, dataDir);

    const session = await plugin.createSession({ tab, cwd: "/tmp", controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });
    factory.process!.written = "";
    const result = await session.applyRuntimeContext?.({
      pluginRuntime: {
        "rules-skills": {
          personalityTemplate: {
            source: "default",
            template: { id: "test", name: "Test", color: "green", ruleIds: ["be-specific"], skillIds: ["tester"] },
            rules: [{ id: "be-specific", description: "Be specific.", text: "Be specific about changed files." }],
            skills: [{ id: "tester", name: "Tester", description: "Tester skill.", instructions: "Tester skill instructions." }]
          }
        }
      }
    });

    expect(factory.process!.killed).toBe(false);
    expect(result).toMatchObject({ applied: true, templateId: "test", templateName: "Test" });
    expect(factory.process!.written).toContain("\u001b[200~CloudX rules/skills update");
    expect(factory.process!.written).toContain("Be specific about changed files.");
    expect(factory.process!.written).toContain("CloudX system rules:");
    expect(factory.process!.written).toContain("Download evidence into the documentation archive.");
    expect(factory.process!.written).toContain("$tester: Tester - Tester skill.");
    expect(factory.process!.written).toContain("supersedes all earlier CloudX rules/skills update messages");
    expect(factory.process!.written).toContain("ignore CloudX rules or skills from earlier updates when they are not listed below");
    expect(factory.process!.written).toContain("prefer using the listed CloudX skills whenever they fit the user's task");
    expect(factory.process!.written).toContain(path.join(dataDir, "rules-skills", "skills", "tester", "SKILL.md"));
    expect(factory.process!.written).toContain("$create-cloudx-skill");
    expect(factory.process!.written).toContain("$documentation-search");
    expect(factory.process!.written).toContain("before answering any factual, research, recipe, recommendation, troubleshooting, summary, or source-grounded question");
    expect(factory.process!.written.endsWith("\u001b[201~\r")).toBe(true);
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "skills", "cloudx", "tester", "SKILL.md"), "utf8")).resolves.toContain("Tester skill instructions.");
  });

  it("shares locked-down Codex defaults and disables non-CloudX discovered skills", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-defaults-data-"));
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-defaults-home-"));
    const codexHome = path.join(homeDir, ".codex");
    const repoRoot = path.join(homeDir, "repo");
    const cwd = path.join(repoRoot, "packages", "app");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await seedImagegenSkill(codexHome);
    const homeSkill = await seedExternalSkill(path.join(homeDir, ".agents", "skills"), "home-skill");
    const repoSkill = await seedExternalSkill(path.join(repoRoot, ".agents", "skills"), "repo-skill");
    const nestedSkill = await seedExternalSkill(path.join(repoRoot, "packages", ".agents", "skills"), "nested-skill");
    const projectConfigSkill = await seedExternalSkill(path.join(repoRoot, ".codex", "skills"), "project-config-skill");
    await fs.writeFile(path.join(codexHome, "config.toml"), [
      'model = "gpt-5.6"',
      "",
      "[features]",
      "apps = true",
      "memories = true",
      "plugins = true",
      "",
      "[memories]",
      "generate_memories = true",
      "use_memories = true",
      "",
      "[skills.bundled]",
      "enabled = true",
      "",
      "[[skills.config]]",
      'name = "unwanted"',
      "enabled = true"
    ].join("\n"), "utf8");

    const launch = await materializeCodexTemplate(
      undefined,
      { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex", CODEX_HOME: codexHome, HOME: homeDir },
      { dataDir, tabId: "locked-down", cwd }
    );

    expect(launch.args).toEqual([...CLOUDX_CODEX_DEFAULT_ARGS, "--add-dir", path.join(dataDir, "rules-skills")]);
    const config = parse(await fs.readFile(launch.overlay!.configPath, "utf8"));
    expect(config.model).toBe("gpt-5.6");
    expect(config.features).toMatchObject({ apps: false, memories: false, plugins: false });
    expect(config.memories).toMatchObject({ generate_memories: false, use_memories: false });
    expect(config.skills).toMatchObject({ bundled: { enabled: false } });
    const skillConfig = (config.skills as { config: Array<{ path: string; enabled: boolean }> }).config;
    expect(skillConfig).toEqual(expect.arrayContaining([
      { path: await fs.realpath(homeSkill), enabled: false },
      { path: await fs.realpath(repoSkill), enabled: false },
      { path: await fs.realpath(nestedSkill), enabled: false },
      { path: await fs.realpath(projectConfigSkill), enabled: false },
      { path: path.join(launch.overlay!.codexHome, "skills", "cloudx-exceptions", "imagegen", "SKILL.md"), enabled: true }
    ]));
    expect(skillConfig).not.toContainEqual(expect.objectContaining({ name: "unwanted" }));
    await expect(fs.readFile(path.join(launch.overlay!.codexHome, "skills", "cloudx-exceptions", "imagegen", "scripts", "image_gen.py"), "utf8")).resolves.toContain("imagegen helper");
  });

  it("fails clearly when the required imagegen exception is unavailable", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-missing-imagegen-data-"));
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-missing-imagegen-home-"));

    await expect(materializeCodexTemplate(
      undefined,
      { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex", CODEX_HOME: codexHome },
      { dataDir, tabId: "missing-imagegen", cwd: "/tmp" }
    )).rejects.toThrow("Required Codex imagegen skill is missing");
  });
});

describe("CodexTerminalSession", () => {
  it("types text and submits when requested", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);

    session.handleAction("enter_text", { text: "run tests", submit: true });

    expect(process.written).toBe("run tests\r");
  });

  it("keeps the submit key separate for Codex TUI input", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, submitDelayMs: 25 });

      session.handleAction("enter_text", { text: "run tests", submit: true });

      expect(process.written).toBe("run tests");
      await vi.advanceTimersByTimeAsync(25);
      expect(process.written).toBe("run tests\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for initial Codex terminal output to become quiet", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, readyQuietMs: 20 });
      const ready = session.handleAction("wait_until_ready", { timeoutMs: 1000, quietMs: 20 }) as Promise<Record<string, unknown>>;

      process.emitData("Codex ready screen");
      await vi.advanceTimersByTimeAsync(19);
      await expect(Promise.race([ready.then(() => "ready"), Promise.resolve("pending")])).resolves.toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      await expect(ready).resolves.toMatchObject({ ready: true, state: "ready", reason: "Terminal output became quiet." });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks submitted Codex input busy until later output quiets", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, readyQuietMs: 30 });

      process.emitData("loaded");
      await vi.advanceTimersByTimeAsync(30);
      session.handleAction("enter_text", { text: "run tests", submit: true });
      expect(session.snapshot().state?.readiness).toMatchObject({ state: "busy" });

      const ready = session.handleAction("wait_until_ready", { timeoutMs: 1000, quietMs: 30 }) as Promise<Record<string, unknown>>;
      process.emitData("working");
      await vi.advanceTimersByTimeAsync(30);

      await expect(ready).resolves.toMatchObject({ ready: true, state: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out when Codex readiness never arrives", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, readyQuietMs: 10 });
      const ready = session.handleAction("wait_until_ready", { timeoutMs: 50, quietMs: 10 }) as Promise<Record<string, unknown>>;
      const expectation = expect(ready).rejects.toThrow("Timed out waiting for Codex readiness after 50 ms");

      await vi.advanceTimersByTimeAsync(50);

      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending Codex readiness waits through the action context signal", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, readyQuietMs: 10 });
      const controller = new AbortController();
      const ready = session.handleAction("wait_until_ready", { timeoutMs: 1000, quietMs: 10 }, { signal: controller.signal }) as Promise<Record<string, unknown>>;
      const expectation = expect(ready).rejects.toThrow("Wait for Codex readiness was cancelled.");

      controller.abort();

      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels delayed submit keys when the terminal stops", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, submitDelayMs: 25 });

      session.handleAction("enter_text", { text: "run tests", submit: true });
      session.stop();

      await vi.advanceTimersByTimeAsync(25);

      expect(process.killed).toBe(true);
      expect(process.written).toBe("run tests");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels delayed submit keys when the terminal exits", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, submitDelayMs: 25 });

      session.handleAction("enter_text", { text: "run tests", submit: true });
      process.exit(0);

      await vi.advanceTimersByTimeAsync(25);

      expect(process.written).toBe("run tests");
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes trailing line breaks before adding the submit key", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);

    const result = session.handleAction("enter_text", { text: "run tests\n\n", submit: true });

    expect(process.written).toBe("run tests\r");
    expect(result).toEqual({ typed: 9, submitted: true });
  });

  it("maps supported keys to terminal sequences", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);

    session.handleAction("send_key", { key: "ctrl-c" });

    expect(process.written).toBe("\u0003");
  });

  it("keeps recent output within the configured replay buffer", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, replayBytes: 6 });

    process.emitData("alpha");
    process.emitData("beta");

    expect(session.snapshot().recentOutput).toBe("habeta");
  });

  it("keeps terminal replay trimming on UTF-8 character boundaries", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process, undefined, { closeOnExit: false, replayBytes: 1025 });

    process.emitData("🙂".repeat(400));

    expect(session.snapshot().recentOutput).toBe("🙂".repeat(256));
    expect(session.snapshot().recentOutput).not.toContain("\uFFFD");
  });

  it("rejects invalid terminal dimensions before resizing", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);

    expect(session.handleAction("resize", { cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(process.resizes).toEqual([[120, 40]]);
    expect(() => session.handleAction("resize", { cols: 0, rows: 24 })).toThrow("cols must be a positive integer.");
    expect(() => session.handleAction("resize", { cols: 80.5, rows: 24 })).toThrow("cols must be a positive integer.");
    expect(() => session.handleAction("resize", { cols: 80, rows: -1 })).toThrow("rows must be a positive integer.");
    expect(process.resizes).toEqual([[120, 40]]);
  });

  it.each(["exit", "stop", "awaited stop"])("retains terminal replay without resizing the process after %s", async (end) => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process);
    process.emitData("Finished work.\n");
    if (end === "exit") process.exit(0);
    else if (end === "stop") session.stop();
    else await session.handleAction("stop", {});
    const resize = vi.spyOn(process, "resize").mockImplementation(() => { throw new Error("ioctl(2) failed, ENOTTY"); });

    expect(() => session.resize(120, 40)).not.toThrow();
    expect(resize).not.toHaveBeenCalled();
    expect(session.snapshot().recentOutput).toBe("Finished work.\n");
    expect(session.snapshot().status).toBe(end === "exit" ? "completed" : "stopped");
    expect(() => session.resize(0, 40)).toThrow("cols must be a positive integer.");
  });

  it("exposes terminal output through standardized voice context", () => {
    const process = new FakeTerminalProcess();
    const session = new CodexTerminalSession(tab, process, undefined, {
      closeOnExit: false,
      voiceKind: "codex-terminal",
      voiceSummary: "Codex terminal"
    });

    process.emitData("running tests\nall green");

    expect(session.voiceContext()).toMatchObject({
      kind: "codex-terminal",
      cwd: "/tmp",
      status: "running",
      summary: "Codex terminal",
      visibleText: "running tests\nall green",
      recentOutput: "running tests\nall green"
    });
  });

  it("marks successful and failed shell-integrated commands", () => {
    const process = new FakeTerminalProcess();
    const indicators: TabIndicatorUpdate[] = [];
    new CodexTerminalSession(tab, process, {
      setTabIndicator: (indicator) => indicators.push(indicator),
      closeTab: () => undefined
    });

    process.emitData("\u001b]633;D;0\u0007");
    process.emitData("\u001b]133;D;2\u001b\\");

    expect(indicators).toMatchObject([
      { color: "green", label: "Command completed" },
      { color: "red", label: "Command failed" }
    ]);
  });

  it("closes Codex tabs when the Codex process exits", () => {
    const process = new FakeTerminalProcess();
    const closed: string[] = [];
    new CodexTerminalSession(
      tab,
      process,
      {
        setTabIndicator: () => undefined,
        closeTab: (reason) => closed.push(reason ?? "")
      },
      { closeOnExit: true }
    );

    process.exit(1);

    expect(closed).toEqual(["Codex exited with code 1."]);
  });

  it("keeps immediately failed Codex tabs open long enough to show the failure", () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const closed: string[] = [];
      const statuses: Array<{ status: WorkspaceTab["status"]; message?: string }> = [];
      const session = new CodexTerminalSession(
        tab,
        process,
        {
          setTabIndicator: () => undefined,
          closeTab: (reason) => closed.push(reason ?? "")
        },
        { closeOnExit: true, closeOnExitAfterMs: 2000 }
      );
      session.onStatusChange((status, message) => statuses.push({ status, message }));

      process.exit(1);

      expect(closed).toEqual([]);
      expect(statuses).toEqual([{ status: "failed", message: "Codex exited with code 1." }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still closes Codex tabs after the startup grace period", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeTerminalProcess();
      const closed: string[] = [];
      new CodexTerminalSession(
        tab,
        process,
        {
          setTabIndicator: () => undefined,
          closeTab: (reason) => closed.push(reason ?? "")
        },
        { closeOnExit: true, closeOnExitAfterMs: 2000 }
      );

      await vi.advanceTimersByTimeAsync(2000);
      process.exit(0);

      expect(closed).toEqual(["Codex exited cleanly."]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TerminalShellIntegrationParser", () => {
  it("parses chunked OSC command-finished events", () => {
    const parser = new TerminalShellIntegrationParser();

    expect(parser.push("before \u001b]133;D;")).toEqual([]);
    expect(parser.push("1\u0007 after")).toEqual([{ sequence: 133, exitCode: 1 }]);
  });

  it("accepts VS Code OSC 633 command-finished events without exit code", () => {
    const parser = new TerminalShellIntegrationParser();

    expect(parser.push("\u001b]633;D\u001b\\")).toEqual([{ sequence: 633 }]);
  });

  it("recovers after an overlong unterminated OSC sequence", () => {
    const parser = new TerminalShellIntegrationParser();

    expect(parser.push(`\u001b]633;${"x".repeat(5000)}`)).toEqual([]);
    expect(parser.push("\u001b]633;D;0\u0007")).toEqual([{ sequence: 633, exitCode: 0 }]);
  });
});

async function seedSkill(dataDir: string, id: string, name: string, description: string, body: string): Promise<void> {
  const skillDir = path.join(dataDir, "rules-skills", "skills", id);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: "${id}"\ndescription: "${description}"\ncloudx_name: "${name}"\n---\n\n${body}\n`,
    "utf8"
  );
}

async function seedSystemRule(dataDir: string, id: string, description: string, text: string): Promise<void> {
  const ruleDir = path.join(dataDir, "rules-skills", "system-rules");
  await fs.mkdir(ruleDir, { recursive: true });
  await fs.writeFile(path.join(ruleDir, `${id}.md`), `---\nid: ${id}\ndescription: ${description}\n---\n${text}\n`, "utf8");
}

async function seedSystemSkill(dataDir: string, id: string, name: string, description: string, body: string): Promise<void> {
  const skillDir = path.join(dataDir, "rules-skills", "system-skills", id);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: "${id}"\ndescription: "${description}"\ncloudx_name: "${name}"\n---\n\n${body}\n`,
    "utf8"
  );
}

async function seedImagegenSkill(codexHome: string): Promise<void> {
  const skillDir = path.join(codexHome, "skills", ".system", "imagegen");
  await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: imagegen\ndescription: Generate images.\n---\n\nImage generation instructions.\n", "utf8");
  await fs.writeFile(path.join(skillDir, "scripts", "image_gen.py"), "# imagegen helper\n", "utf8");
}

async function withProjectTrustFixture(run: (fixture: { root: string; home: string; factory: CapturingFactory; plugin: CodexTerminalPlugin }) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudx-project."trust-'));
  const home = path.join(root, "codex-home");
  const data = path.join(root, "data");
  await seedImagegenSkill(home);
  vi.stubEnv("CODEX_HOME", home);
  const sources = new CodexStateSources(data, { CODEX_HOME: home });
  const factory = new CapturingFactory();
  try {
    await run({ root, home, factory, plugin: new CodexTerminalPlugin(factory, undefined, data, sources) });
  } finally {
    factory.process?.kill();
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function seedExternalSkill(skillsRoot: string, id: string): Promise<string> {
  const skillDir = path.join(skillsRoot, id);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillPath, `---\nname: ${id}\ndescription: External test skill.\n---\n`, "utf8");
  return skillPath;
}

describe("Codex terminal update recovery", () => {
  it("reattaches the exact tab without preparing a conversation or submitting the initial prompt again", async () => {
    const terminal = new FakeTerminalProcess();
    const detach = vi.fn();
    Object.assign(terminal, { detach });
    const factory = { spawn: vi.fn(), attach: vi.fn(async () => terminal) };
    const prepareCodexSession = vi.fn();
    const plugin = new CodexTerminalPlugin(factory);
    const session = await plugin.restoreSession({
      tab, cwd: tab.cwd, initialInput: { prompt: "Do not repeat this work" }, prepareCodexSession,
      controls: { setTabIndicator: vi.fn(), closeTab: vi.fn() }
    });
    expect(factory.attach).toHaveBeenCalledWith(tab.id);
    expect(factory.spawn).not.toHaveBeenCalled();
    expect(prepareCodexSession).not.toHaveBeenCalled();
    expect(terminal.written).toBe("");
    terminal.emitData("Still working");
    expect(session.snapshot().recentOutput).toBe("Still working");
    session.detach!();
    terminal.emitData("After detach");
    expect(detach).toHaveBeenCalledOnce();
    expect(terminal.killed).toBe(false);
    expect(session.snapshot().recentOutput).toBe("Still working");
  });

  it("keeps broker disconnection visible without closing the tab or reporting terminal exit", () => {
    const terminal = new FakeTerminalProcess();
    let disconnect!: (error: Error) => void;
    Object.assign(terminal, { onDisconnect: (listener: (error: Error) => void) => { disconnect = listener; return () => {}; } });
    const closeTab = vi.fn();
    const session = new CodexTerminalSession(tab, terminal, { closeTab, setTabIndicator: vi.fn() }, { closeOnExit: true });
    disconnect(new Error("Broker connection lost"));
    expect(session.snapshot()).toMatchObject({ status: "failed", statusMessage: "Broker connection lost" });
    expect(closeTab).not.toHaveBeenCalled();
    expect(terminal.killed).toBe(false);
  });

  it("waits for confirmed termination before completing a terminal stop", async () => {
    const terminal = new FakeTerminalProcess();
    let finish!: () => void;
    vi.spyOn(terminal, "terminate").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const session = new CodexTerminalSession(tab, terminal);
    let stopped = false;
    const stopping = session.terminate().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(session.snapshot().status).toBe("stopped");
  });
});
