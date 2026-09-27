import { describe, expect, it } from "vitest";
import {
  assertCompletedUpdate,
  assertOnlyLocalWork,
  assertReadiness,
  assertRuntime,
} from "./assertions.mjs";

const source = "a".repeat(40),
  target = "b".repeat(40);
const previous = {
  invocationId: "a".repeat(32),
  pid: 123,
  processStarted: "100",
};
const receipt = {
  commit: target,
  artifactSha256: "c".repeat(64),
  lockSha256: "d".repeat(64),
};
const runtime = {
  verification: "verified",
  build: receipt,
  invocationId: "b".repeat(32),
  pid: 456,
  processStarted: "200",
};
const service = { ActiveState: "active", InvocationID: runtime.invocationId };
const readiness = {
  web: { status: "ready" },
  asr: { status: "ready" },
  documentation: { status: "ready" },
  terminals: { status: "ready", broker: "ready", direct: "ready" },
};
const completed = [
  "prepare",
  "quiesce",
  "snapshot",
  "activate",
  "start",
  "verify",
];
const record = {
  targetCommit: target,
  run: { state: "succeeded", phase: "complete" },
  transition: { sourceCommit: source, completed, verifiedRuntime: runtime },
};

describe("required lifecycle gate", () => {
  it("accepts a ready target with verified artifacts and a new web invocation", () => {
    assertReadiness(readiness);
    assertRuntime({ runtime, receipt, service, commit: target, previous });
    assertCompletedUpdate({
      record,
      source,
      target,
      runtime,
      observedHandoff: true,
    });
  });

  it.each(["web", "asr", "documentation", "terminals"])(
    "fails when target %s readiness fails",
    (component) => {
      expect(() =>
        assertReadiness({ ...readiness, [component]: { status: "not-ready" } }),
      ).toThrow(/readiness|cleanup/);
    },
  );

  it("fails when Git and build advance but the old web process stays alive", () => {
    expect(() =>
      assertRuntime({
        runtime: { ...runtime, ...previous },
        receipt,
        service: { ...service, InvocationID: previous.invocationId },
        commit: target,
        previous,
      }),
    ).toThrow("old web invocation");
    expect(() =>
      assertRuntime({
        runtime: {
          ...runtime,
          pid: previous.pid,
          processStarted: previous.processStarted,
        },
        receipt,
        service,
        commit: target,
        previous,
      }),
    ).toThrow("old web process");
  });

  it("fails when the live commit differs from the exact candidate", () => {
    expect(() =>
      assertRuntime({
        runtime: { ...runtime, build: { ...receipt, commit: source } },
        receipt,
        service,
        commit: target,
        previous,
      }),
    ).toThrow("Running commit");
  });

  it("fails when live artifacts or the systemd invocation do not match", () => {
    expect(() =>
      assertRuntime({
        runtime: {
          ...runtime,
          build: { ...receipt, artifactSha256: "e".repeat(64) },
        },
        receipt,
        service,
        commit: target,
      }),
    ).toThrow("Running artifacts differ");
    expect(() =>
      assertRuntime({
        runtime,
        receipt,
        service: { ...service, InvocationID: previous.invocationId },
        commit: target,
      }),
    ).toThrow("different invocation");
  });

  it("rejects launch acceptance and success without durable readiness", () => {
    expect(() =>
      assertCompletedUpdate({
        record: { ...record, run: { state: "running" } },
        source,
        target,
        runtime,
        observedHandoff: true,
      }),
    ).toThrow("Launch acceptance");
    expect(() =>
      assertCompletedUpdate({
        record: {
          ...record,
          transition: {
            ...record.transition,
            completed: completed.slice(0, -1),
          },
        },
        source,
        target,
        runtime,
        observedHandoff: true,
      }),
    ).toThrow("before completing readiness");
    expect(() =>
      assertCompletedUpdate({
        record,
        source,
        target,
        runtime,
        observedHandoff: false,
      }),
    ).toThrow("coordinator");
  });

  it("allows saved local work and fails on accidental generated artifact changes", () => {
    const local = " M README.md\0?? lifecycle-local-work.txt\0";
    assertOnlyLocalWork(local, ["README.md", "lifecycle-local-work.txt"]);
    expect(() =>
      assertOnlyLocalWork(`${local}?? apps/web/dist\0`, [
        "README.md",
        "lifecycle-local-work.txt",
      ]),
    ).toThrow("Generated artifacts");
    expect(() => assertOnlyLocalWork("", ["README.md"])).toThrow(
      "Generated artifacts",
    );
  });
});
