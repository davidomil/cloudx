import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import ts from "typescript";
import { MANAGED_INTEGRATION_FILES, MANAGED_INTEGRATION_SOURCE_FILES, prepareManagedIntegration } from "./managed-update-integration.mjs";
import { SettingsUpdater } from "./settings-update.mjs";
import { verifySnapshot } from "./managed-update-store.mjs";
import { UpdateHost } from "./managed-update.mjs";
import { verifyHistoricalTerminals } from "./managed-update-readiness.mjs";
import { MISSING_SETTINGS_FILES } from "./managed-update-settings-integration.mjs";
import { CODEX_SOURCES, CODEX_IDENTITY_FILES, SESSION_INTEGRATION_FILES, SESSION_PERSISTENCE_FILES } from "./managed-update-session-integration.mjs";
import { inspectDataCompatibility } from "./managed-update-data.mjs";

const coordinator = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("retains managed Settings and independent terminal readiness in a historical build without changing its Git revision", () => {
  const release = fixture();
  const head = git(release, ["rev-parse", "HEAD"]);
  const integration = prepareManagedIntegration(release, coordinator);
  expect(integration).toEqual({ version: 1, files: MANAGED_INTEGRATION_FILES.filter(file =>
    ![...MISSING_SETTINGS_FILES, ...SESSION_INTEGRATION_FILES, ...SESSION_PERSISTENCE_FILES].includes(file)), independentReadiness: true });
  for (const relative of integration.files) expect(fs.readFileSync(path.join(release, relative))).toEqual(fs.readFileSync(path.join(coordinator, relative)));
  expect(git(release, ["rev-parse", "HEAD"])).toBe(head);
});

it.each(["legacy", "current", "unknown"])("integrates a broker-era target with a %s Codex source reader", kind => {
  const release = fixture("CLOUDX_UPDATE_COORDINATOR_ROOT", "/api/ready/terminals");
  const destination = path.join(release, CODEX_SOURCES);
  const source = kind === "current" ? fs.readFileSync(CODEX_SOURCES, "utf8") :
    git(coordinator, ["show", `a9613fafdc0ed1765fcf72ea7d9f61de08c3914a:${CODEX_SOURCES}`]);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, kind === "unknown" ? source.replace('"dev,home,ino,sourceId,version"', '"unknown"') : source);
  git(release, ["add", "."]);
  git(release, ["commit", "-m", "TEST: target Codex ownership reader"]);
  if (kind === "unknown") {
    expect(() => prepareManagedIntegration(release, coordinator)).toThrow("does not recognize the target source ownership contract");
    expect(git(release, ["status", "--porcelain"])).toBe("");
  } else {
    const integration = prepareManagedIntegration(release, coordinator);
    expect(integration.files).toEqual(kind === "legacy" ? [CODEX_SOURCES, ...CODEX_IDENTITY_FILES] : []);
    expect(integration.sessionRecovery).toBeUndefined();
    if (kind === "legacy") {
      expect(fs.readFileSync(destination, "utf8")).toContain("sameDirectoryIdentity(");
      for (const file of CODEX_IDENTITY_FILES) expect(fs.readFileSync(path.join(release, file))).toEqual(fs.readFileSync(file));
    } else {
      expect(fs.readFileSync(destination, "utf8")).toBe(source);
      expect(git(release, ["status", "--porcelain"])).toBe("");
    }
  }
});

it("selects the supervised readiness probe before execution bindings were supported", () => {
  const release = fixture(undefined, undefined, legacyTerminalContract());
  const head = git(release, ["rev-parse", "HEAD"]);
  const integration = prepareManagedIntegration(release, coordinator);
  expect(integration.independentReadiness).toBe(true);
  expect(fs.readFileSync(path.join(release, "apps/server/src/terminal/TerminalReadiness.ts")))
    .toEqual(fs.readFileSync(path.join(coordinator, "scripts/managed-update-readiness-legacy.ts")));
  expect(fs.readFileSync(path.join(release, "apps/server/src/terminal/TerminalProcess.ts"), "utf8"))
    .toBe(legacyTerminalContract());
  expect(git(release, ["rev-parse", "HEAD"])).toBe(head);
});

