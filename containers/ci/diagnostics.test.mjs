import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectBrowserDiagnostics,
  CommandOutputTail,
  diagnosticLimits,
} from "./diagnostics.mjs";
import {
  candidateIdentity,
  executeVerification,
  prepareSupervisor,
  runCommand,
  terminateCandidateProcesses,
} from "./run.mjs";

test("command output keeps a bounded tail and counts omitted bytes", () => {
  const output = new CommandOutputTail(8);
  output.append(Buffer.from("first\n"));
  assert.deepEqual(output.snapshot(), {
    text: "first\n",
    total_bytes: 6,
    omitted_bytes: 0,
  });
  output.append(Buffer.from("second\n"));
  assert.deepEqual(output.snapshot(), {
    text: "\nsecond\n",
    total_bytes: 13,
    omitted_bytes: 5,
  });
  output.append(Buffer.alloc(1000, "x"));
  assert.deepEqual(output.snapshot(), {
    text: "xxxxxxxx",
    total_bytes: 1013,
    omitted_bytes: 1005,
  });
});

test("failed command tails are bounded while trusted hashes cover all output", async (t) => {
  const fixture = await diagnosticFixture(t);
  await fixture.run("fs.rmSync(process.env.BROWSER, { recursive: true });");
  const stdout = `${"x".repeat(diagnosticLimits.outputTailBytes + 20)}\nlast server observation\n`;
  const stderr = `${"y".repeat(diagnosticLimits.outputTailBytes + 40)}\nlast request failure\n`;
  const result = await executeVerification({
    root: fixture.root,
    commands: [
      planned(`
      const stdout = 'x'.repeat(${diagnosticLimits.outputTailBytes + 20}) + '\\nlast server observation\\n';
      const stderr = 'y'.repeat(${diagnosticLimits.outputTailBytes + 40}) + '\\nlast request failure\\n';
      process.stdout.write(stdout, () => {
        process.stderr.write(stderr, () => process.exit(1));
      });
    `),
    ],
    worktreeDigest: async () => "d".repeat(64),
    settleCandidates,
  });
  assert.equal(result.verdict, "failed");
  for (const [name, output] of Object.entries({ stdout, stderr })) {
    assert.equal(
      result.commands[0][`${name}_sha256`],
      createHash("sha256").update(output).digest("hex"),
    );
    const retained = result.diagnostics.commands[0][name];
    assert.equal(
      retained.text,
      output.slice(-diagnosticLimits.outputTailBytes),
    );
    assert.equal(retained.total_bytes, Buffer.byteLength(output));
    assert.equal(
      retained.omitted_bytes,
      Buffer.byteLength(output) - diagnosticLimits.outputTailBytes,
    );
  }
  assert.deepEqual(result.diagnostics.browser.files, []);
  assert.deepEqual(result.diagnostics.browser.skipped, [
    { path: "test-results/browser", reason: "not-produced" },
  ]);
});

