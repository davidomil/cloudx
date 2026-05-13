import { afterEach, describe, expect, it, vi } from "vitest";

import { requestAudioInputEnumerationAccess } from "./App.js";

describe("requestAudioInputEnumerationAccess", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests microphone permission and immediately stops the temporary stream", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await requestAudioInputEnumerationAccess();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable microphone capture when getUserMedia is missing", async () => {
    vi.stubGlobal("navigator", { mediaDevices: {} });

    await expect(requestAudioInputEnumerationAccess()).rejects.toThrow("This browser does not expose microphone capture.");
  });
});
