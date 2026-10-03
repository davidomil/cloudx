import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  requireCompletedUpgrade,
  requireInstallerSuccess,
  requireReadyInstallation,
} from "./lifecycle-evidence.mjs";

const units = {
  web: "cloudx.service",
  terminal: "cloudx-terminal.service",
  asr: "cloudx-asr.service",
  documentation: "cloudx-documentation.service",
};
const baseURL = "https://127.0.0.1:9140";
const command = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export function runInstaller({ repoRoot, answersPath, logFile }) {
  const log = fs.openSync(logFile, "w", 0o600);
  try {
    const result = spawnSync(
      "./install.sh",
      ["--answers", answersPath, "--yes"],
      {
        cwd: repoRoot,
        stdio: ["ignore", log, log],
        timeout: 60 * 60_000,
        killSignal: "SIGKILL",
      },
    );
    requireInstallerSuccess(result);
  } finally {
    fs.closeSync(log);
  }
}

function serviceState(unit) {
  return Object.fromEntries(
    command("systemctl", [
      "--user",
      "show",
      unit,
      "--property=MainPID,InvocationID,ActiveState,ControlGroup",
    ])
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}

function request(url, binary = false) {
  return command(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--insecure",
      "--max-time",
      "60",
      url,
    ],
    { timeout: 65_000, ...(binary ? { encoding: null } : {}) },
  );
}

async function waitForWeb() {
  const deadline = Date.now() + 5 * 60_000;
  let last;
  while (Date.now() < deadline) {
    try {
      assert.equal(JSON.parse(request(`${baseURL}/api/ready`)).status, "ready");
      return;
    } catch (error) {
      last = error;
      await delay(1000);
    }
  }
  throw new Error("Web readiness deadline exceeded", { cause: last });
}

function frontendEvidence(repoRoot) {
  const directory = path.join(repoRoot, "apps/web/dist");
  const html = request(baseURL, true);
  const assets = [
    ...html.toString().matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g),
  ].map((match) => match[1]);
  assert.ok(
    assets.some((asset) => asset.endsWith(".js")),
    "The application did not serve its built frontend",
  );
  return ["/index.html", ...new Set(assets)].map((relative) => ({
    path: relative,
    diskSha256: digest(fs.readFileSync(path.join(directory, relative))),
    servedSha256: digest(
      relative === "/index.html"
        ? html
        : request(`${baseURL}${relative}`, true),
    ),
  }));
}

