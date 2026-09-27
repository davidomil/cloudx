import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const PROMPT =
  "Save this synthetic CloudX lifecycle conversation. Do not call tools.";
const ANSWER = "The synthetic lifecycle conversation is saved.";
const SHELL_IDENTITY = "cloudx-lifecycle-original-shell";

/** A local Responses provider; the installer still chooses and installs the real Codex binary. */
export async function startProfileProvider({ home, repoRoot }) {
  const requests = [];
  const server = createServer((request, response) => {
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
      // Record only counts/purpose. Neither request prompts nor authentication enter CI artifacts.
      requests.push(purpose);
      const text =
        purpose === "title"
          ? '{"title":"Synthetic lifecycle conversation"}'
          : ANSWER;
      const id = `lifecycle_${requests.length}`;
      const item = {
        type: "message",
        id: `msg_${id}`,
        role: "assistant",
        phase: "final_answer",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { id, status: "in_progress", output: [] },
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
            id,
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
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const codexHome = path.join(home, ".codex");
  try {
    await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      [
        '# CloudX launch preferences: {"yoloMode":true,"defaultSkills":{"imagegen":false}}',
        'model = "cloudx-lifecycle"',
        'model_provider = "cloudx-lifecycle"',
        "check_for_update_on_startup = false",
        "[model_providers.cloudx-lifecycle]",
        'name = "Synthetic lifecycle provider"',
        `base_url = "${origin}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        `[projects.${JSON.stringify(repoRoot)}]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "cloudx-lifecycle-synthetic-key" }),
      { mode: 0o600 },
    );
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    origin,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Seed through the installed server and its New tab UI, never saved-session fixture files. */
export async function seedProfile({
  page,
  request,
  repoRoot,
  home,
  origin,
  dataDir,
  provider,
  source,
  target,
  runAsUser,
}) {
  const api = applicationApi(request, origin);
  const settings = {
    uiScale: 110,
    microphoneEnabled: false,
    voiceCommandsEnabled: false,
  };
  await api("PATCH", "/api/config", { global: settings });
  const workspace = await api("GET", "/api/workspace");
  const window = workspace.windows.find(
    (value) => value.id === workspace.activeWindowId,
  );
  assert(
    window,
    "The installed application must create its initial workspace.",
  );
  await api("PATCH", `/api/windows/${window.id}`, {
    name: "Lifecycle profile",
    defaultCwd: repoRoot,
  });
  const { tab: shell } = await api("POST", "/api/tabs", {
    pluginId: "standard-terminal",
    cwd: repoRoot,
    title: "Lifecycle shell",
    windowId: window.id,
    paneId: window.layout.activePaneId,
  });
  const commandLog = path.join(home, "lifecycle-command-log.txt");
  await attachTerminal(page, origin, shell.id);
  await enterText(
    api,
    shell.id,
    `export CLOUDX_LIFECYCLE_SHELL=${quoteShell(SHELL_IDENTITY)}; printf 'seeded\\n' >> ${quoteShell(commandLog)}`,
  );
  await until(
    async () => (await readOptional(commandLog))?.toString() === "seeded\n",
    "Original shell command did not complete.",
  );

  await page.goto(origin);
  await page
    .getByTitle("Workspace windows", { exact: true })
    .filter({ hasText: "Lifecycle profile" })
    .waitFor();
  await page
    .locator(".workspace-pane.active")
    .getByTitle("Add tab to this pane")
    .click();
  await page.getByLabel("Plugin").selectOption("codex-terminal");
  await page.getByLabel("Session", { exact: true }).selectOption("new");
  await page.getByLabel("New tab directory", { exact: true }).fill(repoRoot);
  await page.getByLabel("Title", { exact: true }).fill("Lifecycle Codex");
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/tabs",
  );
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const created = await creation;
  assert.equal(
    created.status(),
    201,
    `New Codex tab failed: ${await created.text()}`,
  );
  assert.equal(
    created.request().postDataJSON().initialInput?.resume,
    undefined,
    "The fixture must create a new conversation.",
  );
  const { tab: codex } = await created.json();
  const launchView = path.join(dataDir, "codex-launches", codex.id);
  const receiptPath = path.join(launchView, ".cloudx-conversation.json");
  const bindingPath = path.join(launchView, ".cloudx-source.json");
  await until(
    async () => Boolean((await readJsonOptional(receiptPath))?.sessionId),
    "Native Codex did not publish its production selection receipt.",
    45_000,
  );
  const selected = await readJsonOptional(receiptPath);
  assert.equal(selected.authority, "selected");
  assert.equal(selected.tabId, codex.id);
  const binding = JSON.parse(await fs.readFile(bindingPath, "utf8"));
  assert.equal(binding.sourceId, "shared");
  assert.equal(binding.home, await fs.realpath(path.join(home, ".codex")));
  assert.equal(
    await fs.realpath(path.join(launchView, "sessions")),
    path.join(binding.home, "sessions"),
  );
  await api("POST", `/api/tabs/${codex.id}/actions`, {
    action: "wait_until_ready",
    input: { timeoutMs: 30_000 },
  });
  const requestsBeforePrompt = conversationCount(provider);
  await enterText(api, codex.id, PROMPT);
  await until(
    async () => {
      const receipt = await readJsonOptional(receiptPath);
      const bytes =
        receipt?.transcriptPath && (await readOptional(receipt.transcriptPath));
      return (
        bytes &&
        transcriptEvents(bytes).some(
          (event) =>
            event.type === "event_msg" &&
            event.payload?.type === "task_complete" &&
            event.payload.last_agent_message === ANSWER,
        )
      );
    },
    "The installed Codex never saved the synthetic completed turn.",
    45_000,
  );
  assert.equal(
    conversationCount(provider),
    requestsBeforePrompt + 1,
    "The local provider must receive one conversation turn.",
  );
  await until(
    () => provider.requests.includes("title"),
    "Native Codex did not complete conversation title generation.",
  );
  const receipt = await readJsonOptional(receiptPath);
  assert.equal(receipt.sessionId, selected.sessionId);
  const transcriptPath = await fs.realpath(receipt.transcriptPath);
  assert(
    transcriptPath.startsWith(`${binding.home}/sessions/`),
    "The production transcript must live in the shared source.",
  );
  const transcript = await stableBytes(transcriptPath);
  assert.equal(transcriptEvents(transcript)[0].payload.id, selected.sessionId);

  const layout = {
    activePaneId: "lifecycle-codex-pane",
    root: {
      type: "split",
      id: "lifecycle-split",
      direction: "row",
      sizes: [40, 60],
      children: [
        {
          type: "pane",
          pane: {
            id: "lifecycle-shell-pane",
            tabIds: [shell.id],
            activeTabId: shell.id,
          },
        },
        {
          type: "pane",
          pane: {
            id: "lifecycle-codex-pane",
            tabIds: [codex.id],
            activeTabId: codex.id,
          },
        },
      ],
    },
  };
  await api("PATCH", `/api/windows/${window.id}`, { layout });
  await api("POST", "/api/workspace/persist");
  const unrelatedFiles = await seedLocalWork(
    repoRoot,
    source,
    target,
    runAsUser,
  );
  // Refresh the browser's layout authority before Settings flushes pending workspace state.
  await page.reload();
  await page.locator(".workspace-pane").nth(1).waitFor();
  return {
    settings,
    windowId: window.id,
    layout,
    shellId: shell.id,
    codexId: codex.id,
    commandLog,
    receiptPath,
    bindingPath,
    binding: await fs.readFile(bindingPath),
    sessionId: selected.sessionId,
    transcriptPath,
    transcript,
    transcriptSha256: digest(transcript),
    conversationRequests: conversationCount(provider),
    unrelatedFiles,
    allowedStatusPaths: unrelatedFiles.map((value) => value.relativePath),
  };
}

/** First prove preservation, then use explicit recovery only when Settings disclosed an interruption. */
export async function verifyProfile({
  page,
  request,
  origin,
  snapshot,
  provider,
  interruptionConfirmed = false,
}) {
  const api = applicationApi(request, origin);
  const config = await api("GET", "/api/config");
  for (const [key, value] of Object.entries(snapshot.settings))
    assert.equal(config.values.global[key], value, `Setting ${key} changed.`);
  let workspace = await api("GET", "/api/workspace");
  const window = workspace.windows.find(
    (value) => value.id === snapshot.windowId,
  );
  assert.equal(window?.name, "Lifecycle profile");
  assert.deepEqual(
    window.layout,
    snapshot.layout,
    "Saved pane placement changed.",
  );
  for (const file of snapshot.unrelatedFiles)
    assert.deepEqual(
      await fs.readFile(file.path),
      file.bytes,
      `Unrelated local work changed: ${file.relativePath}`,
    );
  assert.deepEqual(
    await fs.readFile(snapshot.bindingPath),
    snapshot.binding,
    "Codex source binding changed.",
  );
  await verifySavedConversation(snapshot, provider);
  assert.equal(
    await fs.readFile(snapshot.commandLog, "utf8"),
    "seeded\n",
    "A saved shell command was replayed.",
  );

  let recoveredShell = false;
  let recoveredConversation = false;
  for (const tabId of [snapshot.shellId, snapshot.codexId]) {
    const tab = workspace.tabs.find((value) => value.id === tabId);
    assert(tab, `Saved tab ${tabId} disappeared.`);
    if (tab.recovery) {
      assert(
        interruptionConfirmed,
        "A compatible terminal was interrupted without a disclosed Settings confirmation.",
      );
      if (tabId === snapshot.shellId) {
        await api("POST", `/api/tabs/${tabId}/recover`, {
          action: "new-shell",
        });
        recoveredShell = true;
      } else {
        assert.equal(
          tab.recovery.canResume,
          true,
          "The exact saved conversation must remain recoverable.",
        );
        assert.equal(tab.recovery.conversationId, snapshot.sessionId);
        await api("POST", `/api/tabs/${tabId}/recover`, {
          action: "resume-conversation",
          sessionId: snapshot.sessionId,
        });
        recoveredConversation = true;
      }
    }
    await attachTerminal(page, origin, tabId);
  }
  if (recoveredConversation) {
    await until(
      async () =>
        (await readJsonOptional(snapshot.receiptPath))?.sessionId ===
        snapshot.sessionId,
      "Recovery selected a different saved conversation.",
    );
    await api("POST", `/api/tabs/${snapshot.codexId}/actions`, {
      action: "wait_until_ready",
      input: { timeoutMs: 30_000 },
    });
  }
  const shellProof = `${snapshot.commandLog}.attached`;
  await enterText(
    api,
    snapshot.shellId,
    `printf '%s' "$CLOUDX_LIFECYCLE_SHELL" > ${quoteShell(shellProof)}; printf 'attached\\n' >> ${quoteShell(snapshot.commandLog)}`,
  );
  await until(
    async () =>
      (await readOptional(snapshot.commandLog))?.toString() ===
      "seeded\nattached\n",
    "The restored shell is not attachable.",
  );
  assert.equal(
    await fs.readFile(shellProof, "utf8"),
    recoveredShell ? "" : SHELL_IDENTITY,
    "A compatible shell was silently replaced.",
  );
  await verifySavedConversation(snapshot, provider, {
    resumed: recoveredConversation,
  });
  workspace = await api("GET", "/api/workspace");
  for (const id of [snapshot.shellId, snapshot.codexId])
    assert.equal(
      workspace.tabs.find((tab) => tab.id === id)?.recovery,
      undefined,
    );
  return {
    transcriptSha256: snapshot.transcriptSha256,
    shell: recoveredShell
      ? "explicitly recovered"
      : "original process attached",
    conversation: recoveredConversation
      ? "exact session resumed without replay"
      : "original conversation attached",
  };
}

export async function verifySavedConversation(
  snapshot,
  provider,
  { resumed = false } = {},
) {
  const bytes = await fs.readFile(snapshot.transcriptPath);
  assert.deepEqual(
    resumed ? bytes.subarray(0, snapshot.transcript.length) : bytes,
    snapshot.transcript,
    "Saved conversation source bytes changed.",
  );
  assert.equal(
    conversationCount(provider),
    snapshot.conversationRequests,
    "Recovery replayed a model prompt.",
  );
  assert.equal(
    (await readJsonOptional(snapshot.receiptPath))?.sessionId,
    snapshot.sessionId,
    "The exact saved conversation identity changed.",
  );
}

function applicationApi(request, origin) {
  return async (method, endpoint, data) => {
    const response = await request.fetch(`${origin}${endpoint}`, {
      method,
      ...(data === undefined ? {} : { data }),
      headers: { origin },
    });
    assert(
      response.ok(),
      `${method} ${endpoint} failed (${response.status()}): ${await response.text()}`,
    );
    return response.json();
  };
}

async function enterText(api, tabId, text) {
  await api("POST", `/api/tabs/${tabId}/actions`, {
    action: "enter_text",
    input: { text, submit: true },
  });
}

async function attachTerminal(page, origin, tabId) {
  // A new production socket must receive the broker's current screen, not just find a saved tab.
  if (new URL(page.url()).origin !== origin) await page.goto(origin);
  await page.evaluate(
    ({ origin, tabId }) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(
          `${origin.replace(/^http/, "ws")}/ws/terminal/${tabId}`,
        );
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("Terminal attachment timed out."));
        }, 15_000);
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.type !== "screen") return;
          clearTimeout(timeout);
          socket.close();
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          socket.close();
          reject(new Error("Terminal attachment failed."));
        };
        socket.onclose = (event) => {
          clearTimeout(timeout);
          if (event.code !== 1000)
            reject(new Error(`Terminal socket closed: ${event.code}`));
        };
      }),
    { origin, tabId },
  );
}

