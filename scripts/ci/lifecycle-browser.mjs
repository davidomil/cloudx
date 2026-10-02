import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const answer = "The lifecycle acceptance conversation is saved.";
const prompt = "Save this isolated lifecycle acceptance conversation.";
const title = "Lifecycle acceptance conversation";

// The same native Responses protocol fixture as CodexConversationRecovery.native.test.ts.
export class NativeLifecycleProvider {
  requests = [];

  async start() {
    this.server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          response.writeHead(400).end();
          return;
        }
        const purpose = input.text?.format?.schema?.properties?.title
          ? "title"
          : "conversation";
        this.requests.push(purpose);
        const text = purpose === "title" ? JSON.stringify({ title }) : answer;
        const item = {
          type: "message",
          id: `msg_${purpose}`,
          role: "assistant",
          phase: "final_answer",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          {
            type: "response.created",
            response: {
              id: `resp_${purpose}`,
              status: "in_progress",
              output: [],
            },
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
              id: `resp_${purpose}`,
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
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.baseURL = `http://127.0.0.1:${this.server.address().port}/v1`;
    return this;
  }

  async close() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

export function conversationEvidence(
  binding,
  receipt,
  transcript,
  canonicalTranscriptPath,
) {
  assert.equal(
    receipt.version,
    2,
    "Native selected-conversation evidence is required.",
  );
  assert.equal(receipt.authority, "selected");
  assert.match(
    receipt.sessionId,
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu,
  );
  assert.ok(path.isAbsolute(binding.home));
  assert.ok(
    canonicalTranscriptPath.startsWith(
      `${binding.home}${path.sep}sessions${path.sep}`,
    ),
    "The transcript must belong to the shared source, not a fabricated launch home.",
  );
  const events = transcript
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events[0]?.type, "session_meta");
  assert.equal(events[0]?.payload?.id, receipt.sessionId);
  const starts = events.filter(
    (event) =>
      event.type === "event_msg" && event.payload?.type === "task_started",
  );
  const completed = events.filter(
    (event) =>
      event.type === "event_msg" && event.payload?.type === "task_complete",
  );
  assert.equal(
    starts.length,
    1,
    "The acceptance prompt must execute exactly once.",
  );
  assert.equal(
    completed.length,
    1,
    "The native acceptance turn must complete exactly once.",
  );
  assert.equal(completed[0].payload.turn_id, starts[0].payload.turn_id);
  assert.equal(completed[0].payload.last_agent_message, answer);
  assert.ok(
    events.some(
      (event) =>
        event.type === "turn_context" &&
        event.payload?.turn_id === starts[0].payload.turn_id,
    ),
  );
  return {
    conversationId: receipt.sessionId,
    turnId: starts[0].payload.turn_id,
    canonicalTranscriptPath,
    transcriptBytes: transcript.length,
    transcriptSha256: sha256(transcript),
  };
}

export function assertPreservedConversation(
  before,
  binding,
  receipt,
  transcript,
  canonicalTranscriptPath,
) {
  assert.deepEqual(
    binding,
    before.binding,
    "The shared Codex source binding changed during update.",
  );
  assert.equal(
    receipt.sessionId,
    before.receipt.sessionId,
    "Update selected a different conversation.",
  );
  assert.equal(receipt.tabId, before.receipt.tabId);
  assert.equal(receipt.transcriptPath, before.receipt.transcriptPath);
  assert.equal(canonicalTranscriptPath, before.canonicalTranscriptPath);
  assert.ok(
    transcript.length >= before.transcriptBytes,
    "The saved transcript was truncated.",
  );
  assert.equal(
    sha256(transcript.subarray(0, before.transcriptBytes)),
    before.transcriptSha256,
    "Saved conversation evidence was modified.",
  );
  conversationEvidence(binding, receipt, transcript, canonicalTranscriptPath);
}

export class LifecycleBrowserProfile {
  static async create(options) {
    const profile = new LifecycleBrowserProfile(options);
    try {
      const { chromium, expect } = await import("@playwright/test");
      profile.expect = expect;
      profile.provider = await new NativeLifecycleProvider().start();
      profile.browser = await chromium.launch({ headless: true });
      profile.context = await profile.browser.newContext({
        baseURL: options.baseURL,
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
        extraHTTPHeaders: { Origin: options.baseURL },
      });
      await profile.context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: false,
      });
      profile.page = await profile.context.newPage();
      profile.page.setDefaultTimeout(30_000);
      profile.page.on("pageerror", (error) => {
        profile.browserErrors.push(error.message);
      });
      return profile;
    } catch (error) {
      await profile.close();
      throw error;
    }
  }

  constructor(options) {
    Object.assign(this, options);
    this.browserErrors = [];
    this.interruptionConfirmed = false;
  }

  async json(method, route, data) {
    const response = await this.context.request.fetch(route, {
      method,
      ...(data === undefined ? {} : { data }),
      timeout: 30_000,
    });
    assert.ok(
      response.ok(),
      `${method} ${route}: ${response.status()} ${await response.text()}`,
    );
    return response.json();
  }

  action(tabId, action, input) {
    return this.json("POST", `/api/tabs/${tabId}/actions`, { action, input });
  }

  async seed() {
    // This is native Codex's supported user configuration, isolated from the controller's home.
    const codexHome = path.join(this.home, ".codex");
    await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      [
        '# CloudX launch preferences: {"defaultSkills":{"imagegen":false}}',
        "check_for_update_on_startup = false",
        'model = "cloudx-native"',
        'model_provider = "cloudx-native"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        "[model_providers.cloudx-native]",
        'name = "CloudX lifecycle test"',
        `base_url = ${JSON.stringify(this.provider.baseURL)}`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        `[projects.${JSON.stringify(this.repoRoot)}]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const settings = {
      themeId: "minimalist-dark",
      uiScale: 105,
      microphoneEnabled: false,
    };
    await this.json("PATCH", "/api/config", { global: settings });
    const created = await this.json("POST", "/api/windows", {
      name: "Lifecycle preserved workspace",
      defaultCwd: this.repoRoot,
    });
    const window = created.windows.find(
      (item) => item.id === created.activeWindowId,
    );
    assert.ok(window);
    const firstPane = window.layout.activePaneId;
    const shell = await this.json("POST", "/api/tabs", {
      pluginId: "standard-terminal",
      title: "Lifecycle preserved shell",
      cwd: this.repoRoot,
      windowId: window.id,
      paneId: firstPane,
    });
    const secondPane = randomUUID();
    await this.json("PATCH", `/api/windows/${window.id}`, {
      layout: {
        activePaneId: secondPane,
        root: {
          type: "split",
          id: randomUUID(),
          direction: "row",
          sizes: [43, 57],
          children: [
            {
              type: "pane",
              pane: {
                id: firstPane,
                tabIds: [shell.tab.id],
                activeTabId: shell.tab.id,
              },
            },
            { type: "pane", pane: { id: secondPane, tabIds: [] } },
          ],
        },
      },
    });
    await this.page.goto("/", { waitUntil: "domcontentloaded" });
    await this.expect(this.page.locator(".workspace-pane")).toHaveCount(2);
    const shellMarker = `lifecycle-${randomUUID()}`;
    await this.action(shell.tab.id, "enter_text", {
      text: `CLOUDX_LIFECYCLE_ID='${shellMarker}'; printf '\\nLIFECYCLE_BEFORE:%s:%s\\n' "$CLOUDX_LIFECYCLE_ID" "$$"`,
      submit: true,
    });
    const shellOutput = await this.readTerminal(
      shell.tab.id,
      `LIFECYCLE_BEFORE:${shellMarker}:`,
    );
    const shellPid = Number(
      shellOutput.match(
        new RegExp(`LIFECYCLE_BEFORE:${shellMarker}:(\\d+)`),
      )?.[1],
    );
    assert.ok(
      Number.isInteger(shellPid) && shellPid > 0,
      "The seeded shell must report its real PID.",
    );

    await this.page
      .locator(".workspace-pane.active")
      .getByTitle("Add tab to this pane")
      .click();
    await this.page.getByLabel("Plugin").selectOption("codex-terminal");
    await this.page.getByLabel("Title").fill("Lifecycle preserved Codex");
    const [response] = await Promise.all([
      this.page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/tabs",
      ),
      this.page.getByRole("button", { name: "Create", exact: true }).click(),
    ]);
    assert.equal(response.status(), 201);
    const codex = (await response.json()).tab;
    this.seeded = {
      settings,
      windowId: window.id,
      shellTabId: shell.tab.id,
      shellMarker,
      shellPid,
      codexTabId: codex.id,
    };
    await this.submitInitialPrompt();
    await waitFor("native conversation completion", async () => {
      const current = await this.readConversation();
      if (!current) return false;
      return current.transcript
        .toString("utf8")
        .includes('"type":"task_complete"')
        ? current
        : false;
    });
    await this.action(codex.id, "wait_until_ready", { timeoutMs: 30_000 });
    await waitFor("native conversation title", () =>
      this.provider.requests.includes("title"),
    );
    const conversation = await this.readConversation();
    const evidence = conversationEvidence(
      conversation.binding,
      conversation.receipt,
      conversation.transcript,
      conversation.canonicalTranscriptPath,
    );
    assert.equal(evidence.conversationId, this.seeded.conversationId);
    assert.equal(conversation.receipt.tabId, codex.id);
    assert.equal(conversation.binding.home, codexHome);
    this.seeded = {
      ...this.seeded,
      ...evidence,
      binding: conversation.binding,
      receipt: conversation.receipt,
      providerRequests: [...this.provider.requests],
    };
    await this.json("POST", "/api/workspace/persist");
    const workspace = await this.json("GET", "/api/workspace");
    this.seeded.layout = workspace.windows.find(
      (item) => item.id === window.id,
    ).layout;
    await fs.writeFile(
      path.join(this.evidenceDir, "profile-before.json"),
      `${JSON.stringify(this.seeded, null, 2)}\n`,
    );
    return this.seeded;
  }

  async readSelectedConversation() {
    const view = path.join(
      this.dataDir,
      "codex-launches",
      this.seeded.codexTabId,
    );
    try {
      const binding = JSON.parse(
        await fs.readFile(path.join(view, ".cloudx-source.json"), "utf8"),
      );
      const receipt = JSON.parse(
        await fs.readFile(path.join(view, ".cloudx-conversation.json"), "utf8"),
      );
      assert.equal(
        receipt.version,
        2,
        "A native v2 selection receipt is required before submitting a prompt.",
      );
      assert.equal(receipt.authority, "selected");
      assert.equal(receipt.tabId, this.seeded.codexTabId);
      assert.equal(receipt.cwd, this.repoRoot);
      for (const id of [receipt.sessionId, receipt.executionId]) {
        assert.match(id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
      }
      return { binding, receipt };
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async submitInitialPrompt() {
    const selected = await waitFor(
      "native conversation selection before the initial prompt",
      () => this.readSelectedConversation(),
      30_000,
    );
    this.seeded.conversationId = selected.receipt.sessionId;
    const readiness = await this.action(
      this.seeded.codexTabId,
      "wait_until_ready",
      { timeoutMs: 30_000 },
    );
    assert.equal(
      readiness.result.ready,
      true,
      "The selected Codex process must respond before submitting a prompt.",
    );
    await this.action(this.seeded.codexTabId, "enter_text", {
      text: prompt,
      submit: true,
    });
  }

  async readConversation() {
    const selected = await this.readSelectedConversation();
    if (!selected?.receipt.transcriptPath) return undefined;
    try {
      return {
        ...selected,
        canonicalTranscriptPath: await fs.realpath(
          selected.receipt.transcriptPath,
        ),
        transcript: await fs.readFile(selected.receipt.transcriptPath),
      };
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async requireRecoveredConversation() {
    const readiness = await this.action(
      this.seeded.codexTabId,
      "wait_until_ready",
      { timeoutMs: 30_000 },
    );
    assert.equal(
      readiness.result.ready,
      true,
      "The recovered Codex process must respond before recovery is accepted.",
    );
    const resumed = await waitFor(
      "the recovered native conversation selection receipt",
      () => this.readConversation(),
      30_000,
    );
    assertPreservedConversation(
      this.seeded,
      resumed.binding,
      resumed.receipt,
      resumed.transcript,
      resumed.canonicalTranscriptPath,
    );
  }

  async readTerminal(tabId, marker, input) {
    return this.page.evaluate(
      ({ tabId, marker, input }) =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(
            `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/terminal/${tabId}`,
          );
          let output = "";
          let completed = false;
          const finish = (error) => {
            if (completed) return;
            completed = true;
            clearTimeout(timer);
            socket.close();
            error ? reject(new Error(error)) : resolve(output);
          };
          const timer = setTimeout(
            () =>
              finish("Terminal did not become attachable before its deadline."),
            30_000,
          );
          socket.onopen = () => {
            if (input)
              socket.send(
                JSON.stringify({ type: "input", data: `${input}\r` }),
              );
          };
          socket.onerror = () => finish("Terminal websocket failed.");
          socket.onclose = () => {
            if (!completed)
              finish("Terminal closed before returning the expected output.");
          };
          socket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === "data" || message.type === "screen")
              output = (output + message.data).slice(-131_072);
            if (output.includes(marker)) finish();
          };
        }),
      { tabId, marker, input },
    );
  }

  async openUpdates() {
    await this.page
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    const settings = this.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings.getByRole("tab", { name: "Updates", exact: true }).click();
    return settings.getByRole("region", {
      name: "CloudX updates",
      exact: true,
    });
  }

  async update({ targetSha, timeoutMs = 40 * 60_000 }) {
    const [previewResponse, panel] = await Promise.all([
      this.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/system/update/preview" &&
          response.request().method() === "GET",
      ),
      this.openUpdates(),
    ]);
    const preview = await previewResponse.json();
    assert.equal(
      preview.target?.commit,
      targetSha,
      "Settings must select the pinned candidate.",
    );
    const [launched] = await Promise.all([
      this.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/system/update" &&
          response.request().method() === "POST",
      ),
      panel
        .getByRole("button", {
          name: "Update CloudX and dependencies",
          exact: true,
        })
        .click(),
    ]);
    let status = await launched.json();
    if (status.confirmation) {
      assert.equal(status.confirmation.targetCommit, targetSha);
      assert.equal(
        status.confirmation.restoreSnapshotRunId,
        undefined,
        "Forward acceptance must not restore a downgrade snapshot.",
      );
      await panel
        .getByLabel(
          "I understand that affected terminal sessions and running work will be interrupted.",
        )
        .check();
      const [confirmed] = await Promise.all([
        this.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/system/update" &&
            response.request().method() === "POST",
        ),
        panel
          .getByRole("button", {
            name: "Confirm interruption and continue",
            exact: true,
          })
          .click(),
      ]);
      status = await confirmed.json();
      this.interruptionConfirmed = true;
    }
    assert.equal(
      status.run?.state,
      "running",
      `Settings did not launch the update: ${JSON.stringify(status)}`,
    );
    assert.equal(status.run.targetCommit, targetSha);
    this.updateRunId = status.run.id;
    await fs.writeFile(
      path.join(this.evidenceDir, "settings-update-launch.json"),
      `${JSON.stringify(status, null, 2)}\n`,
    );
    let reconnects = 0;
    this.page.on("framenavigated", (frame) => {
      if (frame === this.page.mainFrame()) reconnects += 1;
    });
    const completed = await waitFor(
      "durable Settings update completion",
      async () => {
        let response;
        try {
          response = await this.context.request.get("/api/system/update", {
            timeout: 5000,
          });
        } catch (error) {
          if (
            /ECONNREFUSED|ECONNRESET|socket hang up|Timeout|ETIMEDOUT/.test(
              error.message,
            )
          )
            return false;
          throw error;
        }
        if (response.status() === 503) return false;
        assert.ok(
          response.ok(),
          `Update status returned HTTP ${response.status()}.`,
        );
        const current = await response.json();
        assert.equal(
          current.run?.id,
          this.updateRunId,
          "The durable update record changed identity.",
        );
        assert.notEqual(
          current.run.state,
          "failed",
          JSON.stringify(current.run),
        );
        if (current.run.state !== "succeeded") return false;
        assert.equal(current.run.targetCommit, targetSha);
        return current;
      },
      timeoutMs,
    );
    await this.expect
      .poll(() => reconnects, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await this.expect(this.page.locator(".workspace-pane")).toHaveCount(2);
    assert.equal(
      await this.page.evaluate(() =>
        sessionStorage.getItem("cloudx.update.reloadedRun"),
      ),
      this.updateRunId,
      "The source Settings observer must reload after durable completion.",
    );
    await fs.writeFile(
      path.join(this.evidenceDir, "settings-update-completed.json"),
      `${JSON.stringify({ ...completed, interruptionConfirmed: this.interruptionConfirmed, reconnects }, null, 2)}\n`,
    );
    return completed;
  }

  async verifyPreservedProfile({ requiresInterruption }) {
    assert.equal(
      this.interruptionConfirmed,
      requiresInterruption,
      "The durable interruption plan must match the consent given through Settings.",
    );
    const config = await this.json("GET", "/api/config");
    for (const [key, value] of Object.entries(this.seeded.settings))
      assert.equal(config.values.global[key], value);
    const workspace = await this.json("GET", "/api/workspace");
    const window = workspace.windows.find(
      (item) => item.id === this.seeded.windowId,
    );
    assert.equal(window?.name, "Lifecycle preserved workspace");
    assert.deepEqual(
      window.layout,
      this.seeded.layout,
      "Saved workspace layout must survive exactly.",
    );
    for (const id of [this.seeded.shellTabId, this.seeded.codexTabId])
      assert.ok(
        workspace.tabs.some((tab) => tab.id === id),
        `Saved tab ${id} was lost.`,
      );
    const conversation = await this.readConversation();
    assert.ok(conversation, "Saved conversation evidence disappeared.");
    assertPreservedConversation(
      this.seeded,
      conversation.binding,
      conversation.receipt,
      conversation.transcript,
      conversation.canonicalTranscriptPath,
    );
    assert.deepEqual(
      this.provider.requests,
      this.seeded.providerRequests,
      "Update replayed a native prompt.",
    );
    if (!this.interruptionConfirmed) {
      assert.equal(
        conversation.receipt.executionId,
        this.seeded.receipt.executionId,
        "A compatible upgrade must preserve the Codex execution.",
      );
      for (const id of [this.seeded.shellTabId, this.seeded.codexTabId]) {
        assert.equal(
          workspace.tabs.find((tab) => tab.id === id).status,
          "running",
          "A compatible terminal stopped during update.",
        );
      }
      const marker = `LIFECYCLE_AFTER:${this.seeded.shellMarker}:${this.seeded.shellPid}`;
      await this.readTerminal(
        this.seeded.shellTabId,
        marker,
        'printf \'\\nLIFECYCLE_AFTER:%s:%s\\n\' "$CLOUDX_LIFECYCLE_ID" "$$"',
      );
      await this.readTerminal(this.seeded.codexTabId, "Codex");
      const readiness = await this.action(
        this.seeded.codexTabId,
        "wait_until_ready",
        { timeoutMs: 30_000 },
      );
      assert.equal(
        readiness.result.ready,
        true,
        "The preserved Codex process must still respond after update.",
      );
    } else {
      const saved = JSON.parse(
        await fs.readFile(path.join(this.dataDir, "sessions.json"), "utf8"),
      );
      const codex = saved.sessions.find(
        (item) => item.tab.id === this.seeded.codexTabId,
      );
      assert.equal(
        codex?.initialInput?.resume?.sessionId,
        this.seeded.conversationId,
        "Interrupted Codex must retain its exact recovery identity.",
      );
      const recovery = workspace.tabs.find(
        (tab) => tab.id === this.seeded.codexTabId,
      ).recovery;
      assert.equal(
        recovery?.canResume,
        true,
        "The target must offer recovery for the saved conversation.",
      );
      assert.equal(recovery.conversationId, this.seeded.conversationId);
      await this.json("POST", `/api/tabs/${this.seeded.codexTabId}/recover`, {
        action: "resume-conversation",
        sessionId: this.seeded.conversationId,
      });
      await this.requireRecoveredConversation();
      assert.deepEqual(
        this.provider.requests,
        this.seeded.providerRequests,
        "Conversation recovery replayed a native prompt.",
      );
      await this.json("POST", `/api/tabs/${this.seeded.shellTabId}/recover`, {
        action: "new-shell",
      });
      const shell = await this.readTerminal(
        this.seeded.shellTabId,
        "LIFECYCLE_RECOVERED::",
        'printf \'\\nLIFECYCLE_RECOVERED:%s:%s\\n\' "$CLOUDX_LIFECYCLE_ID" "$$"',
      );
      assert.ok(
        !shell.includes(this.seeded.shellMarker),
        "Shell recovery replayed the original command.",
      );
    }
    return {
      settingsPreserved: true,
      layoutPreserved: true,
      conversationEvidencePreserved: true,
      promptReplayed: false,
      terminals: this.interruptionConfirmed
        ? "confirmed interruption; exact saved conversation resumed without replay"
        : "same shell PID and state; Codex attachable",
    };
  }

  async verify({ targetSha, requiresInterruption }) {
    const preserved = await this.verifyPreservedProfile({
      requiresInterruption,
    });
    const [previewResponse, panel] = await Promise.all([
      this.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/system/update/preview" &&
          response.request().method() === "GET",
      ),
      this.openUpdates(),
    ]);
    const preview = await previewResponse.json();
    assert.equal(preview.currentCommit, targetSha);
    assert.equal(preview.target?.commit, targetSha);
    assert.equal(preview.runtime?.commit, targetSha);
    assert.equal(preview.runtime?.verification, "verified");
    assert.equal(preview.state, "current");
    await this.expect(
      panel.getByRole("button", {
        name: "Update CloudX and dependencies",
        exact: true,
      }),
    ).toBeEnabled();
    assert.deepEqual(
      this.browserErrors,
      [],
      "The served frontend raised browser errors.",
    );
    await this.page.screenshot({
      path: path.join(this.evidenceDir, "settings-after.png"),
      fullPage: true,
    });
    const result = { ...preserved, nextPreflight: preview };
    await fs.writeFile(
      path.join(this.evidenceDir, "profile-after.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    return result;
  }

  async close() {
    try {
      if (this.context)
        await this.context.tracing.stop({
          path: path.join(this.evidenceDir, "browser-trace.zip"),
        });
    } finally {
      try {
        await this.browser?.close();
      } finally {
        await this.provider?.close();
      }
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitFor(description, observe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await observe();
    if (value) return value;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}.`);
}
