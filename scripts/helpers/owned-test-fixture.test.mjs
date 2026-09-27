import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OwnedTestFixture } from "./owned-test-fixture.mjs";

const receiptNotifications = vi.hoisted(() => ({
  omitFilename: false,
  count: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    watch(...args) {
      const watcher = actual.watch(...args);
      const emit = watcher.emit;
      watcher.emit = function (event, ...details) {
        if (event === "change" && receiptNotifications.omitFilename) {
          receiptNotifications.count++;
          details[1] = null;
        }
        return emit.call(this, event, ...details);
      };
      return watcher;
    },
  };
});

const diagnostics = await fs.mkdtemp(
  path.join(os.tmpdir(), "cloudx-fixture-proof-"),
);
const fixtures = [];
async function createFixture(name, options = {}) {
  const fixture = await OwnedTestFixture.create(name, {
    diagnostics,
    ...options,
  });
  fixtures.push(fixture);
  return fixture;
}
afterEach(async ({ task }) => {
  receiptNotifications.omitFilename = false;
  receiptNotifications.count = 0;
  for (const fixture of fixtures.splice(0)) {
    if (!fixture.closing) await fixture.close(task.result?.state);
  }
  await fs.rm(diagnostics, { recursive: true, force: true });
});

it.skipIf(process.platform !== "linux")(
  "reconciles filename-less notifications before removing descendants, receipts and the fixture",
  async () => {
    receiptNotifications.omitFilename = true;
    const fixture = await createFixture("filename-less receipts");
    const { stdout } = await fixture.run("detached writer", process.execPath, [
      "-e",
      `
        const child = require('node:child_process').spawn(process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        console.log(child.pid);
        child.unref();
      `,
    ]);
    expect(receiptNotifications.count).toBeGreaterThan(0);
    await expect(fs.access(`/proc/${stdout.trim()}`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fixture.close("pass");
    expect(fixture.phases).toHaveLength(2);
    for (const phase of fixture.phases) {
      expect(phase).toMatchObject({
        state: "passed",
        childrenReaped: true,
        completion: { exitCode: 0 },
      });
      await expect(fs.access(phase.receiptDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    await expect(fs.access(fixture.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "joins a pending writer before removing a large tree and records cleanup independently of a failed body",
  async () => {
    const fixture = await createFixture("large fixture");
    const directories = Array.from({ length: 60 }, (_, index) =>
      path.join(fixture.root, String(index)),
    );
    await Promise.all(
      directories.map(async (directory) => {
        await fs.mkdir(directory);
        await Promise.all(
          Array.from({ length: 100 }, (_, index) =>
            fs.writeFile(path.join(directory, String(index)), "fixture"),
          ),
        );
      }),
    );
    let written = false;
    fixture.trackWrite(
      new Promise((resolve) => setTimeout(resolve, 30)).then(async () => {
        await fs.writeFile(path.join(fixture.root, "last-write"), "complete");
        written = true;
      }),
    );
    await fixture.close("fail");
    expect(written).toBe(true);
    await expect(fs.access(fixture.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const report = JSON.parse(
      await fs.readFile(fixture.diagnosticFile, "utf8"),
    );
    expect(report).toMatchObject({
      bodyState: "fail",
      cleanup: { state: "passed" },
    });
    expect(report.phases.at(-1)).toMatchObject({
      phase: "remove-fixture",
      state: "passed",
      close: { code: 0 },
    });
    expect(report.cleanup.durationMs).toBeGreaterThanOrEqual(
      report.cleanup.waitMs,
    );
    expect((await fs.stat(fixture.diagnosticFile)).mode & 0o777).toBe(0o600);
  },
  20_000,
);

it.skipIf(process.platform !== "linux").each([false, true])(
  "reaps a pending descendant before fixture deletion, detached: %s",
  async (detached) => {
    const fixture = await createFixture("descendant");
    const { stdout } = await fixture.run("writer", process.execPath, [
      "-e",
      `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: ${detached}, stdio: ${detached ? "'ignore'" : "'inherit'"} });
    console.log(child.pid);
    child.unref();
  `,
    ]);
    const phase = fixture.phases[0];
    expect(phase.childrenReaped).toBe(true);
    await expect(fs.access(`/proc/${stdout.trim()}`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(phase.receiptDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fixture.close("pass");
    await expect(fs.access(fixture.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "cancels and joins active commands and detached writers before close returns",
  async () => {
    const fixture = await createFixture("active command");
    const pidFile = path.join(fixture.root, "children.json");
    const running = fixture.run("active writer", process.execPath, [
      "-e",
      `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
  `,
    ]);
    const rejected = expect(running).rejects.toMatchObject({
      code: "ECANCELED",
    });
    await expect
      .poll(() => fs.readFile(pidFile, "utf8").then(JSON.parse, () => []))
      .toHaveLength(2);
    const pids = JSON.parse(await fs.readFile(pidFile, "utf8"));
    await fixture.close("failed");
    await rejected;
    for (const pid of pids)
      await expect(fs.access(`/proc/${pid}`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    for (const phase of fixture.phases)
      await expect(fs.access(phase.receiptDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    await expect(fs.access(fixture.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "cancels commands still preparing their supervisor when close begins",
  async () => {
    const fixture = await createFixture("pending launch");
    const running = fixture.run("pending writer", process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const rejected = expect(running).rejects.toMatchObject({
      code: "ECANCELED",
    });
    await fixture.close("failed");
    await rejected;
    await expect(fs.access(fixture.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const phase of fixture.phases)
      await expect(fs.access(phase.receiptDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);

it.skipIf(process.platform !== "linux").each([false, true])(
  "reports a background write rejection even when it settled before close: %s",
  async (settled) => {
    const fixture = await createFixture("failed background write");
    let rejectWrite;
    fixture.trackWrite(
      new Promise((_resolve, reject) => {
        rejectWrite = reject;
      }),
    );
    if (settled) {
      rejectWrite(
        Object.assign(
          new Error("private writer contents must not be retained"),
          { code: "EIO" },
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    const closing = fixture.close("passed");
    const rejected = expect(closing).rejects.toThrow("test body: passed");
    if (!settled)
      rejectWrite(
        Object.assign(
          new Error("private writer contents must not be retained"),
          { code: "EIO" },
        ),
      );
    await rejected;
    const report = await fs.readFile(fixture.diagnosticFile, "utf8");
    expect(JSON.parse(report)).toMatchObject({
      writes: { failed: 1, failures: [{ code: "EIO" }] },
      cleanup: { state: "failed", directoryRemoved: true },
    });
    expect(report).not.toContain("private writer contents");
    await expect(fs.access(fixture.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "times out a command while reaping its detached descendants and receipts",
  async () => {
    const fixture = await createFixture("timed out writer");
    const running = fixture.run(
      "writer timeout",
      process.execPath,
      [
        "-e",
        `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    console.log(process.pid, child.pid);
    setInterval(() => {}, 1000);
  `,
      ],
      { timeout: 1_000 },
    );
    const error = await running.catch((error) => error);
    expect(error).toMatchObject({ code: "ETIMEDOUT" });
    const pids = error.stdout.trim().split(" ");
    expect(pids).toHaveLength(2);
    for (const pid of pids)
      await expect(fs.access(`/proc/${pid}`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(fixture.phases[0].childrenReaped).toBe(true);
    await fixture.close("fail");
  },
);

it.skipIf(process.platform !== "linux").each(["stdout", "stderr"])(
  "preserves the independent %s output limit without leaking command output into diagnostics",
  async (stream) => {
    const fixture = await createFixture("bounded output");
    const error = await fixture
      .run(
        "output",
        process.execPath,
        [
          "-e",
          `process.${stream}.write('private-output-'.repeat(10000)); setInterval(() => {}, 1000);`,
        ],
        { maxBuffer: 1024 },
      )
      .catch((error) => error);
    expect(error).toMatchObject({ code: "ENOBUFS" });
    expect(Buffer.byteLength(error[stream])).toBe(1024);
    expect(error[stream === "stdout" ? "stderr" : "stdout"]).toBe("");
    expect(fixture.phases[0].childrenReaped).toBe(true);
    await fixture.close("fail");
    expect(await fs.readFile(fixture.diagnosticFile, "utf8")).not.toContain(
      "private-output",
    );
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps command failure distinct from successful cleanup and forbids new writers",
  async () => {
    const fixture = await createFixture("body failure");
    await expect(
      fixture.run("body", process.execPath, ["-e", "process.exit(7)"]),
    ).rejects.toMatchObject({ code: 7 });
    await fixture.close("fail");
    expect(fixture.phases.map((phase) => phase.state)).toEqual([
      "failed",
      "passed",
    ]);
    expect(() => fixture.run("late", process.execPath, [])).toThrow("closing");
  },
);

it.skipIf(process.platform !== "linux")(
  "fails an exhausted cleanup budget with private phase diagnostics",
  async () => {
    const fixture = await createFixture("slow cleanup", {
      cleanupMs: 1,
    });
    await expect(fixture.close("pass")).rejects.toThrow("test body: pass");
    const report = JSON.parse(
      await fs.readFile(fixture.diagnosticFile, "utf8"),
    );
    expect(report.cleanup.state).toBe("failed");
    expect(report.phases.at(-1)).toMatchObject({
      phase: "remove-fixture",
      state: "failed",
    });
    await fs.rm(fixture.root, { recursive: true, force: true });
  },
);
