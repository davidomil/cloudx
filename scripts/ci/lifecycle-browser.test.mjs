import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertPreservedConversation,
  conversationEvidence,
  LifecycleBrowserProfile,
  NativeLifecycleProvider,
} from "./lifecycle-browser.mjs";

it("propagates a missing Settings response so lifecycle cleanup can retain the browser trace", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { LifecycleBrowserProfile } from ${JSON.stringify(new URL("./lifecycle-browser.mjs", import.meta.url).href)};
    const profile = new LifecycleBrowserProfile({ evidenceDir: "/unused" });
    const blockedClick = new Promise(() => {});
    profile.openUpdates = async () => ({ getByRole: () => ({ click: () => blockedClick }) });
    let requests = 0;
    profile.page = { waitForResponse: () => ++requests === 1
      ? Promise.resolve({ json: async () => ({ target: { commit: "candidate" } }) })
      : new Promise((resolve, reject) => setImmediate(() => reject(new Error("Update POST timed out")))) };
    profile.context = { tracing: { stop: async () => console.log("trace retained") } };
    try {
      await profile.update({ targetSha: "candidate" });
      process.exitCode = 1;
    } catch (error) {
      console.log(error.message);
    } finally {
      await profile.close();
    }
  `,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Update POST timed out");
  expect(result.stdout).toContain("trace retained");
});

function savedConversation(home = "/isolated/.codex") {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const binding = {
    version: 1,
    sourceId: "source",
    home,
    dev: "1",
    ino: "2",
  };
  const receipt = {
    version: 2,
    authority: "selected",
    sessionId,
    tabId: "tab",
    executionId: "12345678-1234-4234-8234-123456789def",
    cwd: "/workspace",
    transcriptPath: `${binding.home}/sessions/2026/09/28/rollout-${sessionId}.jsonl`,
  };
  const events = [
    { type: "session_meta", payload: { id: sessionId } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
    { type: "turn_context", payload: { turn_id: "turn" } },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn",
        last_agent_message: "The lifecycle acceptance conversation is saved.",
      },
    },
  ];
  const transcript = Buffer.from(
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return {
    binding,
    receipt,
    transcript,
    ...conversationEvidence(
      binding,
      receipt,
      transcript,
      receipt.transcriptPath,
    ),
  };
}

describe("saved lifecycle conversation evidence", () => {
  it("preserves the exact saved evidence while permitting metadata appended by a reconnect", () => {
    const before = savedConversation();
    const after = Buffer.concat([
      before.transcript,
      Buffer.from('{"type":"session_meta_update","payload":{}}\n'),
    ]);
    expect(() =>
      assertPreservedConversation(
        before,
        before.binding,
        before.receipt,
        after,
        before.canonicalTranscriptPath,
      ),
    ).not.toThrow();
  });

  it("rejects a modified or truncated saved transcript", () => {
    const before = savedConversation();
    const changed = Buffer.from(
      before.transcript.toString().replace("acceptance", "difference"),
    );
    expect(() =>
      assertPreservedConversation(
        before,
        before.binding,
        before.receipt,
        changed,
        before.canonicalTranscriptPath,
      ),
    ).toThrow(/modified/);
    expect(() =>
      assertPreservedConversation(
        before,
        before.binding,
        before.receipt,
        before.transcript.subarray(0, 10),
        before.canonicalTranscriptPath,
      ),
    ).toThrow(/truncated/);
  });

  it("rejects a replayed native prompt even when the old transcript remains intact", () => {
    const before = savedConversation();
    const after = Buffer.concat([
      before.transcript,
      Buffer.from(
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"replayed"}}\n',
      ),
    ]);
    expect(() =>
      assertPreservedConversation(
        before,
        before.binding,
        before.receipt,
        after,
        before.canonicalTranscriptPath,
      ),
    ).toThrow(/exactly once/);
  });

  it("rejects replaced source bindings and selected conversation identities", () => {
    const before = savedConversation();
    expect(() =>
      assertPreservedConversation(
        before,
        { ...before.binding, ino: "3" },
        before.receipt,
        before.transcript,
        before.canonicalTranscriptPath,
      ),
    ).toThrow(/binding changed/);
    expect(() =>
      assertPreservedConversation(
        before,
        before.binding,
        { ...before.receipt, sessionId: "another" },
        before.transcript,
        before.canonicalTranscriptPath,
      ),
    ).toThrow(/different conversation/);
  });

  it("requires a production selection receipt pointing to the shared source", () => {
    const before = savedConversation();
    expect(() =>
      conversationEvidence(
        before.binding,
        { ...before.receipt, version: undefined },
        before.transcript,
        before.canonicalTranscriptPath,
      ),
    ).toThrow(/selected-conversation/);
    expect(() =>
      conversationEvidence(
        before.binding,
        before.receipt,
        before.transcript,
        "/fabricated/session.jsonl",
      ),
    ).toThrow(/shared source/);
  });
});

describe("initial native conversation selection", () => {
  async function selectionProfile() {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-lifecycle-selection-"),
    );
    const profile = new LifecycleBrowserProfile({
      dataDir,
      repoRoot: "/workspace",
    });
    profile.seeded = { codexTabId: "tab" };
    profile.action = vi.fn().mockResolvedValue({ result: { ready: true } });
    const view = path.join(dataDir, "codex-launches", "tab");
    await fs.mkdir(view, { recursive: true });
    const { binding, receipt } = savedConversation();
    delete receipt.transcriptPath;
    await fs.writeFile(
      path.join(view, ".cloudx-source.json"),
      JSON.stringify(binding),
    );
    return {
      profile,
      dataDir,
      receipt,
      receiptPath: path.join(view, ".cloudx-conversation.json"),
    };
  }

  it("does not submit a prompt until the native selection exists, before any transcript file is created", async () => {
    const { profile, dataDir, receipt, receiptPath } = await selectionProfile();
    const readSelectedConversation =
      profile.readSelectedConversation.bind(profile);
    let reportFirstSelection;
    const firstSelection = new Promise((resolve) => {
      reportFirstSelection = resolve;
    });
    vi.spyOn(profile, "readSelectedConversation").mockImplementationOnce(
      async () => {
        const selected = await readSelectedConversation();
        reportFirstSelection(selected);
        return selected;
      },
    );
    try {
      const submitted = profile.submitInitialPrompt();
      await expect(firstSelection).resolves.toBeUndefined();
      expect(profile.action).not.toHaveBeenCalled();
      await fs.writeFile(receiptPath, JSON.stringify(receipt));
      await submitted;
      expect(profile.action.mock.calls).toEqual([
        ["tab", "wait_until_ready", { timeoutMs: 30_000 }],
        [
          "tab",
          "enter_text",
          {
            text: "Save this isolated lifecycle acceptance conversation.",
            submit: true,
          },
        ],
      ]);
      expect(profile.seeded.conversationId).toBe(receipt.sessionId);
      await expect(profile.readConversation()).resolves.toBeUndefined();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("requires a ready process after selection before entering text", async () => {
    const { profile, dataDir, receipt, receiptPath } = await selectionProfile();
    profile.action.mockResolvedValue({ result: { ready: false } });
    try {
      await fs.writeFile(receiptPath, JSON.stringify(receipt));
      await expect(profile.submitInitialPrompt()).rejects.toThrow(
        /must respond/,
      );
      expect(profile.action.mock.calls).toEqual([
        ["tab", "wait_until_ready", { timeoutMs: 30_000 }],
      ]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    { version: 1 },
    { authority: "legacy" },
    { tabId: "another-tab" },
    { sessionId: "invalid" },
    { executionId: "invalid" },
  ])(
    "rejects invalid selection evidence %j before entering any text",
    async (patch) => {
      const { profile, dataDir, receipt, receiptPath } =
        await selectionProfile();
      try {
        await fs.writeFile(
          receiptPath,
          JSON.stringify({ ...receipt, ...patch }),
        );
        await expect(profile.submitInitialPrompt()).rejects.toThrow();
        expect(profile.action).not.toHaveBeenCalled();
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    },
  );
});

describe("profile preservation after an update", () => {
  const replacementExecutionId = "12345678-1234-4234-8234-123456789fed";

  async function installedProfile() {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-lifecycle-preserved-"),
    );
    const profile = new LifecycleBrowserProfile({
      dataDir,
      repoRoot: "/workspace",
    });
    const before = savedConversation(path.join(dataDir, ".codex"));
    profile.seeded = {
      ...before,
      settings: { themeId: "minimalist-dark" },
      windowId: "window",
      layout: {
        activePaneId: "pane",
        root: {
          type: "pane",
          pane: {
            id: "pane",
            tabIds: ["shell", "tab"],
            activeTabId: "tab",
          },
        },
      },
      shellTabId: "shell",
      shellMarker: "saved-shell",
      shellPid: 123,
      codexTabId: "tab",
      providerRequests: ["conversation", "title"],
    };
    const workspace = {
      windows: [
        {
          id: "window",
          name: "Lifecycle preserved workspace",
          layout: profile.seeded.layout,
        },
      ],
      tabs: [
        { id: "shell", status: "running" },
        { id: "tab", status: "running" },
      ],
    };
    const view = path.join(dataDir, "codex-launches", "tab");
    const receiptPath = path.join(view, ".cloudx-conversation.json");
    await fs.mkdir(view, { recursive: true });
    await fs.mkdir(path.dirname(before.receipt.transcriptPath), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(view, ".cloudx-source.json"),
      JSON.stringify(before.binding),
    );
    await fs.writeFile(receiptPath, JSON.stringify(before.receipt));
    await fs.writeFile(before.receipt.transcriptPath, before.transcript);
    await fs.writeFile(
      path.join(dataDir, "sessions.json"),
      JSON.stringify({
        sessions: [
          {
            tab: { id: "tab" },
            initialInput: {
              resume: { sessionId: before.conversationId },
            },
          },
        ],
      }),
    );
    profile.provider = { requests: [...profile.seeded.providerRequests] };
    profile.action = vi
      .fn()
      .mockResolvedValue({ result: { ready: true } });
    profile.readTerminal = vi.fn(async (_tabId, marker) => marker);
    profile.json = vi.fn(async (method, route, data) => {
      if (method === "GET" && route === "/api/config")
        return { values: { global: { ...profile.seeded.settings } } };
      if (method === "GET" && route === "/api/workspace")
        return workspace;
      if (method === "POST" && route === "/api/tabs/tab/recover") {
        expect(data).toEqual({
          action: "resume-conversation",
          sessionId: before.conversationId,
        });
        await fs.writeFile(
          receiptPath,
          JSON.stringify({
            ...before.receipt,
            executionId: replacementExecutionId,
          }),
        );
        return {};
      }
      if (method === "POST" && route === "/api/tabs/shell/recover") {
        expect(data).toEqual({ action: "new-shell" });
        return {};
      }
      throw new Error(`Unexpected request: ${method} ${route}`);
    });
    return { profile, workspace, receiptPath };
  }

  it("accepts the same live Codex execution after a compatible upgrade", async () => {
    const { profile } = await installedProfile();
    try {
      await expect(
        profile.verifyPreservedProfile({
          requiresInterruption: false,
        }),
      ).resolves.toMatchObject({ conversationEvidencePreserved: true });
      expect(profile.readTerminal).toHaveBeenCalledWith("tab", "Codex");
      expect(profile.action).toHaveBeenCalledWith(
        "tab",
        "wait_until_ready",
        {
          timeoutMs: 30_000,
        },
      );
    } finally {
      await fs.rm(profile.dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a replaced Codex execution after a compatible upgrade despite readiness and preserved conversation evidence", async () => {
    const { profile, receiptPath } = await installedProfile();
    try {
      await fs.writeFile(
        receiptPath,
        JSON.stringify({
          ...profile.seeded.receipt,
          executionId: replacementExecutionId,
        }),
      );
      await expect(
        profile.verifyPreservedProfile({
          requiresInterruption: false,
        }),
      ).rejects.toThrow(
        /compatible upgrade must preserve the Codex execution/i,
      );
    } finally {
      await fs.rm(profile.dataDir, { recursive: true, force: true });
    }
  });

  it("accepts a new Codex execution when recovering after a confirmed interruption", async () => {
    const { profile, workspace } = await installedProfile();
    profile.interruptionConfirmed = true;
    for (const tab of workspace.tabs) tab.status = "exited";
    workspace.tabs[1].recovery = {
      canResume: true,
      conversationId: profile.seeded.conversationId,
    };
    try {
      await expect(
        profile.verifyPreservedProfile({
          requiresInterruption: true,
        }),
      ).resolves.toMatchObject({
        conversationEvidencePreserved: true,
        promptReplayed: false,
      });
      expect((await profile.readConversation()).receipt.executionId).toBe(
        replacementExecutionId,
      );
      expect(profile.json).toHaveBeenCalledWith(
        "POST",
        "/api/tabs/tab/recover",
        {
          action: "resume-conversation",
          sessionId: profile.seeded.conversationId,
        },
      );
      expect(profile.action).toHaveBeenCalledWith(
        "tab",
        "wait_until_ready",
        {
          timeoutMs: 30_000,
        },
      );
    } finally {
      await fs.rm(profile.dataDir, { recursive: true, force: true });
    }
  });
});

describe("interrupted native conversation recovery", () => {
  function recoveringProfile() {
    const profile = new LifecycleBrowserProfile({});
    profile.seeded = { ...savedConversation(), codexTabId: "tab" };
    profile.action = vi.fn().mockResolvedValue({ result: { ready: true } });
    return profile;
  }

  it("waits for the selection receipt published after terminal readiness", async () => {
    const profile = recoveringProfile();
    profile.readConversation = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(profile.seeded);
    await expect(
      profile.requireRecoveredConversation(),
    ).resolves.toBeUndefined();
    expect(profile.action).toHaveBeenCalledWith("tab", "wait_until_ready", {
      timeoutMs: 30_000,
    });
    expect(profile.readConversation).toHaveBeenCalledTimes(2);
  });

  it("rejects a readiness response that does not confirm a live recovered process", async () => {
    const profile = recoveringProfile();
    profile.action.mockResolvedValue({ result: { ready: false } });
    profile.readConversation = vi.fn();
    await expect(profile.requireRecoveredConversation()).rejects.toThrow(
      /must respond/,
    );
    expect(profile.readConversation).not.toHaveBeenCalled();
  });

  it("rejects incorrect published evidence instead of waiting for a different selection", async () => {
    const profile = recoveringProfile();
    profile.readConversation = vi.fn().mockResolvedValue({
      ...profile.seeded,
      receipt: { ...profile.seeded.receipt, sessionId: "wrong-conversation" },
    });
    await expect(profile.requireRecoveredConversation()).rejects.toThrow(
      /different conversation/,
    );
    expect(profile.readConversation).toHaveBeenCalledOnce();
  });
});

it("serves real Responses SSE for a native turn and its hidden title without credentials", async () => {
  const provider = await new NativeLifecycleProvider().start();
  try {
    for (const [input, expected] of [
      [{ input: [] }, "The lifecycle acceptance conversation is saved."],
      [
        { text: { format: { schema: { properties: { title: {} } } } } },
        '{"title":"Lifecycle acceptance conversation"}',
      ],
    ]) {
      const response = await fetch(`${provider.baseURL}/responses`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const events = (await response.text())
        .trim()
        .split("\n\n")
        .map((event) => JSON.parse(event.split("\ndata: ")[1]));
      expect(events.map((event) => event.type)).toEqual([
        "response.created",
        "response.output_item.added",
        "response.output_text.delta",
        "response.output_item.done",
        "response.completed",
      ]);
      expect(events.at(-1).response).toMatchObject({
        status: "completed",
        output: [{ content: [{ type: "output_text", text: expected }] }],
      });
    }
    expect(provider.requests).toEqual(["conversation", "title"]);
    expect((await fetch(`${provider.baseURL}/unknown`)).status).toBe(404);
    expect(
      (
        await fetch(`${provider.baseURL}/responses`, {
          method: "POST",
          body: "invalid",
        })
      ).status,
    ).toBe(400);
    expect(provider.requests).toHaveLength(2);
  } finally {
    await provider.close();
  }
});

describe("durable Settings update monitoring", () => {
  const targetSha = "b".repeat(40);
  const launchedRun = {
    id: "accepted-update",
    targetCommit: targetSha,
    state: "running",
  };
  const completedRun = { ...launchedRun, state: "succeeded" };

  function updateResponse(code, run) {
    return {
      status: () => code,
      ok: () => code === 200,
      json: vi.fn(async () => ({ available: true, run })),
    };
  }

  async function monitorUpdate(responses, timeoutMs = 2000) {
    const evidenceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-update-monitor-"),
    );
    const profile = new LifecycleBrowserProfile({ evidenceDir });
    const frame = {};
    profile.openUpdates = async () => ({
      getByRole: () => ({ click: async () => {} }),
    });
    profile.page = {
      waitForResponse: vi
        .fn()
        .mockResolvedValueOnce({
          json: async () => ({ target: { commit: targetSha } }),
        })
        .mockResolvedValueOnce(updateResponse(200, launchedRun)),
      on: (_event, navigated) => navigated(frame),
      mainFrame: () => frame,
      locator: () => ["shell-pane", "codex-pane"],
      evaluate: async () => launchedRun.id,
    };
    profile.expect = Object.assign(
      (panes) => ({
        toHaveCount: async (count) => expect(panes).toHaveLength(count),
      }),
      {
        poll: (read) => ({
          toBeGreaterThan: async (minimum) =>
            expect(read()).toBeGreaterThan(minimum),
        }),
      },
    );
    let responseIndex = 0;
    profile.context = {
      request: {
        get: async () =>
          responses[Math.min(responseIndex++, responses.length - 1)],
      },
    };
    try {
      const result = await profile.update({ targetSha, timeoutMs });
      const evidence = JSON.parse(
        await fs.readFile(
          path.join(evidenceDir, "settings-update-completed.json"),
          "utf8",
        ),
      );
      return { result, evidence };
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }

  it("waits through service shutdown HTTP 503 until the accepted durable run succeeds", async () => {
    const stopping = updateResponse(503);
    const completed = updateResponse(200, completedRun);
    await expect(monitorUpdate([stopping, completed])).resolves.toEqual({
      result: { available: true, run: completedRun },
      evidence: {
        available: true,
        run: completedRun,
        interruptionConfirmed: false,
        reconnects: 1,
      },
    });
    expect(stopping.json).not.toHaveBeenCalled();
    expect(completed.json).toHaveBeenCalledOnce();
  });

  it("fails at the monitoring deadline when HTTP 503 persists", async () => {
    const unavailable = updateResponse(503);
    await expect(monitorUpdate([unavailable], 600)).rejects.toThrow(
      "Timed out waiting for durable Settings update completion.",
    );
    expect(unavailable.json).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 500])(
    "rejects HTTP %i instead of waiting through an unrelated error",
    async (code) => {
      await expect(monitorUpdate([updateResponse(code)])).rejects.toThrow(
        `Update status returned HTTP ${code}.`,
      );
    },
  );

  it("rejects a durable failed run after a temporary HTTP 503", async () => {
    await expect(
      monitorUpdate([
        updateResponse(503),
        updateResponse(200, {
          ...launchedRun,
          state: "failed",
          message: "Activation failed",
        }),
      ]),
    ).rejects.toThrow("Activation failed");
  });

  it("rejects a different durable run after a temporary HTTP 503", async () => {
    await expect(
      monitorUpdate([
        updateResponse(503),
        updateResponse(200, { ...completedRun, id: "another-update" }),
      ]),
    ).rejects.toThrow("The durable update record changed identity.");
  });
});
