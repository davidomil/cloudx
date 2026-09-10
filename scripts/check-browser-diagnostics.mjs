// Run `npm run build`, then `node scripts/check-browser-diagnostics.mjs`.
// Optional scenario names select a subset, for example `settings-startup`.
// Generated fixtures and failure reports stay under ignored test-results/diagnostics.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { utils } from "playwright-core/lib/coreBundle";

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixtures = [
  "cloudx-smoke",
  "rules-skills-git",
  "rules-skills-git-origin-ordering",
  "rules-skills-queued-metadata",
  "rules-skills-request-ordering",
  "settings",
];
const scenarios = fixtures.flatMap((fixture) =>
  (fixture === "settings" ||
  fixture === "cloudx-smoke" ||
  fixture === "rules-skills-git"
    ? ["signal", "assertion", "startup"]
    : ["signal"]
  ).map((failure) => ({ fixture, failure, name: `${fixture}-${failure}` })),
);
const selected = process.argv.slice(2);
for (const name of selected)
  assert(
    scenarios.some((scenario) => scenario.name === name),
    `Unknown probe: ${name}`,
  );
const probes = scenarios.filter(
  ({ name }) => !selected.length || selected.includes(name),
);
const diagnosticsRoot = path.join(repoRoot, "test-results", "diagnostics");
await fs.mkdir(diagnosticsRoot, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(diagnosticsRoot, "run-"));
const fixtureRoot = path.join(runRoot, "fixtures");
await fs.mkdir(fixtureRoot);
console.log(`Browser diagnostics probes: ${runRoot}`);

for (const probe of probes) await writeProbe(probe);
await fs.writeFile(
  path.join(runRoot, "playwright.config.ts"),
  `import base from ${JSON.stringify(path.join(repoRoot, "playwright.config.ts"))};
export default {
  ...base,
  testDir: ${JSON.stringify(fixtureRoot)},
  outputDir: ${JSON.stringify(path.join(runRoot, "results"))},
  workers: 2,
  globalTimeout: 240_000,
  reporter: [
    ["line"],
    ["json", { outputFile: ${JSON.stringify(path.join(runRoot, "results.json"))} }],
    ["html", { open: "never", outputFolder: ${JSON.stringify(path.join(runRoot, "report"))} }],
  ],
};
`,
);

const exitCode = await runPlaywright();
assert.equal(
  exitCode,
  1,
  "Playwright must fail only because of the intentional probes",
);
const report = JSON.parse(
  await fs.readFile(path.join(runRoot, "results.json"), "utf8"),
);
assert.deepEqual(
  report.errors,
  [],
  "Playwright must have no worker or global errors",
);
const tests = collectTests(report.suites);
assert.equal(
  tests.length,
  probes.length * 2,
  "Each probe must run on desktop and mobile",
);
const htmlTests = await readHtmlTests();
assert.equal(htmlTests.length, tests.length);

for (const { title, test } of tests) {
  const probe = probes.find(
    ({ name }) => title === `browser diagnostics ${name}`,
  );
  assert(probe, `Unexpected test ran: ${title}`);
  assert.equal(test.results.length, 1, "Probes must not retry");
  const result = test.results[0];
  assert.equal(
    result.status,
    "failed",
    `${title}: must fail without timing out`,
  );
  assert.equal(
    result.errors.length,
    1,
    `${title}: teardown must add no errors`,
  );
  assert(
    result.errors[0].message.includes(failureMessage(probe)),
    `${title}: failed for an unexpected reason: ${result.errors[0].message}`,
  );
  const htmlTest = htmlTests.find(
    (entry) => entry.title === title && entry.projectName === test.projectName,
  );
  assert(htmlTest, `${title}: missing HTML report entry`);
  const htmlAttachments = htmlTest.results[0].attachments;
  const log = result.attachments.find(({ name }) => name === "server.log");
  assert(log?.path, `${title}: missing server.log attachment`);
  const savedLog = path.join(
    path.dirname(path.dirname(log.path)),
    "server.log",
  );
  const logContents = await fs.readFile(savedLog, "utf8");
  for (const stream of ["stdout", "stderr"])
    assert(
      logContents.includes(marker(probe, stream)),
      `${title}: missing ${stream}`,
    );
  assert.equal(await fs.readFile(log.path, "utf8"), logContents);
  const htmlLog = htmlAttachments.find(({ name }) => name === "server.log");
  assert(htmlLog?.path, `${title}: missing downloadable HTML log attachment`);
  assert.equal(
    await fs.readFile(htmlAttachmentPath(htmlLog), "utf8"),
    logContents,
  );
  for (const attachment of htmlAttachments.filter(({ path: file }) => file))
    assert((await fs.stat(htmlAttachmentPath(attachment))).size > 0);
  if (probe.failure !== "startup") {
    for (const name of ["trace", "screenshot", "video"]) {
      assert(
        result.attachments.some((attachment) => attachment.name === name),
        `${title}: missing ${name}`,
      );
      assert(
        htmlAttachments.some(
          (attachment) => attachment.name === name && attachment.path,
        ),
        `${title}: missing HTML ${name}`,
      );
    }
  }
  console.log(`PASS ${test.projectName}: ${probe.name}`);
}
console.log(
  `Verified ${tests.length} intentional failures; reports retained in ${runRoot}`,
);

