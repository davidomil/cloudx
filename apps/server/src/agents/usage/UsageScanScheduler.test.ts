import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageScanScheduler } from "./UsageScanScheduler.js";

afterEach(() => vi.useRealTimers());

describe("UsageScanScheduler", () => {
  it("serializes and rotates work across owners within one global byte budget", async () => {
    const scheduler = new UsageScanScheduler({ sliceBytes: 32, intervalMs: 0 });
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const ownerA = {};
    const ownerB = {};
    const work = (name: string) => async (budget: number) => {
      expect(budget).toBe(32);
      maximumActive = Math.max(maximumActive, ++active);
      order.push(name);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return order.filter(value => value === name).length < 3;
    };
    scheduler.schedule(ownerA, "file", work("a"));
    scheduler.schedule(ownerA, "file", work("duplicate"));
    scheduler.schedule(ownerB, "file", work("b"));
    await scheduler.idle();
    expect(order).toEqual(["a", "b", "a", "b", "a", "b"]);
    expect(maximumActive).toBe(1);
    await scheduler.dispose();
  });

  it("spaces slices to enforce the configured aggregate rate", async () => {
    vi.useFakeTimers();
    const scheduler = new UsageScanScheduler();
    const budgets: number[] = [];
    scheduler.schedule({}, "file", async budget => { budgets.push(budget); return budgets.length < 3; });
    await vi.advanceTimersByTimeAsync(0);
    expect(budgets).toEqual([256 * 1024]);
    await vi.advanceTimersByTimeAsync(99);
    expect(budgets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(budgets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(budgets).toHaveLength(3);
    await scheduler.idle();
    await scheduler.dispose();
  });

  it("cancels one owner without stopping another owner's indexing", async () => {
    const scheduler = new UsageScanScheduler({ intervalMs: 0 });
    const owner = {};
    const calls: string[] = [];
    scheduler.schedule(owner, "obsolete", async () => { calls.push("obsolete"); return true; });
    scheduler.schedule({}, "kept", async () => { calls.push("kept"); return false; });
    await scheduler.cancel(owner);
    await scheduler.idle();
    expect(calls).toEqual(["kept"]);
    await scheduler.dispose();
  });

  it("finishes only an active slice when disposed", async () => {
    const scheduler = new UsageScanScheduler({ intervalMs: 0 });
    let started!: () => void;
    let finish!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let slices = 0;
    scheduler.schedule({}, "large", async () => { slices++; started(); await gate; return true; });
    await active;
    const disposed = scheduler.dispose();
    finish();
    await disposed;
    expect(slices).toBe(1);
  });

  it("keeps a refresh scheduled while the previous slice is finishing", async () => {
    const scheduler = new UsageScanScheduler({ intervalMs: 0 });
    const owner = {};
    let slices = 0;
    const work = async () => {
      slices++;
      if (slices === 1) scheduler.schedule(owner, "append", work);
      return false;
    };
    scheduler.schedule(owner, "append", work);
    await scheduler.idle();
    expect(slices).toBe(2);
    await scheduler.dispose();
  });

  it.each([{ sliceBytes: 0 }, { sliceBytes: 1.5 }, { intervalMs: -1 }, { intervalMs: Infinity }])("rejects an invalid budget: %j", options => {
    expect(() => new UsageScanScheduler(options)).toThrow("positive byte budget");
  });
});
