import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TabIndicatorUpdate, WorkspaceTab } from "@cloudx/shared";

import { CodexTerminalPlugin, CodexTerminalSession, DEFAULT_TERMINAL_REPLAY_BYTES, TerminalShellIntegrationParser, buildCodexLaunchArgs, codexResumeInput, materializeCodexTemplate } from "./CodexTerminalPlugin.js";
import type { TerminalProcess, TerminalProcessFactory } from "../terminal/TerminalProcess.js";

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
  command: string | undefined;
  args: string[] | undefined;
  env: NodeJS.ProcessEnv | undefined;
  process: FakeTerminalProcess | undefined;

  async spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }): Promise<TerminalProcess> {
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("launches Codex through the user's login shell", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const factory = new CapturingFactory();
    const plugin = new CodexTerminalPlugin(factory);

    await plugin.createSession({ tab, cwd: "/tmp", controls: { setTabIndicator: () => undefined, closeTab: () => undefined } });

    expect(factory.command).toBe("/bin/bash");
    expect(factory.args).toEqual(["-lc", "exec /usr/bin/codex"]);
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

    expect(factory.args).toEqual(["-lc", "exec /usr/bin/codex resume --last --all --include-non-interactive"]);
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

    expect(factory.args).toEqual(["-lc", "exec /usr/bin/codex resume 'release fix thread'"]);
  });

  it("launches resolved template rules and skills through a Codex home overlay", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-overlay-"));
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-base-codex-home-"));
    vi.stubEnv("CODEX_HOME", codexHome);
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
    expect(factory.env?.CODEX_HOME).toContain(path.join(dataDir, "codex-homes", "tab-1"));
    expect(factory.env?.CLOUDX_RULES_SKILLS_DIR).toBe(path.join(dataDir, "rules-skills"));
    const overlayConfig = await fs.readFile(path.join(factory.env!.CODEX_HOME!, "config.toml"), "utf8");
    expect(overlayConfig).toContain("skills/cloudx/code-review/SKILL.md");
    expect(overlayConfig).toContain("skills/cloudx-system/create-cloudx-skill/SKILL.md");
    expect(overlayConfig).toContain("skills/cloudx-system/documentation-search/SKILL.md");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "skills", "cloudx", "code-review", "SKILL.md"), "utf8")).resolves.toContain("Code review skill instructions.");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "skills", "cloudx-system", "create-cloudx-skill", "SKILL.md"), "utf8")).resolves.toContain("Create CloudX Skill");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "skills", "cloudx-system", "documentation-search", "SKILL.md"), "utf8")).resolves.toContain("Documentation search skill instructions.");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "skills", "cloudx-system", "documentation-search", "scripts", "cloudx-doc.mjs"), "utf8")).resolves.toContain("helper");
    const overlayInstructions = await fs.readFile(path.join(factory.env!.CODEX_HOME!, "AGENTS.override.md"), "utf8");
    expect(overlayInstructions).toContain("Prefer direct answers.");
    expect(overlayInstructions).toContain("Keep local notes.");
    expect(overlayInstructions).toContain("CloudX System Rules");
    expect(overlayInstructions).toContain("Download evidence into the documentation archive.");
    expect(overlayInstructions).toContain("Review carefully.");
    expect(overlayInstructions).not.toContain("Stale generated system rule.");
    expect(overlayInstructions).not.toContain("Stale generated template rule.");
    await expect(fs.readFile(path.join(factory.env!.CODEX_HOME!, "sessions", "2026", "05", "15", "rollout-session.jsonl"), "utf8")).resolves.toBe("session\n");
  });

  it("materializes resolved template fields into a Codex home overlay", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-materialized-overlay-"));
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-materialized-base-"));
    await seedSkill(dataDir, "reviewer", "Reviewer", "Reviewer skill.", "Reviewer skill instructions.");
    await seedSkill(dataDir, "testing", "Testing", "Testing skill.", "Testing skill instructions.");
    await fs.writeFile(path.join(codexHome, "config.toml"), [
      "model = \"gpt-5.3-codex\"",
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
    expect(launch.args).toEqual(["--add-dir", path.join(dataDir, "rules-skills")]);
    expect(launch.overlay?.codexHome).toBe(path.join(dataDir, "codex-homes", "tab-99"));
    const overlayConfig = await fs.readFile(path.join(launch.overlay!.codexHome, "config.toml"), "utf8");
    expect(overlayConfig).toContain("model = \"gpt-5.3-codex\"");
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
    await fs.mkdir(path.dirname(sessionState), { recursive: true });
    await fs.writeFile(sessionState, "keep me\n", "utf8");

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
    await expect(fs.readFile(path.join(second.overlay!.codexHome, "skills", "cloudx", "tester", "SKILL.md"), "utf8")).resolves.toContain("Tester skill instructions.");
    await expect(fs.stat(path.join(second.overlay!.codexHome, "skills", "cloudx", "reviewer", "SKILL.md"))).rejects.toThrow();
    await expect(fs.readFile(path.join(second.overlay!.codexHome, "config.toml"), "utf8")).resolves.not.toContain("skills/cloudx/reviewer/SKILL.md");
  });

  it("does not create an overlay when no data directory is provided", async () => {
    const launch = await materializeCodexTemplate(undefined, { CLOUDX_ASSISTANT_BIN: "/usr/bin/codex" });

    expect(launch.command).toBe("/usr/bin/codex");
    expect(launch.args).toEqual([]);
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
  });

  it("injects updated rules and skills into a running Codex terminal without stopping it", async () => {
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", "/usr/bin/codex");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-live-update-"));
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-live-home-"));
    vi.stubEnv("CODEX_HOME", codexHome);
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
