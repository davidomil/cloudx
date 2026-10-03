import assert from "node:assert/strict";

export function requireInstallerSuccess(result) {
  assert.equal(
    result.error,
    undefined,
    "Installer could not finish before its deadline",
  );
  assert.equal(
    result.status,
    0,
    `Installer failed (exit ${result.status}, signal ${result.signal})`,
  );
}

export function requireReadyInstallation(observed, commit) {
  for (const component of ["web", "asr", "documentation", "terminals"]) {
    assert.equal(
      observed.readiness[component]?.status,
      "ready",
      `${component} readiness failed`,
    );
  }
  assert.equal(
    observed.readiness.terminals.broker,
    "ready",
    "Supervised broker terminal probe failed",
  );
  assert.equal(
    observed.readiness.terminals.direct,
    "ready",
    "Supervised direct terminal probe failed",
  );
  assert.equal(
    observed.terminalProbeCleaned,
    true,
    "Terminal readiness left execution receipts behind",
  );
  assert.equal(
    observed.checkout,
    commit,
    "Checkout differs from pinned commit",
  );
  assert.equal(
    observed.runtime.verification,
    "verified",
    "Running artifacts are unverified",
  );
  assert.equal(
    observed.runtime.build.commit,
    commit,
    "Running commit differs from pinned commit",
  );
  assert.equal(
    observed.runtime.build.sourceDirty,
    false,
    "Installed build has modified sources",
  );
  assert.equal(
    observed.runtime.build.artifactSha256,
    observed.manifest.artifactSha256,
    "Running build differs from installed manifest",
  );
  assert.equal(
    observed.runtime.invocationId,
    observed.services.web.InvocationID,
    "Runtime belongs to a different web invocation",
  );
  assert.match(observed.services.web.InvocationID, /^[a-f0-9]{32}$/);
  assert.equal(
    observed.processMatches,
    true,
    "Runtime process identity or service cgroup differs",
  );
  for (const service of Object.values(observed.services)) {
    assert.equal(service.ActiveState, "active", "Required service is inactive");
    assert.ok(
      Number(service.MainPID) > 0,
      "Required service has no live process",
    );
  }
  assert.ok(
    observed.frontend.length > 1,
    "Frontend entry and assets were not checked",
  );
  for (const file of observed.frontend) {
    assert.equal(
      file.servedSha256,
      file.diskSha256,
      `Served frontend differs: ${file.path}`,
    );
  }
}

export function requireCompletedUpgrade({
  before,
  after,
  record,
  coordinatorSurvivedStop,
  sourceSha,
  targetSha,
}) {
  assert.notEqual(sourceSha, targetSha, "Upgrade revisions must differ");
  requireReadyInstallation(before, sourceSha);
  requireReadyInstallation(after, targetSha);
  assert.notEqual(
    after.services.web.InvocationID,
    before.services.web.InvocationID,
    "Old web invocation is still running",
  );
  assert.notEqual(
    after.runtime.pid,
    before.runtime.pid,
    "Old web process is still running",
  );
  assert.equal(
    record.targetCommit,
    targetSha,
    "Updater selected a different target",
  );
  assert.equal(
    record.transition.sourceCommit,
    sourceSha,
    "Updater used a different source commit",
  );
  assert.equal(record.run.state, "succeeded", "Update did not durably succeed");
  assert.ok(
    record.transition.completed.includes("verify"),
    "Success was recorded before verification",
  );
  assert.equal(
    record.transition.verifiedRuntime.build.commit,
    targetSha,
    "Updater verified a different running commit",
  );
  assert.equal(
    record.transition.verifiedRuntime.invocationId,
    after.runtime.invocationId,
    "Updater verified a different web invocation",
  );
  assert.equal(
    coordinatorSurvivedStop,
    true,
    "No evidence that the coordinator survived the old web process",
  );
  if (!record.transition.runtimePlan.requiresInterruption) {
    assert.equal(
      after.services.terminal.InvocationID,
      before.services.terminal.InvocationID,
      "Compatible terminal broker was unnecessarily restarted",
    );
  }
}
