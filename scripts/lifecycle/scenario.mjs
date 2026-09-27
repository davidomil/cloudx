import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { parseEnvironmentFile } from "../installer-environment.mjs";
import {
  assertCompletedUpdate,
  assertOnlyLocalWork,
  assertReadiness,
  assertRuntime,
  sha256,
} from "./assertions.mjs";
import { seedProfile, verifyProfile } from "./profile.mjs";

const updateTimeout = 45 * 60_000;

export async function runScenario(host) {
  const {
    scenario,
    source,
    target,
    evidence,
    baseUrl,
    repoRoot,
    home,
    dataDir,
    provider,
  } = host;
  assert.equal(
    new URL(baseUrl).protocol,
    "https:",
    "Standard installation must serve HTTPS",
  );
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 960 },
  });
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: false,
  });
  const page = await context.newPage();
  const request = context.request;
  const connections = { opened: 0, closed: 0 };
  page.on("websocket", (socket) => {
    connections.opened++;
    socket.on("close", () => connections.closed++);
  });
  let failed = true;
  try {
    const installedCommit = scenario === "upgrade" ? source : target;
    const installed = await inspectInstallation(
      host,
      request,
      installedCommit,
      "installed",
    );
    await page.goto(baseUrl);
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator(".workspace-pane").first()).toBeVisible();
    await verifyServedFrontend(host, request, page, "installed");
    if (scenario === "install") {
      assertOnlyLocalWork(await gitStatus(host), []);
      failed = false;
      return {
        installedCommit,
        runtime: installed.runtime,
        readiness: installed.readiness,
      };
    }

    const snapshot = await seedProfile({
      page,
      request,
      repoRoot,
      home,
      origin: baseUrl,
      dataDir,
      provider,
      source,
      target,
      runAsUser: host.runAsUser,
      uid: host.uid,
    });
    const brokerBefore = await host.captureServiceState(
      "cloudx-terminal.service",
    );
    const beforeStatus = await json(request, `${baseUrl}/api/system/update`);
    assert.equal(
      beforeStatus.available,
      true,
      "Source installation must support Settings updates",
    );
    const settings = await openUpdates(page);
    await expect(
      settings.getByText(target.slice(0, 12), { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const navigations = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    const connectionsBeforeUpdate = { ...connections };
    const accepted = page.waitForResponse(
      (response) =>
        response.url() === `${baseUrl}/api/system/update` &&
        response.request().method() === "POST",
    );
    await settings
      .getByRole("button", {
        name: "Update CloudX and dependencies",
        exact: true,
      })
      .click();
    const launch = await accepted;
    assert.ok(launch.ok(), `Settings launch returned HTTP ${launch.status()}`);
    let launched = await launch.json();
    let interruptionConfirmed = false;
    if (launched.confirmation) {
      assert.equal(launched.confirmation.targetCommit, target);
      assert.ok(
        !launched.confirmation.restoreSnapshotRunId,
        "Forward update unexpectedly requested data restoration",
      );
      const consent = settings.getByRole("group", {
        name: "Confirm update interruption",
      });
      await expect(consent).toBeVisible();
      await consent.getByRole("checkbox").check();
      const confirmation = page.waitForResponse(
        (response) =>
          response.url() === `${baseUrl}/api/system/update` &&
          response.request().method() === "POST",
      );
      await consent
        .getByRole("button", {
          name: "Confirm interruption and continue",
          exact: true,
        })
        .click();
      const response = await confirmation;
      assert.ok(response.ok());
      launched = await response.json();
      interruptionConfirmed = true;
    }
    assert.equal(
      launched.run?.state,
      "running",
      "Settings did not launch the source coordinator",
    );
    assert.notEqual(launched.run.id, beforeStatus.run?.id);
    const recordPath = path.join(
      home,
      ".local/state/cloudx/settings-update",
      `${launched.run.id}.json`,
    );
    const handoff = await observeUpdate(
      host,
      recordPath,
      installed.runtime,
      installed.service,
    );
    const updated = await inspectInstallation(
      host,
      request,
      target,
      "updated",
      installed.runtime,
    );
    assertCompletedUpdate({
      record: handoff.record,
      source,
      target,
      runtime: updated.runtime,
      observedHandoff: handoff.observedHandoff,
    });
    await expect
      .poll(() => navigations.length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    assert.ok(
      connections.closed > connectionsBeforeUpdate.closed,
      "Browser never disconnected from the source service",
    );
    await expect
      .poll(() => connections.opened, { timeout: 30_000 })
      .toBeGreaterThan(connectionsBeforeUpdate.opened);
    await expect(page.locator(".app-shell")).toBeVisible();
    await verifyServedFrontend(
      host,
      request,
      page,
      "updated",
      handoff.record.transition.release,
    );
    const preservation = await verifyProfile({
      page,
      request,
      origin: baseUrl,
      snapshot,
      provider,
      interruptionConfirmed,
    });
    const brokerAfter = await host.captureServiceState(
      "cloudx-terminal.service",
    );
    if (!interruptionConfirmed)
      assert.equal(
        brokerAfter.InvocationID,
        brokerBefore.InvocationID,
        "A compatible terminal broker was unnecessarily restarted",
      );
    assertOnlyLocalWork(await gitStatus(host), snapshot.allowedStatusPaths);

    const nextSettings = await openUpdates(page);
    await nextSettings
      .getByRole("button", { name: "Check update status", exact: true })
      .click();
    const next = await json(request, `${baseUrl}/api/system/update`);
    assert.equal(
      next.available,
      true,
      "Retained coordinator cannot perform the next update preflight",
    );
    assert.equal(next.run?.state, "succeeded");
    const preview = await json(request, `${baseUrl}/api/system/update/preview`);
    assert.equal(preview.currentCommit, target);
    assert.equal(preview.target?.commit, target);
    assert.equal(preview.state, "current");
    const env = parseEnvironmentFile(
      await fs.readFile(path.join(home, ".config/cloudx/cloudx.env"), "utf8"),
    );
    assert.equal(
      env.CLOUDX_UPDATE_COORDINATOR_ROOT,
      handoff.record.coordinator,
    );
    await fs.access(
      path.join(handoff.record.coordinator, "scripts/settings-update.mjs"),
    );
    const result = {
      source,
      target,
      runId: launched.run.id,
      phase: handoff.record.run.phase,
      completed: handoff.record.transition.completed,
      observedHandoff: handoff.observedHandoff,
      runtime: updated.runtime,
      readiness: updated.readiness,
      interruptionConfirmed,
      brokerPreserved: brokerBefore.InvocationID === brokerAfter.InvocationID,
      nextUpdateAvailable: next.available,
      browserReloads: navigations.length,
      connections,
      preservation,
    };
    await save(evidence, "update-result.json", result);
    failed = false;
    return result;
  } finally {
    if (failed) {
      await page
        .screenshot({
          path: path.join(evidence, "browser-failure.png"),
          fullPage: true,
        })
        .catch(() => {});
      await context.tracing
        .stop({ path: path.join(evidence, "browser-trace.zip") })
        .catch(() => {});
    } else await context.tracing.stop();
    await browser.close();
  }
}

async function inspectInstallation(host, request, commit, label, previous) {
  const { home, repoRoot, dataDir, baseUrl, evidence } = host;
  const env = parseEnvironmentFile(
    await fs.readFile(path.join(home, ".config/cloudx/cloudx.env"), "utf8"),
  );
  assert.equal(env.CLOUDX_ASR_DEVICE, "cpu");
  assert.equal(env.CLOUDX_ASR_COMPUTE_TYPE, "int8");
  for (const relative of [
    "node_modules",
    "packages/shared/dist",
    "packages/plugin-api/dist",
    "apps/web/dist",
    "apps/server/dist",
  ])
    assert.ok(
      (await fs.stat(path.join(repoRoot, relative))).isDirectory(),
      `Missing installed ${relative}`,
    );
  for (const relative of [
    "services/asr/.venv/bin/python",
    "services/asr/.venv/bin/uvicorn",
    "services/documentation-indexer/.venv/bin/cloudx-documentation-indexer",
  ])
    await fs.access(path.join(repoRoot, relative), fs.constants.X_OK);
  for (const unit of [
    "cloudx.service",
    "cloudx-terminal.service",
    "cloudx-asr.service",
    "cloudx-documentation.service",
  ]) {
    await fs.access(path.join(home, ".config/systemd/user", unit));
    assert.equal(
      (await host.captureServiceState(unit)).ActiveState,
      "active",
      `${unit} is inactive`,
    );
    await host.runAsUser("systemctl", ["--user", "is-enabled", unit]);
  }
  const codexVersion = (
    await host.runAsUser(env.CLOUDX_ASSISTANT_BIN, ["--version"])
  ).trim();
  assert.match(codexVersion, /^codex-cli \S+$/);
  const readiness = {
    asr: await json(request, `${env.CLOUDX_ASR_URL}/ready`),
    documentation: await json(request, `${env.CLOUDX_DOCUMENTATION_URL}/ready`),
    web: await json(request, `${baseUrl}/api/ready`),
    terminals: await json(request, `${baseUrl}/api/ready/terminals`, 60_000),
  };
  await save(evidence, `${label}-readiness.json`, readiness);
  assertReadiness(readiness);
  assert.deepEqual(
    (await fs.readdir(dataDir)).filter((name) =>
      name.startsWith("terminal-readiness-"),
    ),
    [],
    "Readiness terminals leaked execution directories",
  );
  const runtime = await json(request, `${baseUrl}/api/runtime`);
  const receipt = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, "apps/server/dist/runtime-build.json"),
      "utf8",
    ),
  );
  const service = await host.captureServiceState("cloudx.service");
  await save(evidence, `${label}-runtime.json`, {
    runtime,
    receipt,
    service,
    codexVersion,
  });
  assertRuntime({ runtime, receipt, service, commit, previous });
  if (previous)
    assert.equal(
      Number(service.MainPID),
      runtime.pid,
      "The target runtime is not the managed service's main process",
    );
  assert.equal(
    receipt.lockSha256,
    sha256(await fs.readFile(path.join(repoRoot, "package-lock.json"))),
  );
  const groups = (await fs.readFile(`/proc/${runtime.pid}/cgroup`, "utf8"))
    .split("\n")
    .map((line) => line.split(":")[2]);
  assert.ok(
    service.ControlGroup &&
      groups.some(
        (group) =>
          group === service.ControlGroup ||
          group?.startsWith(`${service.ControlGroup}/`),
      ),
    "Runtime belongs to another service group",
  );
  const stat = await fs.readFile(`/proc/${runtime.pid}/stat`, "utf8");
  assert.equal(
    runtime.processStarted,
    stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
  );
  assert.equal(
    runtime.bootId,
    (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
  );
  assert.equal(
    (
      await host.runAsUser("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
    ).trim(),
    commit,
  );
  return { runtime, readiness, service };
}

export async function verifyServedFrontend(
  host,
  request,
  page,
  label,
  preparedRelease = host.repoRoot,
) {
  const root = path.join(preparedRelease, "apps/web/dist");
  const expectedIndex = await fs.readFile(path.join(root, "index.html"));
  assert.equal(
    sha256(
      await fs.readFile(path.join(host.repoRoot, "apps/web/dist/index.html")),
    ),
    sha256(expectedIndex),
    "Installed frontend differs from the prepared target",
  );
  const response = await request.get(host.baseUrl);
  assert.equal(response.status(), 200);
  assert.equal(
    sha256(await response.body()),
    sha256(expectedIndex),
    "Served frontend index differs from installed build",
  );
  const assets = [
    ...expectedIndex.toString().matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g),
  ].map((match) => match[1]);
  assert.ok(
    assets.some((asset) => asset.endsWith(".js")),
    "Frontend contains no built application script",
  );
  const digests = {};
  for (const asset of assets) {
    const expected = await fs.readFile(path.join(root, asset));
    assert.equal(
      sha256(
        await fs.readFile(path.join(host.repoRoot, "apps/web/dist", asset)),
      ),
      sha256(expected),
      `Installed frontend asset differs from the prepared target: ${asset}`,
    );
    const served = await request.get(`${host.baseUrl}${asset}`);
    assert.equal(served.status(), 200);
    assert.equal(
      sha256(await served.body()),
      sha256(expected),
      `Wrong frontend asset served: ${asset}`,
    );
    digests[asset] = sha256(expected);
  }
  const loaded = await page.evaluate(() =>
    [...document.querySelectorAll('script[type="module"][src]')].map(
      (script) => new URL(script.src).pathname,
    ),
  );
  assert.ok(
    loaded.some((asset) => assets.includes(asset)),
    "Browser did not load the installed frontend script",
  );
  await save(host.evidence, `${label}-frontend.json`, {
    indexSha256: sha256(expectedIndex),
    assets: digests,
  });
}

