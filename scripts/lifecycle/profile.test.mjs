import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startProfileProvider,
  verifySavedConversation,
  waitForSavedTurn,
} from "./profile.mjs";

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryHome() {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-lifecycle-profile-"),
  );
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function savedTurnFixture(transcript) {
  const home = await temporaryHome();
  const transcriptPath = path.join(home, "conversation.jsonl");
  const receiptPath = path.join(home, "receipt.json");
  await fs.writeFile(transcriptPath, transcript);
  await fs.writeFile(receiptPath, JSON.stringify({ transcriptPath }));
  return { transcriptPath, receiptPath };
}

const completedTurn = JSON.stringify({
  type: "event_msg",
  payload: {
    type: "task_complete",
    last_agent_message: "The synthetic lifecycle conversation is saved.",
  },
});

describe("installed lifecycle conversation evidence", () => {
  it("waits through an empty transcript and partial records until the completed turn has a newline", async () => {
    const header = '{"type":"session_meta","payload":{"id":"original-id"}}\n';
    const snapshots = [
      "",
      header.slice(0, 12),
      header,
      header + completedTurn.slice(0, 30),
      header + completedTurn,
      header + completedTurn + '\n{"type":',
    ];
    const { transcriptPath, receiptPath } = await savedTurnFixture(
      snapshots[0],
    );
    const observed = [];
    const readFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(async (file, ...options) => {
      const bytes = await readFile(file, ...options);
      if (file === transcriptPath) {
        observed.push(bytes.toString());
        expect(observed.length).toBeLessThanOrEqual(snapshots.length);
        // Advance the writer only after this poll has captured its bytes.
        if (observed.length < snapshots.length)
          await fs.writeFile(transcriptPath, snapshots[observed.length]);
      }
      return bytes;
    });

    await expect(waitForSavedTurn(receiptPath)).resolves.toBeUndefined();
    expect(observed).toEqual(snapshots);
  });

  it.each([
    ["before completion", `{broken}\n${completedTurn}\n`],
    ["after completion", `${completedTurn}\n{broken}\n`],
    ["a blank completed record", `${completedTurn}\n\n`],
  ])("rejects malformed completed records: %s", async (_label, transcript) => {
    const { receiptPath } = await savedTurnFixture(transcript);
    await expect(waitForSavedTurn(receiptPath)).rejects.toThrow(SyntaxError);
  });

  it("provides completed synthetic native Responses turns without precreating conversation evidence", async () => {
    const home = await temporaryHome();
    const provider = await startProfileProvider({
      home,
      repoRoot: path.join(home, "cloudx"),
    });
    cleanups.push(() => provider.close());
    expect(await fs.readdir(path.join(home, ".codex"))).toEqual([
      "auth.json",
      "config.toml",
    ]);
    expect(
      await fs.readFile(path.join(home, ".codex/config.toml"), "utf8"),
    ).toContain(`base_url = "${provider.origin}/v1"`);
    const response = await fetch(`${provider.origin}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
        model: "cloudx-lifecycle",
        input: [{ role: "user", content: "Synthetic test input" }],
      }),
    });
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "The synthetic lifecycle conversation is saved.",
              },
            ],
          },
        ],
      },
    });
    const title = await fetch(`${provider.origin}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
        text: {
          format: { schema: { properties: { title: { type: "string" } } } },
        },
      }),
    });
    expect(await title.text()).toContain("Synthetic lifecycle conversation");
    expect(provider.requests).toEqual(["conversation", "title"]);
    expect((await fetch(`${provider.origin}/wrong`)).status).toBe(404);
    expect(
      (
        await fetch(`${provider.origin}/v1/responses`, {
          method: "POST",
          body: "invalid",
        })
      ).status,
    ).toBe(400);
  });

  it("rejects changed bytes, changed identity and a replayed prompt even when saved tabs still exist", async () => {
    const home = await temporaryHome();
    const transcript = Buffer.from(
      "synthetic immutable conversation evidence\n",
    );
    const snapshot = {
      transcript,
      transcriptPath: path.join(home, "conversation.jsonl"),
      receiptPath: path.join(home, "receipt.json"),
      sessionId: "original-id",
      conversationRequests: 1,
    };
    const provider = { requests: ["conversation", "title"] };
    await fs.writeFile(snapshot.transcriptPath, transcript);
    await fs.writeFile(
      snapshot.receiptPath,
      JSON.stringify({ sessionId: snapshot.sessionId }),
    );
    await expect(
      verifySavedConversation(snapshot, provider),
    ).resolves.toBeUndefined();

    await fs.appendFile(snapshot.transcriptPath, "native resume metadata\n");
    await expect(verifySavedConversation(snapshot, provider)).rejects.toThrow(
      "source bytes changed",
    );
    await expect(
      verifySavedConversation(snapshot, provider, { resumed: true }),
    ).resolves.toBeUndefined();
    await fs.writeFile(
      snapshot.transcriptPath,
      Buffer.from("corrupted original bytes\n"),
    );
    await expect(
      verifySavedConversation(snapshot, provider, { resumed: true }),
    ).rejects.toThrow("source bytes changed");

    await fs.writeFile(snapshot.transcriptPath, transcript);
    provider.requests.push("conversation");
    await expect(verifySavedConversation(snapshot, provider)).rejects.toThrow(
      "replayed a model prompt",
    );
    provider.requests.pop();
    await fs.writeFile(
      snapshot.receiptPath,
      JSON.stringify({ sessionId: "different-id" }),
    );
    await expect(verifySavedConversation(snapshot, provider)).rejects.toThrow(
      "identity changed",
    );
  });
});
