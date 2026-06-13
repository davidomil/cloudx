import { afterEach, describe, expect, it, vi } from "vitest";

import { createBrowserId, createBrowserUuid } from "./browserId.js";

describe("browser id helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates v4 ids from getRandomValues without randomUUID", () => {
    vi.stubGlobal("crypto", {
      getRandomValues(bytes: Uint8Array) {
        bytes.set(Array.from({ length: bytes.length }, (_, index) => index));
        return bytes;
      }
    });

    expect(createBrowserUuid()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(createBrowserId("pane")).toBe("pane-00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("fails clearly when browser random values are unavailable", () => {
    vi.stubGlobal("crypto", undefined);

    expect(() => createBrowserUuid()).toThrow("Browser random values are required to create workspace ids.");
  });
});
