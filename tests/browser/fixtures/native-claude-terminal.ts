import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodePtyTerminalProcessFactory } from "../../../apps/server/src/terminal/NodePtyTerminalProcess.js";
import type { TerminalProducer } from "../../../apps/server/src/terminal/TerminalProcess.js";

/** A real Claude TUI whose model traffic can only use a synthetic loopback Messages endpoint. */
export class NativeClaudeTerminalSession {
  readonly answer = "Claude local answer with café.";
  output = "";
  readonly requests: Record<string, unknown>[] = [];
  readonly paths: string[] = [];
  private native?: TerminalProducer;
  private readonly home: string;
  private readonly provider = createServer((request, response) => {
    const pathname = new URL(request.url!, "http://fixture.invalid").pathname;
    this.paths.push(`${request.method} ${pathname}`);
    if (request.method === "HEAD" && pathname === "/api/hello") {
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST" || pathname !== "/v1/messages") {
      response.writeHead(404, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: {
            type: "not_found_error",
            message: "No external provider in this fixture.",
          },
        }),
      );
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const input = JSON.parse(body);
      this.requests.push(input);
      const message = {
        id: `msg_fixture_${this.requests.length}`,
        type: "message",
        role: "assistant",
        model: input.model,
        content: [{ type: "text", text: this.answer }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (!input.stream) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        {
          type: "message_start",
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: this.answer },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ])
        response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      response.end();
    });
  });

  private constructor(
    private readonly claude: string,
    private readonly root: string,
  ) {
    this.home = path.join(root, "home");
  }

  static async create(
    claude: string,
    fullscreen: boolean,
  ): Promise<NativeClaudeTerminalSession> {
    const fixture = new NativeClaudeTerminalSession(
      claude,
      await fs.mkdtemp(
        path.join(os.tmpdir(), "cloudx-native-claude-terminal-"),
      ),
    );
    try {
      await new Promise<void>((resolve) =>
        fixture.provider.listen(0, "127.0.0.1", resolve),
      );
      await fs.mkdir(fixture.home, { mode: 0o700 });
      await fs.writeFile(
        path.join(fixture.root, "editor.mjs"),
        `import fs from "node:fs";\nfs.appendFileSync(process.argv[2], " editor edit");\nfs.appendFileSync(${JSON.stringify(path.join(fixture.root, "editor-invocations"))}, "invoked\\n");\n`,
      );
      await fs.writeFile(
        path.join(fixture.home, ".claude.json"),
        JSON.stringify({
          hasCompletedOnboarding: true,
          hasSeenAutoDefaultNudge: true,
          theme: "dark",
          projects: { [fixture.root]: { hasTrustDialogAccepted: true } },
        }),
      );
      await fs.writeFile(
        path.join(fixture.home, "settings.json"),
        JSON.stringify({
          model: "claude-sonnet-4-6",
          alwaysThinkingEnabled: false,
          tui: fullscreen ? "fullscreen" : "default",
          autoUpdatesChannel: "stable",
          permissions: { defaultMode: "manual" },
        }),
      );
      return fixture;
    } catch (error) {
      await fixture.dispose();
      throw error;
    }
  }

  async start(
    dimensions: { cols: number; rows: number },
    output: (chunk: string) => void,
  ): Promise<void> {
    const port = (this.provider.address() as { port: number }).port;
    this.native = await new NodePtyTerminalProcessFactory().spawn(
      this.claude,
      [
        "--model",
        "claude-sonnet-4-6",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "user",
      ],
      {
        cwd: this.root,
        ...dimensions,
        env: {
          PATH: process.env.PATH!,
          HOME: this.home,
          CLAUDE_CONFIG_DIR: this.home,
          TERM: "xterm-256color",
          SHELL: "/bin/sh",
          SSH_TTY: "/dev/pts/cloudx-isolated-claude",
          ANTHROPIC_API_KEY: "cloudx-local-synthetic-key",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          VISUAL: `${process.execPath} ${path.join(this.root, "editor.mjs")}`,
          EDITOR: `${process.execPath} ${path.join(this.root, "editor.mjs")}`,
        },
      },
    );
    this.native.onData((chunk) => {
      this.output = (this.output + chunk).slice(-512_000);
      output(chunk);
    });
  }

  async uploadFile(relativePath: string, bytes: Buffer): Promise<string> {
    const filename = path.resolve(this.root, relativePath);
    if (!filename.startsWith(`${this.root}${path.sep}`))
      throw new Error("Uploads must stay inside the isolated workspace.");
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
    return filename;
  }

  async editorInvocations(): Promise<string> {
    try {
      return await fs.readFile(
        path.join(this.root, "editor-invocations"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  input(event: {
    type: string;
    data: string;
    cols: number;
    rows: number;
  }): void {
    if (event.type === "input") this.native?.write(event.data);
    if (event.type === "resize") this.native?.resize(event.cols, event.rows);
  }

  async dispose(): Promise<void> {
    await this.native?.terminate();
    this.provider.closeAllConnections();
    await new Promise<void>((resolve) => this.provider.close(() => resolve()));
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
