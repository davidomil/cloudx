import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx stage "));
  directories.push(root);
  const runner = path.join(root, "private runner");
  const controller = path.join(runner, "checkout");
  const browsers = path.join(runner, "browsers");
  const destination = path.join(root, "staged controller");
  fs.mkdirSync(path.join(controller, "scripts/ci"), { recursive: true });
  fs.mkdirSync(path.join(controller, "node_modules/@playwright"), {
    recursive: true,
  });
  for (const script of [
    "lifecycle",
    "lifecycle-browser",
    "lifecycle-evidence",
    "lifecycle-catalog",
  ])
    fs.copyFileSync(
      `scripts/ci/${script}.mjs`,
      path.join(controller, `scripts/ci/${script}.mjs`),
    );
  for (const name of ["@playwright/test", "playwright", "playwright-core"])
    fs.symlinkSync(
      path.resolve("node_modules", name),
      path.join(controller, "node_modules", name),
    );
  fs.mkdirSync(browsers);
  fs.writeFileSync(path.join(browsers, "chrome"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  fs.writeFileSync(
    path.join(controller, "private-profile"),
    "not harness input",
  );
  fs.chmodSync(runner, 0o700);
  return { runner, controller, browsers, destination };
}

it("stages a standalone harness and executable browser without exposing the runner profile", () => {
  const { runner, controller, browsers, destination } = fixture();
  execFileSync("bash", [
    "scripts/ci/lifecycle-stage.sh",
    controller,
    browsers,
    destination,
  ]);
  // Removing the source proves that neither package links nor controller imports reach back into it.
  fs.rmSync(runner, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    await import('./scripts/ci/lifecycle.mjs');
    await import('./scripts/ci/lifecycle-browser.mjs');
    await import('./scripts/ci/lifecycle-catalog.mjs');
    const { chromium } = await import('@playwright/test');
    console.log(chromium.executablePath());
  `,
    ],
    {
      cwd: destination,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: path.join(destination, "browsers"),
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(path.join(destination, "browsers"));
  expect(fs.existsSync(path.join(destination, "private-profile"))).toBe(false);
  expect(
    fs.statSync(path.join(destination, "browsers/chrome")).mode & 0o777,
  ).toBe(0o755);
  expect(
    fs.statSync(path.join(destination, "scripts/ci/lifecycle.mjs")).mode &
      0o777,
  ).toBe(0o644);
});

it.each(["scripts/ci/lifecycle.mjs", "node_modules/playwright-core"])(
  "fails when required controller input %s is missing",
  (missing) => {
    const { controller, browsers, destination } = fixture();
    fs.rmSync(path.join(controller, missing));
    const result = spawnSync(
      "bash",
      ["scripts/ci/lifecycle-stage.sh", controller, browsers, destination],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(missing);
  },
);

it("fails when the controller browser installation is missing", () => {
  const { controller, browsers, destination } = fixture();
  fs.rmSync(browsers, { recursive: true });
  const result = spawnSync(
    "bash",
    ["scripts/ci/lifecycle-stage.sh", controller, browsers, destination],
    { encoding: "utf8" },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(browsers);
});
