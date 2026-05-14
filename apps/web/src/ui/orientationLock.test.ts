import { describe, expect, it, vi } from "vitest";

import { attemptPortraitOrientationLock } from "./orientationLock.js";

describe("orientation lock", () => {
  it("attempts a portrait lock on visible coarse-pointer devices", async () => {
    const lock = vi.fn().mockResolvedValue(undefined);

    await expect(attemptPortraitOrientationLock(windowWith({ matches: true, lock }), { visibilityState: "visible" })).resolves.toBe("locked");
    expect(lock).toHaveBeenCalledWith("portrait");
  });

  it("skips non-touch desktop-like devices", async () => {
    const lock = vi.fn().mockResolvedValue(undefined);

    await expect(attemptPortraitOrientationLock(windowWith({ matches: false, lock }), { visibilityState: "visible" })).resolves.toBe("not_applicable");
    expect(lock).not.toHaveBeenCalled();
  });

  it("reports unsupported browsers without throwing", async () => {
    await expect(attemptPortraitOrientationLock(windowWith({ matches: true }), { visibilityState: "visible" })).resolves.toBe("unsupported");
  });

  it("reports browser policy rejections without throwing", async () => {
    const lock = vi.fn().mockRejectedValue(new DOMException("Not allowed", "SecurityError"));

    await expect(attemptPortraitOrientationLock(windowWith({ matches: true, lock }), { visibilityState: "visible" })).resolves.toBe("blocked");
  });
});

function windowWith({ matches, lock }: { matches: boolean; lock?: (orientation: "portrait") => Promise<void> }) {
  return {
    matchMedia: () => ({ matches }),
    screen: {
      orientation: lock ? { lock } : {}
    }
  };
}
