import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertPreservedConversation,
  conversationEvidence,
  LifecycleBrowserProfile,
  NativeLifecycleProvider,
} from "./lifecycle-browser.mjs";

function savedConversation() {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const binding = {
    version: 1,
    sourceId: "source",
    home: "/isolated/.codex",
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