it("selects direct supervision for the actual pre-broker terminal contract", () => {
  const contract = git(coordinator, ["show", "224a75ef7b3efced05b2c6b3b136250d9a532dc3:apps/server/src/terminal/TerminalProcess.ts"]);
  const release = fixture(undefined, undefined, contract);
  expect(prepareManagedIntegration(release, coordinator)).toMatchObject({ independentReadiness: true, terminalMode: "direct" });
  expect(fs.readFileSync(path.join(release, "apps/server/src/terminal/TerminalReadiness.ts")))
    .toEqual(fs.readFileSync(path.join(coordinator, "scripts/managed-update-readiness-legacy.ts")));
});

it("rejects an inconsistent broker module beside the direct-only terminal contract", () => {
  const contract = git(coordinator, ["show", "224a75ef7b3efced05b2c6b3b136250d9a532dc3:apps/server/src/terminal/TerminalProcess.ts"]);
  const release = fixture(undefined, undefined, contract);
  fs.writeFileSync(path.join(release, "apps/server/src/terminal/DurableTerminalProcess.ts"), "unexpected broker contract");
  git(release, ["add", "."]);
  git(release, ["commit", "-m", "TEST: inconsistent broker contract"]);
  expect(() => prepareManagedIntegration(release, coordinator)).toThrow("does not recognize the target terminal spawn contract");
  expect(git(release, ["status", "--porcelain"])).toBe("");
});

it.each([...new Set([...MISSING_SETTINGS_FILES, ...SESSION_INTEGRATION_FILES, "apps/server/src/jsonStateFile.ts"])])("preserves local edits to the historical integration file %s", relative => {
  const release = preBrokerFixture();
  fs.appendFileSync(path.join(release, relative), "\n// operator edit\n");
  expect(() => prepareManagedIntegration(release, coordinator)).toThrow(`conflicts with local changes to ${relative}`);
  expect(fs.readFileSync(path.join(release, relative), "utf8")).toContain("operator edit");
  expect(fs.existsSync(path.join(release, "apps/server/src/system/CloudxUpdateService.ts"))).toBe(false);
  expect(git(release, ["status", "--porcelain"])).toBe(`M ${relative}`);
});

it.each(["standard-terminal", "local-web"])("plans the first pre-broker downgrade with a saved %s tab without a historical snapshot", pluginId => {
  const release = preBrokerFixture(), data = directory();
  const sessionFile = path.join(data, "sessions.json");
  const content = JSON.stringify({ version: 1, activeTabId: "saved-tab", sessions: [{ tab: { id: "saved-tab", pluginId,
    cwd: data, title: "Saved tab", status: "stopped", createdAt: "2026-09-22", updatedAt: "2026-09-22",
    indicator: { color: "yellow", label: "Stopped", updatedAt: "2026-09-22" } }, initialInput: { retained: true } }] });
  fs.writeFileSync(sessionFile, content);
  expect(inspectDataCompatibility(release, {}, data).compatible).toBe(false);
  expect(prepareManagedIntegration(release, coordinator)).toMatchObject({ terminalMode: "direct", sessionRecovery: "saved-tabs-v1" });
  const record = { transition: { release } };
  expect(() => UpdateHost.prototype.planData.call({ envConfig: {}, paths: { dataDir: data } }, record)).not.toThrow();
  expect(record.transition.dataCompatibility).toMatchObject({ compatible: true, sessionSchema: 1, targetSessionSchema: 1 });
  expect(record.transition.restoreData).toBeUndefined();
  expect(fs.readFileSync(sessionFile, "utf8")).toBe(content);
});

function preBrokerFixture() {
  const release = directory();
  git(release, ["init"]);
  git(release, ["config", "user.name", "CloudX Test"]);
  git(release, ["config", "user.email", "test@invalid"]);
  for (const file of new Set([...MISSING_SETTINGS_FILES, ...SESSION_INTEGRATION_FILES, "apps/server/src/jsonStateFile.ts", "apps/server/src/terminal/TerminalProcess.ts"])) {
    const destination = path.join(release, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, git(coordinator, ["show", `224a75ef7b3efced05b2c6b3b136250d9a532dc3:${file}`]));
  }
  git(release, ["add", "."]);
  git(release, ["commit", "-m", "TEST: Settings before updater support"]);
  return release;
}

