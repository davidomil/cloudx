import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { CodexNativeWork } from "@cloudx/shared";
import { AppServerClient, StdioAppServerTransport } from "../appServer/AppServerClient.js";

const { CodexNativeWorkObservation } = await import(new URL("../../helpers/codex-native-work.mjs", import.meta.url).href);
const { CodexConversationSelection } = await import(new URL("../../helpers/codex-conversation-selection.mjs", import.meta.url).href);
const nativeBinary = process.env.CLOUDX_NATIVE_CODEX;

function completedResponse(response: ServerResponse) {
  const item = { type: "message", id: "msg_native_health", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: "The configured native response completed.", annotations: [] }] };
  for (const event of [
    { type: "response.created", response: { id: "resp_native_health", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_native_health", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

// Opt-in native protocol integration with an isolated home and credential-free local provider.
it.skipIf(!nativeBinary)("retains native blocked failure across exact resume, preserves goal accounting, and validates a subsequent successful turn without touching a parallel client", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-work-health-"));
  const home = path.join(root, "home");
  const objective = "Fail this selected goal until explicit recovery.";
  const requestId = "e8a8a973-5a9d-412c-8142-d1ca46d61146";
  let recoverResponses = false;
  let heldRecovery: ServerResponse | undefined;
  const httpStatuses: number[] = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      httpStatuses.push(200);
      response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": requestId });
      if (!body.includes(objective)) return completedResponse(response);
      if (recoverResponses) { heldRecovery = response; return; }
      const event = { type: "response.failed", response: { id: "resp_failed_health", status: "failed", error: { code: "server_error", message: `An error occurred while processing your request. Request ID: ${requestId}.` } } };
      response.end(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`);
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  const clients: Array<{ close: () => Promise<void> }> = [];
  try {
    await fs.mkdir(home, { mode: 0o700 });
    await fs.writeFile(path.join(home, "config.toml"), [
      'check_for_update_on_startup = false', 'model = "cloudx-native"', 'model_provider = "cloudx-native"',
      'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
      '[features]', 'goals = true',
      '[model_providers.cloudx-native]', 'name = "CloudX native work health"',
      `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"',
      'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0',
      `[projects.${JSON.stringify(root)}]`, 'trust_level = "trusted"', ''
    ].join("\n"));
    const startClient = async (expectedThreadId?: string, previousError?: CodexNativeWork["lastError"]) => {
      const native = spawn(nativeBinary!, ["app-server", "--listen", "stdio://"], {
        cwd: root, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ["pipe", "pipe", "ignore"]
      });
      const exited = new Promise<void>(resolve => native.once("close", () => resolve()));
      const binding = { tabId: expectedThreadId ? "affected" : randomUUID(), executionId: randomUUID(), receiptPath: path.join(root, "health.json"), ...(expectedThreadId ? { expectedThreadId, recovery: true, previousError } : {}) };
      const selection = new CodexConversationSelection(binding, () => {});
      let work: CodexNativeWork | undefined;
      const observer = new CodexNativeWorkObservation(binding, (value: CodexNativeWork) => { work = value; }, selection);
      const transport = new StdioAppServerTransport({ process: native, stop: () => { native.kill("SIGKILL"); } });
      transport.onMessage(message => { selection.fromServer(message); observer.fromServer(message); });
      const client = new AppServerClient({
        send(message) { selection.fromClient(message); observer.fromClient(message); transport.send(message); },
        onMessage: listener => transport.onMessage(listener),
        onError: listener => transport.onError(listener), close: () => transport.close()
      });
      const close = async () => { client.close(); await exited; };
      clients.push({ close });
      await client.request("initialize", { clientInfo: { name: "cloudx_native_health", version: "1" }, capabilities: { experimentalApi: true } });
      transport.send({ method: "initialized", params: {} });
      const reply = await client.request(expectedThreadId ? "thread/resume" : "thread/start", {
        ...(expectedThreadId ? { threadId: expectedThreadId, excludeTurns: false } : {}), cwd: root,
        model: "cloudx-native", modelProvider: "cloudx-native", approvalPolicy: "never", sandbox: "danger-full-access"
      }) as { thread: { id: string; cwd: string; path: string } };
      return { native, client, close, thread: reply.thread, work: () => work };
    };

    const affected = await startClient();
    const healthy = await startClient();
    await healthy.client.request("turn/start", { threadId: healthy.thread.id, input: [{ type: "text", text: "Complete the healthy parallel conversation.", text_elements: [] }] });
    await expect.poll(() => healthy.work()?.turnStatus, { timeout: 10_000 }).toBe("completed");
    const goal = await affected.client.request("thread/goal/set", { threadId: affected.thread.id, objective, tokenBudget: 200, status: "active" }) as { goal: Record<string, unknown> };
    await expect.poll(() => affected.work()?.goalStatus, { timeout: 10_000 }).toBe("blocked");
    expect(affected.native.exitCode).toBeNull();
    expect(affected.work()).toMatchObject({ turnStatus: "failed", goalStatus: "blocked", lastError: { kind: "terminal", requestId, code: "other" } });
    expect(httpStatuses.every(status => status === 200)).toBe(true);
    expect(healthy.work()).toMatchObject({ turnStatus: "completed" });
    expect(healthy.work()?.lastError).toBeUndefined();
    const blocked = await affected.client.request("thread/goal/get", { threadId: affected.thread.id }) as { goal: Record<string, unknown> };
    expect(blocked.goal).toMatchObject({ objective, tokenBudget: 200, status: "blocked", createdAt: goal.goal.createdAt });
    await expect.poll(async () => {
      const events = (await fs.readFile(affected.thread.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      return events.find(event => event.type === "event_msg" && event.payload?.type === "task_complete" && event.payload.error)?.payload.error.message;
    }, { timeout: 5_000 }).toContain(requestId);
    const failedWork = affected.work()!;
    await affected.close();

    const repeated = await startClient(affected.thread.id, failedWork.lastError);
    const resumed = await repeated.client.request("thread/goal/get", { threadId: affected.thread.id }) as { goal: Record<string, unknown> };
    expect(resumed.goal).toMatchObject({ objective, status: "blocked", tokenBudget: 200, tokensUsed: blocked.goal.tokensUsed, timeUsedSeconds: blocked.goal.timeUsedSeconds, createdAt: blocked.goal.createdAt });
    expect(repeated.thread).toMatchObject({ id: affected.thread.id, cwd: root });
    expect(repeated.work()).toMatchObject({ recoveryStatus: "awaiting_goal_resume", goalStatus: "blocked", lastError: { requestId } });
    await repeated.client.request("thread/goal/set", { threadId: affected.thread.id, status: "active" });
    await expect.poll(() => repeated.work()?.recoveryStatus, { timeout: 10_000 }).toBe("failed");
    await expect.poll(() => repeated.work()?.goalStatus, { timeout: 10_000 }).toBe("blocked");
    expect(healthy.native.exitCode).toBeNull();
    expect(healthy.work()?.turnStatus).toBe("completed");
    await repeated.close();

    const recovered = await startClient(affected.thread.id, repeated.work()?.lastError);
    await recovered.client.request("thread/goal/get", { threadId: affected.thread.id });
    recoverResponses = true;
    const reactivated = await recovered.client.request("thread/goal/set", { threadId: affected.thread.id, status: "active" }) as { goal: Record<string, unknown> };
    expect(reactivated.goal).toMatchObject({ objective, status: "active", tokenBudget: 200, tokensUsed: resumed.goal.tokensUsed, createdAt: blocked.goal.createdAt });
    expect(Number(reactivated.goal.timeUsedSeconds)).toBeGreaterThanOrEqual(Number(blocked.goal.timeUsedSeconds));
    await expect.poll(() => Boolean(heldRecovery), { timeout: 10_000 }).toBe(true);
    expect(recovered.work()?.recoveryStatus).toBe("running");
    completedResponse(heldRecovery!);
    await expect.poll(() => recovered.work()?.recoveryStatus, { timeout: 10_000 }).toBe("succeeded");
    // Supported pause prevents further goal turns after the one used for validation.
    await recovered.client.request("thread/goal/set", { threadId: affected.thread.id, status: "paused" });
    expect(recovered.work()).toMatchObject({ recoveryStatus: "succeeded" });
    expect(healthy.native.exitCode).toBeNull();
    expect(healthy.work()).toMatchObject({ turnStatus: "completed" });
    expect(JSON.stringify(recovered.work())).not.toContain(objective);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 40_000);