function installationEvidence(repoRoot) {
  const dataDir = path.join(repoRoot, ".cloudx");
  const readiness = Object.fromEntries(
    Object.entries({
      web: `${baseURL}/api/ready`,
      asr: "http://127.0.0.1:7810/ready",
      documentation: "http://127.0.0.1:7820/ready",
      terminals: `${baseURL}/api/ready/terminals`,
    }).map(([name, url]) => [name, JSON.parse(request(url))]),
  );
  const runtime = JSON.parse(request(`${baseURL}/api/runtime`));
  const services = Object.fromEntries(
    Object.entries(units).map(([name, unit]) => [name, serviceState(unit)]),
  );
  const processStarted = fs
    .readFileSync(`/proc/${runtime.pid}/stat`, "utf8")
    .split(") ")
    .at(-1)
    .split(" ")[19];
  const cgroups = fs
    .readFileSync(`/proc/${runtime.pid}/cgroup`, "utf8")
    .split("\n")
    .map((line) => line.split(":")[2]);
  const group = services.web.ControlGroup;
  const observed = {
    readiness,
    runtime,
    services,
    checkout: command("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).trim(),
    manifest: readJson(
      path.join(repoRoot, "apps/server/dist/runtime-build.json"),
    ),
    processMatches:
      runtime.processStarted === processStarted &&
      runtime.bootId ===
        fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() &&
      !!group &&
      cgroups.some(
        (entry) => entry === group || entry?.startsWith(`${group}/`),
      ),
    terminalProbeCleaned: !fs
      .readdirSync(dataDir)
      .some((name) => name.startsWith("terminal-readiness-")),
    frontend: frontendEvidence(repoRoot),
  };
  return observed;
}

async function install({
  scenario,
  sourceSha,
  targetSha,
  repoRoot,
  evidenceDir,
}) {
  const home = os.homedir();
  for (const file of [
    ".cloudx",
    "node_modules",
    "apps/server/dist",
    "apps/web/dist",
    "services/asr/.venv",
    "services/documentation-indexer/.venv",
  ]) {
    assert.equal(
      fs.existsSync(path.join(repoRoot, file)),
      false,
      `Clean installation already contains ${file}`,
    );
  }
  for (const file of [
    ".config/cloudx/cloudx.env",
    ...Object.values(units).map((unit) => `.config/systemd/user/${unit}`),
    ".local/state/cloudx/settings-update",
  ]) {
    assert.equal(
      fs.existsSync(path.join(home, file)),
      false,
      `Fresh user already contains ${file}`,
    );
  }
  const answersPath = path.join(home, "installer-answers.json");
  // The installer requires a saved native login even with an unauthenticated local provider.
  // This fixed invalid token is test data, never a controller or user credential.
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      OPENAI_API_KEY: "sk-cloudx-lifecycle-synthetic-not-a-credential",
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    'model_provider = "cloudx-native"\n[model_providers.cloudx-native]\nname = "Lifecycle fixture"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n',
    { mode: 0o600 },
  );
  writeJson(answersPath, {
    allowedRoots: home,
    port: 9140,
    cpuThreads: 2,
    useGpu: false,
    installWhisperCpp: false,
    installServices: true,
    startServices: true,
    enableLinger: true,
    runCodexLogin: false,
  });
  runInstaller({
    repoRoot,
    answersPath,
    logFile: path.join(evidenceDir, "installer.log"),
  });
  for (const relative of [
    "node_modules",
    "packages/shared/dist",
    "packages/plugin-api/dist",
    "apps/server/dist/index.js",
    "apps/web/dist/index.html",
  ]) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, relative)),
      `Installer did not generate ${relative}`,
    );
  }
  for (const relative of [
    "services/asr/.venv/bin/uvicorn",
    "services/documentation-indexer/.venv/bin/cloudx-documentation-indexer",
  ]) {
    fs.accessSync(path.join(repoRoot, relative), fs.constants.X_OK);
  }
  command("systemctl", ["--user", "is-enabled", ...Object.values(units)]);
  const env = fs.readFileSync(
    path.join(home, ".config/cloudx/cloudx.env"),
    "utf8",
  );
  assert.match(env, /^CLOUDX_ASR_DEVICE=cpu$/m);
  assert.match(env, /^CLOUDX_ASR_COMPUTE_TYPE=int8$/m);
  const codex = /^CLOUDX_ASSISTANT_BIN=(.+)$/m.exec(env)?.[1];
  assert.ok(
    codex?.startsWith(`${home}/`),
    "Installer must select the fresh user's Codex binary",
  );
  const { CODEX_CLI_VERSION } = await import(
    pathToFileURL(path.join(repoRoot, "scripts/install-cloudx.mjs"))
  );
  const codexVersion = command(codex, ["--version"]).trim();
  assert.equal(
    codexVersion,
    `codex-cli ${CODEX_CLI_VERSION}`,
    "Installed native Codex version differs from installer selection",
  );
  writeJson(path.join(evidenceDir, "codex.json"), {
    executable: codex,
    version: codexVersion,
  });
  await waitForWeb();
  const observed = installationEvidence(repoRoot);
  writeJson(path.join(evidenceDir, "installed.json"), observed);
  requireReadyInstallation(
    observed,
    scenario === "upgrade" ? sourceSha : targetSha,
  );
}