it.each([
  ["unknown spawn options", "export interface TerminalSpawnOptions { options: unknown; }\nterminate(): Promise<void>;", "does not recognize the target terminal spawn contract"],
  ["unconfirmed shutdown", "export interface TerminalSpawnOptions { cwd: string; }", "requires the target's supervised terminal shutdown contract"],
])("rejects %s before copying any integration", (_name, contract, message) => {
  const release = fixture(undefined, undefined, contract);
  expect(() => prepareManagedIntegration(release, coordinator)).toThrow(message);
  expect(git(release, ["status", "--porcelain"])).toBe("");
});

it("upgrades the pre-channel server contract while preserving its unrelated source", () => {
  const release = fixture("historical Settings", 'const historicalBehavior = true;\nupdates?: Pick<CloudxUpdateService, "status" | "start">;');
  const integration = prepareManagedIntegration(release, coordinator);
  expect(integration.files).toContain("apps/server/src/server.ts");
  expect(integration.files).toContain("apps/server/src/system/CloudxUpdateCatalog.ts");
  expect(fs.readFileSync(path.join(release, "apps/server/src/server.ts"), "utf8"))
    .toBe('const historicalBehavior = true;\nupdates?: Pick<CloudxUpdateService, "status" | "start" | "preview" | "selectChannel">;');
});

it("checks the entire migration before overwriting files when the legacy server has local edits", () => {
  const release = fixture("historical Settings", 'updates?: Pick<CloudxUpdateService, "status" | "start">;');
  const server = path.join(release, "apps/server/src/server.ts");
  fs.appendFileSync(server, "\nlocal edit\n");
  expect(() => prepareManagedIntegration(release, coordinator)).toThrow("conflicts with local changes to apps/server/src/server.ts");
  expect(fs.readFileSync(server, "utf8")).toContain("local edit");
  expect(fs.readFileSync(path.join(release, MANAGED_INTEGRATION_FILES[0]), "utf8")).toBe("historical Settings");
});

it("rejects an unknown server contract before changing its integration", () => {
  const release = fixture("historical Settings", "unknown Settings contract");
  expect(() => prepareManagedIntegration(release, coordinator)).toThrow("does not recognize the target server's Settings contract");
  expect(git(release, ["status", "--porcelain"])).toBe("");
});

it("keeps a target's native managed integration and readiness when it supports those contracts", () => {
  const release = fixture("CLOUDX_UPDATE_COORDINATOR_ROOT", "/api/ready/terminals");
  expect(prepareManagedIntegration(release, coordinator)).toEqual({ version: 1, files: [], independentReadiness: false });
  expect(git(release, ["status", "--porcelain"])).toBe("");
});

it("stops integration when it would conceal a local Settings edit", () => {
  const release = fixture();
  const file = path.join(release, MANAGED_INTEGRATION_FILES[0]);
  fs.appendFileSync(file, "\nlocal edit\n");
  expect(() => prepareManagedIntegration(release, coordinator)).toThrow("conflicts with local changes");
  expect(fs.readFileSync(file, "utf8")).toContain("local edit");
});

it.each(["file", "directory"])("rejects a tracked %s symlink before integration can overwrite its destination", kind => {
  const release = fixture();
  const external = directory();
  const destination = path.join(external, "CloudxUpdateService.ts");
  fs.writeFileSync(destination, "private external data");
  const relative = kind === "file" ? MANAGED_INTEGRATION_FILES[0] : "apps/server/src/system";
  fs.rmSync(path.join(release, relative), { recursive: true });
  fs.symlinkSync(kind === "file" ? destination : external, path.join(release, relative));
  git(release, ["add", "."]);
  git(release, ["commit", "-m", "TEST: historical symlink"]);
  expect(() => prepareManagedIntegration(release, coordinator)).toThrow("cannot follow links");
  expect(fs.readFileSync(destination, "utf8")).toBe("private external data");
});

