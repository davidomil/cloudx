import { describe, expect, it } from "vitest";

import { parseTerminalMemoryLimit, parseTerminalMemoryLimits, parseTerminalMemoryStatus } from "./terminalMemory.js";

describe("terminal memory limits", () => {
  it("converts explicit binary units into exact bytes for persistence and round trips", () => {
    const limits = parseTerminalMemoryLimits({ memoryHigh: " 1.5 GiB ", memoryMax: "2TiB" });
    expect(limits).toEqual({ memoryHigh: "1610612736", memoryMax: "2199023255552" });
    expect(parseTerminalMemoryLimits(limits)).toEqual(limits);
    expect(parseTerminalMemoryLimit("1KiB")).toBe("1024");
    expect(parseTerminalMemoryLimit("1MiB")).toBe("1048576");
    expect(parseTerminalMemoryLimit("123B")).toBe("123");
    expect(parseTerminalMemoryLimit("9007199254740993B")).toBe("9007199254740993");
  });

  it("allows unlimited limits and a finite hard cap without throttling", () => {
    expect(parseTerminalMemoryLimits({ memoryHigh: "infinity", memoryMax: "infinity" })).toEqual({ memoryHigh: "infinity", memoryMax: "infinity" });
    expect(parseTerminalMemoryLimits({ memoryHigh: "infinity", memoryMax: "1GiB" }).memoryMax).toBe("1073741824");
    expect(parseTerminalMemoryLimits({ memoryHigh: "1GiB", memoryMax: "infinity" }).memoryHigh).toBe("1073741824");
  });

  it.each(["", "0", "0GiB", "-1GiB", "1GB", "1G", "50%", "NaN", "1e3B", "0.1B", "18446744073709551615B", 1024, null])("rejects invalid memory size %j", value => {
    expect(() => parseTerminalMemoryLimit(value)).toThrow();
  });

  it("requires both limits and rejects finite thresholds above the hard ceiling", () => {
    for (const value of [null, [], {}, { memoryHigh: "1GiB" }, { memoryHigh: "1GiB", memoryMax: "2GiB", extra: true }]) {
      expect(() => parseTerminalMemoryLimits(value)).toThrow();
    }
    expect(() => parseTerminalMemoryLimits({ memoryHigh: "3GiB", memoryMax: "2GiB" })).toThrow("MemoryHigh must not exceed MemoryMax");
    expect(parseTerminalMemoryLimits({ memoryHigh: "2GiB", memoryMax: "2GiB" }).memoryHigh).toBe("2147483648");
  });
});

describe("terminal memory status", () => {
  const status = {
    service: "cloudx-terminal.service", manageable: false, reason: "User systemd is unavailable.",
    limits: { memoryHigh: "infinity", memoryMax: null }, effective: { memoryHigh: "1GiB", memoryMax: null },
    usageBytes: null, pressure: null, events: null,
    fragmentPath: null, dropInPaths: ["/config/limits.conf"], controlGroup: null, activeState: null
  };

  it("keeps unknown readings distinct from unlimited and canonicalizes observed limits", () => {
    expect(parseTerminalMemoryStatus(status)).toEqual({ ...status, effective: { memoryHigh: "1073741824", memoryMax: null } });
  });

  it("accepts page-rounded observed zero without allowing a zero input policy", () => {
    const rounded = { ...status, limits: { memoryHigh: "1", memoryMax: "infinity" }, effective: { memoryHigh: "0", memoryMax: "infinity" } };
    expect(parseTerminalMemoryStatus(rounded)).toEqual(rounded);
    expect(() => parseTerminalMemoryLimits({ memoryHigh: "0", memoryMax: "infinity" })).toThrow("positive");
  });

  it("accepts usage, pressure, event counters and existing override provenance", () => {
    const observed = { ...status, usageBytes: 10, pressure: { someAvg10: 96.22, fullAvg10: 95.73 }, events: { high: 2260, oom: 1, oomKill: 0 } };
    expect(parseTerminalMemoryStatus(observed)).toEqual({ ...observed, effective: { memoryHigh: "1073741824", memoryMax: null } });
  });

  it.each([
    null, { ...status, manageable: "yes" }, { ...status, limits: {} }, { ...status, effective: null },
    { ...status, usageBytes: -1 }, { ...status, pressure: { someAvg10: 1 } },
    { ...status, events: { high: 1, oom: -1, oomKill: 0 } }, { ...status, dropInPaths: [12] },
    { ...status, fragmentPath: 5 }, { ...status, reason: 1 }
  ])("rejects malformed server status %j", value => {
    expect(() => parseTerminalMemoryStatus(value)).toThrow();
  });
});
