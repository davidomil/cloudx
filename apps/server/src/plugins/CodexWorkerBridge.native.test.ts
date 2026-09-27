import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { WorkspaceTab } from "@cloudx/shared";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { CodexStateSources } from "./CodexStateSources.js";
import type { PluginSession } from "@cloudx/plugin-api";

const codex = process.env.CLOUDX_NATIVE_CODEX;

// Uses the installed Codex protocol and TUI with a local synthetic provider; no credentials or external model service.
it.skipIf(!codex)("preserves the native worker completion while Codex generates its hidden thread title", async () => {
  expect(path.isAbsolute(codex!)).toBe(true);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-worker-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const sources = new CodexStateSources(data, { CODEX_HOME: home });
  const finalText = "The native final response remains visible after handoff.";
  const title = "Verify native worker completion";
  const providerRequests: string[] = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const purpose = input.text?.format?.schema?.properties?.title ? "title" : "worker";
      providerRequests.push(purpose);
      const text = purpose === "title" ? JSON.stringify({ title }) : finalText;
      const message = { type: "message", id: `msg_${purpose}`, role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: `resp_${purpose}`, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response: { id: `resp_${purpose}`, status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address() as { port: number };
  let terminal: PluginSession | undefined;
  try {
    await fs.mkdir(home, { mode: 0o700 });
    await fs.writeFile(path.join(home, "config.toml"), [
      '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
      'check_for_update_on_startup = false',
      'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
      '[model_providers.cloudx-native]', 'name = "CloudX native test"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: codex, SHELL: "/bin/sh", TERM: "xterm-256color" };
    const binding = { workerId: "native-worker", attemptId: "native-attempt", receiptPath: path.join(root, "turn.json") };
    const tab: WorkspaceTab = { id: "native", pluginId: "codex-terminal", ownerPluginId: "forge", title: "Native", cwd: root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "", updatedAt: "" } };
    terminal = await new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, data, sources, env).createSession({
      tab, cwd: root, codexTurn: binding,
      initialInput: { prompt: "Return the configured native test response." },
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    terminal.onData!(data => { if (data.includes("\u001b[6n")) terminal!.write!("\u001b[1;1R"); });
    const session = terminal;
    let receipt: { status: string; threadId: string; turnId: string } | undefined;
    await expect.poll(async () => {
      try { receipt = JSON.parse(await fs.readFile(binding.receiptPath, "utf8")); }
      catch { return session.snapshot().recentOutput; }
      return receipt?.status;
    }, { timeout: 15_000 }).toBe("completed");
    await expect.poll(() => providerRequests.includes("title") ? "title requested" : session.snapshot().recentOutput, { timeout: 5_000 }).toBe("title requested");
    await expect.poll(() => fs.readFile(path.join(home, "session_index.jsonl"), "utf8"), { timeout: 5_000 }).toContain(title);
    expect(providerRequests.sort()).toEqual(["title", "worker"]);
    expect(JSON.parse(await fs.readFile(binding.receiptPath, "utf8"))).toEqual(receipt);
    expect(JSON.parse(await fs.readFile(`${binding.receiptPath}.final.json`, "utf8"))).toMatchObject({
      threadId: receipt!.threadId, turnId: receipt!.turnId, text: finalText
    });
    await session.handleAction("finish", { threadId: receipt!.threadId, turnId: receipt!.turnId });
    expect(session.snapshot().status).toBe("completed");
    expect(session.snapshot().recentOutput).toContain(finalText);
  } finally {
    await terminal?.terminate?.();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 25_000);