it("bundles the maintained integration and lifecycle probe with the coordinator for the next Settings handoff", async () => {
  const home = directory();
  const updater = new SettingsUpdater({ repoRoot: coordinator, home });
  const record = { run: { id: "11111111-1111-4111-8111-111111111111" } };
  updater.stage(record);
  const manifest = JSON.parse(fs.readFileSync(path.join(record.coordinator, "bundle.json"), "utf8"));
  expect(() => verifySnapshot(record.coordinator, manifest)).not.toThrow();
  expect(manifest.map(entry => entry.path)).toEqual(expect.arrayContaining([...MANAGED_INTEGRATION_SOURCE_FILES,
    "scripts/managed-update-integration.mjs", "scripts/managed-update-readiness.mjs"]));
  expect(manifest.map(entry => entry.path)).not.toContain("apps/server/src/server.ts");
  const next = { run: { id: "22222222-2222-4222-8222-222222222222" } };
  const { SettingsUpdater: RetainedUpdater } = await import(pathToFileURL(path.join(record.coordinator, "scripts/settings-update.mjs")));
  new RetainedUpdater({ repoRoot: coordinator, home }).stage(next);
  const nextManifest = JSON.parse(fs.readFileSync(path.join(next.coordinator, "bundle.json"), "utf8"));
  expect(() => verifySnapshot(next.coordinator, nextManifest)).not.toThrow();
  expect(next.coordinator).not.toBe(record.coordinator);
  const { prepareManagedIntegration: retainedIntegration } = await import(pathToFileURL(path.join(next.coordinator, "scripts/managed-update-integration.mjs")));
  const release = fixture("historical Settings", 'updates?: Pick<CloudxUpdateService, "status" | "start">;', legacyTerminalContract());
  expect(retainedIntegration(release).files).toContain("apps/server/src/server.ts");
  expect(fs.readFileSync(path.join(release, "apps/server/src/terminal/TerminalReadiness.ts")))
    .toEqual(fs.readFileSync(path.join(coordinator, "scripts/managed-update-readiness-legacy.ts")));
});

