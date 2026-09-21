import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attempts,
  requiredCases,
  requireStressRuntime,
  runCommand,
  runTerminalStress,
  stressRuntime,
} from "./terminal-stress/run.mjs";
import { measureReplay } from "./terminal-stress/measure-replay.mjs";

const roots = [];
const runtime = {
  node: "v22.23.1",
  platform: "linux",
  cpu_max: "200000 100000",
  memory_max: String(7 * 1024 ** 3),
  memory_swap_max: "0",
};
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function fixture(behavior = "") {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-terminal-stress-"),
  );
  roots.push(root);
  const script = path.join(root, "fixture.mjs");
  await fs.writeFile(
    script,
    `
import fs from 'node:fs/promises';
const number = Number(process.env.CLOUDX_TERMINAL_STRESS_ATTEMPT);
const filename = process.argv.find(value => value.startsWith('--outputFile=')).slice('--outputFile='.length);
const cases = ${JSON.stringify(requiredCases)}.map(title => ({ title, fullName: title, status: 'passed', duration: number }));
const report = { success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [{ assertionResults: cases }] };
${behavior}
await fs.writeFile(filename, JSON.stringify(report));
`,
  );
  const directory = path.join(root, "results");
  return { root, directory, command: [process.execPath, script], runtime };
}

describe("terminal stress evidence", () => {
  it("keeps every attempt and duration after an initial failure and bounds noisy output", async () => {
    const input = await fixture(`
process.stdout.write('x'.repeat(100000));
process.stderr.write('y'.repeat(100000));
if (number === 1) process.exitCode = 1;
`);
    const results = await runTerminalStress(input);
    expect(results.verdict).toBe("failed");
    expect(results.attempts.map((attempt) => attempt.outcome)).toEqual([
      "failed",
      "passed",
      "passed",
    ]);
    expect(results.attempts).toHaveLength(attempts);
    for (const attempt of results.attempts) {
      expect(attempt.duration_ms).toBeGreaterThan(0);
      expect(
        attempt.cases.every((test) => test.duration_ms === attempt.number),
      ).toBe(true);
      for (const stream of [attempt.stdout, attempt.stderr]) {
        expect(stream.total_bytes).toBe(100000);
        expect(Buffer.byteLength(stream.text)).toBe(64 * 1024);
        expect(stream.omitted_bytes).toBe(100000 - 64 * 1024);
      }
    }
    expect(
      JSON.parse(
        await fs.readFile(path.join(input.directory, "results.json"), "utf8"),
      ),
    ).toEqual(results);
    expect(await fs.readdir(input.directory)).not.toContain("results.json.tmp");
  });

  it.each(["skipped", "failed", "missing"])(
    "rejects a %s required case despite a successful command",
    async (status) => {
      const input = await fixture(
        status === "missing"
          ? "cases.pop();"
          : `cases.at(-1).status = '${status}';`,
      );
      const results = await runTerminalStress(input);
      expect(results.verdict).toBe("failed");
      expect(
        results.attempts.every(
          (attempt) => attempt.exit_code === 0 && attempt.outcome === "failed",
        ),
      ).toBe(true);
      expect(results.attempts[0].report_errors).toContain(
        `Required case did not pass exactly once: ${requiredCases.at(-1)}`,
      );
    },
  );

  it("records signals and incomplete reports as failures without cancelling remaining attempts", async () => {
    const input = await fixture(
      "if (number === 1) process.kill(process.pid, 'SIGTERM');",
    );
    const results = await runTerminalStress(input);
    expect(results.verdict).toBe("failed");
    expect(results.attempts[0]).toMatchObject({
      exit_code: null,
      signal: "SIGTERM",
      outcome: "failed",
    });
    expect(results.attempts[0].report_errors[0]).toContain("ENOENT");
    expect(results.attempts.slice(1).map((attempt) => attempt.outcome)).toEqual(
      ["passed", "passed"],
    );
  });

  it("records an unfinished attempt before starting its process", async () => {
    const input = await fixture(`
const aggregate = JSON.parse(await fs.readFile(new URL('./results.json', 'file://' + filename.replace(/attempt-\\d+\\/vitest.json$/, '')), 'utf8'));
if (aggregate.verdict !== 'incomplete' || aggregate.attempts.at(-1).outcome !== 'incomplete') process.exitCode = 1;
`);
    expect((await runTerminalStress(input)).verdict).toBe("passed");
  });

  it("rejects a passing required case whose duration was not recorded", async () => {
    const input = await fixture("delete cases.at(-1).duration;");
    const results = await runTerminalStress(input);
    expect(results.verdict).toBe("failed");
    expect(results.attempts[0].report_errors).toContain(
      "A selected terminal case has no valid duration.",
    );
  });

  it("refuses stale attempt reports before launching a new run", async () => {
    const input = await fixture();
    await fs.mkdir(input.directory);
    await fs.writeFile(
      path.join(input.directory, "vitest.json"),
      '{"success":true}',
    );
    await expect(runTerminalStress(input)).rejects.toThrow(
      "output directory must be empty",
    );
    expect(await fs.readdir(input.directory)).toEqual(["vitest.json"]);
  });

  it("preserves runtime prerequisite failures as machine-readable evidence", async () => {
    const input = await fixture();
    const results = await runTerminalStress({
      ...input,
      runtime: { ...runtime, node: "v25.0.0" },
    });
    expect(results).toMatchObject({
      verdict: "failed",
      attempts: [],
      error: expect.stringContaining("Terminal stress requires"),
    });
    expect(
      JSON.parse(
        await fs.readFile(path.join(input.directory, "results.json"), "utf8"),
      ),
    ).toEqual(results);
  });

  it("reports launch errors with bounded diagnostic output", async () => {
    const result = await runCommand(["/missing/cloudx-terminal-stress"]);
    expect(result.exit_code).not.toBe(0);
    expect(result.stderr.text).toContain("ENOENT");
  });

  it("reads enforced resource limits and refuses a different runtime", async () => {
    const input = await fixture();
    for (const [name, value] of [
      ["cpu.max", runtime.cpu_max],
      ["memory.max", runtime.memory_max],
      ["memory.swap.max", runtime.memory_swap_max],
    ])
      await fs.writeFile(path.join(input.root, name), `${value}\n`);
    const observed = await stressRuntime(input.root);
    expect(observed).toEqual({
      ...runtime,
      node: process.version,
      platform: process.platform,
    });
    expect(() => requireStressRuntime(runtime)).not.toThrow();
    for (const overrides of [
      { node: "v25.0.0" },
      { platform: "darwin" },
      { cpu_max: "max 100000" },
      { memory_max: "max" },
      { memory_swap_max: "1024" },
    ])
      expect(() => requireStressRuntime({ ...runtime, ...overrides })).toThrow(
        "Terminal stress requires",
      );
  });

  it("measures a full 32 MiB replay separately without imposing an elapsed-time threshold", () => {
    const result = measureReplay();
    expect(result).toMatchObject({
      kind: "terminal-replay-throughput",
      bytes: 32 * 1024 * 1024,
      chunk_bytes: 4096,
      retained_bytes: 32 * 1024 * 1024,
    });
    expect(Number.isFinite(result.append_mib_per_second)).toBe(true);
  });
});
