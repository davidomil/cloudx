import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { PluginSession } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import { shellQuote } from "../terminal/ShellLaunch.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { completedVerificationTurn } from "./CodexVerificationTranscript.js";
import { verifyCodexRuntime } from "./CodexRuntimeVerification.js";

const nativeBinary = process.env.CLOUDX_NATIVE_CODEX;

it.skipIf(!nativeBinary)("new tabs and Forge workers use the selected installation while existing native sessions finish on their original installation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-version-selection-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const prefix = path.join(root, "codex");
  const sources = new CodexStateSources(data, { CODEX_HOME: home });
  const sessions: PluginSession[] = [];
  const finalText = "The selected native installation completed the turn.";
  const commandLog = path.join(root, "native-launches");
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body);
      const text = input.text?.format?.schema?.properties?.title ? '{"title":"Native version selection"}' : finalText;
      const item = { type: "message", id: "msg_selection", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_selection", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_selection", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  try {
    await fs.mkdir(home, { mode: 0o700 });
    await fs.writeFile(path.join(home, "config.toml"), [
      '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
      'check_for_update_on_startup = false',
      'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
      '[model_providers.cloudx-native]', 'name = "CloudX native test"',
      `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    const version = execFileSync(nativeBinary!, ["--version"], { encoding: "utf8" }).trim().replace(/^codex-cli /u, "");
    const releases: Array<{ version: string; assistantBin: string }> = [];
    for (const label of ["original", "selected"]) {
      const installation = path.join(prefix, ".cloudx-codex", label);
      const packageDir = path.join(installation, "lib/node_modules/@openai/codex");
      const assistantBin = path.join(installation, "bin/codex");
      await fs.mkdir(path.join(packageDir, "bin"), { recursive: true });
      await fs.mkdir(path.dirname(assistantBin), { recursive: true });
      await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version, bin: { codex: "bin/codex.js" } }));
      await fs.writeFile(path.join(packageDir, "bin/codex.js"), [
        "#!/bin/sh",
        `printf '%s\\t%s\\n' ${shellQuote(label)} "$CODEX_HOME" >> ${shellQuote(commandLog)}`,
        `exec ${shellQuote(nativeBinary!)} "$@"`, ""
      ].join("\n"), { mode: 0o700 });
      await fs.symlink(path.join(packageDir, "bin/codex.js"), assistantBin);
      releases.push({ version, assistantBin });
    }
    const select = async (active: typeof releases[number], previous: typeof active | null) => {
      const temporary = path.join(prefix, "selection.tmp");
      await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, active, previous }));
      await fs.rename(temporary, path.join(prefix, ".cloudx-codex-selection.json"));
    };
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: path.join(prefix, "bin/codex"), SHELL: "/bin/sh", TERM: "xterm-256color" };
    const plugin = new CodexTerminalPlugin(new NodePtyTerminalProcessFactory(), undefined, data, sources, env);
    const start = async (id: string, worker = false) => {
      const tab: WorkspaceTab = { id, pluginId: "codex-terminal", ...(worker ? { ownerPluginId: "forge" } : {}), title: id, cwd: root, status: "running", createdAt: "", updatedAt: "", indicator: { color: "green", label: "Running", updatedAt: "" } };
      const binding = { workerId: id, attemptId: `${id}-attempt`, receiptPath: path.join(root, `${id}-turn.json`) };
      const session = await plugin.createSession({
        tab, cwd: root, ...(worker ? { codexTurn: binding, initialInput: { prompt: "Complete the native selection check." } } : {}),
        controls: { closeTab: () => undefined, setTabIndicator: () => undefined }
      });
      sessions.push(session);
      session.onData!(data => { if (data.includes("\u001b[6n")) session.write!("\u001b[1;1R"); });
      const recovery = new CodexConversationRecovery(sources.viewPath(id));
      await expect.poll(() => recovery.read()?.sessionId ?? session.snapshot().recentOutput, { timeout: 15_000 }).toMatch(/^[a-f0-9-]{36}$/u);
      const threadId = recovery.read()!.sessionId;
      await expect.poll(() => session.restoreInput!()?.resume).toEqual({ mode: "session", sessionId: threadId });
      return { id, session, recovery, threadId, binding };
    };
    const finishWorker = async ({ session, binding, threadId }: Awaited<ReturnType<typeof start>>) => {
      let receipt: { status: string; threadId: string; turnId: string } | undefined;
      await expect.poll(async () => {
        try { receipt = JSON.parse(await fs.readFile(binding.receiptPath, "utf8")); } catch { return session.snapshot().recentOutput; }
        return receipt?.status;
      }, { timeout: 15_000 }).toBe("completed");
      expect(receipt!.threadId).toBe(threadId);
      await session.handleAction("finish", { threadId, turnId: receipt!.turnId });
      expect(session.snapshot().status).toBe("completed");
      expect(session.snapshot().recentOutput).toContain(finalText);
    };
    await select(releases[0]!, null);
    const originalTab = await start("original-tab");
    const originalWorker = await start("original-worker", true);
    const originalConfig = await fs.readFile(path.join(home, "config.toml"), "utf8");
    let compatibilityOutput = "";
    await verifyCodexRuntime({ assistantBin: releases[1]!.assistantBin, previousAssistantBin: releases[0]!.assistantBin, env, sharedStateHome: home, dataDir: data,
      onOutput: text => { compatibilityOutput += text; } });
    expect(compatibilityOutput).toMatch(/Native compatibility verified against [1-9]\d* distinct retained SQLite schemas/u);
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(originalConfig);
    await select(releases[1]!, releases[0]!);
    const selectedTab = await start("selected-tab");
    const selectedWorker = await start("selected-worker", true);
    const launches = (await fs.readFile(commandLog, "utf8")).trim().split("\n");
    for (const session of [originalTab, originalWorker, selectedTab, selectedWorker]) {
      const expected = session.id.startsWith("original") ? "original" : "selected";
      expect(launches.filter(line => line.endsWith(`/${session.id}`))).toEqual([
        `${expected}\t${sources.viewPath(session.id)}`, `${expected}\t${sources.viewPath(session.id)}`
      ]);
      expect(session.recovery.read()!.sessionId).toBe(session.threadId);
    }
    expect(originalTab.session.snapshot().status).toBe("running");
    expect(originalWorker.session.snapshot().status).toBe("running");
    await originalTab.session.handleAction("wait_until_ready", { timeoutMs: 10_000 });
    await originalTab.session.handleAction("enter_text", { text: "Complete on the original installation after the selection changed.", submit: true });
    await expect.poll(async () => {
      const transcriptPath = originalTab.recovery.read()?.transcriptPath;
      if (!transcriptPath) return undefined;
      const transcript = (await fs.readFile(transcriptPath, "utf8")).split("\n").slice(0, -1).map(line => JSON.parse(line));
      return completedVerificationTurn(transcript, 0, originalTab.threadId, finalText);
    }, { timeout: 15_000 }).toMatchObject({ threadId: originalTab.threadId, turnId: expect.any(String) });
    await finishWorker(originalWorker);
    await finishWorker(selectedWorker);
    expect(await fs.readFile(commandLog, "utf8")).toBe(`${launches.join("\n")}\n`);
  } finally {
    await Promise.all(sessions.map(session => session.terminate?.()));
    await sources.dispose();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
