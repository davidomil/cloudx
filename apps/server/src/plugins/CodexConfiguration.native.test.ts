import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parse } from "smol-toml";
import type { WorkspaceTab } from "@cloudx/shared";
import type { PluginSession } from "@cloudx/plugin-api";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexSettingsService } from "./CodexSettingsService.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { completedVerificationTurn, readVerificationTranscript } from "./CodexVerificationTranscript.js";

const codex = process.env.CLOUDX_NATIVE_CODEX;
const answer = "The saved native configuration completed this isolated turn.";
const tui = { resume_cwd: "current", notifications: false, animations: false };
const instructions = "Use the instructions file from the original isolated Codex home.";

it.skipIf(!codex).each(["tab", "Forge worker"])("saved configuration reaches a new native %s while an existing session keeps its launch defaults", async role => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: {
      model_verbosity: "low", model_reasoning_summary: "concise", tui
    } });
    expect(selected.configuration?.selectedVersion).toMatch(/^0\.(160\.0|162\.1)$/u);
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ text: { verbosity: "low" }, reasoning: { summary: "concise" } });
    expect(parse(await fs.readFile(fixture.overlayConfigPath, "utf8"))).toMatchObject({ tui });

    await fixture.settings.update({ expectedRevision: selected.revision, nativeOptions: { model_verbosity: "high", model_reasoning_summary: "detailed" } });
    await fixture.completeTurn();
    expect(fixture.requests[1]).toMatchObject({ text: { verbosity: "low" }, reasoning: { summary: "concise" } });

    await fixture.launch(role === "Forge worker");
    const completed = await fixture.completeTurn();
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests[2]).toMatchObject({ text: { verbosity: "high" }, reasoning: { summary: "detailed" } });
    const persisted = parse(await fs.readFile(path.join(fixture.home, "config.toml"), "utf8"));
    expect(persisted).toMatchObject({ model_verbosity: "high", model_reasoning_summary: "detailed", tui });
    expect(persisted).not.toHaveProperty("profile");
    expect(parse(await fs.readFile(fixture.overlayConfigPath, "utf8"))).toMatchObject({ tui });
    if (role === "Forge worker") {
      expect(fixture.requests[2]).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "xhigh" } });
      await expect.poll(async () => JSON.parse(await fs.readFile(fixture.receiptPath, "utf8")), { timeout: 5_000 })
        .toMatchObject({ status: "completed", threadId: completed.threadId, turnId: completed.turnId });
      await fixture.session!.handleAction("finish", { threadId: completed.threadId, turnId: completed.turnId });
      expect(fixture.session!.snapshot().status).toBe("completed");
    }
  } finally { await fixture.dispose(); }
}, 50_000);

it.skipIf(!codex)("rejects schema-listed legacy profile selection before modifying shared configuration", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const original = await fixture.settings.read();
    const configPath = path.join(fixture.home, "config.toml");
    const text = await fs.readFile(configPath, "utf8");
    await expect(fixture.settings.update({ expectedRevision: original.revision, nativeOptions: {
      profiles: { writing: { model_verbosity: "low" } }, profile: "writing"
    } })).rejects.toThrow(/profile|selected Codex/iu);
    expect(await fs.readFile(configPath, "utf8")).toBe(text);
  } finally { await fixture.dispose(); }
}, 15_000);

it.skipIf(!codex)("native profile files override shared defaults and trusted project values override the selected profile", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const original = await fixture.settings.read();
    await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model_verbosity: "low", model_reasoning_summary: "concise" } });
    const profilePath = path.join(fixture.home, "writing.config.toml");
    await fs.writeFile(profilePath, "# Selected native profile\n");
    const profile = await fixture.settings.read(undefined, "writing");
    expect(profile.configuration).toMatchObject({ targetProfile: "writing", sourcePath: profilePath });
    await fixture.settings.update({ expectedRevision: profile.revision, targetProfile: "writing", nativeOptions: { model_verbosity: "high", model_reasoning_summary: "detailed" } });
    const shared = await fixture.settings.read();
    await fixture.settings.update({ expectedRevision: shared.revision, configProfile: "writing" });
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[0]).toMatchObject({ text: { verbosity: "high" }, reasoning: { summary: "detailed" } });

    const currentProfile = await fixture.settings.read(undefined, "writing");
    await fixture.settings.update({ expectedRevision: currentProfile.revision, targetProfile: "writing", nativeOptions: { model_verbosity: "medium" } });
    await fixture.completeTurn();
    expect(fixture.requests[1]).toMatchObject({ text: { verbosity: "high" }, reasoning: { summary: "detailed" } });
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests[2]).toMatchObject({ text: { verbosity: "medium" }, reasoning: { summary: "detailed" } });
    expect(parse(await fs.readFile(path.join(path.dirname(fixture.overlayConfigPath), "writing.config.toml"), "utf8"))).toMatchObject({ model_verbosity: "medium" });

    await fs.mkdir(path.join(fixture.root, ".codex"));
    await fs.writeFile(path.join(fixture.root, ".codex", "config.toml"), 'model_verbosity = "low"\n');
    await fixture.launch(true);
    const completed = await fixture.completeTurn();
    expect(fixture.requests[3]).toMatchObject({ text: { verbosity: "low" }, reasoning: { summary: "detailed", effort: "xhigh" } });
    await expect.poll(async () => JSON.parse(await fs.readFile(fixture.receiptPath, "utf8")), { timeout: 5_000 })
      .toMatchObject({ status: "completed", threadId: completed.threadId, turnId: completed.turnId });
    await fixture.session!.handleAction("finish", { threadId: completed.threadId, turnId: completed.turnId });
    expect(fixture.session!.snapshot().status).toBe("completed");
    expect(parse(await fs.readFile(profilePath, "utf8"))).toMatchObject({ model_verbosity: "medium", model_reasoning_summary: "detailed" });
    expect((await fixture.settings.read()).configuration!.values.model_verbosity).toBe("low");
  } finally { await fixture.dispose(); }
}, 60_000);

