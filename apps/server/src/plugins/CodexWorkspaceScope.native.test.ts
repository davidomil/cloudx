import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import headless from "@xterm/headless";
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
  const screens: Array<{ dispose(): void }> = [];
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
    const inventory = await client.request("thread/list", { limit: 100, sourceKinds: ["cli", "vscode", "exec", "appServer"], modelProviders: ["cloudx-native"] }) as { data: Array<{ id: string; cwd: string; path: string }> };
    expect(inventory.data.map(thread => thread.id)).toEqual(expect.arrayContaining([mine, shared]));
    const template = await fs.readFile(inventory.data.find(thread => thread.id === mine)!.path, "utf8");
    const olderHistory = path.join(home, "sessions", "2020", "01", "01");
    await fs.mkdir(olderHistory, { recursive: true });
    const rolloutFiles = 5633;
    await Promise.all(Array.from({ length: rolloutFiles - 6 }, async (_, index) => {
      const id = randomUUID();
      const contents = template.split("\n").filter(Boolean).map(line => {
        const record = JSON.parse(line.replaceAll(mine, id).replaceAll("Owned-workspace-A", `Historical-unproven-${index}`));
        record.timestamp = "2020-01-01T00:00:00.000Z";
        if (record.type === "session_meta") record.payload.timestamp = record.timestamp;
        return JSON.stringify(record);
      }).join("\n") + "\n";
      const target = path.join(olderHistory, `rollout-2020-01-01T00-00-00-${id}.jsonl`);
      await fs.writeFile(target, contents);
      await fs.utimes(target, new Date("2020-01-01"), new Date("2020-01-01"));
    }));
    const measurements: Array<Record<string, unknown>> = [];
    const requestsAfterSeeding = modelRequests;
    client.close();
    client = undefined;
    await stopped;
    const unindexedId = randomUUID();
    const unindexedPath = path.join(olderHistory, `rollout-2021-01-01T00-00-00-${unindexedId}.jsonl`);
    await fs.writeFile(unindexedPath, template.replaceAll(mine, unindexedId).replaceAll("Owned-workspace-A", "Unindexed-owned-session"));
    await fs.utimes(unindexedPath, new Date("2021-01-01"), new Date("2021-01-01"));
    new CodexWorkspaceScope({ workspaceId: "workspace-a", cwd: project, provenanceDirectory,
      owned: false, all: false, includeNonInteractive: false })
      .recordSelection({ authority: "selected", sessionId: unindexedId, cwd: project }, { created: true });
    const indexBeforeLaunch = await promisify(execFile)("python3", ["-I", "-S", "-c", `
import pathlib, sqlite3, sys
count = 0
for file in pathlib.Path(sys.argv[1]).glob("state_*.sqlite"):
    with sqlite3.connect(file.as_uri() + "?mode=ro", uri=True) as connection:
        count += connection.execute("SELECT count(*) FROM threads WHERE id = ?", (sys.argv[2],)).fetchone()[0]
print(count)
`, home, unindexedId]);
    expect(indexBeforeLaunch.stdout.trim()).toBe("0");
    const plugin = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, data, sources, env);
    async function launch(resume: Record<string, unknown>, recovering = false, workspaceId = "workspace-a") {
      const launchedAt = performance.now();
      const tab: WorkspaceTab = { id: randomUUID(), pluginId: "codex-terminal", title: "Workspace resume", cwd: project,
        status: "failed", createdAt: "", updatedAt: "", indicator: { color: "red", label: "Exited", updatedAt: "" } };
      const input = { tab, cwd: project, workspaceId, initialInput: { resume },
        controls: { closeTab: () => undefined, setTabIndicator: () => undefined } };
      const session = await (recovering ? plugin.recoverSession(input) : plugin.createSession(input));
      sessions.push(session);
      const screen = new headless.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
      screens.push(screen);
      let output = "";
      let firstRowsMs: number | undefined;
      const visibleText = () => Array.from({ length: screen.buffer.active.length }, (_, index) => screen.buffer.active.getLine(index)?.translateToString(true)).join("\n");
      session.onData!(chunk => {
        screen.write(chunk, () => {
          if (firstRowsMs === undefined && visibleText().includes("Owned-workspace-A")) firstRowsMs = Math.round(performance.now() - launchedAt);
        });
        output = (output + chunk).slice(-131072);
        if (chunk.includes("\u001b[6n")) session.write!("\u001b[1;1R");
      });
      return { session, text: () => stripVTControlCharacters(output), clearOutput: () => { output = ""; }, firstRowsMs: () => firstRowsMs,
        visibleText,
        diagnostics: () => fs.readFile(path.join(sources.viewPath(tab.id), "cloudx-codex-backend.log"), "utf8"),
        identity: () => new CodexConversationRecovery(sources.viewPath(tab.id)).readForExecution(tab.id, session.restoreInput!()!.codexExecutionId) };
    }
    for (const recovering of [false, true]) {
      const picker = await launch({ mode: "picker", all: false, includeNonInteractive: true }, recovering);
      await expect.poll(picker.text, { timeout: 15000 }).toContain("Owned-workspace-A");
      expect(picker.text()).toContain("Exec-workspace-A");
      expect(picker.text()).not.toContain("Shared-cwd-workspace-B");
      expect(picker.text()).not.toContain("Linked-Forge-worker");
      expect(picker.text()).not.toContain("Unrelated-workspace-B");
      await expect.poll(picker.text, { timeout: 15000 }).toContain("Unindexed-owned-session");
      const timingEvents = (await picker.diagnostics()).split("\n").filter(line => line.startsWith("CloudX resume timing "))
        .map(line => JSON.parse(line.slice("CloudX resume timing ".length)));
      expect(timingEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "launch_prepared" }), expect.objectContaining({ event: "native_initialized", failed: false }),
        expect.objectContaining({ event: "first_usable_rows", backendPages: expect.any(Number) })
      ]));
      expect(timingEvents.filter(event => event.event === "list_page").every(event => event.delivered)).toBe(true);
      if (!recovering) expect(timingEvents).toContainEqual(expect.objectContaining({ event: "list_page", indexed: false, rows: 1 }));
      expect(picker.firstRowsMs()).toBeLessThan(15000);
      measurements.push({ recovering, rolloutFiles, firstRenderedRowsMs: picker.firstRowsMs(), timingEvents });
      await picker.session.terminate!();
    }
    const interactive = await launch({ mode: "picker", all: false, includeNonInteractive: false });
    await expect.poll(interactive.text, { timeout: 15000 }).toContain("Owned-workspace-A");
    expect(interactive.text()).not.toContain("Exec-workspace-A");
    interactive.clearOutput();
    interactive.session.write!("Unfindable-resume-session");
    await expect.poll(interactive.visibleText, { timeout: 15000 }).toContain("No results for your search");
    interactive.clearOutput();
    interactive.session.write!("\x15Owned-workspace-A");
    await expect.poll(interactive.visibleText, { timeout: 15000 }).toContain("Owned-workspace-A");
    const cancellationStarted = performance.now();
    await interactive.session.terminate!();
    expect(performance.now() - cancellationStarted).toBeLessThan(5000);
    const empty = await launch({ mode: "picker", all: false, includeNonInteractive: false }, false, "empty-workspace");
    await expect.poll(empty.visibleText, { timeout: 15000 }).toContain("No sessions yet");
    await empty.session.terminate!();
    const cancelled = await launch({ mode: "picker", all: false, includeNonInteractive: false }, false, "empty-workspace");
    await expect.poll(cancelled.text, { timeout: 15000 }).toContain("Loading sessions");
    const nativeCancellationStarted = performance.now();
    cancelled.session.write!("\x03");
    await expect.poll(() => cancelled.session.hasExited?.(), { timeout: 5000 }).toBe(true);
    measurements.push({ nativeCancelMs: Math.round(performance.now() - nativeCancellationStarted), pendingHistoryRows: rolloutFiles });
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
    if (process.env.CLOUDX_RESUME_EVIDENCE_DIR) {
      await fs.mkdir(process.env.CLOUDX_RESUME_EVIDENCE_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.CLOUDX_RESUME_EVIDENCE_DIR, "native-resume-timings.json"), JSON.stringify({ measurements }, null, 2));
    }
  } finally {
    client?.close();
    await stopped;
    await Promise.all(sessions.map(session => session.terminate?.()));
    screens.forEach(screen => screen.dispose());
    await sources.dispose();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 90000);
