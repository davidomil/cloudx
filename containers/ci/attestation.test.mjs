import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  calculateWorktreeDigest,
  candidateIdentity,
  captureSourceManifest,
  copyGitObjectData,
  executeVerification,
  prepareAttestation,
  prepareSupervisor,
  prepareWorkspace,
  publishAttestation,
  runCommand,
  terminateCandidateProcesses,
  verificationCommands,
} from "./run.mjs";

test("verifier image pins the CI Node runtime and offline native headers", async () => {
  assert.equal(process.versions.node, "22.23.1");
  await fs.access("/usr/local/include/node/node.h");
  assert.equal(process.env.npm_config_nodedir, "/usr/local");
});

test("dependency installation runs lifecycle scripts only inside the candidate sandbox", () => {
  const install = verificationCommands()[0];

  assert.deepEqual(install.args, ["ci", "--offline"]);
  assert.equal(install.command, "npm");
});

test("object-data copy preserves history without importing source Git metadata", async () => {
  const sandbox = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-object-history-"),
  );
  const source = path.join(sandbox, "source");
  const root = path.join(sandbox, "target");
  const git = (directory, ...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@invalid.local",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        directory,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  try {
    await fs.mkdir(source);
    await fs.mkdir(root);
    git(source, "init", "--quiet");
    await fs.writeFile(path.join(source, "tracked.txt"), "historical\n");
    git(source, "add", ".");
    git(source, "commit", "--quiet", "-m", "historical fixture");
    const historical = git(source, "rev-parse", "HEAD");
    git(source, "repack", "-ad");
    await fs.writeFile(path.join(source, "tracked.txt"), "current\n");
    git(source, "commit", "--quiet", "-am", "current fixture");
    const current = git(source, "rev-parse", "HEAD");
    git(root, "init", "--quiet", "--initial-branch=verification");
    await fs.writeFile(path.join(root, "tracked.txt"), "fresh snapshot\n");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "fresh snapshot");
    const head = git(root, "rev-parse", "HEAD");
    const config = await fs.readFile(path.join(root, ".git", "config"));
    await fs.writeFile(
      path.join(source, ".git", "hooks", "hostile-hook"),
      "not copied",
    );
    await fs.writeFile(
      path.join(source, ".git", "objects", "info", "alternates"),
      "/host/private/objects\n",
    );
    await fs.writeFile(path.join(source, ".git", "shallow"), `${historical}\n`);
    const before = await objectFixtureSnapshot(source);

    const result = await copyGitObjectData(source, root);
    assert.ok(result.files > 2);
    assert.equal(git(root, "cat-file", "-t", historical), "commit");
    assert.equal(git(root, "show", `${historical}:tracked.txt`), "historical");
    assert.equal(git(root, "show", `${current}:tracked.txt`), "current");
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "branch", "--show-current"), "verification");
    assert.equal(
      await fs.readFile(path.join(root, "tracked.txt"), "utf8"),
      "fresh snapshot\n",
    );
    assert.deepEqual(
      await fs.readFile(path.join(root, ".git", "config")),
      config,
    );
    for (const excluded of [
      "shallow",
      "hooks/hostile-hook",
      "objects/info/alternates",
      "refs/heads/master",
      "refs/heads/main",
    ]) {
      await assert.rejects(fs.lstat(path.join(root, ".git", excluded)), {
        code: "ENOENT",
      });
    }
    assert.deepEqual(await objectFixtureSnapshot(source), before);
    // Identical objects already present in a fresh snapshot are not overwritten.
    assert.deepEqual(await copyGitObjectData(source, root), result);
    assert.deepEqual(await objectFixtureSnapshot(source), before);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("object-data copy rejects symlinks, unpaired packs, and size/count overruns", async (t) => {
  const loose = `ab/${"c".repeat(38)}`;
  const pack = `pack/pack-${"d".repeat(40)}.pack`;
  for (const kind of [
    "git-link",
    "objects-link",
    "directory-link",
    "file-link",
    "unpaired",
    "file-size",
    "total-size",
    "count",
    "conflict",
  ]) {
    await t.test(kind, async () => {
      const sandbox = await fs.mkdtemp(
        path.join(os.tmpdir(), "cloudx-object-reject-"),
      );
      const source = path.join(sandbox, "source");
      const root = path.join(sandbox, "target");
      const objects = path.join(source, ".git", "objects");
      try {
        await fs.mkdir(path.join(objects, "ab"), { recursive: true });
        await fs.mkdir(path.join(objects, "pack"));
        await fs.mkdir(path.join(root, ".git", "objects"), { recursive: true });
        await fs.writeFile(path.join(objects, loose), "object");
        let options;
        if (kind.endsWith("-link")) {
          const input =
            kind === "git-link"
              ? path.join(source, ".git")
              : kind === "objects-link"
                ? objects
                : kind === "directory-link"
                  ? path.join(objects, "ab")
                  : path.join(objects, loose);
          await fs.rename(input, `${input}-original`);
          await fs.symlink(`${input}-original`, input);
        } else if (kind === "unpaired") {
          await fs.writeFile(path.join(objects, pack), "pack");
        } else if (kind === "file-size") {
          await fs.truncate(path.join(objects, loose), 64 * 1024 * 1024 + 1);
        } else if (kind === "total-size") {
          options = { maximumBytes: 1 };
        } else if (kind === "count") {
          await fs.writeFile(
            path.join(objects, `ab/${"e".repeat(38)}`),
            "second",
          );
          options = { maximumFiles: 1 };
        } else {
          await fs.mkdir(path.join(root, ".git", "objects", "ab"));
          await fs.writeFile(
            path.join(root, ".git", "objects", loose),
            "conflicting",
          );
        }
        await assert.rejects(
          copyGitObjectData(source, root, options),
          /Git object input/u,
        );
      } finally {
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    });
  }
});

async function objectFixtureSnapshot(directory) {
  const snapshot = [];
  for (const name of (
    await fs.readdir(directory, { recursive: true })
  ).sort()) {
    const target = path.join(directory, name);
    const stat = await fs.lstat(target);
    if (stat.isFile())
      snapshot.push([
        name,
        stat.mode,
        (await fs.readFile(target)).toString("hex"),
      ]);
  }
  return snapshot;
}

test("candidate commands receive an identity-consistent login environment", async () => {
  assert.equal(process.getuid?.(), 0, "test must run as root");
  prepareSupervisor();
  const sandbox = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-candidate-user-"),
  );
  await fs.chmod(sandbox, 0o777);
  const output = path.join(sandbox, "user.txt");

  try {
    const result = await runCommand(
      {
        command: "sh",
        args: ["-c", 'printf "%s" "$USER" > "$OUTPUT"'],
        env: { OUTPUT: output },
        timeoutMs: 1_000,
      },
      sandbox,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(await fs.readFile(output, "utf8"), candidateIdentity.username);
  } finally {
    await terminateCandidateProcesses({
      terminateGraceMs: 250,
      killGraceMs: 2_000,
    });
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

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
  execFileSync("git", ["init", "--quiet", source]);

  try {
    await prepareWorkspace({
      source,
      root,
      archive: path.join(sandbox, "source.tar"),
      npmCacheSource: cache,
    });
    for (const owned of [
      root,
      path.join(root, ".git"),
      path.join(root, ".git", "config"),
    ]) {
      assert.equal((await fs.stat(owned)).uid, candidateIdentity.uid);
    }
    assert.equal((await fs.stat(source)).uid, 0);
    assert.equal((await fs.stat(path.join(source, ".git"))).uid, 0);
    const ownershipProbe = await runCommand(
      {
        command: "git",
        args: ["rev-parse", "--absolute-git-dir"],
        env: {
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        timeoutMs: 1_000,
      },
      root,
    );
    assert.equal(ownershipProbe.exitCode, 0);
    assert.equal(
      ownershipProbe.stdoutSha256,
      createHash("sha256")
        .update(`${path.join(root, ".git")}\n`)
        .digest("hex"),
    );
    const objects = path.join(root, ".git", "objects");
    const existingPrefixes = new Set(await fs.readdir(objects));
    const payloads = new Map();
    let pair;
    for (let index = 0; index < 10_000 && !pair; index += 1) {
      const body = `candidate object ${index}`;
      const oid = createHash("sha1")
        .update(`blob ${Buffer.byteLength(body)}\0${body}`)
        .digest("hex");
      const prefix = oid.slice(0, 2);
      if (existingPrefixes.has(prefix)) continue;
      const previous = payloads.get(prefix);
      if (previous) pair = [previous, { body, oid, prefix }];
      else payloads.set(prefix, { body, oid, prefix });
    }
    assert.ok(pair, "bounded fixture must find a new shared object prefix");
    execFileSync("git", ["-C", source, "hash-object", "-w", "--stdin"], {
      input: pair[0].body,
    });
    const immutableSource = await objectFixtureSnapshot(source);
    await copyGitObjectData(source, root);
    const objectWrite = await runCommand(
      {
        command: "sh",
        args: ["-c", 'printf %s "$OBJECT_BODY" | git hash-object -w --stdin'],
        env: {
          OBJECT_BODY: pair[1].body,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        timeoutMs: 1_000,
      },
      root,
    );
    assert.equal(objectWrite.exitCode, 0);
    assert.equal(
      (await fs.stat(path.join(objects, pair[1].prefix, pair[1].oid.slice(2))))
        .uid,
      candidateIdentity.uid,
    );
    assert.deepEqual(await objectFixtureSnapshot(source), immutableSource);
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

test(
  "failed browser verification retains diagnostics after its workspace is removed",
  { timeout: 30_000 },
  async () => {
    prepareSupervisor();
    const sandbox = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-browser-evidence-"),
    );
    const source = path.join(sandbox, "source");
    const root = path.join(sandbox, "work", "repository");
    const cache = path.join(sandbox, "cache");
    const target = path.join(sandbox, "results.json");
    await fs.chmod(sandbox, 0o755);
    await fs.mkdir(source);
    await fs.mkdir(cache);
    await fs.writeFile(target, "", { flag: "wx", mode: 0o600 });
    await fs.writeFile(
      path.join(source, ".gitignore"),
      "test-results/\nplaywright-report/\n",
    );
    await fs.writeFile(
      path.join(source, "package.json"),
      JSON.stringify({
        scripts: {
          "test:browser":
            "node /opt/cloudx-base/node_modules/@playwright/test/cli.js test",
        },
      }),
    );
    await fs.writeFile(
      path.join(source, "playwright.config.mjs"),
      `
    export default {
      testDir: '.', testMatch: 'failure.spec.mjs', outputDir: 'test-results/browser',
      workers: 1, retries: 0, timeout: 10000, reporter: 'line',
      use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    };
  `,
    );
    await fs.writeFile(
      path.join(source, "failure.spec.mjs"),
      `
    import { test, expect } from '/opt/cloudx-base/node_modules/@playwright/test/index.mjs';
    import fs from 'node:fs/promises';
    test('retains a failed browser observation', async ({ page }, testInfo) => {
      await page.setContent('<button>Save queued rule</button>');
      const log = testInfo.outputPath('browser-fixture.log');
      await fs.writeFile(log, 'fixture: save response was not observed\\n');
      await testInfo.attach('browser fixture', { path: log, contentType: 'text/plain' });
      console.log('fixture: server accepted the pull');
      console.error('fixture: save response was not observed');
      await fs.writeFile(testInfo.outputPath('forged-verdict.txt'), '{"verdict":"passed"}');
      expect(1).toBe(2);
    });
  `,
    );
    execFileSync("git", ["init", "--quiet", source]);
    const settleCandidates = () =>
      terminateCandidateProcesses({
        terminateGraceMs: 250,
        killGraceMs: 2_000,
      });

    try {
      await prepareWorkspace({
        source,
        root,
        archive: path.join(sandbox, "source.tar"),
        npmCacheSource: cache,
      });
      const attestation = await prepareAttestation(target);
      const browser = verificationCommands().at(-1);
      const evidence = await executeVerification({
        root,
        commands: [
          {
            ...browser,
            timeoutMs: 20_000,
            env: { ...browser.env, HOME: path.join(sandbox, "work", "home") },
          },
        ],
        settleCandidates,
      });
      await publishAttestation(attestation, evidence);
      await fs.rm(root, { recursive: true });
      const saved = JSON.parse(await fs.readFile(target, "utf8"));

      assert.equal(saved.verdict, "failed");
      assert.equal(saved.commands[0].exit_code, 1);
      assert.equal(saved.tree_sha256_before, saved.tree_sha256_after);
      assert.equal(saved.diagnostics.trust, "untrusted-candidate-output");
      assert.match(
        saved.diagnostics.commands[0].stdout.text,
        /fixture: server accepted the pull/u,
      );
      assert.match(
        saved.diagnostics.commands[0].stderr.text,
        /fixture: save response was not observed/u,
      );
      const files = saved.diagnostics.browser.files;
      for (const name of [
        "trace.zip",
        "error-context.md",
        "test-failed-1.png",
        "browser-fixture.log",
      ]) {
        assert.ok(
          files.some((file) => file.path.endsWith(`/${name}`)),
          `missing ${name}`,
        );
      }
      const trace = files.find((file) => file.path.endsWith("/trace.zip"));
      const bytes = Buffer.from(trace.base64, "base64");
      assert.equal(bytes.length, trace.bytes);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        trace.sha256,
      );
      const retained = path.join(sandbox, "retained-trace.zip");
      await fs.writeFile(retained, bytes);
      execFileSync("python3", ["-m", "zipfile", "--test", retained]);
      assert.notEqual((await fs.stat(target)).uid, candidateIdentity.uid);
      assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    } finally {
      await settleCandidates();
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  },
);