it.skipIf(!codex).each(["tab", "Forge worker"])("relative model catalog and instructions paths survive save validation and a native %s launch", async role => {
  const fixture = await NativeConfigurationSession.create({ relativePaths: true });
  try {
    const original = await fixture.settings.read();
    await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model_verbosity: "high", model_reasoning_summary: "detailed" } });
    const source = await fs.readFile(path.join(fixture.home, "config.toml"), "utf8");
    expect(source).toContain('model_catalog_json = "models.json"');
    expect(source).toContain('model_instructions_file = "instructions.md"');
    await fixture.launch(role === "Forge worker");
    const completed = await fixture.completeTurn();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ text: { verbosity: "high" }, reasoning: { summary: "detailed" } });
    expect(JSON.stringify(fixture.requests[0])).toContain(instructions);
    expect(parse(await fs.readFile(fixture.overlayConfigPath, "utf8"))).toMatchObject({
      model_catalog_json: path.join(fixture.home, "models.json"), model_instructions_file: path.join(fixture.home, "instructions.md")
    });
    if (role === "Forge worker") {
      await expect.poll(async () => JSON.parse(await fs.readFile(fixture.receiptPath, "utf8")), { timeout: 5_000 })
        .toMatchObject({ status: "completed", threadId: completed.threadId, turnId: completed.turnId });
      await fixture.session!.handleAction("finish", { threadId: completed.threadId, turnId: completed.turnId });
      expect(fixture.session!.snapshot().status).toBe("completed");
    }
    expect(await fs.readFile(path.join(fixture.home, "config.toml"), "utf8")).toBe(source);
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex)("rejects reasoning effort missing from the selected native model capabilities without changing the source", async () => {
  const fixture = await NativeConfigurationSession.create();
  try {
    const original = await fixture.settings.read();
    const selected = await fixture.settings.update({ expectedRevision: original.revision, nativeOptions: { model_reasoning_effort: "low" } });
    expect(selected.configuration!.values.model_reasoning_effort).toBe("low");
    const configPath = path.join(fixture.home, "config.toml");
    const text = await fs.readFile(configPath, "utf8");
    await expect(fixture.settings.update({ expectedRevision: selected.revision, nativeOptions: { model_reasoning_effort: "banana" } }))
      .rejects.toThrow("Selected model does not advertise the chosen reasoning effort.");
    await expect(fixture.settings.update({ expectedRevision: selected.revision, reasoningEffort: "none" }))
      .rejects.toThrow("Selected model does not advertise the chosen reasoning effort.");
    expect(await fs.readFile(configPath, "utf8")).toBe(text);
  } finally { await fixture.dispose(); }
}, 15_000);

interface ConfigurationRequest {
  text?: { verbosity?: string };
  reasoning?: { summary?: string };
}

class NativeConfigurationSession {
  readonly home: string;
  readonly data: string;
  readonly sources: CodexStateSources;
  readonly settings: CodexSettingsService;
  readonly recovery: CodexConversationRecovery;
  readonly receiptPath: string;
  readonly overlayConfigPath: string;
  readonly requests: ConfigurationRequest[] = [];
  session?: PluginSession;
  private readonly env: NodeJS.ProcessEnv;
  private readonly provider;

