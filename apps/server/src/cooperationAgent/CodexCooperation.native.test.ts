import { createServer } from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { expect, it } from "vitest";
import type { PluginSession } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";

import { CodexTerminalPlugin } from "../plugins/CodexTerminalPlugin.js";
import { CodexStateSources } from "../plugins/CodexStateSources.js";
import { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { AgentCooperationContext } from "./AgentCooperationContext.js";
import { NativeAgentFeedbackPort } from "./NativeAgentFeedbackPort.js";
import { COOPERATION_RULES, COOPERATION_SKILLS } from "./cooperationContributions.js";

const codex = process.env.CLOUDX_NATIVE_CODEX;
const visible = (value = "") => stripVTControlCharacters(value).replace(/\s+/gu, "");

// The real broker, native TUI and app-server share one original connection.
it.skipIf(!codex)("native Codex receives addressed idle feedback without replacing its conversation or typed draft", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-coop-native-codex-"));
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  const requests: Record<string, unknown>[] = [];
  let imagePath: string | undefined;
  let requestedImage = false;
  let receivedImage = false;
  let releaseBusy: (() => void) | undefined;
  let busySeen = false;
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    requests.push(input);
    if (!busySeen && JSON.stringify(input.input?.at(-1)).includes("BUSY_NATIVE_TURN")) {
      busySeen = true;
      await new Promise<void>(resolve => { releaseBusy = resolve; });
    }
    const imageResult = input.input?.find((item: { type: string; call_id?: string }) => item.type === "function_call_output" && item.call_id === "image-native-call");
    if (imageResult) receivedImage = Array.isArray(imageResult.output) && imageResult.output.some((item: { type: string; image_url?: string }) => item.type === "input_image" && item.image_url?.startsWith("data:"));
    const readImage = Boolean(imagePath && !requestedImage && raw.includes("event-image"));
    if (readImage) requestedImage = true;
    const title = input.text?.format?.schema?.properties?.title;
    const text = title ? JSON.stringify({ title: "Cooperation native fixture" }) : raw.includes("event-codex") ? "Synthetic Codex feedback answer." : "Synthetic Codex initial answer.";
    const message = readImage ? { type: "function_call", id: "image-native", call_id: "image-native-call", namespace: "functions", name: "view_image", arguments: JSON.stringify({ path: imagePath }) }
      : { type: "message", id: `msg_${requests.length}`, role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `resp_${requests.length}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      ...(readImage ? [] : [{ type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text }]),
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: `resp_${requests.length}`, status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  let session: PluginSession | undefined;
  let native: NativeAgentFeedbackPort | undefined;
  try {
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(home, "config.toml"), [
      '# CloudX launch preferences: {"yoloMode":false,"defaultSkills":{"imagegen":false}}',
      'check_for_update_on_startup = false', 'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'approval_policy = "never"', 'sandbox_mode = "workspace-write"',
      '[model_providers.cloudx-native]', 'name = "CloudX native fixture"', `base_url = "http://127.0.0.1:${port}/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = false', `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: codex, SHELL: "/bin/sh", TERM: "xterm-256color" };
    const sources = new CodexStateSources(dataDir, env);
    const catalog = new RulesSkillsCatalogService(dataDir);
    for (const rule of COOPERATION_RULES) await catalog.saveSystemRule(rule);
    for (const skill of COOPERATION_SKILLS) await catalog.saveSystemSkill(skill);
    const tab: WorkspaceTab = { id: "native-codex", pluginId: "codex-terminal", title: "Native cooperation", cwd: root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "", updatedAt: "" } };
    const contexts = new AgentCooperationContext({ dataDir, endpoint: () => "http://127.0.0.1:1/api/cooperation/agent", binding: () => ({ tabId: tab.id, boardId: "board-native", assignmentGeneration: 1, providerId: "codex" }) });
    session = await new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, dataDir, sources, env).createSession({
      tab, cwd: root, runtimeContext: await contexts.augmentRuntimeContext(tab), initialInput: { prompt: "Begin the synthetic cooperation session." },
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    const terminal = session;
    terminal.onData?.(chunk => { if (chunk.includes("\u001b[6n")) terminal.write?.("\u001b[1;1R"); });
    await expect.poll(() => visible(terminal.snapshot().recentOutput), { timeout: 20000 }).toContain("SyntheticCodexinitialanswer.");
    const nativePath = `${contexts.contextPath(tab.id)}.native.json`;
    await expect.poll(async () => JSON.parse(await fs.readFile(nativePath, "utf8")).currentTurn?.status, { timeout: 10000 }).toBe("completed");
    const identityPath = path.join(sources.viewPath(tab.id), ".cloudx-conversation.json");
    const original = JSON.parse(await fs.readFile(identityPath, "utf8"));
    const draft = "CODEX_USER_DRAFT_MUST_SURVIVE";
    terminal.write?.(draft);
    native = new NativeAgentFeedbackPort({ contexts });
    const delivery = await native.deliver({ recipientTabId: tab.id, assignmentGeneration: 1, boardId: "board-native", boardRevision: 1, eventIds: ["event-codex"], text: "User board question event-codex: explain the note at its target." });
    expect(delivery, JSON.stringify(delivery)).toMatchObject({ state: "nativeAccepted", providerTurnId: expect.any(String) });
    await expect.poll(() => visible(terminal.snapshot().recentOutput), { timeout: 10000 }).toContain("SyntheticCodexfeedbackanswer.");
    expect(JSON.parse(await fs.readFile(identityPath, "utf8")).sessionId).toBe(original.sessionId);
    const feedbackRequest = requests.find(request => JSON.stringify(request).includes("event-codex"));
    expect(feedbackRequest).toBeDefined();
    expect(JSON.stringify(feedbackRequest)).not.toContain(draft);
    terminal.write?.("\r");
    await expect.poll(() => requests.some(request => JSON.stringify((request.input as Array<{ type: string }>)?.at(-1)).includes(draft)), { timeout: 10000 }).toBe(true);
    const nativeReceipt = JSON.parse(await fs.readFile(nativePath, "utf8"));
    expect(nativeReceipt.deliveries).toEqual([expect.objectContaining({ eventIds: ["event-codex"], state: "nativeAccepted", providerTurnId: delivery.providerTurnId })]);
    await expect.poll(async () => JSON.parse(await fs.readFile(nativePath, "utf8")).currentTurn?.status, { timeout: 10000 }).toBe("completed");
    const originalImage = await fs.readFile("docs/design/cooperation/examples/assets/reference.png");
    const originalImagePath = path.join(root, "original.png");
    await fs.writeFile(originalImagePath, originalImage);
    imagePath = (await contexts.materializeAsset(tab.id, 1, { asset: { id: "asset-codex", mime: "image/png", sha256: createHash("sha256").update(originalImage).digest("hex"), byteLength: originalImage.length, width: 1200, height: 800, relativePath: "assets/reference.png" }, localPath: originalImagePath })).localPath;
    expect(await fs.readFile(imagePath)).toEqual(originalImage);
    const imageDelivery = await native.deliver({ recipientTabId: tab.id, assignmentGeneration: 1, boardId: "board-native", boardRevision: 2, eventIds: ["event-image"], text: `For event-image, open the original board image at ${imagePath} with view_image.` });
    expect(imageDelivery, JSON.stringify({ imageDelivery, screen: visible(terminal.snapshot().recentOutput).slice(-1800) })).toMatchObject({ state: "nativeAccepted" });
    await expect.poll(() => receivedImage ? "opened" : JSON.stringify({
      outputs: requests.flatMap(request => (request.input as Array<{ type: string; output?: unknown }>) ?? []).filter(item => item.type === "function_call_output").map(item => JSON.stringify(item.output).slice(0, 500)),
      screen: visible(terminal.snapshot().recentOutput).slice(-1000)
    }), { timeout: 10000 }).toBe("opened");
    await expect.poll(async () => JSON.parse(await fs.readFile(nativePath, "utf8")).currentTurn?.status, { timeout: 10000 }).toBe("completed");
    terminal.write?.("BUSY_NATIVE_TURN");
    await expect.poll(() => visible(terminal.snapshot().recentOutput), { timeout: 10000 }).toContain("BUSY_NATIVE_TURN");
    terminal.write?.("\r");
    await expect.poll(() => busySeen, { timeout: 10000 }).toBe(true);
    const queued = { recipientTabId: tab.id, assignmentGeneration: 1, boardId: "board-native", boardRevision: 3, eventIds: ["event-queued"], text: "Read the queued event-queued only after this native turn finishes." };
    expect(await native.deliver(queued)).toMatchObject({ state: "queued" });
    expect(requests.some(request => JSON.stringify(request).includes("event-queued"))).toBe(false);
    releaseBusy!();
    await expect.poll(async () => JSON.parse(await fs.readFile(nativePath, "utf8")).currentTurn?.status, { timeout: 10000 }).toBe("completed");
    expect(await native.deliver(queued)).toMatchObject({ state: "nativeAccepted" });
    await expect.poll(() => requests.some(request => JSON.stringify(request).includes("event-queued")), { timeout: 10000 }).toBe(true);
  } finally {
    releaseBusy?.();
    native?.close();
    await session?.terminate?.();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45000);
