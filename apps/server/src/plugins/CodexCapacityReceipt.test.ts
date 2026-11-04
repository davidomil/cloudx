import { describe, expect, it } from "vitest";
import type { ForgeTurnCompletion } from "@cloudx/shared";
const { CodexWorkerTurn } = await import(new URL("../../helpers/codex-worker-bridge.mjs", import.meta.url).href);

function fixture() {
  const receipts: ForgeTurnCompletion[] = [];
  const turn = new CodexWorkerTurn({ workerId: "worker", attemptId: "attempt", executionId: "execution", expectedThreadId: "conversation" }, (receipt: ForgeTurnCompletion) => receipts.push(receipt));
  turn.fromClient({ id: 4, method: "turn/start", params: { threadId: "conversation" } });
  return { receipts, turn, started: { id: 4, result: { turn: { id: "turn" } } } };
}
const completion = (error: unknown, threadId = "conversation", turnId = "turn") => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error } } });

describe("Owned native model-capacity receipts", () => {
  it.each(["codexErrorInfo", "codex_error_info"])("preserves terminal %s classification", field => {
    const f = fixture();
    f.turn.fromServer(f.started);
    f.turn.fromServer(completion({ message: "At capacity", [field]: field === "codexErrorInfo" ? "serverOverloaded" : "server_overloaded" }));
    expect(f.receipts.at(-1)).toMatchObject({ workerId: "worker", attemptId: "attempt", executionId: "execution", threadId: "conversation", turnId: "turn", status: "failed", nativeError: { code: field === "codexErrorInfo" ? "serverOverloaded" : "server_overloaded" } });
  });

  it.each([true, false])("keeps error notifications with willRetry=%s active until matching turn completion", willRetry => {
    const f = fixture();
    f.turn.fromServer(f.started);
    f.turn.fromServer({ method: "error", params: { threadId: "conversation", turnId: "turn", willRetry, error: { message: "At capacity", codexErrorInfo: "serverOverloaded" } } });
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]).toMatchObject({ status: "running" });
    expect(f.receipts[0]?.nativeError).toBeUndefined();
  });

  it("correlates queued terminal completion after native turn admission", () => {
    const f = fixture();
    f.turn.fromServer(completion({ message: "At capacity", codexErrorInfo: "serverOverloaded" }));
    expect(f.receipts).toHaveLength(0);
    f.turn.fromServer(f.started);
    expect(f.receipts.at(-1)).toMatchObject({ status: "failed", nativeError: { code: "serverOverloaded" } });
  });

  it("ignores other conversations and turns and does not classify arbitrary text", () => {
    const f = fixture();
    f.turn.fromServer(f.started);
    f.turn.fromServer(completion({ message: "At capacity", codexErrorInfo: "serverOverloaded" }, "other"));
    f.turn.fromServer(completion({ message: "At capacity", codexErrorInfo: "serverOverloaded" }, "conversation", "other"));
    expect(f.receipts.at(-1)?.status).toBe("running");
    f.turn.fromServer(completion({ message: "Selected model is at capacity. Please try a different model." }));
    expect(f.receipts.at(-1)?.nativeError).toBeUndefined();
  });

});