  private constructor(readonly root: string) {
    this.home = path.join(root, "home");
    this.data = path.join(root, "data");
    this.env = { PATH: process.env.PATH, HOME: this.home, CODEX_HOME: this.home, CLOUDX_ASSISTANT_BIN: codex, SHELL: "/bin/sh", TERM: "xterm-256color" };
    this.sources = new CodexStateSources(this.data, this.env);
    this.settings = new CodexSettingsService(this.sources, this.env);
    this.recovery = new CodexConversationRecovery(this.sources.viewPath("configuration"));
    this.receiptPath = path.join(root, "turn.json");
    this.overlayConfigPath = path.join(this.sources.viewPath("configuration"), "config.toml");
    this.provider = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const input = JSON.parse(body);
        const title = Boolean(input.text?.format?.schema?.properties?.title);
        if (!title) this.requests.push(input as ConfigurationRequest);
        const text = title ? '{"title":"Native configuration validation"}' : answer;
        const item = { type: "message", id: "msg_configuration", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id: "resp_configuration", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
          { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: "resp_configuration", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
  }

  static async create({ relativePaths = false }: { relativePaths?: boolean } = {}) {
    expect(path.isAbsolute(codex!)).toBe(true);
    const fixture = new NativeConfigurationSession(await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-configuration-")));
    try {
      await new Promise<void>(resolve => fixture.provider.listen(0, "127.0.0.1", resolve));
      const port = (fixture.provider.address() as { port: number }).port;
      await fs.mkdir(fixture.home, { mode: 0o700 });
      const catalogPath = path.join(fixture.home, "models.json");
      if (relativePaths) await fs.writeFile(path.join(fixture.home, "instructions.md"), instructions);
      await fs.writeFile(catalogPath, JSON.stringify({ models: [{
        slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", default_reasoning_level: "low",
        supported_reasoning_levels: ["low", "xhigh"].map(effort => ({ effort, description: effort })),
        shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
        model_messages: { instructions_template: "Respond using the isolated native test provider." },
        support_verbosity: true, default_verbosity: "medium", supports_reasoning_summaries: true,
        supports_reasoning_summary_parameter: true, truncation_policy: { mode: "tokens", limit: 10_000 }, experimental_supported_tools: []
      }] }));
      await fs.writeFile(path.join(fixture.home, "config.toml"), [
        '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
        'model = "gpt-6.1-sol"', `model_catalog_json = ${JSON.stringify(relativePaths ? "models.json" : catalogPath)}`,
        ...(relativePaths ? ['model_instructions_file = "instructions.md"'] : []),
        'model_provider = "cloudx-native"', 'check_for_update_on_startup = false',
        '[model_providers.cloudx-native]', 'name = "CloudX native configuration test"',
        `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
        `[projects.${JSON.stringify(fixture.root)}]`, 'trust_level = "trusted"', ''
      ].join("\n"));
      return fixture;
    } catch (error) { await fixture.dispose(); throw error; }
  }

  async launch(forge = false) {
    await this.session?.terminate?.();
    const tab: WorkspaceTab = { id: "configuration", pluginId: "codex-terminal", ...(forge ? { ownerPluginId: "forge" } : {}), title: "Native configuration", cwd: this.root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "", updatedAt: "" } };
    this.session = await new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, this.data, this.sources, this.env).createSession({
      tab, cwd: this.root,
      ...(forge ? { initialInput: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" }, agentTurn: { workerId: "native-configuration", attemptId: "native-configuration-attempt", receiptPath: this.receiptPath } } : {}),
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    this.session.onData!(chunk => { if (chunk.includes("\u001b[6n")) this.session!.write!("\u001b[1;1R"); });
    await expect.poll(() => this.recovery.read()?.sessionId ?? this.session?.snapshot().recentOutput, { timeout: 15_000 }).toMatch(/^[a-f0-9-]{36}$/u);
    await this.session.handleAction("wait_until_ready", { timeoutMs: 10_000 });
  }

  async completeTurn() {
    const threadId = this.recovery.read()!.sessionId;
    const firstNewEvent = (await readVerificationTranscript(this.recovery.read()?.transcriptPath)).length;
    await this.session!.handleAction("enter_text", { text: "Verify the saved native configuration.", submit: true });
    let completed: ReturnType<typeof completedVerificationTurn>;
    await expect.poll(async () => {
      completed = completedVerificationTurn(await readVerificationTranscript(this.recovery.read()?.transcriptPath), firstNewEvent, threadId, answer);
      return completed;
    }, { timeout: 10_000 }).toMatchObject({ threadId, turnId: expect.any(String) });
    await this.session!.handleAction("wait_until_ready", { timeoutMs: 10_000 });
    return completed!;
  }

  async dispose() {
    try { await this.session?.terminate?.(); }
    finally {
      this.provider.closeAllConnections();
      await new Promise<void>(resolve => this.provider.close(() => resolve()));
      await this.sources.dispose();
      await fs.rm(this.root, { recursive: true, force: true });
    }
  }
}
