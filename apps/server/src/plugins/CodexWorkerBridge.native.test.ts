import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { WorkspaceTab } from "@cloudx/shared";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CODEX_SUBMIT_DELAY_MS, CodexTerminalSession } from "./CodexTerminalPlugin.js";

const codex = process.env.CLOUDX_NATIVE_CODEX;

// Uses the installed Codex protocol and TUI with a local synthetic provider; no credentials or external model service.
it.skipIf(!codex)("completes the installed native worker turn and gracefully closes its visible conversation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-worker-"));
  const home = path.join(root, "home");
  const finalText = "The native final response remains visible after handoff.";
  const provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const message = { type: "message", id: "msg_native", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: finalText, annotations: [] }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_native", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: finalText },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response: { id: "resp_native", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address() as { port: number };
  let terminal;
  try {
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "config.toml"), [
      'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
      '[model_providers.cloudx-native]', 'name = "CloudX native test"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = false', ''
    ].join("\n"));
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TERM: "xterm-256color" };
    const binding = { workerId: "native-worker", attemptId: "native-attempt", receiptPath: path.join(root, "turn.json") };
    terminal = await new NodePtyTerminalProcessFactory().spawn(process.execPath, [fileURLToPath(new URL("../../helpers/codex-worker-bridge.mjs", import.meta.url)), JSON.stringify({
      binding, command: codex,
      serverArgs: ["app-server", "--listen", "stdio://"],
      tuiArgs: ["--no-alt-screen", "--yolo", "--cd", root, "--", "Return the configured native test response."]
    })], { cwd: root, env, cols: 100, rows: 30 });
    terminal.onData(data => { if (data.includes("\u001b[6n")) terminal!.write("\u001b[1;1R"); });
    const tab: WorkspaceTab = { id: "native", pluginId: "codex-terminal", title: "Native", cwd: root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "", updatedAt: "" } };
    const session = new CodexTerminalSession(tab, terminal, undefined, { closeOnExit: false, nativeTurn: binding, submitDelayMs: CODEX_SUBMIT_DELAY_MS });
    let receipt: { status: string; threadId: string; turnId: string } | undefined;
    await expect.poll(async () => {
      try { receipt = JSON.parse(await fs.readFile(binding.receiptPath, "utf8")); }
      catch { return session.snapshot().recentOutput; }
      return receipt?.status;
    }, { timeout: 15_000 }).toBe("completed");
    await session.handleAction("finish", { threadId: receipt!.threadId, turnId: receipt!.turnId });
    expect(session.snapshot().status).toBe("completed");
    expect(session.snapshot().recentOutput).toContain(finalText);
  } finally {
    await terminal?.terminate();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 25_000);