async function exercise({
  scenario,
  sourceSha,
  targetSha,
  repoRoot,
  evidenceDir,
}) {
  const home = os.homedir(),
    dataDir = path.join(repoRoot, ".cloudx");
  await waitForWeb();
  const before = installationEvidence(repoRoot);
  requireReadyInstallation(
    before,
    scenario === "upgrade" ? sourceSha : targetSha,
  );
  const { LifecycleBrowserProfile } = await import("./lifecycle-browser.mjs");
  const profile = await LifecycleBrowserProfile.create({
    baseURL,
    repoRoot,
    home,
    dataDir,
    evidenceDir,
  });
  let observer;
  try {
    if (scenario === "install") {
      // A browser must load the actual served application, not merely an index file.
      await profile.page.goto(baseURL, { waitUntil: "domcontentloaded" });
      await profile.page
        .locator(".workspace-pane")
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
      writeJson(path.join(evidenceDir, "result.json"), {
        scenario,
        sourceSha,
        targetSha,
        result: "passed",
        installation: before,
      });
      return;
    }
    await profile.seed();
    const localFile = path.join(repoRoot, "lifecycle-untracked.txt");
    const localWork = path.join(home, "unrelated-project");
    fs.mkdirSync(localWork);
    command("git", ["init"], { cwd: localWork });
    fs.writeFileSync(path.join(localWork, "notes.txt"), "committed work\n");
    command("git", ["add", "notes.txt"], { cwd: localWork });
    command(
      "git",
      [
        "-c",
        "user.name=Lifecycle test",
        "-c",
        "user.email=lifecycle@example.invalid",
        "commit",
        "-m",
        "TEST: isolated local work",
      ],
      { cwd: localWork },
    );
    fs.appendFileSync(
      path.join(localWork, "notes.txt"),
      "uncommitted local work\n",
    );
    fs.writeFileSync(
      localFile,
      "Untracked work survives the production updater.\n",
    );
    const workStatus = command("git", ["status", "--porcelain=v1", "-z"], {
      cwd: localWork,
    });
    const statusBefore = command(
      "git",
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ],
      { cwd: repoRoot },
    );
    let coordinatorSurvivedStop = false;
    const observations = [];
    const observationErrors = [];
    observer = setInterval(() => {
      try {
        const web = serviceState(units.web),
          coordinator = serviceState("cloudx-settings-update.service");
        if (
          web.InvocationID !== before.services.web.InvocationID &&
          coordinator.ActiveState === "active" &&
          Number(coordinator.MainPID) > 0
        ) {
          const groups = fs.readFileSync(
            `/proc/${coordinator.MainPID}/cgroup`,
            "utf8",
          );
          const oldProcessGone = !fs.existsSync(`/proc/${before.runtime.pid}`);
          if (
            oldProcessGone &&
            coordinator.ControlGroup &&
            !groups.includes(`${before.services.web.ControlGroup}/`) &&
            coordinator.ControlGroup !== before.services.web.ControlGroup
          ) {
            coordinatorSurvivedStop = true;
            if (!observations.length)
              observations.push({
                at: new Date().toISOString(),
                web,
                coordinator,
                oldProcessGone,
              });
          }
        }
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code))
          observationErrors.push(error.message);
      }
    }, 250);
    await profile.update({ targetSha });
    clearInterval(observer);
    observer = undefined;
    assert.deepEqual(
      observationErrors,
      [],
      "Could not observe service handoff",
    );
    const stateDir = path.join(home, ".local/state/cloudx/settings-update");
    const { id } = readJson(path.join(stateDir, "latest.json"));
    const record = readJson(path.join(stateDir, `${id}.json`));
    assert.equal(
      record.run.id,
      profile.updateRunId,
      "The durable record differs from the launched update",
    );
    const after = installationEvidence(repoRoot);
    writeJson(path.join(evidenceDir, "updated.json"), after);
    writeJson(path.join(evidenceDir, "coordinator.json"), {
      coordinatorSurvivedStop,
      observations,
      run: record.run,
      completed: record.transition.completed,
    });
    writeJson(
      path.join(evidenceDir, "runtime-receipt.json"),
      readJson(path.join(stateDir, id, "runtime.json")),
    );
    requireCompletedUpgrade({
      before,
      after,
      record,
      coordinatorSurvivedStop,
      sourceSha,
      targetSha,
    });
    assert.equal(
      fs.readFileSync(localFile, "utf8"),
      "Untracked work survives the production updater.\n",
    );
    assert.equal(
      fs.readFileSync(path.join(localWork, "notes.txt"), "utf8"),
      "committed work\nuncommitted local work\n",
    );
    assert.equal(
      command(
        "git",
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--no-renames",
        ],
        { cwd: repoRoot },
      ),
      statusBefore,
      "Updater leaked generated files into user changes",
    );
    assert.equal(
      command("git", ["status", "--porcelain=v1", "-z"], { cwd: localWork }),
      workStatus,
      "Unrelated local Git work changed",
    );
    const coordinatorScript = path.join(
      record.coordinator,
      "scripts/settings-update.mjs",
    );
    assert.ok(
      fs.existsSync(coordinatorScript),
      "The retained coordinator is missing",
    );
    const status = JSON.parse(
      command(
        process.execPath,
        [coordinatorScript, "status", dataDir, String(after.runtime.pid)],
        {
          cwd: repoRoot,
          env: { ...process.env, CLOUDX_INSTALL_ROOT: repoRoot },
        },
      ),
    );
    assert.equal(
      status.available,
      true,
      "The retained coordinator cannot perform next-update preflight",
    );
    assert.equal(status.run.state, "succeeded");
    await profile.verify({
      targetSha,
      requiresInterruption: record.transition.runtimePlan.requiresInterruption,
    });
    writeJson(path.join(evidenceDir, "result.json"), {
      scenario,
      sourceSha,
      targetSha,
      result: "passed",
      coordinatorSurvivedStop,
      sourceInvocation: before.runtime.invocationId,
      targetInvocation: after.runtime.invocationId,
      runningCommit: after.runtime.build.commit,
      codex: readJson(path.join(evidenceDir, "codex.json")),
      preservedProfile: true,
      nextUpdatePreflight: true,
    });
  } finally {
    clearInterval(observer);
    await profile.close();
  }
}

