import { describe, expect, it, vi } from "vitest";
import { StagedAssets } from "./StagedAssets.js";

function fixture() {
  const receipt = vi.fn(async (_operationId: string) => false);
  const discard = vi.fn(async (_token: string) => {});
  const failed = vi.fn();
  return { receipt, discard, failed, assets: new StagedAssets({ receipt, discard, failed }) };
}

describe("retiring original asset stages", () => {
  it("discards a known uncommitted stage when its real view retires", async () => {
    const f = fixture();
    expect(f.assets.staged("asset", "token")).toBe(true);
    await f.assets.retire();
    expect(f.discard).toHaveBeenCalledWith("token", undefined);
    expect(f.receipt).not.toHaveBeenCalled();
  });
  it("waits for an in-flight attachment and preserves a committed original", async () => {
    const f = fixture();
    f.assets.staged("asset", "token");
    f.assets.saving("asset", "operation");
    await f.assets.retire();
    expect(f.discard).not.toHaveBeenCalled();
    await f.assets.settled("asset", true);
    expect(f.receipt).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
  });
  it("checks the exact original receipt before discarding an uncertain write", async () => {
    const f = fixture();
    f.assets.staged("asset", "token");
    f.assets.saving("asset", "operation");
    await f.assets.retire();
    await f.assets.settled("asset", false);
    expect(f.receipt).toHaveBeenCalledWith("operation");
    expect(f.discard).toHaveBeenCalledWith("token", "operation");
    const committed = fixture();
    committed.receipt.mockResolvedValue(true);
    committed.assets.staged("asset", "original");
    committed.assets.saving("asset", "saved-operation");
    await committed.assets.settled("asset", false);
    await committed.assets.retire();
    expect(committed.discard).not.toHaveBeenCalled();
  });
  it("discards a stage response arriving after retirement before any attachment is started", async () => {
    const f = fixture();
    await f.assets.retire();
    expect(f.assets.staged("late", "late-token")).toBe(false);
    await f.assets.retire();
    expect(f.discard).toHaveBeenCalledTimes(1);
    expect(f.discard).toHaveBeenCalledWith("late-token", undefined);
  });
  it("reports cleanup failure without resending, retrying or removing another stage", async () => {
    const f = fixture();
    f.discard.mockRejectedValueOnce(new Error("Disconnected during cleanup"));
    f.assets.staged("failed", "failed-token");
    f.assets.staged("other", "other-token");
    f.assets.forgotten("other");
    await f.assets.retire();
    await f.assets.retire();
    expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Disconnected during cleanup" }));
    expect(f.discard).toHaveBeenCalledTimes(1);
  });
  it("preserves an uncertain stage when its receipt cannot be read and supports a fresh mount before user input", async () => {
    const f = fixture();
    await f.assets.retire(); f.assets.activate();
    expect(f.assets.staged("asset", "token")).toBe(true);
    f.assets.saving("asset", "original-operation");
    await f.assets.settled("asset", false);
    f.receipt.mockRejectedValue(new Error("Receipt endpoint disconnected"));
    await f.assets.retire();
    expect(f.discard).not.toHaveBeenCalled();
    expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Receipt endpoint disconnected" }));
  });
});
