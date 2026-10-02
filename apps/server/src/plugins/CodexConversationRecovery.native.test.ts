import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";
import { AppServerClient, StdioAppServerTransport } from "../appServer/AppServerClient.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { verifyCodexRuntime } from "./CodexRuntimeVerification.js";
import { completedVerificationTurn } from "./CodexVerificationTranscript.js";
import type { PluginSession } from "@cloudx/plugin-api";
import { NodePtyTerminalProcess, NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { SessionStateStore } from "../workspace/SessionStateStore.js";

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
  { name: "preserves launch permissions and native conversation evidence through new, idle resume, process loss and migration", transition: "new" },
  { name: "preserves native permission changes through fork and process loss", transition: "fork" },
  { name: "preserves native permission changes through first-prompt editing and process loss", transition: "edit" },
  { name: "preserves native permission changes through new and process loss", transition: "restricted-new" },
  { name: "preserves configured permissions and roots through native new and process loss", transition: "configured" }
].map(({ name, transition }) => [name, transition]))("%s", async (_name, transition) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-selection-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const skills = path.join(data, "rules-skills");
  const configuredRoot = path.join(root, "configured-workspace");
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
  let terminal: PluginSession | undefined;
  let stopObserving: (() => void) | undefined;
  let output = "";
  let executionId: string;
  let restartedExecutionId: string;
  const recovery = new CodexConversationRecovery(sources.viewPath(tab.id));
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: codexBinary, SHELL: "/bin/sh", TERM: "xterm-256color" };
  const production = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, data, sources, env);
  const launch = async (sessionId?: string) => {
    output = "";
    terminal = await production.createSession({
      tab, cwd: root,
      initialInput: sessionId ? { resume: { mode: "session", sessionId } } : undefined,
      controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
    });
    terminal.onData!(data => {
      output = (output + data).slice(-32_768);
      if (data.includes("\u001b[6n")) terminal!.write!("\u001b[1;1R");
    });
    return terminal.restoreInput!()!.codexExecutionId as string;
  };
  const visibleOutput = () => stripVTControlCharacters(output).replace(/\s+/gu, "");
  const submit = (text: string) => terminal!.write!(`\u001b[200~${text}\u001b[201~\r`);
  const readTranscript = async () => {
    const file = recovery.read()?.transcriptPath;
    if (!file) return [];
    try { return (await fs.readFile(file, "utf8")).split("\n").slice(0, -1).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const completeTurn = async (text: string) => {
    await terminal!.handleAction("wait_until_ready", { timeoutMs: 10_000 });
    const firstNewEvent = (await readTranscript()).length;
    const threadId = recovery.read()!.sessionId;
    await terminal!.handleAction("enter_text", { text, submit: true });
    await expect.poll(async () => completedVerificationTurn(
      await readTranscript(), firstNewEvent, threadId, "The conversation is saved."
    ), { timeout: 10_000 }).toMatchObject({ threadId, turnId: expect.any(String) });
    await terminal!.handleAction("wait_until_ready", { timeoutMs: 10_000 });
    return readTranscript();
  };
  try {
    await fs.mkdir(home, { mode: 0o700 });
    await fs.mkdir(configuredRoot);
    await fs.writeFile(path.join(home, "config.toml"), [
      `# CloudX launch preferences: ${JSON.stringify({ yoloMode: transition !== "configured", defaultSkills: { imagegen: false } })}`,
      'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'check_for_update_on_startup = false',
      'approval_policy = "on-request"', 'sandbox_mode = "read-only"',
      '[sandbox_workspace_write]', `writable_roots = [${JSON.stringify(configuredRoot)}]`,
      '[model_providers.cloudx-native]', 'name = "CloudX native test"',
      `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    executionId = await launch();
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
    const transcript = await completeTurn("Save this native test conversation.");
    await expect.poll(() => requests.includes("title"), { timeout: 5_000 }).toBe(true);
    await expect.poll(() => plugin.describeRecovery(input)).toMatchObject({ canResume: true, conversationId: original });
    expect(transcript.find(item => item.type === "turn_context")?.payload).toMatchObject({
      approval_policy: transition === "configured" ? "on-request" : "never",
      sandbox_policy: { type: transition === "configured" ? "read-only" : "danger-full-access" }
    });
    expect(transcript.find(item => item.type === "turn_context")?.payload.workspace_roots).toEqual(expect.arrayContaining([root, configuredRoot, skills]));

    let selected = original;
    if (transition !== "new") {
      submit("/permissions");
      await expect.poll(visibleOutput).toContain("1.Askforapproval");
      output = "";
      terminal!.write!("1");
      await expect.poll(visibleOutput).toContain("Permissionselectionrequested:Askforapproval");
      if (transition === "edit") {
        terminal!.write!("\u001b");
        await new Promise(resolve => setTimeout(resolve, 150));
        terminal!.write!("\u001b");
        await new Promise(resolve => setTimeout(resolve, 150));
        terminal!.write!("\r");
      } else submit(transition === "fork" ? "/fork" : "/new");
      if (transition === "edit") {
        await expect.poll(visibleOutput, { timeout: 5_000 }).toContain("Conversationrevertedtothispoint.");
        expect(recovery.read()?.sessionId).toBe(original);
      } else await expect.poll(() => recovery.read()?.sessionId, { timeout: 5_000 }).not.toBe(original);
      selected = recovery.read()!.sessionId;
      expect(selected).toBeTruthy();
      output = "";
      const restrictedTranscript = await completeTurn(transition === "edit" ? "" : "Save the selected restricted conversation.");
      expect(restrictedTranscript.filter(item => item.type === "turn_context").at(-1)?.payload).toMatchObject({
        approval_policy: "on-request", sandbox_policy: { type: "workspace-write", writable_roots: expect.arrayContaining([skills]) }
      });
      expect(restrictedTranscript.filter(item => item.type === "turn_context").at(-1)?.payload.workspace_roots).toEqual(expect.arrayContaining([root, configuredRoot, skills]));
    } else {
      submit("/new");
      await expect.poll(() => recovery.read()?.sessionId, { timeout: 5_000 }).not.toBe(original);
      expect(recovery.read()!.sessionId).toBeTruthy();
      expect(requests.filter(value => value === "conversation")).toHaveLength(1);
      output = "";
      const newTranscript = await completeTurn("Save the new unrestricted conversation.");
      expect(newTranscript.find(item => item.type === "turn_context")?.payload).toMatchObject({
        approval_policy: "never", sandbox_policy: { type: "danger-full-access" }
      });
      expect(newTranscript.find(item => item.type === "turn_context")?.payload.workspace_roots).toEqual(expect.arrayContaining([root, configuredRoot, skills]));
      submit(`/resume ${original}`);
      await expect.poll(() => recovery.read()?.sessionId === original ? original : output, { timeout: 5_000 }).toBe(original);
    }
    const conversationCount = 2;
    expect(requests.filter(value => value === "conversation")).toHaveLength(conversationCount);

    // The terminal supervisor stops both the visible TUI and backend. No prompt is replayed.
    await expect.poll(() => terminal!.restoreInput!()).toMatchObject({ codexExecutionId: executionId, resume: { mode: "session", sessionId: selected } });
    const savedInput = terminal!.restoreInput!()!;
    await terminal!.terminate!();
    terminal = undefined;
    const persisted = new CodexConversationRecovery(sources.viewPath(tab.id)).read();
    expect(persisted).toMatchObject({ sessionId: selected, selection: { tabId: tab.id, executionId } });
    expect(await plugin.describeRecovery(input)).toMatchObject({ canResume: true, conversationId: selected });
    if (transition === "new") await expectMigrationSnapshotPreservesNativeConversation({ data, home, sources, tab, initialInput: savedInput });
    const replacementRoot = path.join(root, "configured-after-restart");
    await fs.mkdir(replacementRoot);
    const configPath = path.join(home, "config.toml");
    await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace(JSON.stringify(configuredRoot), JSON.stringify(replacementRoot)));
    restartedExecutionId = await launch(selected);
    await expect.poll(() => {
      const identity = new CodexConversationRecovery(sources.viewPath(tab.id)).read();
      return identity?.selection?.executionId === restartedExecutionId ? identity : output;
    }, { timeout: 10_000 }).toMatchObject({ sessionId: selected, selection: { executionId: restartedExecutionId } });
    expect(requests.filter(value => value === "conversation")).toHaveLength(conversationCount);
    output = "";
    const restoredTranscript = await completeTurn("Verify the restored conversation permissions and saved roots.");
    const restoredContext = restoredTranscript.filter(item => item.type === "turn_context").at(-1)?.payload;
    expect(restoredContext).toMatchObject({
      approval_policy: transition === "new" ? "never" : "on-request",
      sandbox_policy: { type: transition === "new" ? "danger-full-access" : "workspace-write" },
      workspace_roots: expect.arrayContaining([root, configuredRoot, skills])
    });
    expect(restoredContext.workspace_roots).not.toContain(replacementRoot);
    expect(recovery.read()!.sessionId).toBe(selected);
  } finally {
    stopObserving?.();
    await terminal?.terminate?.();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45_000);

async function expectMigrationSnapshotPreservesNativeConversation({ data, home, sources, tab, initialInput }: {
  data: string; home: string; sources: CodexStateSources; tab: WorkspaceTab; initialInput: Record<string, unknown>;
}) {
  const view = sources.viewPath(tab.id);
  const receipt = JSON.parse(await fs.readFile(path.join(view, ".cloudx-conversation.json"), "utf8"));
  expect(receipt).toMatchObject({ version: 2, authority: "selected", tabId: tab.id, executionId: initialInput.codexExecutionId });
  expect(receipt.transcriptPath.startsWith(`${path.join(view, "sessions")}${path.sep}`)).toBe(true);
  expect(await fs.realpath(path.join(view, "sessions"))).toBe(path.join(home, "sessions"));
  expect(await sources.readBinding(tab.id)).toMatchObject({ sourceId: "shared", home });
  const transcriptPath = await fs.realpath(receipt.transcriptPath);
  expect(transcriptPath).not.toBe(receipt.transcriptPath);

  await new SessionStateStore(data).save({ version: 1, activeTabId: tab.id, sessions: [{ tab, initialInput }] });
  await fs.writeFile(path.join(data, "workspace.json"), JSON.stringify({ windows: [{
    id: "native-window", name: "Native recovery", defaultCwd: tab.cwd, createdAt: tab.createdAt, updatedAt: tab.updatedAt,
    layout: { activePaneId: "native-pane", root: { type: "pane", pane: { id: "native-pane", tabIds: [tab.id] } } }
  }] }));
  const originals = new Map(await Promise.all([
    "sessions.json", "workspace.json", `codex-launches/${tab.id}/.cloudx-source.json`, `codex-launches/${tab.id}/.cloudx-conversation.json`
  ].map(async relative => [relative, await fs.readFile(path.join(data, relative))] as const)));
  const transcript = await fs.readFile(receipt.transcriptPath);
  const { snapshotTerminalRecovery } = await import(new URL("../../../../scripts/terminal-upgrade-recovery.mjs", import.meta.url).href);
  const backup = snapshotTerminalRecovery({ dataDir: data, log: () => undefined });
  expect(backup).toBeTypeOf("string");
  for (const [relative, original] of originals) {
    expect(await fs.readFile(path.join(data, relative))).toEqual(original);
    expect(await fs.readFile(path.join(backup, relative))).toEqual(original);
  }
  expect(await fs.readFile(receipt.transcriptPath)).toEqual(transcript);
  expect(await fs.readFile(path.join(backup, "transcripts", `${tab.id}.jsonl`))).toEqual(transcript);
  expect(JSON.parse(await fs.readFile(path.join(backup, "manifest.json"), "utf8")).conversations).toEqual([{
    tabId: tab.id, lastObservedSessionId: receipt.sessionId, transcriptPath, snapshot: `transcripts/${tab.id}.jsonl`
  }]);
}

it.skipIf(!codexBinary).each([false, true])("verifies the updater's production tab launch with coalesced input: %s", async coalesceInput => {
  const evidence: string[] = [];
  const write = NodePtyTerminalProcess.prototype.write;
  let bufferedInput = "";
  // A busy native reader can consume prompt text and Enter together, regardless of write timing.
  const writeSpy = coalesceInput ? vi.spyOn(NodePtyTerminalProcess.prototype, "write").mockImplementation(function (this: NodePtyTerminalProcess, data) {
    if (data === "\u001b[1;1R") return write.call(this, data);
    bufferedInput += data;
    if (bufferedInput.endsWith("\r")) {
      write.call(this, bufferedInput);
      bufferedInput = "";
    }
  }) : undefined;
  try {
    await verifyCodexRuntime({ assistantBin: codexBinary!, onOutput: text => evidence.push(text) });
    expect(evidence).toEqual([
      "Selected conversation saved before any model prompt.\n",
      "Synthetic local-provider turn preserved selection, launch permissions and workspace/skills roots.\n",
      "Resumed Forge turn matched the selected thread, native completion and final shutdown.\n"
    ]);
  } finally {
    writeSpy?.mockRestore();
  }
}, 35_000);

it.skipIf(!codexBinary).each(["resume", "fork", "new", "cancel"])("hands the native startup %s picker to one selected conversation before a prompt", async action => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-picker-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const trace = path.join(root, "processes.jsonl");
  const wrapper = path.join(root, "codex");
  const sources = new CodexStateSources(data, { CODEX_HOME: home });
  const tab: WorkspaceTab = { id: "picker", pluginId: "codex-terminal", title: "Picker", cwd: root, status: "failed", createdAt: "", updatedAt: "", indicator: { color: "red", label: "Exited", updatedAt: "" } };
  const recovery = new CodexConversationRecovery(sources.viewPath(tab.id));
  let requests = 0;
  const provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      const item = { type: "message", id: "msg_saved", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: "Saved picker conversation.", annotations: [] }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_saved", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Saved picker conversation." },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_saved", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  let terminal: PluginSession | undefined;
  let output = "";
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: wrapper, SHELL: "/bin/sh", TERM: "xterm-256color" };
  const production = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, data, sources, env);
  const controls = { closeTab: () => undefined, setTabIndicator: () => undefined };
  const launch = async (resume?: Record<string, unknown>) => {
    output = "";
    terminal = await production[resume ? "recoverSession" : "createSession"]({ tab, cwd: root, initialInput: resume ? { resume } : undefined, controls });
    terminal.onData!(chunk => {
      output = (output + chunk).slice(-65_536);
      if (chunk.includes("\u001b[6n")) terminal!.write!("\u001b[1;1R");
    });
    return terminal.restoreInput!()!.codexExecutionId;
  };
  const pids = async () => (await fs.readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { pid: number; backend: boolean });
  const visible = () => stripVTControlCharacters(output).replace(/\s+/gu, "");
  try {
    await fs.mkdir(home, { mode: 0o700 });
    // The executable records process identity before exec; only the fork case
    // changes the native picker verb, while retaining production plugin/PTY setup.
    await fs.writeFile(wrapper, `#!/usr/bin/env python3\nimport os,sys,json\na=sys.argv[1:]\nwith open(${JSON.stringify(trace)}, 'a') as f: f.write(json.dumps({'pid':os.getpid(),'backend':'app-server' in a})+'\\n')\nif ${action === "fork" ? "True" : "False"} and 'resume' in a: a[a.index('resume')]='fork'\nos.execv(${JSON.stringify(codexBinary)}, [${JSON.stringify(codexBinary)}]+a)\n`, { mode: 0o755 });
    await fs.writeFile(path.join(home, "config.toml"), [
      `# CloudX launch preferences: ${JSON.stringify({ yoloMode: true, defaultSkills: { imagegen: false } })}`,
      'model = "cloudx-native"', 'model_provider = "cloudx-native"', 'check_for_update_on_startup = false',
      '[features]', 'thread_title = false',
      '[model_providers.cloudx-native]', 'name = "CloudX native picker test"',
      `base_url = "http://127.0.0.1:${(provider.address() as { port: number }).port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    await launch();
    await expect.poll(() => recovery.read()?.sessionId ?? output, { timeout: 15_000 }).toMatch(/^[a-f0-9-]{36}$/u);
    const savedId = recovery.read()!.sessionId;
    await terminal!.handleAction("wait_until_ready", { timeoutMs: 10_000 });
    await terminal!.handleAction("enter_text", { text: "Save the picker recovery conversation.", submit: true });
    await expect.poll(visible, { timeout: 10_000 }).toContain("Savedpickerconversation.");
    await terminal!.handleAction("wait_until_ready", { timeoutMs: 10_000 });
    await terminal!.terminate!();
    terminal = undefined;
    await recovery.requireTranscript(savedId, home);
    const beforePicker = (await pids()).length;
    const beforeRequests = requests;
    const executionId = await launch({ mode: "picker", all: true });
    await expect.poll(visible, { timeout: 10_000 }).toContain(action === "fork" ? "Forkaprevioussession" : "Resumeaprevioussession");
    await expect.poll(visible, { timeout: 10_000 }).toContain("Savethepickerrecoveryconversation.");
    expect(recovery.read()).toBeUndefined();
    const pickerBackend = (await pids()).slice(beforePicker).find(process => process.backend)!.pid;
    terminal!.write!(action === "cancel" ? "\u0003" : action === "new" ? "\u001b" : "\r");
    if (action === "cancel") {
      await expect.poll(() => terminal!.hasExited!(), { timeout: 10_000 }).toBe(true);
      expect(recovery.read()).toBeUndefined();
    } else {
      await expect.poll(() => recovery.read()?.selection?.executionId === executionId ? recovery.read() : output, { timeout: 10_000 }).toMatchObject({ selection: { tabId: tab.id, executionId } });
      const selected = recovery.read()!.sessionId;
      expect(selected === savedId).toBe(action === "resume");
      expect(terminal!.hasExited!()).toBe(false);
      await expect.poll(() => terminal!.restoreInput!()).toMatchObject({ resume: { mode: "session", sessionId: selected } });
      await expect(fs.access(`/proc/${pickerBackend}`)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await pids()).slice(beforePicker).filter(process => process.backend)).toHaveLength(2);
      const freshReader = new CodexConversationRecovery(sources.viewPath(tab.id));
      expect(freshReader.readForExecution(tab.id, executionId)).toMatchObject({ sessionId: selected });
      await terminal!.handleAction("wait_until_ready", { timeoutMs: 10_000 });
      await terminal!.handleAction("enter_text", { text: "/status", submit: true });
      await expect.poll(visible).toContain(selected);
    }
    expect(requests).toBe(beforeRequests);
    expect(output).not.toMatch(/401 Unauthorized|CloudX native worker bridge:/u);
    await terminal!.terminate!();
    terminal = undefined;
    for (const { pid } of await pids()) await expect(fs.access(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await terminal?.terminate?.();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45_000);