it.each(["settings-update.mjs", "managed-update.mjs"])("loads staged %s through resume and the next handoff after checkout replacement", entrypoint => {
  const home = directory(), checkout = directory();
  const installed = { run: { id: "11111111-1111-4111-8111-111111111111" } };
  new SettingsUpdater({ repoRoot: checkout, home }).stage(installed);
  fs.cpSync(installed.coordinator, checkout, { recursive: true });

  function stageFrom(source, record) {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { SettingsUpdater } from './scripts/settings-update.mjs';
      const [repoRoot, home, saved] = process.argv.slice(1);
      const record = JSON.parse(saved);
      new SettingsUpdater({ repoRoot, home }).stage(record);
      console.log(JSON.stringify(record));
    `, checkout, home, JSON.stringify(record)], { cwd: source, encoding: "utf8", timeout: 10_000 }));
  }

  const staged = stageFrom(checkout, { run: { id: "22222222-2222-4222-8222-222222222222" } });
  fs.rmSync(checkout, { recursive: true });
  fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "scripts", entrypoint), "throw new Error('Replaced checkout must not supply the coordinator');\n");

  const resumed = stageFrom(staged.coordinator, staged);
  const next = stageFrom(staged.coordinator, { run: { id: "33333333-3333-4333-8333-333333333333" } });
  expect(resumed).toEqual(staged);
  expect(next.coordinator).not.toBe(staged.coordinator);
  for (const record of [staged, resumed, next]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(record.coordinator, "bundle.json"), "utf8"));
    expect(() => verifySnapshot(record.coordinator, manifest)).not.toThrow();
    expect(manifest.map(entry => entry.path)).toContain("scripts/codex-updater.mjs");
    expect(execFileSync(process.execPath, ["--input-type=module", "--eval",
      "await import(process.argv[1]); console.log('loaded');", pathToFileURL(path.join(record.coordinator, "scripts", entrypoint)).href],
    { cwd: checkout, encoding: "utf8", timeout: 10_000 }).trim()).toBe("loaded");
  }
});

it("retains working historical persistence through coordinator reuse and the next handoff after checkout replacement", () => {
  const home = directory(), checkout = directory();
  const staged = { run: { id: "11111111-1111-4111-8111-111111111111" } };
  new SettingsUpdater({ repoRoot: checkout, home }).stage(staged);
  fs.writeFileSync(path.join(checkout, "replaced-checkout"), "Historical checkout without maintained persistence helpers");
  for (const id of [staged.run.id, "22222222-2222-4222-8222-222222222222"]) {
    const release = preBrokerFixture();
    execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { SettingsUpdater } from './scripts/settings-update.mjs';
      const [repoRoot, home, saved, release, id] = process.argv.slice(1);
      const previous = JSON.parse(saved);
      const record = id === previous.run.id ? previous : { run: { id } };
      new SettingsUpdater({ repoRoot, home }).stage(record);
      const { prepareManagedIntegration } = await import(record.coordinator + '/scripts/managed-update-integration.mjs');
      prepareManagedIntegration(release);
    `, checkout, home, JSON.stringify(staged), release, id], { cwd: staged.coordinator, encoding: "utf8", timeout: 10_000 });

    // Compile the retained source, then let a fresh Node process resolve its
    // dependencies without access to modules in the original checkout.
    const source = path.join(release, "apps/server/src");
    fs.writeFileSync(path.join(source, "pathBoundary.ts"), git(coordinator,
      ["show", "224a75ef7b3efced05b2c6b3b136250d9a532dc3:apps/server/src/pathBoundary.ts"]));
    for (const name of fs.readdirSync(source).filter(name => name.endsWith(".ts"))) {
      fs.writeFileSync(path.join(source, name.replace(/\.ts$/, ".js")), ts.transpileModule(fs.readFileSync(path.join(source, name), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText);
    }
    fs.writeFileSync(path.join(release, "package.json"), JSON.stringify({ type: "module" }));
    expect(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      import { JsonStateFile, openOwnedDirectoryNoFollow } from './apps/server/src/jsonStateFile.js';
      const state = new JsonStateFile(process.cwd(), 'saved.json', 'Saved state');
      await state.write({ preserved: true });
      assert.deepEqual(await state.read(), { preserved: true });
      const owned = await openOwnedDirectoryNoFollow(process.cwd(), process.cwd() + '/owned', 'Owned directory');
      assert.ok(owned.identity.durable.filesystemId);
      await owned.assertCurrent();
      await owned.remove();
      await owned.close();
      console.log('persisted');
    `], { cwd: release, encoding: "utf8", timeout: 10_000 }).trim()).toBe("persisted");
  }
});

it.each([
  ["command", undefined], ["invalid JSON", undefined], ["incomplete result", undefined],
  ["broker result for a direct target", "direct"], ["direct result for a broker target", undefined],
])("reports historical terminal %s failure before runtime attestation", (failure, terminalMode) => {
  const host = Object.create(UpdateHost.prototype);
  Object.assign(host, { target: { kind: "web", origin: "https://127.0.0.1:3001" }, envConfig: {}, paths: { dataDir: coordinator },
    runner: { sleep() {}, capture() { return { status: 0, stdout: '{"status":"ready"}\n200', stderr: "" }; }, inspect(command) {
      if (command === "curl") return '{"status":"ready"}';
      if (failure === "command") throw new Error("private child diagnostic");
      if (failure === "broker result for a direct target") return '{"broker":"ready","direct":"ready"}';
      if (failure === "direct result for a broker target") return '{"broker":"not-applicable","direct":"ready"}';
      return failure === "invalid JSON" ? "invalid" : '{"broker":"ready"}';
    } } });
  expect(() => host.verify({ coordinator, transition: { release: coordinator, integration: { independentReadiness: true, terminalMode } } }))
    .toThrow(expect.objectContaining({ component: "terminals", publicMessage: expect.stringContaining("supervisor or broker failure") }));
});

it("rejects redirected readiness roots before importing target code", async () => {
  const root = directory();
  const linked = path.join(root, "linked");
  fs.symlinkSync(root, linked);
  await expect(verifyHistoricalTerminals(linked, root)).rejects.toThrow("owned real directories");
});

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-managed-integration-"));
  roots.push(root);
  return root;
}
function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function legacyTerminalContract() {
  return fs.readFileSync(path.join(coordinator, "apps/server/src/terminal/TerminalProcess.ts"), "utf8")
    .replace("  execution?: TerminalExecutionBinding;\n", "");
}
function fixture(service = "historical Settings", server = 'updates?: Pick<CloudxUpdateService, "status" | "start" | "preview" | "selectChannel">;\n/api/ready',
  terminal = fs.readFileSync(path.join(coordinator, "apps/server/src/terminal/TerminalProcess.ts"), "utf8")) {
  const root = directory();
  git(root, ["init"]);
  git(root, ["config", "user.name", "CloudX Test"]);
  git(root, ["config", "user.email", "test@invalid"]);
  for (const [relative, content] of [[MANAGED_INTEGRATION_FILES[0], service], ["apps/server/src/server.ts", server], ["apps/server/src/terminal/TerminalProcess.ts", terminal]]) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "TEST: historical update integration"]);
  return root;
}
