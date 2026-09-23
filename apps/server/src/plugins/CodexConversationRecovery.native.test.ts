import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";
import { AppServerClient, StdioAppServerTransport } from "../appServer/AppServerClient.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { buildCodexRemoteTuiArgs, CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import type { TerminalProcess } from "../terminal/TerminalProcess.js";

const codexBinary = process.env.CLOUDX_NATIVE_CODEX;

// Opt in with CLOUDX_NATIVE_CODEX=/absolute/path/to/codex; no credentials or model service are used.
it.skipIf(!codexBinary)("requires selection after native resume changes conversations before another prompt", async () => {
  expect(path.isAbsolute(codexBinary!)).toBe(true);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-recovery-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const sources = new CodexStateSources(data, { CODEX_HOME: home });
  let client: AppServerClient | undefined;
  let stopped: Promise<unknown> | undefined;
  try {
    await fs.mkdir(home, { mode: 0o700 });
    await fs.writeFile(path.join(home, "config.toml"), [
      'model = "cloudx-native"',
      'model_provider = "cloudx-native"',
      '[model_providers.cloudx-native]',
      'name = "CloudX native test"',
      'base_url = "http://127.0.0.1:1/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
      ''
    ].join("\n"));
    const tab: WorkspaceTab = {
      id: "native-recovery", pluginId: "codex-terminal", title: "Native recovery", cwd: home,
      status: "failed", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      indicator: { color: "red", label: "Exited", updatedAt: new Date(0).toISOString() }
    };
    await sources.bind(tab.id, await sources.resolve());
    const recovery = new CodexConversationRecovery(sources.viewPath(tab.id));
    const native = spawn(codexBinary!, [...recovery.launchArgs(), "app-server", "--listen", "stdio://"], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "ignore"]
    });
    stopped = new Promise(resolve => native.once("close", resolve));
    const transport = new StdioAppServerTransport({ process: native, stop: () => { native.kill("SIGKILL"); } });
    client = new AppServerClient(transport);
    await client.request("initialize", {
      clientInfo: { name: "cloudx_native_recovery", version: "1" },
      capabilities: { experimentalApi: true }
    });
    transport.send({ method: "initialized", params: {} });

    const original = await client.request("thread/start", { cwd: home, model: "cloudx-native", modelProvider: "cloudx-native" }) as { thread: { id: string } };
    const prompt = await client.request("turn/start", {
      threadId: original.thread.id,
      input: [{ type: "text", text: "Observe the original conversation.", text_elements: [] }]
    }) as { turn: { id: string } };
    await expect.poll(() => recovery.read()?.sessionId, { timeout: 5_000 }).toBe(original.thread.id);
    await client.request("turn/interrupt", { threadId: original.thread.id, turnId: prompt.turn.id });

    const selected = await client.request("thread/start", { cwd: home, model: "cloudx-native", modelProvider: "cloudx-native" }) as { thread: { id: string } };
    await client.request("thread/inject_items", {
      threadId: selected.thread.id,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "A different saved conversation." }] }]
    });
    await client.request("thread/unsubscribe", { threadId: selected.thread.id });
    const resumed = await client.request("thread/resume", { threadId: selected.thread.id, excludeTurns: false }) as { thread: { id: string } };
    expect(resumed.thread.id).toBe(selected.thread.id);
    expect(selected.thread.id).not.toBe(original.thread.id);
    await recovery.requireTranscript(selected.thread.id, home);
    await recovery.requireTranscript(original.thread.id, home);

    // Kill after native resume, without submitting another turn that could refresh the hook receipt.
    const killed = once(native, "close", { signal: AbortSignal.timeout(5_000) });
    client.close();
    await killed;
    expect(recovery.read()?.sessionId).toBe(original.thread.id);

    const plugin = new CodexTerminalPlugin({ spawn: async () => { throw new Error("Recovery description must not launch a process."); } }, undefined, data, sources);
    const description = await plugin.describeRecovery({
      tab, cwd: home, initialInput: { resume: { mode: "session", sessionId: original.thread.id } },
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    expect(description.canResume).toBe(false);
    expect(description).not.toHaveProperty("conversationId");
    expect(description.message).toMatch(/select a saved session/i);
  } finally {
    client?.close();
    await stopped;
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(!codexBinary).each([
  { name: "durably follows native idle new and resume selection across observer and process loss", editFirstPrompt: false },
  { name: "preserves native permission changes through first-prompt editing and process loss", editFirstPrompt: true }
])("$name", async ({ editFirstPrompt }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-selection-"));
  const home = path.join(root, "home");
  const skills = path.join(root, "skills");
  const data = path.join(root, "data");
  const sources = new CodexStateSources(data, { CODEX_HOME: home });
  const tab: WorkspaceTab = {
    id: "native-selection", pluginId: "codex-terminal", title: "Native selection", cwd: root,
    status: "failed", createdAt: "", updatedAt: "",
    indicator: { color: "red", label: "Exited", updatedAt: "" }
  };
  const requests: string[] = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const purpose = input.text?.format?.schema?.properties?.title ? "title" : "conversation";
      requests.push(purpose);
      const text = purpose === "title" ? '{"title":"Native selection recovery"}' : "The conversation is saved.";
      const item = { type: "message", id: `msg_${purpose}`, role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: `resp_${purpose}`, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: `resp_${purpose}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  let terminal: TerminalProcess | undefined;
  let stopObserving: (() => void) | undefined;
  let output = "";
  const executionId = "11111111-1111-4111-8111-111111111111";
  const restartedExecutionId = "22222222-2222-4222-8222-222222222222";
  const recovery = new CodexConversationRecovery(sources.viewPath(tab.id));
  const launch = async (args: string[], execution = executionId) => {
    output = "";
    terminal = await new NodePtyTerminalProcessFactory().spawn(process.execPath, [
      fileURLToPath(new URL("../../helpers/codex-worker-bridge.mjs", import.meta.url)),
      JSON.stringify({
        selection: { tabId: tab.id, executionId: execution, receiptPath: recovery.receiptPath },
        permissions: { yoloMode: true, additionalWritableRoots: [skills] },
        command: codexBinary,
        serverArgs: ["--config", 'approval_policy="never"', "--config", 'sandbox_mode="danger-full-access"', "app-server", "--listen", "stdio://"],
        tuiArgs: buildCodexRemoteTuiArgs(["--yolo", "--no-alt-screen", "--add-dir", skills], ["--cd", root, "--model", "cloudx-native", ...args])
      })
    ], { cwd: root, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TERM: "xterm-256color" }, cols: 100, rows: 30 });
    terminal.onData(data => {
      output = (output + data).slice(-32_768);
      if (data.includes("\u001b[6n")) terminal!.write("\u001b[1;1R");
    });
  };
  const submit = async (text: string) => {
    terminal!.write(text);
    await new Promise(resolve => setTimeout(resolve, 100));
    terminal!.write("\r");
  };
  try {
    await fs.mkdir(home, { mode: 0o700 });
    await fs.mkdir(skills, { mode: 0o700 });
    await fs.writeFile(path.join(home, "config.toml"), [
      'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'check_for_update_on_startup = false',
      'approval_policy = "on-request"', 'sandbox_mode = "read-only"',
      '[model_providers.cloudx-native]', 'name = "CloudX native test"',
      `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    await sources.bind(tab.id, await sources.resolve());
    await launch([]);
    await expect.poll(() => recovery.read()?.sessionId ?? output, { timeout: 15_000 }).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
    const original = recovery.read()!.sessionId;
    expect(requests).toEqual([]);
    const input = { tab, cwd: root, initialInput: { codexExecutionId: executionId }, controls: { closeTab: () => undefined, setTabIndicator: () => undefined } };
    const plugin = new CodexTerminalPlugin({ spawn: async () => { throw new Error("Description cannot launch a process."); } }, undefined, data, sources);
    expect(await plugin.describeRecovery(input)).toMatchObject({ canResume: false, message: expect.stringMatching(/transcript.*unavailable/i) });

    // Reopening the observer models a web-server reconnect while the bridge remains alive.
    let observed: string | undefined;
    stopObserving = new CodexConversationRecovery(sources.viewPath(tab.id)).observe(identity => { observed = identity.sessionId; }, error => { throw error; });
    expect(observed).toBe(original);
    stopObserving();
    await submit("Save this native test conversation.");
    await expect.poll(() => output, { timeout: 10_000 }).toContain("The conversation is saved.");
    await expect.poll(() => requests.includes("title"), { timeout: 5_000 }).toBe(true);
    await expect.poll(() => plugin.describeRecovery(input)).toMatchObject({ canResume: true, conversationId: original });
    const transcript = (await fs.readFile(recovery.read()!.transcriptPath!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(transcript.find(item => item.type === "turn_context")?.payload).toMatchObject({ approval_policy: "never", sandbox_policy: { type: "danger-full-access" } });
    expect(transcript.find(item => item.type === "session_meta")?.payload.runtime_workspace_roots).toEqual(expect.arrayContaining([root, skills]));

    let selected = original;
    if (editFirstPrompt) {
      await submit("/permissions");
      await expect.poll(() => output).toContain("1. Ask for approval");
      output = "";
      terminal!.write("1");
      await expect.poll(() => output).toContain("Permissions updated");
      terminal!.write("\u001b");
      await new Promise(resolve => setTimeout(resolve, 150));
      terminal!.write("\u001b");
      await new Promise(resolve => setTimeout(resolve, 150));
      terminal!.write("\r");
      await expect.poll(() => recovery.read()?.sessionId, { timeout: 5_000 }).not.toBe(original);
      selected = recovery.read()!.sessionId;
      expect(selected).toBeTruthy();
      output = "";
      await submit("");
      await expect.poll(() => output, { timeout: 10_000 }).toContain("The conversation is saved.");
      const editedTranscript = (await fs.readFile(recovery.read()!.transcriptPath!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(editedTranscript.find(item => item.type === "turn_context")?.payload).toMatchObject({
        approval_policy: "on-request", sandbox_policy: { type: "workspace-write", writable_roots: expect.arrayContaining([skills]) }
      });
      expect(editedTranscript.find(item => item.type === "session_meta")?.payload.runtime_workspace_roots).toEqual(expect.arrayContaining([root, skills]));
    } else {
      await submit("/new");
      await expect.poll(() => recovery.read()?.sessionId, { timeout: 5_000 }).not.toBe(original);
      expect(recovery.read()!.sessionId).toBeTruthy();
      expect(requests.filter(value => value === "conversation")).toHaveLength(1);
      await submit(`/resume ${original}`);
      await expect.poll(() => recovery.read()?.sessionId === original ? original : output, { timeout: 5_000 }).toBe(original);
    }
    const conversationCount = editFirstPrompt ? 2 : 1;
    expect(requests.filter(value => value === "conversation")).toHaveLength(conversationCount);

    // The terminal supervisor stops both the visible TUI and backend. No prompt is replayed.
    await terminal!.terminate();
    terminal = undefined;
    const persisted = new CodexConversationRecovery(sources.viewPath(tab.id)).read();
    expect(persisted).toMatchObject({ sessionId: selected, selection: { tabId: tab.id, executionId } });
    expect(await plugin.describeRecovery(input)).toMatchObject({ canResume: true, conversationId: selected });
    await launch(["resume", selected], restartedExecutionId);
    await expect.poll(() => {
      const identity = new CodexConversationRecovery(sources.viewPath(tab.id)).read();
      return identity?.selection?.executionId === restartedExecutionId ? identity : output;
    }, { timeout: 10_000 }).toMatchObject({ sessionId: selected, selection: { executionId: restartedExecutionId } });
    expect(requests.filter(value => value === "conversation")).toHaveLength(conversationCount);
  } finally {
    stopObserving?.();
    await terminal?.terminate();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45_000);