async function seedLocalWork(repoRoot, source, target, runAsUser) {
  assert(
    source && target,
    "Immutable source and target are required to choose unrelated local work.",
  );
  assert.equal(
    typeof runAsUser,
    "function",
    "Git must run as the installed application user.",
  );
  const changed = new Set(
    (
      await runAsUser("git", ["diff", "--name-only", "-z", source, target], {
        cwd: repoRoot,
      })
    ).split("\0"),
  );
  const tracked = (
    await runAsUser("git", ["ls-files", "-z"], { cwd: repoRoot })
  ).split("\0");
  const owner = await fs.stat(repoRoot);
  const candidates = [
    "README.md",
    "CONTRIBUTING.md",
    "LICENSE",
    ...tracked
      .filter((value) => value.startsWith("docs/") && value.endsWith(".md"))
      .sort(),
  ];
  const relativePath = candidates.find(
    (value) => tracked.includes(value) && !changed.has(value),
  );
  assert(
    relativePath,
    "No unchanged tracked document is available for the local-work fixture.",
  );
  const edits = [
    { relativePath, append: "\nSynthetic lifecycle local work.\n" },
    {
      relativePath: "lifecycle-local-work.txt",
      append: "Synthetic untracked lifecycle work.\n",
    },
  ];
  const files = [];
  for (const edit of edits) {
    const file = path.join(repoRoot, edit.relativePath);
    await fs.appendFile(file, edit.append);
    await fs.chown(file, owner.uid, owner.gid);
    files.push({
      relativePath: edit.relativePath,
      path: file,
      bytes: await fs.readFile(file),
    });
  }
  return files;
}

async function stableBytes(file) {
  let previous = await fs.readFile(file);
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(250);
    const current = await fs.readFile(file);
    if (current.equals(previous)) return current;
    previous = current;
  }
  throw new Error("Native conversation did not become idle.");
}

async function until(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(200);
  }
  throw new Error(message);
}

async function readOptional(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJsonOptional(file) {
  const bytes = await readOptional(file);
  return bytes && JSON.parse(bytes.toString());
}

function transcriptEvents(bytes) {
  return bytes
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}
function conversationCount(provider) {
  return provider.requests.filter((value) => value === "conversation").length;
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