async function observeUpdate(host, recordPath, previous, sourceService) {
  const started = Date.now();
  const observations = [];
  let observedHandoff = false;
  let coordinatorInvocation;
  while (Date.now() - started < updateTimeout) {
    host.signal?.throwIfAborted();
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    const [web, coordinator] = await Promise.all([
      host.captureServiceState("cloudx.service"),
      host.captureServiceState("cloudx-settings-update.service"),
    ]);
    const oldProcessStillAlive = await fs
      .readFile(`/proc/${previous.pid}/stat`, "utf8")
      .then(
        (stat) =>
          stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ===
          previous.processStarted,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    if (coordinator.ActiveState === "active") {
      coordinatorInvocation ??= coordinator.InvocationID;
      assert.equal(
        coordinator.InvocationID,
        coordinatorInvocation,
        "Update coordinator restarted during the web handoff",
      );
    }
    if (!oldProcessStillAlive && coordinator.ActiveState === "active") {
      assert.ok(
        coordinator.ControlGroup &&
          coordinator.ControlGroup !== sourceService.ControlGroup,
      );
      assert.ok(
        !coordinator.ControlGroup.startsWith(`${sourceService.ControlGroup}/`),
      );
      observedHandoff = true;
    }
    const observation = {
      phase: record.run.phase,
      state: record.run.state,
      webInvocation: web.InvocationID,
      coordinatorInvocation: coordinator.InvocationID,
      observedHandoff,
    };
    if (JSON.stringify(observations.at(-1)) !== JSON.stringify(observation)) {
      observations.push(observation);
      await save(host.evidence, "handoff.json", observations);
    }
    if (record.run.state === "failed")
      throw new Error(
        `Update failed in ${record.run.phase}: ${record.run.cause ?? record.run.message}`,
      );
    if (record.run.state === "succeeded") return { record, observedHandoff };
    await delay(250);
  }
  throw new Error(
    "The Settings update did not durably complete within 45 minutes",
  );
}

async function openUpdates(page) {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  if (!(await dialog.isVisible()))
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("searchbox", { name: "Search settings" })
    .fill("Updates");
  return dialog.locator('[aria-label="CloudX updates"]');
}

async function json(request, url, timeout = 30_000) {
  const response = await request.get(url, { timeout });
  assert.equal(
    response.status(),
    200,
    `${new URL(url).pathname} returned HTTP ${response.status()}`,
  );
  return response.json();
}

async function gitStatus(host) {
  return host.runAsUser(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    { cwd: host.repoRoot },
  );
}

async function save(directory, name, value) {
  await fs.writeFile(
    path.join(directory, name),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
}
