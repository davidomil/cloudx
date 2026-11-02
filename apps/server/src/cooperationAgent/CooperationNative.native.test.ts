import { createServer } from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { expect, it } from "vitest";
import type { PluginSession } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";

import { AgentAccountStore } from "../agents/AgentAccountStore.js";
import { ClaudeSettingsService } from "../agents/claude/ClaudeSettingsService.js";
import { CodexTerminalPlugin } from "../plugins/CodexTerminalPlugin.js";
import { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { AgentCooperationContext } from "./AgentCooperationContext.js";
import { NativeAgentFeedbackPort } from "./NativeAgentFeedbackPort.js";
import { COOPERATION_RULES, COOPERATION_SKILLS } from "./cooperationContributions.js";

const claude = process.env.CLOUDX_NATIVE_CLAUDE;
const visible = (value = "") => stripVTControlCharacters(value).replace(/\s+/gu, "");

// Executes the production TUI launcher and normal MCP child against a local
// synthetic provider. No personal credentials or external model service.
it.skipIf(!claude).each(["default", "hold", "refuse"] as const)("native Claude preserves its original session and composer with %s inbound policy", async inbound => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-coop-native-claude-"));
  const dataDir = path.join(root, "data");
  const home = path.join(root, "home");
  const requests: Array<Record<string, unknown>> = [];
  let imagePath: string | undefined;
  let requestedImage = false;
  let receivedImage = false;
  let nativeStatePath: string | undefined;
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("count_tokens")) { response.end('{"input_tokens":10}'); return; }
    if (!request.url?.includes("/messages")) { response.end("{}"); return; }
    const input = JSON.parse(raw);
    requests.push(input);
    const latest = input.messages?.at(-1);
    if (latest?.role === "user" && Array.isArray(latest.content) && latest.content.some((block: { type: string; tool_use_id?: string }) => block.type === "tool_result" && block.tool_use_id === "image-read"))
      receivedImage = JSON.stringify(latest.content).includes('"type":"image"');
    const readImage = Boolean(imagePath && !requestedImage && JSON.stringify(latest).includes("event-image"));
    if (readImage) requestedImage = true;
    const text = JSON.stringify(input.messages).includes("CLOUDX_COOPERATION_EVENTS:") ? "Synthetic board feedback answer" : "Synthetic board initial answer";
    response.setHeader("content-type", "text/event-stream");
    const emit = (type: string, value: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    emit("message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } });
    emit("content_block_start", { type: "content_block_start", index: 0, content_block: readImage ? { type: "tool_use", id: "image-read", name: "Read", input: {} } : { type: "text", text: "" } });
    emit("content_block_delta", { type: "content_block_delta", index: 0, delta: readImage
      ? { type: "input_json_delta", partial_json: JSON.stringify({ file_path: imagePath }) }
      : { type: "text_delta", text } });
    emit("content_block_stop", { type: "content_block_stop", index: 0 });
    emit("message_delta", { type: "message_delta", delta: { stop_reason: readImage ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    emit("message_stop", { type: "message_stop" });
    response.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  let session: PluginSession | undefined;
  let native: NativeAgentFeedbackPort | undefined;
  try {
    await fs.mkdir(home, { recursive: true });
    if (inbound !== "default") {
      await fs.mkdir(path.join(home, ".claude"));
      await fs.writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ crossSessionInbound: inbound }));
    }
    const env = {
      PATH: process.env.PATH, HOME: home, SHELL: "/bin/sh", TERM: "xterm-256color", CLOUDX_CLAUDE_BIN: claude,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1"
    };
    const accounts = new AgentAccountStore(dataDir, env);
    const account = await accounts.create({ providerId: "claude", label: "Local synthetic fixture", kind: "api-key", apiKey: "sk-ant-synthetic-local-only" });
    const settings = new ClaudeSettingsService(dataDir, () => path.join(home, ".claude"), env);
    const catalog = new RulesSkillsCatalogService(dataDir);
    for (const rule of COOPERATION_RULES) await catalog.saveSystemRule(rule);
    for (const skill of COOPERATION_SKILLS) await catalog.saveSystemSkill(skill);
    const tab: WorkspaceTab = { id: "native-claude", pluginId: "codex-terminal", title: "Native cooperation", cwd: root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "", updatedAt: "" } };
    let executionId: string | undefined;
    const contexts = new AgentCooperationContext({ dataDir, endpoint: () => "http://127.0.0.1:1/api/cooperation/agent", binding: () => ({ tabId: tab.id, boardId: "board-native", assignmentGeneration: 1, providerId: "claude", executionId }) });
    const runtimeContext = await contexts.augmentRuntimeContext(tab);
    const plugin = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, dataDir, undefined, env, {
      accounts, claudeSettings: { read: async () => ({ ...await settings.read(), permissionMode: "acceptEdits", autoTrustWorkspace: true }) }
    });
    session = await plugin.createSession({
      tab, cwd: root, runtimeContext, initialInput: { agent: { providerId: "claude", accountId: account.id }, model: "claude-sonnet-4-5", prompt: "Begin this synthetic board session." },
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined, setRestoreInput: async input => {
        executionId = input.codexExecutionId as string;
        await contexts.prepare(tab.id);
      } }
    });
    const nativePath = await contexts.nativeReceiptPath(tab.id);
    nativeStatePath = nativePath;
    const terminal = session;
    session.onData?.(chunk => { if (chunk.includes("\u001b[6n")) terminal.write?.("\u001b[1;1R"); });
    let acceptedSyntheticKey = false;
    await expect.poll(async () => {
      const output = terminal.snapshot().recentOutput ?? "";
      if (!acceptedSyntheticKey && visible(output).includes("DoyouwanttousethisAPIkey?")) {
        acceptedSyntheticKey = true;
        terminal.write?.("\u001b[A\r");
      }
      return visible(output);
    }, { timeout: 20000 }).toContain("Syntheticboardinitialanswer");
    const identityPath = path.join(dataDir, "claude-launches", tab.id, ".cloudx-conversation.json");
    const originalIdentity = JSON.parse(await fs.readFile(identityPath, "utf8"));
    const draft = "USER_DRAFT_MUST_SURVIVE";
    terminal.write?.(draft);
    native = new NativeAgentFeedbackPort({ contexts });
    await expect.poll(async () => {
      try { return JSON.parse(await fs.readFile(nativePath, "utf8")).status; }
      catch { return terminal.snapshot().recentOutput; }
    }, { timeout: 10000 }).toBe("ready");
    const delivery = await native.deliver({ recipientTabId: tab.id, assignmentGeneration: 1, boardId: "board-native", boardRevision: 2, eventIds: ["event-native"], text: "Explain the user's selected note section on the assigned board." });
    if (inbound !== "default") {
      expect(delivery).toMatchObject({ state: "unknown" });
      expect(requests.some(request => JSON.stringify(request.messages).includes("CLOUDX_COOPERATION_EVENTS:event-native"))).toBe(false);
      expect(JSON.parse(await fs.readFile(identityPath, "utf8")).sessionId).toBe(originalIdentity.sessionId);
      expect(visible(terminal.snapshot().recentOutput)).toContain(draft);
      return;
    }
    expect(delivery.state, JSON.stringify({ delivery, output: visible(terminal.snapshot().recentOutput).slice(-3500), transcript: (await fs.readFile(originalIdentity.transcriptPath, "utf8")).split("\n").filter(line => line.includes("event-native")).map(line => line.slice(0,1000)) })).toBe("nativeAccepted");
    await expect.poll(() => visible(terminal.snapshot().recentOutput), { timeout: 10000 }).toContain("Syntheticboardfeedbackanswer");
    expect(JSON.parse(await fs.readFile(identityPath, "utf8")).sessionId).toBe(originalIdentity.sessionId);
    expect(visible(terminal.snapshot().recentOutput)).toContain(draft);
    const feedbackRequest = requests.find(request => JSON.stringify(request).includes("event-native"));
    expect(feedbackRequest).toBeDefined();
    expect(JSON.stringify(feedbackRequest)).not.toContain(draft);
    terminal.write?.("\r");
    await expect.poll(() => requests.some(request => {
      const messages = request.messages as Array<{ role: string; content: unknown }>;
      return messages?.at(-1)?.role === "user" && JSON.stringify(messages.at(-1)?.content).includes(draft);
    }), { timeout: 10000 }).toBe(true);
    await expect.poll(async () => {
      const records = (await fs.readFile(originalIdentity.transcriptPath, "utf8")).split("\n").slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
      const submittedDraft = records.find(record => record.type === "user" && record.message?.content === draft);
      const currentTurn = JSON.parse(await fs.readFile(nativePath, "utf8")).currentTurn;
      return { status: currentTurn?.status, matchesSubmittedDraft: Boolean(submittedDraft?.promptId && currentTurn?.providerTurnId === submittedDraft.promptId) };
    }, { timeout: 10000 }).toEqual({ status: "completed", matchesSubmittedDraft: true });
    const originalImage = await fs.readFile("docs/design/cooperation/examples/assets/reference.png");
    const sourceImagePath = path.join(root, "original-board.png");
    await fs.writeFile(sourceImagePath, originalImage);
    const asset = { id: "asset-native", mime: "image/png" as const, sha256: createHash("sha256").update(originalImage).digest("hex"), byteLength: originalImage.length, width: 1200, height: 800, relativePath: "assets/reference.png" };
    imagePath = (await contexts.materializeAsset(tab.id, 1, { asset, localPath: sourceImagePath })).localPath;
    expect(await fs.readFile(imagePath)).toEqual(originalImage);
    const imageDelivery = await native.deliver({ recipientTabId: tab.id, assignmentGeneration: 1, boardId: "board-native", boardRevision: 3, eventIds: ["event-image"], text: `Open the original board image with Read at ${imagePath}.` });
    expect(["unknown", "nativeAccepted"]).toContain(imageDelivery.state);
    await expect.poll(async () => JSON.parse(await fs.readFile(nativePath, "utf8")).deliveries.find((entry: { eventIds: string[] }) => entry.eventIds.includes("event-image"))?.state,
      { timeout: 10000 }).toBe("nativeAccepted");
    await expect.poll(() => receivedImage, { timeout: 10000 }).toBe(true);
    const transcript = await fs.readFile(originalIdentity.transcriptPath, "utf8");
    expect(transcript).toContain('"operation":"enqueue"');
    expect(transcript).toContain("CLOUDX_COOPERATION_EVENTS:event-native");
  } catch (error) {
    const diagnostics = process.env.CLOUDX_COOPERATION_NATIVE_DIAGNOSTICS_DIR;
    if (diagnostics) {
      const launchDir = path.join(dataDir, "claude-launches", "native-claude");
      const receipts: Record<string, unknown> = {};
      for (const name of [".cloudx-conversation.json", ".cloudx-turn.json", ".cloudx-turn-stop.json", ".cloudx-turn-stops.json"])
        receipts[name] = await fs.readFile(path.join(launchDir, name), "utf8").then(JSON.parse).catch(() => undefined);
      const identity = receipts[".cloudx-conversation.json"] as { transcriptPath?: string } | undefined;
      const transcript = identity?.transcriptPath ? await fs.readFile(identity.transcriptPath, "utf8").catch(() => "") : "";
      const records = transcript.split("\n").filter(Boolean).map(line => {
        try {
          const record = JSON.parse(line);
          return { type: record.type, subtype: record.subtype, promptId: record.promptId, uuid: record.uuid, timestamp: record.timestamp,
            operation: record.operation, role: record.message?.role,
            text: typeof record.message?.content === "string" ? record.message.content.slice(0, 1000) : record.message?.content?.map((part: { type: string; text?: string }) => ({ type: part.type, text: part.text?.slice(0, 1000) })),
            hookSummary: record.subtype === "stop_hook_summary" ? record : undefined };
        } catch { return { invalidLine: true }; }
      }).slice(-40);
      const nativeState = nativeStatePath ? await fs.readFile(nativeStatePath, "utf8").then(JSON.parse).catch(() => undefined) : undefined;
      await fs.mkdir(diagnostics, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(diagnostics, `claude-${inbound}-${Date.now()}.json`), JSON.stringify({ receipts, nativeState, records,
        terminal: stripVTControlCharacters(session?.snapshot().recentOutput ?? "").slice(-12000) }, null, 2), { mode: 0o600 });
    }
    throw error;
  } finally {
    native?.close();
    await session?.terminate?.();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45000);
