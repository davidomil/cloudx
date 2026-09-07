import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { ProcessShutdownController } from "./ProcessShutdownController.js";

describe("ProcessShutdownController", () => {
  it("uses one awaited close path for repeated SIGINT and SIGTERM events", async () => {
    const signals = new EventEmitter();
    let finishClose!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => {
      finishClose = resolve;
    }));
    const reportError = vi.fn();
    const controller = new ProcessShutdownController(close, signals, reportError);
    controller.start();

    signals.emit("SIGTERM");
    signals.emit("SIGINT");

    expect(close).toHaveBeenCalledTimes(1);
    finishClose();
    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports close failures once without creating another close attempt", async () => {
    const signals = new EventEmitter();
    const failure = new Error("close failed");
    const close = vi.fn().mockRejectedValue(failure);
    const reportError = vi.fn();
    const controller = new ProcessShutdownController(close, signals, reportError);
    controller.start();

    signals.emit("SIGTERM");
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(failure));

    await expect(controller.shutdown()).rejects.toThrow("close failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
