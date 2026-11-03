import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const modulePath = fileURLToPath(new URL("../../helpers/cooperation-codex-feedback.mjs", import.meta.url));
const { CodexCooperationFeedback } = await import(modulePath);
const envelope = { text: "Explain this target.", eventIds: ["event-1"] };

function fixture(owned = false) {
  const sent: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  let boundaries = 0;
  const feedback = new CodexCooperationFeedback({
    owned, threadId: () => "thread-1", connected: () => true, skills: [{ name: "cooperation-feedback", path: "/skills/feedback/SKILL.md" }],
    boundary: () => { boundaries += 1; }, send: (message: typeof sent[number]) => { sent.push(message); }
  });
  feedback.fromClient({ id: "initialize-1", method: "initialize" });
  feedback.fromServer({ id: "initialize-1", result: {} });
  return { feedback, sent, boundaries: () => boundaries };
}

it("starts an addressed idle turn on the original native RPC connection without composer input", async () => {
  const f = fixture();
  const result = f.feedback.deliver(envelope);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ method: "turn/start", params: { threadId: "thread-1", input: [
    { type: "text", text: "$cooperation-board $cooperation-feedback\nExplain this target." },
    { type: "skill", name: "cooperation-feedback", path: "/skills/feedback/SKILL.md" }
  ] } });
  expect(f.feedback.fromServer({ id: f.sent[0].id, result: { turn: { id: "feedback-turn" } } })).toBe(false);
  expect(await result).toEqual({ state: "nativeAccepted", providerTurnId: "feedback-turn" });
});

it("queues busy or modal feedback and admits only explicit identity-checked steering", async () => {
  const f = fixture();
  f.feedback.fromServer({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "working-turn" } } });
  expect(await f.feedback.deliver(envelope)).toMatchObject({ state: "queued" });
  f.feedback.fromServer({ id: "approval", method: "item/commandExecution/requestApproval", params: {} });
  expect(await f.feedback.deliver({ ...envelope, immediate: true })).toMatchObject({ state: "queued", reason: expect.stringContaining("approval") });
  expect(f.sent).toHaveLength(0);
  f.feedback.fromClient({ id: "approval", result: { decision: "accept" } });
  const steering = f.feedback.deliver({ ...envelope, immediate: true });
  expect(f.sent[0]).toMatchObject({ method: "turn/steer", params: { threadId: "thread-1", expectedTurnId: "working-turn" } });
  f.feedback.fromServer({ id: f.sent[0].id, result: { turnId: "working-turn" } });
  expect(await steering).toEqual({ state: "nativeAccepted", providerTurnId: "working-turn" });
  f.feedback.fromServer({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "working-turn" } } });
  expect(f.boundaries()).toBe(2);
});

it("does not create a second owned worker turn and reports lost native acknowledgment as unknown", async () => {
  const f = fixture(true);
  expect(await f.feedback.deliver(envelope)).toEqual({ state: "queued", reason: "ownerContinuationRequired" });
  expect(f.sent).toHaveLength(0);
  f.feedback.fromServer({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "attempt-turn" } } });
  const steering = f.feedback.deliver({ ...envelope, immediate: true });
  f.feedback.close();
  expect(await steering).toMatchObject({ state: "unknown" });
});