function collect({ repoRoot, evidenceDir }) {
  const responses = {};
  for (const [name, url] of Object.entries({
    web: `${baseURL}/api/ready`,
    runtime: `${baseURL}/api/runtime`,
    asr: "http://127.0.0.1:7810/ready",
    documentation: "http://127.0.0.1:7820/ready",
  })) {
    try {
      responses[name] = command("curl", [
        "--silent",
        "--show-error",
        "--insecure",
        "--max-time",
        "3",
        "--write-out",
        "\\nHTTP %{http_code}",
        url,
      ]);
    } catch (error) {
      responses[name] = { error: error.message };
    }
  }
  writeJson(path.join(evidenceDir, "final-responses.json"), responses);
  for (const relative of [
    "apps/server/dist/runtime-build.json",
    ".cloudx/terminal-runtime/web.json",
    ".cloudx/terminal-runtime/broker.json",
  ]) {
    const file = path.join(repoRoot, relative);
    if (fs.existsSync(file))
      fs.copyFileSync(
        file,
        path.join(evidenceDir, `final-${relative.replaceAll("/", "-")}`),
      );
  }
  const stateDir = path.join(
    os.homedir(),
    ".local/state/cloudx/settings-update",
  );
  const latest = path.join(stateDir, "latest.json");
  if (fs.existsSync(latest)) {
    const { id } = readJson(latest);
    assert.match(id, /^[a-f0-9-]{36}$/);
    const record = readJson(path.join(stateDir, `${id}.json`));
    writeJson(path.join(evidenceDir, "final-update.json"), {
      run: record.run,
      sourceCommit: record.transition?.sourceCommit,
      targetCommit: record.targetCommit,
      completed: record.transition?.completed,
      verifiedRuntime: record.transition?.verifiedRuntime,
    });
    const runtime = path.join(stateDir, id, "runtime.json");
    if (fs.existsSync(runtime))
      fs.copyFileSync(
        runtime,
        path.join(evidenceDir, "final-runtime-receipt.json"),
      );
  }
}

async function main() {
  const [action, scenario, sourceSha, targetSha, repoRoot, evidenceDir] =
    process.argv.slice(2);
  assert.ok(["install", "exercise", "collect"].includes(action));
  assert.ok(["install", "upgrade"].includes(scenario));
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.match(targetSha, /^[a-f0-9]{40}$/);
  const options = { scenario, sourceSha, targetSha, repoRoot, evidenceDir };
  try {
    await { install, exercise, collect }[action](options);
  } catch (error) {
    writeJson(path.join(evidenceDir, "result.json"), {
      scenario,
      sourceSha,
      targetSha,
      result: "failed",
      action,
      error: error.stack,
    });
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
