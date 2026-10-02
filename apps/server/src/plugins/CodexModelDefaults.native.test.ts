import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { parse } from "smol-toml";
import { DEFAULT_CODEX_MODEL, type WorkspaceTab } from "@cloudx/shared";
import type { PluginSession } from "@cloudx/plugin-api";
import { forgeConfigFields } from "../forge/ForgeSettingsService.js";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { completedVerificationTurn, readVerificationTranscript } from "./CodexVerificationTranscript.js";

const codex = process.env.CLOUDX_NATIVE_CODEX;
const answer = "The selected native model completed this isolated turn.";
const unavailable = `${DEFAULT_CODEX_MODEL} is unavailable for this account.`;

// Opt in with the supported binary; credentials and external model services are never used.
it.skipIf(!codex)("sends the ordinary application default to the native provider without imposing a service tier", async () => {
  const fixture = await NativeModelSession.create();
  try {
    await fixture.launch();
    expect(parse(await fs.readFile(path.join(fixture.sources.viewPath("model"), "config.toml"), "utf8"))).toMatchObject({ model: DEFAULT_CODEX_MODEL });
    const completed = await fixture.completeTurn();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ model: "gpt-6.1-sol" });
    expect(fixture.requests[0]).not.toHaveProperty("service_tier");
    if (process.env.CLOUDX_NATIVE_TERMINAL_CAPTURE) {
      await fs.writeFile(process.env.CLOUDX_NATIVE_TERMINAL_CAPTURE, fixture.output);
      await fs.writeFile(`${process.env.CLOUDX_NATIVE_TERMINAL_CAPTURE}.json`, JSON.stringify({
        requests: fixture.requests.map(({ model, reasoning, service_tier }) => ({ model, reasoning, service_tier })),
        context: { model: completed.context.model, effort: completed.context.effort, collaboration: completed.context.collaboration_mode }
      }, null, 2));
    }
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex).each(["worker", "review"])("sends the Forge %s default model and effort through the real bridge", async role => {
  const defaults = Object.fromEntries(forgeConfigFields().map(field => [field.key, field.defaultValue]));
  const fixture = await NativeModelSession.create();
  try {
    const model = defaults[`${role}Model`];
    const reasoningEffort = defaults[`${role}ReasoningEffort`];
    expect(model).toBe("gpt-6.1-sol");
    expect(reasoningEffort).toBe(role === "worker" ? "xhigh" : "max");
    await fixture.launch({ model, reasoningEffort }, true);
    const completed = await fixture.completeTurn();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ model: DEFAULT_CODEX_MODEL, reasoning: { effort: reasoningEffort } });
    await expect.poll(async () => JSON.parse(await fs.readFile(fixture.receiptPath, "utf8")), { timeout: 5_000 }).toMatchObject({ status: "completed", threadId: completed.threadId, turnId: completed.turnId });
    await fixture.session!.handleAction("finish", { threadId: completed.threadId, turnId: completed.turnId });
    expect(fixture.session!.snapshot().status).toBe("completed");
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex).each(["global", "session"])("preserves %s model, effort and priority tier across restart and exact conversation resume", async scope => {
  const preferences = ['model = "gpt-6-astra"', 'model_reasoning_effort = "high"', 'service_tier = "priority"'];
  const fixture = await NativeModelSession.create({ preferences });
  try {
    const choice = scope === "session" ? { model: "gpt-6-sol", reasoningEffort: "medium" } : undefined;
    await fixture.launch(choice);
    const first = await fixture.completeTurn();
    const saved = fixture.session!.restoreInput!()!;
    expect(saved).toMatchObject({ ...choice, resume: { mode: "session", sessionId: first.threadId } });
    await fixture.launch(saved);
    const resumed = await fixture.completeTurn();
    expect(resumed.threadId).toBe(first.threadId);
    expect(resumed.turnId).not.toBe(first.turnId);
    expect(fixture.requests).toHaveLength(2);
    for (const request of fixture.requests) expect(request).toMatchObject({ model: choice?.model ?? "gpt-6-astra", reasoning: { effort: choice?.reasoningEffort ?? "high" }, service_tier: "priority" });
    expect(parse(await fs.readFile(path.join(fixture.home, "config.toml"), "utf8"))).toMatchObject({ model: "gpt-6-astra", model_reasoning_effort: "high", service_tier: "priority" });
  } finally { await fixture.dispose(); }
}, 40_000);

it.skipIf(!codex)("uses the advertised GPT-6.1 Sol reasoning default and explicit priority tier from native model metadata", async () => {
  const fixture = await NativeModelSession.create({ preferences: ['service_tier = "priority"'], advertiseNewModel: true });
  try {
    await fixture.launch();
    await fixture.completeTurn();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "low" }, service_tier: "priority" });
  } finally { await fixture.dispose(); }
}, 30_000);

