import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  calculateWorktreeDigest,
  candidateIdentity,
  captureSourceManifest,
  executeVerification,
  prepareAttestation,
  prepareSupervisor,
  prepareWorkspace,
  publishAttestation,
  runCommand,
  terminateCandidateProcesses,
} from "./run.mjs";

test("candidate commands cannot create or replace supervisor attestation", async () => {
  assert.equal(process.getuid?.(), 0, "test must run as root");
  prepareSupervisor();
  const sandbox = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-attestation-test-"),
  );
  const workspace = path.join(sandbox, "workspace");
  const watcherPid = path.join(workspace, "watcher.pid");
  const statusPath = path.join(workspace, "candidate.status");
  const descriptorsPath = path.join(workspace, "candidate.fds");
  const target =
    process.env.CLOUDX_TEST_ATTESTATION_PATH ??
    path.join(sandbox, "results.json");
  await fs.chmod(sandbox, 0o755);
  if (!process.env.CLOUDX_TEST_ATTESTATION_PATH) {
    await fs.writeFile(target, "", { flag: "wx", mode: 0o600 });
  }
  await fs.mkdir(workspace);
  await fs.chmod(workspace, 0o777);

  try {
    const attestation = await prepareAttestation(target);
    const attack = await runCommand(
      {
        command: "sh",
        args: [
          "-c",
          [
            'cat "/proc/$$/status" > "$STATUS"',
            'for descriptor in "/proc/$$/fd"/*; do readlink "$descriptor" || true; done > "$DESCRIPTORS"',
            'printf forged > "$RESULT" 2>/dev/null || true',
            "setsid sh -c 'while :; do printf forged > \"$RESULT\" 2>/dev/null || true; done' >/dev/null 2>&1 &",
            'printf "%s\\n" "$!" > "$WATCHER_PID"',
          ].join("\n"),
        ],
        env: {
          DESCRIPTORS: descriptorsPath,
          RESULT: target,
          STATUS: statusPath,
          WATCHER_PID: watcherPid,
        },
        timeoutMs: 1_000,
      },
      workspace,
    );
    assert.equal(attack.exitCode, 0);
    assert.equal(await fs.readFile(target, "utf8"), "");
    const candidateStatus = await fs.readFile(statusPath, "utf8");
    assert.match(candidateStatus, /^CapPrm:\s+0+$/mu);
    assert.match(candidateStatus, /^CapEff:\s+0+$/mu);
    assert.match(candidateStatus, /^Groups:\s*$/mu);
    assert.equal(
      (await fs.readFile(descriptorsPath, "utf8")).includes(target),
      false,
    );
    const watcher = Number(await fs.readFile(watcherPid, "utf8"));
    assert.ok(Number.isInteger(watcher) && watcher > 1);
    assert.doesNotMatch(
      await fs.readFile(`/proc/${watcher}/status`, "utf8"),
      /^State:\s+Z/mu,
    );

    await terminateCandidateProcesses({
      terminateGraceMs: 250,
      killGraceMs: 2_000,
    });
    try {
      assert.match(
        await fs.readFile(`/proc/${watcher}/status`, "utf8"),
        /^State:\s+Z/mu,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const evidence = {
      schema_version: 1,
      kind: "managed-container-verification",
      verdict: "passed",
    };
    await publishAttestation(attestation, evidence);

    const replacement = await runCommand(
      {
        command: "sh",
        args: [
          "-c",
          'rm -f "$RESULT" 2>/dev/null || true; printf replaced > "$RESULT" 2>/dev/null || true',
        ],
        env: { RESULT: target },
        timeoutMs: 1_000,
      },
      workspace,
    );
    assert.equal(replacement.exitCode, 0);
    await terminateCandidateProcesses({
      terminateGraceMs: 250,
      killGraceMs: 2_000,
    });

    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), evidence);
    const resultStat = await fs.stat(target);
    assert.equal(resultStat.mode & 0o777, 0o600);
    assert.notEqual(resultStat.uid, candidateIdentity.uid);
  } finally {
    await terminateCandidateProcesses({
      terminateGraceMs: 250,
      killGraceMs: 2_000,
    });
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("candidate cannot hide source mutation with writable Git metadata", async () => {
  assert.equal(process.getuid?.(), 0, "test must run as root");
  prepareSupervisor();
  const sandbox = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-workspace-test-"),
  );
  const source = path.join(sandbox, "source");
  const cache = path.join(sandbox, "cache");
  const root = path.join(sandbox, "work", "repository");
  await fs.chmod(sandbox, 0o755);
  await fs.mkdir(source);
  await fs.mkdir(cache);
  await fs.writeFile(path.join(source, "tracked.txt"), "trusted\n");

  try {
    await prepareWorkspace({
      source,
      root,
      archive: path.join(sandbox, "source.tar"),
      npmCacheSource: cache,
    });
    const sourceManifest = await captureSourceManifest(root);
    const listing = path.join(root, "listing.txt");
    const evidence = await executeVerification({
      root,
      sourceManifest,
      commands: [
        {
          command: "sh",
          args: [
            "-c",
            [
              'printf "candidate\\n" > build-output.txt',
              'printf "mutated\\n" > tracked.txt',
              'git -c safe.directory="$PWD" read-tree --empty',
              "printf '%s\\n' tracked.txt build-output.txt listing.txt > .git/info/exclude",
              'git -c safe.directory="$PWD" ls-files --cached --others --exclude-standard > listing.txt',
            ].join("\n"),
          ],
          env: { HOME: path.join(sandbox, "work", "home") },
          timeoutMs: 1_000,
        },
      ],
      settleCandidates: () =>
        terminateCandidateProcesses({
          terminateGraceMs: 250,
          killGraceMs: 2_000,
        }),
    });
    assert.equal(evidence.commands[0].exit_code, 0);
    assert.equal(evidence.verdict, "failed");
    assert.notEqual(evidence.tree_sha256_after, evidence.tree_sha256_before);
    assert.equal(await fs.readFile(listing, "utf8"), "");
    assert.equal(
      await fs.readFile(path.join(root, "build-output.txt"), "utf8"),
      "candidate\n",
    );
    assert.equal(
      (await fs.stat(path.join(root, "build-output.txt"))).uid,
      candidateIdentity.uid,
    );
    assert.equal(
      evidence.tree_sha256_after,
      await calculateWorktreeDigest(root, sourceManifest),
    );
  } finally {
    await terminateCandidateProcesses({
      terminateGraceMs: 250,
      killGraceMs: 2_000,
    });
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("attestation admission rejects files the candidate could control", async () => {
  assert.equal(process.getuid?.(), 0, "test must run as root");
  prepareSupervisor();
  const sandbox = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-attestation-input-test-"),
  );
  await fs.chmod(sandbox, 0o777);
  const permissive = path.join(sandbox, "permissive.json");
  const candidateOwned = path.join(sandbox, "candidate.json");
  const link = path.join(sandbox, "link.json");

  try {
    await fs.writeFile(permissive, "", { mode: 0o644 });
    await assert.rejects(prepareAttestation(permissive), /mode-0600/u);
    await fs.symlink(permissive, link);
    await assert.rejects(prepareAttestation(link), /mode-0600/u);

    const result = await runCommand(
      {
        command: "sh",
        args: ["-c", 'umask 077; : > "$CANDIDATE_FILE"'],
        env: { CANDIDATE_FILE: candidateOwned },
        timeoutMs: 1_000,
      },
      sandbox,
    );
    assert.equal(result.exitCode, 0);
    await terminateCandidateProcesses({
      terminateGraceMs: 250,
      killGraceMs: 2_000,
    });
    assert.equal((await fs.stat(candidateOwned)).uid, candidateIdentity.uid);
    await assert.rejects(prepareAttestation(candidateOwned), /candidate UID/u);
  } finally {
    await terminateCandidateProcesses({
      terminateGraceMs: 250,
      killGraceMs: 2_000,
    });
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
