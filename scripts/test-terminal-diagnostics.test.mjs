import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("retains diagnostics from actual Vitest deadlines and assertion failures while passing cases remain passes", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  await fs.mkdir(path.join(root, "test-results"), { recursive: true });
  const directory = await fs.mkdtemp(
    path.join(root, "test-results/terminal-diagnostic-probe-"),
  );
  const helper = path.join(
    root,
    "apps/server/src/terminal/testing/TerminalDiagnostics.ts",
  );
  try {
    await fs.writeFile(
      path.join(directory, "vitest.config.mjs"),
      'export default { test: { include: ["probe.test.ts"] } };',
    );
    await fs.writeFile(
      path.join(directory, "probe.test.ts"),
      `
      import { it, expect } from "vitest";
      import { retainTerminalDiagnostics } from ${JSON.stringify(helper)};
      it("deadline", { timeout: 50 }, async context => {
        const diagnostics = retainTerminalDiagnostics(context, "deadline");
        diagnostics.enterPhase("waiting for REPLAY_SCREEN_READY");
        await new Promise(() => {});
      });
      it("assertion", context => {
        retainTerminalDiagnostics(context, "assertion").enterPhase("verify shell PID");
        expect("changed PID").toBe("original PID");
      });
      it("success", context => {
        retainTerminalDiagnostics(context, "success").enterPhase("confirmed deletion");
      });
    `,
    );
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [
          path.join(root, "node_modules/vitest/vitest.mjs"),
          "run",
          "--root",
          directory,
          "--config",
          path.join(directory, "vitest.config.mjs"),
          "--reporter=dot",
          "--reporter=json",
          "--outputFile",
          path.join(directory, "results.json"),
        ],
        {
          cwd: root,
          env: { ...process.env, CLOUDX_TERMINAL_DIAGNOSTICS_DIR: directory },
        },
        (error, stdout, stderr) =>
          resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    expect(result.code).toBe(1);
    const read = async (name) =>
      JSON.parse(
        await fs.readFile(path.join(directory, `${name}.json`), "utf8"),
      );
    expect(await read("deadline")).toMatchObject({
      status: "failed",
      phase: "waiting for REPLAY_SCREEN_READY",
      runtime: { node: process.version },
    });
    expect((await read("deadline")).error).toContain("timed out");
    expect(await read("assertion")).toMatchObject({
      status: "failed",
      phase: "verify shell PID",
    });
    expect((await read("assertion")).error).toContain("original PID");
    expect(await read("success")).toMatchObject({
      status: "passed",
      phase: "confirmed deletion",
    });
    expect(await read("results")).toMatchObject({
      numFailedTests: 2,
      numPassedTests: 1,
    });
    expect(result.stderr).toContain("TERMINAL_DIAGNOSTICS");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 15_000);
