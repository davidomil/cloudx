import { expect, it } from "vitest";

const { CodexTurnActivity } = await import(new URL("../../helpers/codex-worker-bridge.mjs", import.meta.url).href);

it("reports running while any started turn has not completed", () => {
  const saved: Array<{ status: string }> = [];
  const activity = new CodexTurnActivity((value: { status: string }) => saved.push(value));

  activity.fromClient({ id: 1, method: "turn/start", params: { threadId: "t" } });
  activity.fromServer({ id: 1, result: { turn: { id: "turn-1" } } });
  activity.fromClient({ id: 2, method: "turn/start", params: { threadId: "aux" } });
  activity.fromServer({ id: 2, result: { turn: { id: "turn-2" } } });
  activity.fromServer({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
  activity.fromServer({ method: "turn/completed", params: { turn: { id: "turn-2", status: "interrupted" } } });
  // Failed starts and unrelated replies do not change the state.
  activity.fromClient({ id: 3, method: "turn/start", params: { threadId: "t" } });
  activity.fromServer({ id: 3, error: { message: "rejected" } });
  activity.fromServer({ id: 99, result: {} });

  expect(saved.map(value => value.status)).toEqual(["running", "idle"]);
});
