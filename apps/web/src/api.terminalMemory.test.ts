import { afterEach, describe, expect, it, vi } from "vitest";

import { getTerminalMemory, setTerminalMemory } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

const status = {
  service: "cloudx-terminal.service", manageable: true,
  limits: { memoryHigh: "1024", memoryMax: "infinity" }, effective: { memoryHigh: "1024", memoryMax: "infinity" },
  usageBytes: 10, pressure: { someAvg10: 0, fullAvg10: 0 }, events: { high: 2, oom: 0, oomKill: 0 },
  fragmentPath: "/service", dropInPaths: [], controlGroup: "/group", activeState: "active"
};

describe("terminal memory transport", () => {
  it("reads uncached status and accepts cancellation", async () => {
    const fetch = vi.fn(async () => Response.json(status));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await expect(getTerminalMemory(signal)).resolves.toEqual(status);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/terminal-memory", { signal, cache: "no-store", headers: undefined });
  });

  it("applies limits and returns the server's effective readback", async () => {
    const fetch = vi.fn(async () => Response.json(status));
    vi.stubGlobal("fetch", fetch);
    const limits = { memoryHigh: "1024", memoryMax: "infinity" };
    const signal = new AbortController().signal;
    await expect(setTerminalMemory(limits, signal)).resolves.toEqual(status);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/terminal-memory", {
      method: "PUT", body: JSON.stringify(limits), signal, headers: { "content-type": "application/json" }
    });
  });

  it("reports actionable server failures and rejects malformed readings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "Cannot persist limits: check permissions on the user systemd configuration." }, { status: 403 })));
    await expect(setTerminalMemory({ memoryHigh: "1024", memoryMax: "2048" })).rejects.toThrow("check permissions");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...status, usageBytes: "unknown" })));
    await expect(getTerminalMemory()).rejects.toThrow("Invalid terminal memory status");
  });
});
