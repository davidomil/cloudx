import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";
import { AppServerClient, StdioAppServerTransport } from "../appServer/AppServerClient.js";
import { CodexConversationRecovery } from "./CodexConversationRecovery.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";

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
