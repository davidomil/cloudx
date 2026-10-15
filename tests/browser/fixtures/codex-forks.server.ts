import type { Page, WebSocketRoute } from "@playwright/test";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listTabLayoutPanes } from "../../../packages/shared/src/index.js";
import { TabContextService } from "../../../apps/server/src/context/TabContextService.js";
import { PathPolicy } from "../../../apps/server/src/pathPolicy.js";
import { PluginRegistry } from "../../../apps/server/src/pluginRegistry.js";
import { CodexConversationRecovery } from "../../../apps/server/src/plugins/CodexConversationRecovery.js";
import { CodexStateSources } from "../../../apps/server/src/plugins/CodexStateSources.js";
import { CodexTerminalPlugin } from "../../../apps/server/src/plugins/CodexTerminalPlugin.js";
import { SessionStore } from "../../../apps/server/src/sessionStore.js";
import { DurableTerminalProcessFactory } from "../../../apps/server/src/terminal/DurableTerminalProcess.js";
import { NodePtyTerminalProcessFactory } from "../../../apps/server/src/terminal/NodePtyTerminalProcess.js";
import { TerminalBroker } from "../../../apps/server/src/terminal/TerminalBroker.js";
import { SessionStateStore } from "../../../apps/server/src/workspace/SessionStateStore.js";
import { WorkspaceLayoutStore } from "../../../apps/server/src/workspace/WorkspaceLayoutStore.js";

