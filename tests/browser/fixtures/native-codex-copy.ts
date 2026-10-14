import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodePtyTerminalProcessFactory } from "../../../apps/server/src/terminal/NodePtyTerminalProcess.js";
import type { TerminalProducer } from "../../../apps/server/src/terminal/TerminalProcess.js";

/** A real native TUI with only an isolated home and synthetic local Responses provider. */
export class NativeCodexCopySession {
  readonly answer = "Native selected answer with café.";
  output = "";
  requestCount = 0;
  readonly prompts: string[] = [];
  readonly toolOutputs: string[] = [];
  private native?: TerminalProducer;
  private diagnosticBurst = 0;
  private readonly home: string;
  private readonly provider = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const input = JSON.parse(body);
      const title = Boolean(input.text?.format?.schema?.properties?.title);
      if (!title) {
        this.requestCount++;
        this.prompts.push(JSON.stringify(input.input));
        this.toolOutputs.push(
          ...input.input
            .filter((item: { type: string }) =>
              item.type.endsWith("_call_output"),
            )
            .map((item: { output: unknown }) => JSON.stringify(item.output)),
        );
      }
      const text = title
        ? '{"title":"Native clipboard validation"}'
        : this.answer;
      const toolFailure =
        this.bridgeDiagnostics && !title && this.requestCount === 1;
      const item = toolFailure
        ? {
            type: "custom_tool_call",
            id: "patch_failure",
            call_id: "call_patch_failure",
            name: "apply_patch",
            input:
              "*** Begin Patch\n*** Update File: missing-regression-source.txt\n@@\n-old\n+new\n*** End Patch",
          }
        : {
            type: "message",
            id: "msg_copy",
            role: "assistant",
            phase: "final_answer",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { id: "resp_copy", status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
        ...(toolFailure
          ? []
          : [
              {
                type: "response.output_text.delta",
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                delta: text,
              },
            ]),
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_copy",
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

  private constructor(
    private readonly codex: string,
    private readonly root: string,
    private readonly bridgeDiagnostics: boolean,
  ) {
    this.home = path.join(root, "home");
  }

  static async create(
    codex: string,
    bridgeDiagnostics = false,
  ): Promise<NativeCodexCopySession> {
    const fixture = new NativeCodexCopySession(
      codex,
      await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-browser-copy-")),
      bridgeDiagnostics,
    );
    try {
      await new Promise<void>((resolve) =>
        fixture.provider.listen(0, "127.0.0.1", resolve),
      );
      const port = (fixture.provider.address() as { port: number }).port;
      await fs.mkdir(fixture.home, { mode: 0o700 });
      await fs.writeFile(
        path.join(fixture.home, "config.toml"),
        [
          'model = "gpt-6.1-sol"',
          'model_provider = "cloudx-copy"',
          "check_for_update_on_startup = false",
          "[model_providers.cloudx-copy]",
          'name = "Isolated CloudX clipboard test"',
          `base_url = "http://127.0.0.1:${port}/v1"`,
          'wire_api = "responses"',
          "requires_openai_auth = false",
          "[tui]",
          "fullscreen_transcript = true",
          'copy_on_select = "never"',
          `[projects.${JSON.stringify(fixture.root)}]`,
          'trust_level = "trusted"',
          "[analytics]",
          "enabled = false",
          "[feedback]",
          "enabled = false",
          "",
        ].join("\n"),
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
    let command = this.codex;
    let args: string[] = [];
    if (this.bridgeDiagnostics) {
      const wrapper = path.join(this.root, "codex-diagnostics.mjs");
      await fs.writeFile(
        wrapper,
        `#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const child = spawn(${JSON.stringify(this.codex)}, process.argv.slice(2), { stdio: 'inherit' });
child.on('error', error => { throw error; });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
if (process.argv.includes('app-server')) setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(path.join(this.root, "emit-diagnostics"))})) return;
  const sequence = fs.readFileSync(${JSON.stringify(path.join(this.root, "emit-diagnostics"))}, 'utf8');
  fs.unlinkSync(${JSON.stringify(path.join(this.root, "emit-diagnostics"))});
  process.stderr.write(('\\x1b[31mBACKEND_DIAGNOSTIC_ONLY\\x1b[0m\\npatch hunk café 界\\n').repeat(8000) + 'DIAGNOSTIC_BURST_COMPLETE ' + sequence + '\\n');
}, 20);
`,
        { mode: 0o700 },
      );
      command = process.execPath;
      args = [
        fileURLToPath(
          new URL(
            "../../../apps/server/helpers/codex-worker-bridge.mjs",
            import.meta.url,
          ),
        ),
        JSON.stringify({
          selection: {
            tabId: "copy-tab",
            executionId: "01a08470-d118-7b72-b1df-439e72e5c745",
            receiptPath: path.join(this.root, "selected.json"),
          },
          command: wrapper,
          serverArgs: ["app-server", "--listen", "stdio://"],
          tuiArgs: [],
        }),
      ];
    }
    this.native = await new NodePtyTerminalProcessFactory().spawn(
      command,
      args,
      {
        cwd: this.root,
        ...dimensions,
        env: {
          PATH: process.env.PATH!,
          HOME: this.home,
          CODEX_HOME: this.home,
          TERM: "xterm-256color",
          SHELL: "/bin/sh",
          SSH_TTY: "/dev/pts/cloudx-isolated-copy",
        },
      },
    );
    this.native.onData((chunk) => {
      this.output = (this.output + chunk).slice(-256_000);
      output(chunk);
    });
  }

  async emitBackendDiagnostics(): Promise<string> {
    const sequence = String(++this.diagnosticBurst);
    await fs.writeFile(path.join(this.root, "emit-diagnostics"), sequence);
    return `DIAGNOSTIC_BURST_COMPLETE ${sequence}`;
  }

  async backendDiagnostics(): Promise<string> {
    return fs.readFile(
      path.join(this.root, "cloudx-codex-backend.log"),
      "utf8",
    );
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