it.skipIf(!codex)("keeps a native model-access denial visible without substituting another model", async () => {
  const fixture = await NativeModelSession.create({ deny: true });
  try {
    await fixture.launch();
    await fixture.session!.handleAction("enter_text", { text: "Check access to the configured model.", submit: true });
    await expect.poll(() => stripVTControlCharacters(fixture.output).replace(/\s+/gu, ""), { timeout: 10_000 }).toContain(unavailable.replace(/\s+/gu, ""));
    await fixture.session!.handleAction("wait_until_ready", { timeoutMs: 10_000 });
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect([...new Set(fixture.requests.map(request => request.model))]).toEqual([DEFAULT_CODEX_MODEL]);
    expect(fixture.session!.hasExited!()).toBe(false);
  } finally { await fixture.dispose(); }
}, 30_000);

interface ModelRequest {
  model: string;
  reasoning?: { effort?: string };
  service_tier?: string;
}

class NativeModelSession {
  readonly home: string;
  readonly data: string;
  readonly sources: CodexStateSources;
  readonly recovery: CodexConversationRecovery;
  readonly receiptPath: string;
  readonly requests: ModelRequest[] = [];
  session?: PluginSession;
  output = "";
  private readonly provider;

  private constructor(readonly root: string, deny: boolean) {
    this.home = path.join(root, "home");
    this.data = path.join(root, "data");
    this.sources = new CodexStateSources(this.data, { CODEX_HOME: this.home });
    this.recovery = new CodexConversationRecovery(this.sources.viewPath("model"));
    this.receiptPath = path.join(root, "turn.json");
    this.provider = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const input = JSON.parse(body);
        const title = Boolean(input.text?.format?.schema?.properties?.title);
        if (!title) this.requests.push(input as ModelRequest);
        if (deny && !title) {
          response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", code: "model_not_found", message: unavailable } }));
          return;
        }
        const text = title ? '{"title":"Native model validation"}' : answer;
        const item = { type: "message", id: "msg_model", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id: "resp_model", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
          { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: "resp_model", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
  }

  static async create({ preferences = [], deny = false, advertiseNewModel = false }: { preferences?: string[]; deny?: boolean; advertiseNewModel?: boolean } = {}) {
    expect(path.isAbsolute(codex!)).toBe(true);
    const fixture = new NativeModelSession(await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-model-")), deny);
    try {
      await new Promise<void>(resolve => fixture.provider.listen(0, "127.0.0.1", resolve));
      const port = (fixture.provider.address() as { port: number }).port;
      await fs.mkdir(fixture.home, { mode: 0o700 });
      const catalogPath = path.join(fixture.home, "native-test-models.json");
      if (advertiseNewModel) await fs.writeFile(catalogPath, JSON.stringify({ models: [{
        // Minimal synthetic ModelInfo: capabilities match upstream models-manager/models.json,
        // while using a local Responses provider makes no claim about account entitlement.
        slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", default_reasoning_level: "low",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => ({ effort, description: effort })),
        shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
        model_messages: { instructions_template: "Respond using the isolated native test provider." },
        support_verbosity: false, truncation_policy: { mode: "tokens", limit: 10_000 }, experimental_supported_tools: [],
        service_tiers: [{ id: "priority", name: "Fast", description: "Synthetic priority tier" }]
      }] }));
      await fs.writeFile(path.join(fixture.home, "config.toml"), [
        '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
        ...preferences,
        ...(advertiseNewModel ? [`model_catalog_json = ${JSON.stringify(catalogPath)}`] : []),
        'model_provider = "cloudx-native"', 'check_for_update_on_startup = false',
        '[model_providers.cloudx-native]', 'name = "CloudX native model test"',
        `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
        `[projects.${JSON.stringify(fixture.root)}]`, 'trust_level = "trusted"', ''
      ].join("\n"));
      return fixture;
    } catch (error) { await fixture.dispose(); throw error; }
  }

  async launch(initialInput?: Record<string, unknown>, forge = false) {
    await this.session?.terminate?.();
    this.output = "";
    const tab: WorkspaceTab = { id: "model", pluginId: "codex-terminal", ...(forge ? { ownerPluginId: "forge" } : {}), title: "Native model", cwd: this.root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "", updatedAt: "" } };
    const env = { PATH: process.env.PATH, HOME: this.home, CODEX_HOME: this.home, CLOUDX_ASSISTANT_BIN: codex, SHELL: "/bin/sh", TERM: "xterm-256color" };
    this.session = await new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, this.data, this.sources, env).createSession({
      tab, cwd: this.root, initialInput,
      ...(forge ? { codexTurn: { workerId: "native-model", attemptId: "native-model-attempt", receiptPath: this.receiptPath } } : {}),
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    this.session.onData!(chunk => {
      this.output = (this.output + chunk).slice(-256_000);
      if (chunk.includes("\u001b[6n")) this.session!.write!("\u001b[1;1R");
    });
    await expect.poll(() => this.recovery.read()?.sessionId ?? this.output, { timeout: 15_000 }).toMatch(/^[a-f0-9-]{36}$/u);
    await this.session.handleAction("wait_until_ready", { timeoutMs: 10_000 });
  }

  async completeTurn() {
    const threadId = this.recovery.read()!.sessionId;
    const firstNewEvent = (await readVerificationTranscript(this.recovery.read()?.transcriptPath)).length;
    await this.session!.handleAction("enter_text", { text: "Verify the configured model preferences.", submit: true });
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