test("browser diagnostics never follow links or read noncandidate files", async (t) => {
  for (const kind of [
    "workspace-link",
    "results-link",
    "browser-link",
    "nested-link",
    "file-link",
    "hardlink",
    "fifo",
    "foreign-owner",
    "traversal-name",
    "control-name",
  ]) {
    await t.test(kind, async (t) => {
      const fixture = await diagnosticFixture(t);
      await fixture.run(
        `
        fs.mkdirSync(process.env.OUTSIDE, { recursive: true });
        fs.writeFileSync(path.join(process.env.OUTSIDE, 'trace.zip'), 'outside-candidate-secret');
        const kind = process.env.KIND;
        const location = kind === 'workspace-link' ? process.env.ROOT
          : kind === 'results-link' ? path.join(process.env.ROOT, 'test-results')
          : process.env.BROWSER;
        if (['workspace-link', 'results-link', 'browser-link'].includes(kind)) {
          fs.renameSync(location, location + '-original');
          fs.symlinkSync(process.env.OUTSIDE, location);
        } else if (kind === 'nested-link') {
          fs.symlinkSync(process.env.OUTSIDE, path.join(process.env.BROWSER, 'linked'));
        } else if (kind === 'file-link') {
          fs.symlinkSync(process.env.SECRET, path.join(process.env.BROWSER, 'trace.zip'));
        } else if (kind === 'hardlink') {
          fs.linkSync(path.join(process.env.OUTSIDE, 'trace.zip'), path.join(process.env.BROWSER, 'trace.zip'));
        } else if (kind === 'fifo') {
          require('node:child_process').execFileSync('mkfifo', [path.join(process.env.BROWSER, 'trace.zip')]);
        } else if (kind === 'traversal-name') {
          fs.writeFileSync(path.join(process.env.BROWSER, '..\\\\..\\\\results.json.log'), 'forged');
        } else if (kind === 'control-name') {
          fs.writeFileSync(path.join(process.env.BROWSER, 'bad\\nname.log'), 'forged');
        }
      `,
        { KIND: kind },
      );
      if (kind === "foreign-owner")
        await fs.writeFile(
          path.join(fixture.browser, "trace.zip"),
          "supervisor-private",
        );

      const report = await collectBrowserDiagnostics(
        fixture.root,
        candidateIdentity.uid,
      );
      assert.deepEqual(report.files, []);
      assert.ok(report.skipped.length > 0);
      assert.equal(
        await fs.readFile(fixture.secret, "utf8"),
        "supervisor-private",
      );
      assert.equal(
        JSON.stringify(report).includes("supervisor-private"),
        false,
      );
      assert.equal(
        JSON.stringify(report).includes("outside-candidate-secret"),
        false,
      );
    });
  }
});

test("browser artifact limits report what was skipped without truncating trace bytes", async (t) => {
  for (const kind of [
    "file-size",
    "total-size",
    "file-count",
    "entry-count",
    "depth",
  ]) {
    await t.test(kind, async (t) => {
      const fixture = await diagnosticFixture(t);
      await fixture.run(`
        fs.writeFileSync(path.join(process.env.BROWSER, 'trace.zip'), 'trace');
        fs.writeFileSync(path.join(process.env.BROWSER, 'error-context.md'), 'context');
        fs.writeFileSync(path.join(process.env.BROWSER, 'fixture.log'), 'fixture');
        fs.mkdirSync(path.join(process.env.BROWSER, 'deep', 'deeper'), { recursive: true });
        fs.writeFileSync(path.join(process.env.BROWSER, 'deep', 'deeper', 'trace.zip'), 'deep trace');
      `);
      const limits = { ...diagnosticLimits };
      if (kind === "file-size") limits.fileBytes = 4;
      if (kind === "total-size") limits.totalBytes = 5;
      if (kind === "file-count") limits.files = 1;
      if (kind === "entry-count") limits.entries = 2;
      if (kind === "depth") limits.depth = 1;

      const report = await collectBrowserDiagnostics(
        fixture.root,
        candidateIdentity.uid,
        limits,
      );
      assert.equal(report.truncated, true);
      assert.ok(
        report.skipped.some((entry) => entry.reason === `${kind}-limit`),
      );
      assert.ok(report.files.length <= limits.files);
      assert.ok(report.scanned_entries <= limits.entries);
      assert.ok(
        report.files.reduce((bytes, file) => bytes + file.bytes, 0) <=
          limits.totalBytes,
      );
      for (const file of report.files) {
        const expected = await fs.readFile(path.join(fixture.root, file.path));
        assert.deepEqual(Buffer.from(file.base64, "base64"), expected);
        assert.equal(file.bytes, expected.length);
      }
    });
  }
});

