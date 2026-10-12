import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import type { PluginSession } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";
import { AppServerClient, StdioAppServerTransport } from "../appServer/AppServerClient.js";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { CodexStateSources } from "./CodexStateSources.js";

const { CodexWorkspaceScope } = await import(new URL("../../helpers/codex-workspace-scope.mjs", import.meta.url).href);
const codexBinary = process.env.CLOUDX_NATIVE_CODEX;

// Isolated native sessions use a no-auth local fixture provider.
it.skipIf(!codexBinary)("scopes the native production picker and last selection by original workspace, excluding linked Forge worktrees", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-workspace-scope-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const project = path.join(root, "project");
  const other = path.join(root, "other");
  const forge = path.join(root, "forge-worktree");
  const provenanceDirectory = path.join(data, "codex-workspaces");
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: codexBinary,
    SHELL: "/bin/sh", TERM: "xterm-256color" };
  const sources = new CodexStateSources(data, env);
  let client: AppServerClient | undefined;
  let stopped: Promise<unknown> | undefined;
  const sessions: PluginSession[] = [];
  let modelRequests = 0;
  const provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      modelRequests++;
      const item = { type: "message", id: "msg_saved", role: "assistant", phase: "final_answer", status: "completed",
        content: [{ type: "output_text", text: "Saved conversation.", annotations: [] }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_saved", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Saved conversation." },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_saved", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    await Promise.all([home, project, other, provenanceDirectory].map(directory => fs.mkdir(directory, { recursive: true })));
    const git = promisify(execFile);
    await git("git", ["init", project]);
    await git("git", ["-C", project, "-c", "user.name=Native test", "-c", "user.email=native@example.invalid", "commit", "--allow-empty", "-m", "Initial"]);
    await git("git", ["-C", project, "worktree", "add", forge]);
    await fs.writeFile(path.join(home, "config.toml"), [
      '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
      'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'check_for_update_on_startup = false',
      '[features]', 'worktrees = true',
      '[model_providers.cloudx-native]', 'name = "CloudX native test"',
      `base_url = "http://127.0.0.1:${(provider.address() as { port: number }).port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(project)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    const native = spawn(codexBinary!, ["app-server", "--listen", "stdio://"], {
      cwd: project, env, stdio: ["pipe", "pipe", "ignore"]
    });
    stopped = new Promise(resolve => native.once("close", resolve));
    const transport = new StdioAppServerTransport({ process: native, stop: () => { native.kill("SIGKILL"); } });
    client = new AppServerClient(transport);
    await client.request("initialize", { clientInfo: { name: "cloudx_workspace_native", version: "1" }, capabilities: { experimentalApi: true } });
    transport.send({ method: "initialized", params: {} });
    const execSession = spawn(codexBinary!, ["exec", "--cd", project, "--color", "never", "Exec-workspace-A"], { cwd: project, env, stdio: ["ignore", "ignore", "pipe"] });
    let execOutput = "";
    execSession.stderr.on("data", chunk => { execOutput += chunk; });
    const execCode = await new Promise<number | null>((resolve, reject) => { execSession.once("error", reject); execSession.once("close", resolve); });
    expect(execCode, execOutput).toBe(0);
    const execInventory = await client.request("thread/list", { limit: 100, sourceKinds: ["exec"], modelProviders: ["cloudx-native"] }) as { data: Array<{ id: string; cwd: string }> };
    expect(execInventory.data).toHaveLength(1);
    const execThread = execInventory.data[0]!;
    new CodexWorkspaceScope({ workspaceId: "workspace-a", cwd: project, provenanceDirectory, owned: false, all: false, includeNonInteractive: true })
      .recordSelection({ authority: "selected", sessionId: execThread.id, cwd: execThread.cwd }, { created: true });
    async function seed(workspaceId: string, cwd: string, title: string, owned = false) {
      const { thread } = await client!.request("thread/start", { cwd, model: "cloudx-native", modelProvider: "cloudx-native" }) as { thread: { id: string; cwd: string } };
      let completed = false;
      transport.onMessage(message => { if (message.method === "turn/completed" && (message.params as { threadId?: string })?.threadId === thread.id) completed = true; });
      await client!.request("turn/start", { threadId: thread.id,
        input: [{ type: "text", text: title, text_elements: [] }] });
      await expect.poll(() => completed, { timeout: 10000 }).toBe(true);
      await client!.request("thread/name/set", { threadId: thread.id, name: title });
      await client!.request("thread/unsubscribe", { threadId: thread.id });
      new CodexWorkspaceScope({ workspaceId, cwd, provenanceDirectory, owned, all: false, includeNonInteractive: false })
        .recordSelection({ authority: "selected", sessionId: thread.id, cwd: thread.cwd }, { created: true });
      return thread.id;
    }
    const mine = await seed("workspace-a", project, "Owned-workspace-A");
    const shared = await seed("workspace-b", project, "Shared-cwd-workspace-B");
    await seed("workspace-b", other, "Unrelated-workspace-B");
    await seed("workspace-a", forge, "Linked-Forge-worker", true);
    const inventory = await client.request("thread/list", { limit: 100, sourceKinds: ["cli", "vscode", "exec", "appServer"], modelProviders: ["cloudx-native"] }) as { data: Array<{ id: string; cwd: string }> };
    expect(inventory.data.map(thread => thread.id)).toEqual(expect.arrayContaining([mine, shared]));
    const requestsAfterSeeding = modelRequests;
    client.close();
    client = undefined;
    await stopped;
    const plugin = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, data, sources, env);
    async function launch(resume: Record<string, unknown>, recovering = false) {
      const tab: WorkspaceTab = { id: randomUUID(), pluginId: "codex-terminal", title: "Workspace resume", cwd: project,
        status: "failed", createdAt: "", updatedAt: "", indicator: { color: "red", label: "Exited", updatedAt: "" } };
      const input = { tab, cwd: project, workspaceId: "workspace-a", initialInput: { resume },
        controls: { closeTab: () => undefined, setTabIndicator: () => undefined } };
      const session = await (recovering ? plugin.recoverSession(input) : plugin.createSession(input));
      sessions.push(session);
      let output = "";
      session.onData!(chunk => {
        output = (output + chunk).slice(-131072);
        if (chunk.includes("\u001b[6n")) session.write!("\u001b[1;1R");
      });
      return { session, text: () => stripVTControlCharacters(output),
        identity: () => new CodexConversationRecovery(sources.viewPath(tab.id)).readForExecution(tab.id, session.restoreInput!()!.codexExecutionId) };
    }
    for (const recovering of [false, true]) {
      const picker = await launch({ mode: "picker", all: false, includeNonInteractive: true }, recovering);
      await expect.poll(picker.text, { timeout: 15000 }).toContain("Owned-workspace-A");
      expect(picker.text()).toContain("Exec-workspace-A");
      expect(picker.text()).not.toContain("Shared-cwd-workspace-B");
      expect(picker.text()).not.toContain("Linked-Forge-worker");
      expect(picker.text()).not.toContain("Unrelated-workspace-B");
      await picker.session.terminate!();
    }
    const interactive = await launch({ mode: "picker", all: false, includeNonInteractive: false });
    await expect.poll(interactive.text, { timeout: 15000 }).toContain("Owned-workspace-A");
    expect(interactive.text()).not.toContain("Exec-workspace-A");
    await interactive.session.terminate!();
    const last = await launch({ mode: "last", all: false, includeNonInteractive: true });
    await expect.poll(() => last.identity()?.sessionId, { timeout: 15000 }).toBe(mine);
    await last.session.terminate!();
    const broad = await launch({ mode: "picker", all: true, includeNonInteractive: true });
    await expect.poll(broad.text, { timeout: 15000 }).toContain("Linked-Forge-worker");
    expect(broad.text()).toContain("Shared-cwd-workspace-B");
    expect(broad.text()).toContain("Unrelated-workspace-B");
    await broad.session.terminate!();
    const exact = await launch({ mode: "session", sessionId: shared });
    await expect.poll(() => exact.identity()?.sessionId, { timeout: 15000 }).toBe(shared);
    expect(new CodexWorkspaceScope({ workspaceId: "workspace-a", cwd: project, provenanceDirectory,
      owned: false, all: false, includeNonInteractive: false }).readOwnership(shared).workspaceId).toBe("workspace-b");
    expect(modelRequests).toBe(requestsAfterSeeding);
  } finally {
    client?.close();
    await stopped;
    await Promise.all(sessions.map(session => session.terminate?.()));
    await sources.dispose();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 90000);
