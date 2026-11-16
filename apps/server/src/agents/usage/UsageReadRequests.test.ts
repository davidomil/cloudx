import { describe, expect, it, vi } from "vitest";

import { UsageReadRequests } from "./UsageReadRequests.js";
import type { UsageSnapshot } from "./usageRecord.js";

function pendingSnapshot() {
  let resolve!: (snapshot: UsageSnapshot) => void;
  const result = new Promise<UsageSnapshot>(finish => { resolve = finish; });
  return { result, resolve };
}

describe("usage metadata consumers", () => {
  it("coalesces discoveries and keeps another consumer's discovery after one cancels", async () => {
    const requests = new UsageReadRequests();
    const pending = pendingSnapshot();
    const first = new AbortController();
    const discover = vi.fn((_signal: AbortSignal) => pending.result);
    const canceled = requests.read("session", discover, first.signal);
    const retained = requests.read("session", discover);
    first.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0]![0].aborted).toBe(false);
    pending.resolve({ records: [], indexing: "backfilling" });
    await expect(retained).resolves.toEqual({ records: [], indexing: "backfilling" });
    await requests.dispose();
  });

  it("detaches the last consumer promptly and keeps its late completion out of a replacement discovery", async () => {
    const requests = new UsageReadRequests();
    const old = pendingSnapshot();
    const replacement = pendingSnapshot();
    const controller = new AbortController();
    let abandoned!: AbortSignal;
    const canceled = requests.read("session", signal => { abandoned = signal; return old.result; }, controller.signal);
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    expect(abandoned.aborted).toBe(true);
    const discover = vi.fn(() => replacement.result);
    const next = requests.read("session", discover);
    old.resolve({ records: [], indexing: "error" });
    await Promise.resolve();
    const shared = requests.read("session", discover);
    expect(discover).toHaveBeenCalledTimes(1);
    replacement.resolve({ records: [] });
    await expect(next).resolves.toEqual({ records: [] });
    await expect(shared).resolves.toEqual({ records: [] });
    await requests.dispose();
  });

  it("does not start discovery for already canceled or disposed consumers", async () => {
    const requests = new UsageReadRequests();
    const discover = vi.fn(async () => ({ records: [] }));
    const controller = new AbortController();
    controller.abort();
    await expect(requests.read("session", discover, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await requests.dispose();
    await expect(requests.read("session", discover)).rejects.toThrow("disposed");
    expect(discover).not.toHaveBeenCalled();
  });

  it("aborts active metadata discovery and drains its lifecycle on disposal", async () => {
    const requests = new UsageReadRequests();
    let active!: AbortSignal;
    const reading = requests.read("session", signal => {
      active = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const settled = expect(reading).rejects.toMatchObject({ name: "AbortError" });
    await requests.dispose();
    await settled;
    expect(active.aborted).toBe(true);
    await requests.idle();
  });
});