function marker(probe, stream) {
  return `browser-diagnostics:${probe.name}:${stream}`;
}

function failureMessage(probe) {
  return `Intentional browser diagnostics ${probe.failure === "startup" ? "startup" : "assertion"} failure: ${probe.name}`;
}

async function writeProbe(probe) {
  const preload = path.join(fixtureRoot, `${probe.name}.mjs`);
  await fs.writeFile(
    preload,
    `import { writeSync } from "node:fs";
writeSync(1, ${JSON.stringify(`${marker(probe, "stdout")}\n`)});
writeSync(2, ${JSON.stringify(`${marker(probe, "stderr")}\n`)});
${probe.failure === "startup" ? `throw new Error(${JSON.stringify(failureMessage(probe))});` : ""}
`,
  );
  let source = await fs.readFile(
    path.join(repoRoot, "tests/browser", `${probe.fixture}.spec.ts`),
    "utf8",
  );
  const rootDeclaration =
    'const repoRoot = path.resolve(import.meta.dirname, "../..");';
  assert(
    source.includes(rootDeclaration),
    `${probe.fixture}: repoRoot declaration changed`,
  );
  source = source.replace(
    rootDeclaration,
    `const repoRoot = ${JSON.stringify(repoRoot)};`,
  );
  const spawnArguments = /spawn\(\s*process\.execPath,\s*\[/g;
  assert.equal(
    [...source.matchAll(spawnArguments)].length,
    1,
    `${probe.fixture}: expected one server spawn`,
  );
  source = source.replace(
    spawnArguments,
    (prefix) =>
      `${prefix}"--import", ${JSON.stringify(pathToFileURL(preload).href)}, `,
  );
  const insertion = source.search(
    probe.fixture === "cloudx-smoke" ? /^  test\(/m : /^test\(|^for \(/m,
  );
  assert(insertion >= 0, `${probe.fixture}: could not locate first test`);
  const probeTest = `
test(${JSON.stringify(`browser diagnostics ${probe.name}`)}, async ({ page, isMobile }) => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-shell")).toBeVisible();
  ${probe.fixture === "settings" ? "await openSettings(page, isMobile);" : ""}
  await expect.poll(() => serverLogs.includes(${JSON.stringify(marker(probe, "stdout"))}) && serverLogs.includes(${JSON.stringify(marker(probe, "stderr"))})).toBe(true);
  ${
    probe.failure === "signal"
      ? `
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  expect(server.kill("SIGKILL")).toBe(true);
  await exited;
  expect(server.exitCode).toBeNull();
  expect(server.signalCode).toBe("SIGKILL");
  `
      : ""
  }
  expect("observed", ${JSON.stringify(failureMessage(probe))}).toBe("expected");
});

`;
  source = source.slice(0, insertion) + probeTest + source.slice(insertion);
  await fs.writeFile(path.join(fixtureRoot, `${probe.name}.spec.ts`), source);
}

async function runPlaywright() {
  const cli = fileURLToPath(
    new URL("cli.js", import.meta.resolve("playwright/package.json")),
  );
  const child = spawn(
    process.execPath,
    [
      cli,
      "test",
      "--config",
      path.join(runRoot, "playwright.config.ts"),
      "--grep",
      "browser diagnostics",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (signal) reject(new Error(`Playwright terminated with ${signal}`));
      else resolve(exitCode);
    });
  });
  await fs.writeFile(path.join(runRoot, "playwright.log"), output);
  return code;
}

function collectTests(suites) {
  return suites.flatMap((suite) => [
    ...suite.specs.flatMap((spec) =>
      spec.tests.map((test) => ({ title: spec.title, test })),
    ),
    ...collectTests(suite.suites ?? []),
  ]);
}

async function readHtmlTests() {
  // This follows the installed Playwright reporter's embedded ZIP format and reader.
  const html = await fs.readFile(
    path.join(runRoot, "report", "index.html"),
    "utf8",
  );
  const encodedReport = html.match(
    /<template id="playwrightReportBase64">data:application\/zip;base64,([^<]+)<\/template>/,
  );
  assert(encodedReport, "HTML report must contain its report data");
  const zipPath = path.join(runRoot, "report-data.zip");
  await fs.writeFile(zipPath, Buffer.from(encodedReport[1], "base64"));
  const zip = new utils.ZipFile(zipPath);
  try {
    const summary = JSON.parse((await zip.read("report.json")).toString());
    assert.deepEqual(summary.errors, []);
    const files = await Promise.all(
      summary.files.map(async ({ fileId }) =>
        JSON.parse((await zip.read(`${fileId}.json`)).toString()),
      ),
    );
    return files.flatMap((file) => file.tests);
  } finally {
    zip.close();
  }
}

function htmlAttachmentPath(attachment) {
  assert(
    attachment.path.startsWith("data/"),
    `Attachment is not portable: ${attachment.path}`,
  );
  return path.join(runRoot, "report", attachment.path);
}