/** Real session, pane, persistence, broker and native bridge owners; only transport and model output are fixtures. */
export class CodexForkWorkspace {
  readonly requests: unknown[] = [];
  readonly workspaceSockets: WebSocketRoute[] = [];
  readonly terminalSockets = new Map<string, WebSocketRoute[]>();
  readonly errors: unknown[] = [];
  store!: SessionStore;
  sourceTabId!: string;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const input = JSON.parse(body);
      const title = Boolean(input.text?.format?.schema?.properties?.title);
      if (!title) this.requests.push(input.input);
      const text = title
        ? '{"title":"Fork browser conversation"}'
        : "The branch is ready.";
      const item = {
        type: "message",
        id: "msg_fork",
        role: "assistant",
        phase: "final_answer",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { id: "resp_fork", status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: text,
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_fork",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      response.end();
    });
  });
  private readonly sources: CodexStateSources;
  private readonly workspace: WorkspaceLayoutStore;
  private readonly plugins = new PluginRegistry();
  private readonly saved: SessionStateStore;
  private readonly broker: TerminalBroker;

  private constructor(
    readonly root: string,
    codex: string,
  ) {
    const data = path.join(root, "data");
    const home = path.join(root, "home");
    const policy = new PathPolicy([root]);
    this.sources = new CodexStateSources(data, { CODEX_HOME: home });
    this.workspace = new WorkspaceLayoutStore(data, policy);
    this.saved = new SessionStateStore(data);
    const socket = path.join(root, "broker.sock");
    const factory = new NodePtyTerminalProcessFactory();
    this.broker = new TerminalBroker(socket, factory);
    this.plugins.register(
      new CodexTerminalPlugin(
        new DurableTerminalProcessFactory(socket, factory),
        undefined,
        data,
        this.sources,
        {
          PATH: process.env.PATH,
          HOME: home,
          CODEX_HOME: home,
          CLOUDX_ASSISTANT_BIN: codex,
          TERM: "xterm-256color",
          SHELL: "/bin/sh",
        },
      ),
    );
    this.createStore();
  }

  static async create(codex: string): Promise<CodexForkWorkspace> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-browser-forks-"),
    );
    const wrapper = path.join(root, "codex-fixture.mjs");
    await fs.writeFile(
      wrapper,
      `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
const server = process.argv.includes('app-server');
const child = spawn(${JSON.stringify(codex)}, process.argv.slice(2), { stdio: server ? ['pipe', 'pipe', 'inherit'] : 'inherit' });
child.on('error', error => { throw error; });
child.on('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
if (server) {
  child.stdout.pipe(process.stdout);
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'thread/fork' && fs.existsSync(${JSON.stringify(path.join(root, "reject-fork"))})) {
      fs.unlinkSync(${JSON.stringify(path.join(root, "reject-fork"))});
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: 'Deliberate native fork rejection' } }) + '\\n');
    } else child.stdin.write(line + '\\n');
  }).on('close', () => child.stdin.end());
}
`,
      { mode: 0o700 },
    );
    const fixture = new CodexForkWorkspace(root, wrapper);
    try {
      await fs.mkdir(path.join(fixture.root, "home"));
      await new Promise<void>((resolve) =>
        fixture.provider.listen(0, "127.0.0.1", resolve),
      );
      const port = (fixture.provider.address() as { port: number }).port;
      await fs.writeFile(
        path.join(fixture.root, "home/config.toml"),
        [
          '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
          'model = "gpt-6.1-sol"',
          'model_provider = "cloudx-forks"',
          "check_for_update_on_startup = false",
          "[model_providers.cloudx-forks]",
          'name = "Isolated fork browser provider"',
          `base_url = "http://127.0.0.1:${port}/v1"`,
          'wire_api = "responses"',
          "requires_openai_auth = false",
          `[projects.${JSON.stringify(fixture.root)}]`,
          'trust_level = "trusted"',
          "[analytics]",
          "enabled = false",
          "[feedback]",
          "enabled = false",
          "",
        ].join("\n"),
      );
      await fixture.broker.start();
      const source = await fixture.store.prepareTab({
        pluginId: "codex-terminal",
        cwd: fixture.root,
        title: "Original conversation",
      });
      const window = fixture.workspace.getActiveWindow();
      await fixture.workspace.placeTabAndPublish(
        {
          tabId: source.id,
          windowId: window.id,
          paneId: listTabLayoutPanes(window.layout.root)[0].id,
        },
        () => fixture.store.publishPreparedTab(source.id),
      );
      fixture.sourceTabId = source.id;
      await fixture.store.snapshot();
      return fixture;
    } catch (error) {
      await fixture.dispose();
      throw error;
    }
  }

  private createStore() {
    this.store = new SessionStore(
      this.plugins,
      new PathPolicy([this.root]),
      new TabContextService(path.join(this.root, "data")),
      undefined,
      this.workspace,
      undefined,
      (error) => this.errors.push(error),
      this.saved,
    );
    this.unsubscribers.push(
      this.store.onTabsChange(() => {
        void this.broadcast();
      }),
      this.workspace.onChange(() => {
        void this.broadcast();
      }),
    );
  }

  private async broadcast() {
    const snapshot = await this.store.snapshot();
    for (const socket of this.workspaceSockets)
      socket.send(JSON.stringify({ type: "workspace", ...snapshot }));
  }

  identity(tabId: string) {
    return new CodexConversationRecovery(this.sources.viewPath(tabId)).read();
  }

  rejectNextFork() {
    return fs.writeFile(
      path.join(this.root, "reject-fork"),
      "Reject exactly one thread/fork request.",
    );
  }

  async transcript(tabId: string): Promise<string> {
    const transcriptPath = this.identity(tabId)?.transcriptPath;
    return transcriptPath ? fs.readFile(transcriptPath, "utf8") : "";
  }

  async reconnectServer() {
    await this.store.dispose();
    this.createStore();
    await this.store.restore();
  }

  async connect(page: Page) {
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const active = /^\/api\/tabs\/([^/]+)\/active$/.exec(pathname);
      const window = /^\/api\/windows\/([^/]+)$/.exec(pathname);
      const commands = /^\/api\/tabs\/([^/]+)\/command-details$/.exec(pathname);
      if (active) {
        this.store.setActiveTab(active[1]);
        return route.fulfill({ json: {} });
      }
      if (window && route.request().method() === "PATCH") {
        await this.workspace.updateWindow(
          window[1],
          route.request().postDataJSON(),
        );
        return route.fulfill({ json: await this.store.snapshot() });
      }
      if (commands)
        return route.fulfill({
          json: {
            version: 1,
            tabId: commands[1],
            executionId: "",
            status: "unavailable",
            commands: [],
            reason: "No command in this turn.",
          },
        });
      const responses: Record<string, unknown> = {
        "/api/plugins": { plugins: this.plugins.list() },
        "/api/workspace": await this.store.snapshot(),
        "/api/config": {
          values: {
            global: {
              voiceControlAiEnabled: false,
              voiceCommandsEnabled: false,
              microphoneEnabled: false,
            },
            plugins: {},
          },
          schema: { global: [], plugins: {} },
        },
        "/api/automation/catalog": { nodes: [] },
        "/api/automation/groups": { groups: [] },
        "/api/notifications": { notifications: [] },
        "/api/health": { status: "ok" },
        "/api/system/update": { available: false },
      };
      if (pathname.startsWith("/api/hooks/"))
        return route.fulfill({ json: { output: {} } });
      if (!(pathname in responses)) {
        this.errors.push(`Unexpected request: ${pathname}`);
        return route.fulfill({ status: 404, json: {} });
      }
      return route.fulfill({ json: responses[pathname] });
    });
    await page.routeWebSocket("**/ws/workspace", async (socket) => {
      this.workspaceSockets.push(socket);
      socket.onClose(() => {
        const index = this.workspaceSockets.indexOf(socket);
        if (index >= 0) this.workspaceSockets.splice(index, 1);
      });
      socket.send(
        JSON.stringify({ type: "workspace", ...(await this.store.snapshot()) }),
      );
    });
    await page.routeWebSocket("**/ws/terminal/*", async (socket) => {
      const tabId = socket.url().split("/").at(-1)!;
      const sockets = this.terminalSockets.get(tabId) ?? [];
      sockets.push(socket);
      this.terminalSockets.set(tabId, sockets);
      const session = this.store.getSession(tabId);
      socket.onMessage((message) => {
        const event = JSON.parse(String(message));
        if (event.type === "input" && this.store.acceptsInput(tabId))
          session.write!(event.data);
        if (event.type === "resize") session.resize!(event.cols, event.rows);
      });
      let attached = false;
      const live: string[] = [];
      const attachment = await session.attachTerminal!((data) => {
        if (attached) socket.send(JSON.stringify({ type: "data", data }));
        else live.push(data);
      });
      socket.send(JSON.stringify({ type: "screen", ...attachment.screen }));
      attached = true;
      for (const data of live)
        socket.send(JSON.stringify({ type: "data", data }));
      socket.onClose(() => attachment.dispose());
    });
  }

  async dispose() {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    await this.store?.dispose();
    await this.broker.stop();
    await this.sources.dispose();
    this.provider.closeAllConnections();
    await new Promise<void>((resolve) => this.provider.close(() => resolve()));
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
