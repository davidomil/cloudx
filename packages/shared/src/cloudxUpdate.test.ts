import { describe, expect, it } from "vitest";
import { parseCloudxUpdateStatus } from "./cloudxUpdate.js";

const run = {
  id: "update-1", state: "running", message: "Updating CloudX.", startedAt: "2026-09-15T00:00:00.000Z"
};

describe("CloudX update status", () => {
  it("projects availability and a durable run without leaking private runner fields", () => {
    expect(parseCloudxUpdateStatus({ available: true, logPath: "/private/log", run: { ...run, pid: 123 } }))
      .toEqual({ available: true, run });
    expect(parseCloudxUpdateStatus({ available: false, unavailableReason: "Use the installed service." }))
      .toEqual({ available: false, unavailableReason: "Use the installed service." });
  });

  it.each(["succeeded", "failed"])("accepts a finished %s run", state => {
    const status = { available: true, run: { ...run, state, finishedAt: "2026-09-15T00:03:00.000Z" } };
    expect(parseCloudxUpdateStatus(status)).toEqual(status);
  });

  it.each([null, [], {}, { available: "true" }, { available: false, unavailableReason: 5 },
    { available: true, run: [] },
    ...[{ id: "" }, { id: "x".repeat(129) }, { state: "unknown" }, { state: ["running"] }, { message: 5 }, { message: "x".repeat(4097) },
      { startedAt: "invalid" }, { finishedAt: 12 }].map(change => ({ available: true, run: { ...run, ...change } }))
  ])("rejects malformed process or HTTP output: %j", status => {
    expect(() => parseCloudxUpdateStatus(status)).toThrow(/Invalid CloudX update/);
  });
});