test("successful verification does not inspect or retain candidate diagnostics", async (t) => {
  const fixture = await diagnosticFixture(t);
  await fixture.run(
    `fs.symlinkSync(process.env.SECRET, path.join(process.env.BROWSER, 'trace.zip'));`,
  );
  const result = await executeVerification({
    root: fixture.root,
    commands: [planned("process.stdout.write('successful output');")],
    worktreeDigest: async () => "a".repeat(64),
    settleCandidates,
  });
  assert.equal(result.verdict, "passed");
  assert.equal(Object.hasOwn(result, "diagnostics"), false);
});

test("candidate teardown completes before the verifier retains final artifact bytes", async (t) => {
  const fixture = await diagnosticFixture(t);
  await fixture.run(`
    fs.writeFileSync(path.join(process.env.ROOT, 'daemon.cjs'), ${JSON.stringify(`
      const fs = require('node:fs');
      const target = process.env.BROWSER + '/fixture.log';
      fs.writeFileSync(target, 'before quiescence');
      process.on('SIGTERM', () => { fs.writeFileSync(target, 'after quiescence'); process.exit(0); });
      process.send('ready');
      setInterval(() => {}, 1000);
    `)});
  `);
  const result = await executeVerification({
    root: fixture.root,
    commands: [
      planned(`
      const child = require('node:child_process').fork('daemon.cjs', {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, BROWSER: process.cwd() + '/test-results/browser' },
      });
      child.on('message', () => { child.disconnect(); child.unref(); process.exit(1); });
    `),
    ],
    worktreeDigest: async () => "b".repeat(64),
    settleCandidates,
  });
  assert.equal(result.verdict, "failed");
  assert.equal(result.diagnostics.trust, "untrusted-candidate-output");
  const log = result.diagnostics.browser.files.find((file) =>
    file.path.endsWith("/fixture.log"),
  );
  assert.equal(
    Buffer.from(log.base64, "base64").toString(),
    "after quiescence",
  );
});

test("unresolved candidate teardown stops verification before diagnostic reads", async (t) => {
  const fixture = await diagnosticFixture(t);
  const originalOpen = fs.opendir;
  let diagnosticReads = 0;
  fs.opendir = async (...args) => {
    diagnosticReads += 1;
    return originalOpen(...args);
  };
  try {
    await assert.rejects(
      executeVerification({
        root: fixture.root,
        commands: [planned("process.exit(1)")],
        worktreeDigest: async () => "c".repeat(64),
        settleCandidates: async () => {
          throw new Error("candidate remains alive");
        },
      }),
      /candidate remains alive/u,
    );
    assert.equal(diagnosticReads, 0);
  } finally {
    fs.opendir = originalOpen;
  }
});

function planned(script, env = {}) {
  return {
    command: process.execPath,
    args: ["-e", script],
    env,
    timeoutMs: 3000,
  };
}

function settleCandidates() {
  return terminateCandidateProcesses({
    terminateGraceMs: 250,
    killGraceMs: 2000,
  });
}

async function diagnosticFixture(t) {
  prepareSupervisor();
  const sandbox = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-diagnostics-"),
  );
  const work = path.join(sandbox, "work");
  const root = path.join(work, "repository");
  const browser = path.join(root, "test-results", "browser");
  const secret = path.join(sandbox, "results.json");
  await fs.chmod(sandbox, 0o755);
  await fs.mkdir(work, { mode: 0o777 });
  await fs.chmod(work, 0o1777);
  await fs.writeFile(secret, "supervisor-private", { mode: 0o600 });
  t.after(async () => {
    await settleCandidates();
    await fs.rm(sandbox, { recursive: true, force: true });
  });
  const run = async (script, environment = {}) => {
    const result = await runCommand(
      planned(
        `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.mkdirSync(process.env.BROWSER, { recursive: true });
      ${script}
    `,
        {
          ROOT: root,
          BROWSER: browser,
          SECRET: secret,
          OUTSIDE: path.join(work, "outside"),
          ...environment,
        },
      ),
      sandbox,
    );
    await settleCandidates();
    assert.equal(result.exitCode, 0);
  };
  await run("");
  return { root, browser, secret, run };
}
