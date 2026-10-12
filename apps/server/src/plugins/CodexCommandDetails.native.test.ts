import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { parseCodexCommandDetailsSnapshot, type WorkspaceTab } from "@cloudx/shared";
import type { PluginSession } from "@cloudx/plugin-api";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { CodexStateSources } from "./CodexStateSources.js";

const codex = process.env.CLOUDX_NATIVE_CODEX;

// The real TUI and bridge use an isolated home and a local provider, without account credentials.
it.skipIf(!codex)("retains a real native multiline command and its large output after completion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-command-details-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const sources = new CodexStateSources(data, { CODEX_HOME: home });
  const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  const header = 'quotes: " and literal \\n\n\tindented output';
  const lines = Array.from({ length: 40_000 }, (_, i) => `row ${i}: preserved  whitespace`);
  const expectedOutput = `${header}\n${lines.join("\n")}\n`;
  const command = [
    "python3 - <<'PY'",
    ...Array.from({ length: 120 }, () => "# long command with quotes ' and literal \\n"),
    "import time", "time.sleep(1)", `print(${JSON.stringify(header)}, flush=True)`,
    "for i in range(40000): print(f'row {i}: preserved  whitespace')", "PY"
  ].join("\n");
  let sentCommand = false;
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const title = input.text?.format?.schema?.properties?.title;
      const runCommand = !title && !sentCommand;
      if (runCommand) sentCommand = true;
      const text = title ? '{"title":"Command details native validation"}' : "Native command complete.";
      const item = runCommand ? {
        type: "function_call", id: "fc_command", call_id: "call_command", namespace: "functions", name: "exec_command",
        arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 10_000 })
      } : {
        type: "message", id: "msg_details", role: "assistant", phase: "final_answer", status: "completed",
        content: [{ type: "output_text", text, annotations: [] }]
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_details", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        ...(runCommand ? [] : [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text }]),
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_details", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
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
      'check_for_update_on_startup = false', 'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
      '[model_providers.cloudx-native]', 'name = "CloudX native test"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: codex, SHELL: "/bin/sh", TERM: "xterm-256color" };
    const tab: WorkspaceTab = { id: "native-details", pluginId: "codex-terminal", title: "Native details", cwd: root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "", updatedAt: "" } };
    const plugin = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, data, sources, env);
    terminal = await plugin.createSession({
      tab, cwd: root, initialInput: { prompt: "Execute the supplied native test command." },
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    terminal.onData!(text => {
      screen.write(text);
      if (text.includes("\u001b[6n")) terminal!.write!("\u001b[1;1R");
    });
    const session = terminal;
    const read = async () => parseCodexCommandDetailsSnapshot(await session.handleAction("command_details", {}));
    await expect.poll(async () => (await read()).commands[0]?.status ?? session.snapshot().recentOutput, { timeout: 15_000 }).toBe("completed");
    const snapshot = await read();
    expect(snapshot).toMatchObject({ status: "available", tabId: tab.id });
    expect(snapshot.executionId).toBe(session.restoreInput?.()?.codexExecutionId);
    const capturedCommand = snapshot.commands[0].command;
    expect(capturedCommand).toContain("python3 - <<'PY'");
    expect(capturedCommand).toContain("time.sleep(1)");
    expect(capturedCommand.split("\n")).toHaveLength(command.split("\n").length);
    expect(snapshot.commands[0]).toMatchObject({ cwd: root, status: "completed", exitCode: 0, commandTruncated: false, outputTruncated: false });
    expect(snapshot.commands[0].output.length).toBe(expectedOutput.length);
    expect(snapshot.commands[0].output === expectedOutput).toBe(true);
    expect(snapshot.commands[0].threadId).toBeTruthy();
    expect(snapshot.commands[0].turnId).toBeTruthy();
    expect(snapshot.commands[0].id).toBeTruthy();
    await expect.poll(() => Array.from({ length: screen.buffer.active.length }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true)).join("\n").replace(/\s/g, ""), { timeout: 5_000 }).toContain("Nativecommandcomplete.");

    await session.terminate!();
    terminal = await plugin.createSession({
      tab, cwd: root, initialInput: { resume: { mode: "session", sessionId: snapshot.commands[0].threadId } },
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    terminal.onData!(text => { if (text.includes("\u001b[6n")) terminal!.write!("\u001b[1;1R"); });
    const resumed = terminal;
    const readResumed = async () => parseCodexCommandDetailsSnapshot(await resumed.handleAction("command_details", {}));
    await expect.poll(async () => (await readResumed()).commands.length || resumed.snapshot().recentOutput, { timeout: 10_000 }).toBe(1);
    const history = await readResumed();
    expect(history.executionId).not.toBe(snapshot.executionId);
    expect(history.commands[0]).toMatchObject({
      threadId: snapshot.commands[0].threadId, turnId: snapshot.commands[0].turnId, id: snapshot.commands[0].id,
      command: capturedCommand, status: "completed", exitCode: 0, outputTruncated: true
    });
  } catch (error) {
    console.error(JSON.stringify({ recentOutput: terminal?.snapshot().recentOutput?.slice(-4_096) }));
    throw error;
  } finally {
    await terminal?.terminate?.();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await sources.dispose();
    screen.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 25_000);
