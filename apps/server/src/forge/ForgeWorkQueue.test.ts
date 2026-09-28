import { describe, expect, it, vi } from "vitest";
import { ForgeWorkQueue } from "./ForgeWorkQueue.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("Forge state work queue", () => {
  it("keeps state operations serial until they explicitly yield", async () => {
    const queue = new ForgeWorkQueue();
    const held = deferred();
    const started = deferred();
    const events: string[] = [];
    const first = queue.run(async () => {
      events.push("first started");
      started.resolve();
      await held.promise;
      events.push("first completed");
    });
    const second = queue.run(async () => { events.push("second completed"); });
    await started.promise;
    expect(events).toEqual(["first started"]);
    held.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first started", "first completed", "second completed"]);
  });

  it.each(["success", "failure", "synchronous failure"])("reacquires state ownership before propagating I/O %s", async outcome => {
    const queue = new ForgeWorkQueue();
    const io = deferred<string>();
    const ioStarted = deferred();
    const otherHeld = deferred();
    const otherStarted = deferred();
    const events: string[] = [];
    const problem = new Error("Context write failed");
    const first = queue.run(async () => {
      try {
        const result = await queue.yieldFor(() => {
          ioStarted.resolve();
          if (outcome === "synchronous failure") throw problem;
          return io.promise;
        });
        events.push(result);
      } catch (error) {
        expect(error).toBe(problem);
        events.push("failure handled");
      } finally {
        events.push("first finalized");
      }
    });
    const second = queue.run(async () => {
      events.push("other started");
      otherStarted.resolve();
      await otherHeld.promise;
      events.push("other completed");
    });
    await Promise.all([ioStarted.promise, otherStarted.promise]);
    if (outcome === "success") io.resolve("I/O completed");
    if (outcome === "failure") io.reject(problem);
    await Promise.resolve();
    expect(events).toEqual(["other started"]);
    otherHeld.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["other started", "other completed",
      outcome === "success" ? "I/O completed" : "failure handled", "first finalized"]);
  });

  it("preserves each operation identity across overlapping I/O and clears settled contexts", async () => {
    const queue = new ForgeWorkQueue();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    let firstToken: object | undefined;
    let secondToken: object | undefined;
    let inspectSettledContext!: () => Promise<object | undefined>;
    const inspect = deferred();
    const first = queue.run(async () => {
      firstToken = queue.current();
      const later = inspect.promise.then(() => queue.current());
      inspectSettledContext = () => { inspect.resolve(); return later; };
      await queue.yieldFor(async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        expect(queue.current()).toBe(firstToken);
      });
      expect(queue.current()).toBe(firstToken);
    });
    const second = queue.run(async () => {
      secondToken = queue.current();
      await queue.yieldFor(async () => {
        secondStarted.resolve();
        await releaseSecond.promise;
      });
      expect(queue.current()).toBe(secondToken);
    });
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    expect(firstToken).toBeDefined();
    expect(secondToken).toBeDefined();
    expect(firstToken).not.toBe(secondToken);
    expect(queue.current()).toBeUndefined();
    releaseSecond.resolve();
    await second;
    releaseFirst.resolve();
    await first;
    expect(await inspectSettledContext()).toBeUndefined();
  });

  it("runs reservation cleanup before releasing state ownership, including failures", async () => {
    const queue = new ForgeWorkQueue();
    const cleanupStarted = deferred();
    const cleanupHeld = deferred();
    const events: string[] = [];
    const failed = queue.run(async () => { throw new Error("Operation failed"); }, async () => {
      expect(queue.current()).toBeDefined();
      cleanupStarted.resolve();
      await cleanupHeld.promise;
      events.push("reservation removed");
      throw new Error("Cleanup failed");
    });
    const failure = expect(failed).rejects.toThrow("Cleanup failed");
    const next = queue.run(async () => { events.push("next operation"); });
    await cleanupStarted.promise;
    expect(events).toEqual([]);
    cleanupHeld.resolve();
    await Promise.all([failure, next]);
    expect(events).toEqual(["reservation removed", "next operation"]);
  });

  it("drains complete operation lifetimes, including yielded I/O, errors and work added while draining", async () => {
    const queue = new ForgeWorkQueue();
    const io = deferred();
    const started = deferred();
    const addedWork = deferred();
    const addedStarted = deferred();
    const finished = vi.fn();
    const first = queue.run(async () => {
      await queue.yieldFor(async () => { started.resolve(); await io.promise; });
      throw new Error("I/O failure");
    });
    const failed = expect(first).rejects.toThrow("I/O failure");
    await started.promise;
    const drained = queue.drain().then(finished);
    const added = queue.run(async () => {
      addedStarted.resolve();
      await queue.yieldFor(() => addedWork.promise);
    });
    await addedStarted.promise;
    io.resolve();
    await failed;
    expect(finished).not.toHaveBeenCalled();
    addedWork.resolve();
    await Promise.all([added, drained]);
    expect(finished).toHaveBeenCalledOnce();
    await queue.drain();
  });

  it("rejects yielding without state ownership and preserves the active wait", async () => {
    const queue = new ForgeWorkQueue();
    await expect(queue.yieldFor(async () => {})).rejects.toThrow("active state operation");
    await queue.run(async () => {
      await queue.yieldFor(async () => {
        await expect(queue.yieldFor(async () => {})).rejects.toThrow("active state operation");
      });
    });
    await queue.run(async () => {});
  });
});
