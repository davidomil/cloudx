import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function assertRuntime({ runtime, receipt, service, commit, previous }) {
  assert.equal(
    runtime.verification,
    "verified",
    "Running artifacts must be verified",
  );
  assert.equal(
    runtime.build?.commit,
    commit,
    "Running commit differs from the pinned candidate",
  );
  assert.equal(
    receipt.commit,
    commit,
    "On-disk build is not the pinned candidate",
  );
  assert.equal(
    runtime.build.artifactSha256,
    receipt.artifactSha256,
    "Running artifacts differ from the installed build",
  );
  assert.equal(
    runtime.build.lockSha256,
    receipt.lockSha256,
    "Running dependency lock differs from the build",
  );
  assert.equal(service.ActiveState, "active", "Web service is not active");
  assert.match(runtime.invocationId, /^[a-f0-9]{32}$/);
  assert.equal(
    runtime.invocationId,
    service.InvocationID,
    "The endpoint is served by a different invocation",
  );
  assert.ok(
    Number.isSafeInteger(runtime.pid) && runtime.pid > 0,
    "Missing runtime PID",
  );
  if (previous) {
    assert.notEqual(
      runtime.invocationId,
      previous.invocationId,
      "The old web invocation is still running",
    );
    assert.ok(
      runtime.pid !== previous.pid ||
        runtime.processStarted !== previous.processStarted,
      "The old web process is still running",
    );
  }
}

export function assertReadiness(readiness) {
  assert.equal(readiness.web?.status, "ready", "HTTPS web readiness failed");
  assert.equal(readiness.asr?.status, "ready", "ASR readiness failed");
  assert.equal(
    readiness.documentation?.status,
    "ready",
    "Documentation readiness failed",
  );
  assert.deepEqual(
    readiness.terminals,
    { status: "ready", broker: "ready", direct: "ready" },
    "Supervised terminal creation and cleanup failed",
  );
}

export function assertCompletedUpdate({
  record,
  source,
  target,
  runtime,
  observedHandoff,
}) {
  assert.notEqual(
    source,
    target,
    "An upgrade requires two different immutable revisions",
  );
  assert.equal(record.targetCommit, target);
  assert.equal(record.transition?.sourceCommit, source);
  assert.equal(
    record.run?.state,
    "succeeded",
    "Launch acceptance is not update completion",
  );
  assert.equal(record.run.phase, "complete");
  assert.deepEqual(
    record.transition.completed,
    ["prepare", "quiesce", "snapshot", "activate", "start", "verify"],
    "Update succeeded before completing readiness",
  );
  assert.equal(record.transition.verifiedRuntime?.verification, "verified");
  assert.equal(record.transition.verifiedRuntime?.build?.commit, target);
  assert.equal(
    record.transition.verifiedRuntime?.invocationId,
    runtime.invocationId,
  );
  assert.ok(
    observedHandoff,
    "The coordinator was not observed alive after the source web process stopped",
  );
}

export function assertOnlyLocalWork(status, allowedPaths) {
  const paths = status
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
  assert.deepEqual(
    paths.sort(),
    [...allowedPaths].sort(),
    "Generated artifacts or unexpected changes leaked into Git status",
  );
}
