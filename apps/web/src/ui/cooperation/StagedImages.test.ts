import { describe, expect, it, vi } from "vitest";
import { StagedImages } from "./StagedImages.js";

function fixture() {
  const receipt = vi.fn(async (_operationId: string) => false);
  const discard = vi.fn(async (_token: string) => {});
  const failed = vi.fn();
  return { receipt, discard, failed, images: new StagedImages({ receipt, discard, failed }) };
}

describe("retiring original image stages", () => {
  it("discards a known uncommitted stage when its real view retires", async () => {
    const f = fixture();
    expect(f.images.staged("image", "token")).toBe(true);
    await f.images.retire();
    expect(f.discard).toHaveBeenCalledWith("token", undefined);
    expect(f.receipt).not.toHaveBeenCalled();
  });
  it("waits for an in-flight attachment and preserves a committed original", async () => {
    const f = fixture();
    f.images.staged("image", "token");
    f.images.saving("image", "operation");
    await f.images.retire();
    expect(f.discard).not.toHaveBeenCalled();
    await f.images.settled("image", true);
    expect(f.receipt).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
  });
  it("checks the exact original receipt before discarding an uncertain write", async () => {
    const f = fixture();
    f.images.staged("image", "token");
    f.images.saving("image", "operation");
    await f.images.retire();
    await f.images.settled("image", false);
    expect(f.receipt).toHaveBeenCalledWith("operation");
    expect(f.discard).toHaveBeenCalledWith("token", "operation");
    const committed = fixture();
    committed.receipt.mockResolvedValue(true);
    committed.images.staged("image", "original");
    committed.images.saving("image", "saved-operation");
    await committed.images.settled("image", false);
    await committed.images.retire();
    expect(committed.discard).not.toHaveBeenCalled();
  });
  it("discards a stage response arriving after retirement before any attachment is started", async () => {
    const f = fixture();
    await f.images.retire();
    expect(f.images.staged("late", "late-token")).toBe(false);
    await f.images.retire();
    expect(f.discard).toHaveBeenCalledTimes(1);
    expect(f.discard).toHaveBeenCalledWith("late-token", undefined);
  });
  it("reports cleanup failure without resending, retrying or removing another stage", async () => {
    const f = fixture();
    f.discard.mockRejectedValueOnce(new Error("Disconnected during cleanup"));
    f.images.staged("failed", "failed-token");
    f.images.staged("other", "other-token");
    f.images.forgotten("other");
    await f.images.retire();
    await f.images.retire();
    expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Disconnected during cleanup" }));
    expect(f.discard).toHaveBeenCalledTimes(1);
  });
  it("preserves an uncertain stage when its receipt cannot be read and supports a fresh mount before user input", async () => {
    const f = fixture();
    await f.images.retire(); f.images.activate();
    expect(f.images.staged("image", "token")).toBe(true);
    f.images.saving("image", "original-operation");
    await f.images.settled("image", false);
    f.receipt.mockRejectedValue(new Error("Receipt endpoint disconnected"));
    await f.images.retire();
    expect(f.discard).not.toHaveBeenCalled();
    expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Receipt endpoint disconnected" }));
  });
});
