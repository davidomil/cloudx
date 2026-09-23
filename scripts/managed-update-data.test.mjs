import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectDataCompatibility, inspectSnapshotCompatibility, inspectTargetRuntime } from "./managed-update-data.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.each([0, 1, 2, 3, 2147483647])("compares actual archive schema %s with the selected target without changing the catalog", version => {
  const f = fixture();
  createCatalog(f.archive, version);
  const before = fs.readFileSync(f.catalog);
  const files = fs.readdirSync(f.archive);
  const result = inspectDataCompatibility(f.release, f.env, f.data);
  expect(result).toMatchObject({ compatible: version <= 2, archiveSchema: version, targetArchiveSchema: 2, sessionSchema: 1, targetSessionSchema: 1 });
  expect(result.migrations).toEqual(version < 2 ? [{ component: "documentation", from: version, to: 2 }] : []);
  if (version > 2) expect(result.message).toContain("retaining newer data");
  expect(fs.readFileSync(f.catalog)).toEqual(before);
  expect(fs.readdirSync(f.archive)).toEqual(files);
});

it("reads schema changes committed in a live WAL instead of the older main database header", async () => {
  const f = fixture();
  fs.mkdirSync(f.archive, { recursive: true });
  const child = spawn("python3", ["-I", "-S", "-c", `import sqlite3,sys
connection=sqlite3.connect(sys.argv[1])
connection.execute('PRAGMA journal_mode=WAL')
connection.execute('PRAGMA user_version=3')
connection.commit()
print('ready', flush=True)
sys.stdin.read()
connection.close()
`, f.catalog], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(child.stdout, "data");
    expect(fs.readFileSync(f.catalog).readUInt32BE(60)).toBe(0);
    expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: false, archiveSchema: 3 });
  } finally {
    const exited = once(child, "exit");
    child.stdin.end();
    await exited;
  }
});

it.each([0, 1, 2])("supports a legacy selected target declaring catalog schema %s", target => {
  const f = fixture({ target });
  createCatalog(f.archive, target);
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: true, archiveSchema: target, targetArchiveSchema: target });
  createCatalog(f.archive, target + 1);
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: false, archiveSchema: target + 1, targetArchiveSchema: target });
});

it("uses a configured non-default documentation root independently of the default catalog", () => {
  const f = fixture();
  createCatalog(f.archive, 8);
  const external = path.join(f.root, "archive with ? and # characters");
  createCatalog(external, 1);
  expect(inspectDataCompatibility(f.release, { CLOUDX_DOCUMENTATION_DATA_DIR: external }, f.data)).toMatchObject({ compatible: true, archiveSchema: 1 });
});

it("does not create absent catalog or session data", () => {
  const f = fixture();
  fs.rmSync(f.data, { recursive: true });
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: true, archivePresent: false, sessionsPresent: false, migrations: [] });
  expect(fs.existsSync(f.data)).toBe(false);
});

it.each([0, 1, 2])("compares saved session schema %s with the target's exact reader contract", version => {
  const f = fixture();
  fs.writeFileSync(path.join(f.data, "sessions.json"), JSON.stringify({ version, sessions: [] }));
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: version === 1, sessionSchema: version, targetSessionSchema: 1 });
});

it.each(["missing", "unrecognized"])("rejects persisted sessions with a %s target reader", kind => {
  const f = fixture();
  if (kind === "missing") fs.unlinkSync(f.sessionSource);
  else fs.writeFileSync(f.sessionSource, "export class SessionStateStore { read() { throw new Error('unknown contract'); } }");
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: false, targetSessionSchema: null });
});

it("retains an empty schema-1 store written during shutdown when the actual pre-broker target has no session persistence", () => {
  const f = inMemoryTargetFixture();
  const sessionFile = path.join(f.data, "sessions.json");
  fs.unlinkSync(sessionFile);
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: true, sessionsPresent: false, targetSessionPersistence: "none" });
  const empty = '{\n  "version": 1,\n  "sessions": []\n}\n';
  fs.writeFileSync(sessionFile, empty);
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: true, sessionSchema: 1, targetSessionSchema: null, targetSessionPersistence: "none", migrations: [] });
  expect(fs.readFileSync(sessionFile, "utf8")).toBe(empty);
  const snapshot = path.join(f.root, "snapshot");
  fs.cpSync(f.data, snapshot, { recursive: true });
  expect(inspectSnapshotCompatibility(f.release, f.env, f.data, [{ root: f.data, destination: snapshot }])).toMatchObject({ compatible: true, targetSessionPersistence: "none" });
  expect(fs.readFileSync(path.join(snapshot, "sessions.json"), "utf8")).toBe(empty);
});

it.each([
  { version: 1, sessions: [{ tab: { id: "saved-tab" } }] },
  { version: 1, sessions: [], activeTabId: "saved-tab" },
  { version: 1, sessions: [], activeTabId: null },
  { version: 1, sessions: [], futureState: {} },
  { version: 0, sessions: [] },
  { version: 2, sessions: [] },
])("keeps nonempty or unknown session metadata incompatible with the pre-broker target: %j", saved => {
  const f = inMemoryTargetFixture(), sessionFile = path.join(f.data, "sessions.json");
  const content = JSON.stringify(saved);
  fs.writeFileSync(sessionFile, content);
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: false, targetSessionPersistence: "none" });
  expect(fs.readFileSync(sessionFile, "utf8")).toBe(content);
});

it.each([null, { version: "1", sessions: [] }, { version: 1, sessions: {} }])("rejects malformed saved sessions for the recognized in-memory target: %j", saved => {
  const f = inMemoryTargetFixture();
  fs.writeFileSync(path.join(f.data, "sessions.json"), JSON.stringify(saved));
  expect(() => inspectDataCompatibility(f.release, f.env, f.data)).toThrow("invalid schema declaration");
});

it.each(["missing session store", "different constructor", "persistence reader", "file access", "broker", "different terminal contract"])(
  "does not declare absent session persistence for a target with a %s", unknown => {
    const f = inMemoryTargetFixture();
    const store = path.join(f.release, "apps/server/src/sessionStore.ts");
    if (unknown === "missing session store") fs.unlinkSync(store);
    if (unknown === "different constructor") fs.writeFileSync(store, fs.readFileSync(store, "utf8").replace("private readonly workspace?: WorkspaceLayoutStore", "private readonly renamedWorkspace?: WorkspaceLayoutStore"));
    if (unknown === "persistence reader") fs.writeFileSync(f.sessionSource, "export class SessionStateStore { read() {} }");
    if (unknown === "file access") fs.appendFileSync(store, '\nimport fs from "node:fs";\n');
    if (unknown === "broker") fs.writeFileSync(path.join(f.release, "apps/server/src/terminal/DurableTerminalProcess.ts"), "export class DurableTerminalProcessFactory {}");
    if (unknown === "different terminal contract") fs.writeFileSync(path.join(f.release, "apps/server/src/terminal/TerminalProcess.ts"), "export interface TerminalProcessFactory { spawn(): unknown; }");
    const result = inspectDataCompatibility(f.release, f.env, f.data);
    expect(result).toMatchObject({ compatible: false, targetSessionSchema: null });
    expect(result.targetSessionPersistence).toBeUndefined();
  },
);

it.each(["missing", "negative", "expression", "overflow"])("does not guess a %s target catalog declaration", kind => {
  const f = fixture();
  createCatalog(f.archive, 0);
  if (kind === "missing") fs.unlinkSync(f.catalogSource);
  else fs.writeFileSync(f.catalogSource, `SCHEMA_VERSION = ${{ negative: "-1", expression: "1 + 1", overflow: "2147483648" }[kind]}\n`);
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: false, targetArchiveSchema: null });
});

it.each([null, { version: -1, sessions: [] }, { version: 1.5, sessions: [] }, { version: "1", sessions: [] }, { version: 1 }])(
  "rejects malformed session metadata %j before reporting compatibility", value => {
    const f = fixture();
    fs.writeFileSync(path.join(f.data, "sessions.json"), JSON.stringify(value));
    expect(() => inspectDataCompatibility(f.release, f.env, f.data)).toThrow("invalid schema declaration");
  },
);

it("rejects negative SQLite schema versions and a corrupt catalog", () => {
  const f = fixture();
  createCatalog(f.archive, -1);
  expect(() => inspectDataCompatibility(f.release, f.env, f.data)).toThrow("invalid schema version");
  fs.writeFileSync(f.catalog, "not sqlite");
  expect(() => inspectDataCompatibility(f.release, f.env, f.data)).toThrow();
});

it("inspects a candidate's actual schemas even when its recorded target commit matches", () => {
  const f = fixture();
  createCatalog(f.archive, 3);
  const snapshot = path.join(f.root, "snapshot");
  fs.cpSync(f.data, snapshot, { recursive: true });
  const candidate = [{ root: f.data, destination: snapshot, targetCommit: "a".repeat(40) }];
  fs.writeFileSync(path.join(f.release, "target-commit"), "a".repeat(40));
  expect(inspectSnapshotCompatibility(f.release, f.env, f.data, candidate)).toMatchObject({ compatible: false, archiveSchema: 3 });
  createCatalog(path.join(snapshot, "documentation"), 1);
  expect(inspectSnapshotCompatibility(f.release, f.env, f.data, candidate)).toMatchObject({ compatible: true, archiveSchema: 1 });
  expect(inspectDataCompatibility(f.release, f.env, f.data).archiveSchema).toBe(3);
  fs.writeFileSync(path.join(snapshot, "sessions.json"), JSON.stringify({ version: 2, sessions: [] }));
  expect(inspectSnapshotCompatibility(f.release, f.env, f.data, candidate)).toMatchObject({ compatible: false, sessionSchema: 2 });
});

it.each(["nested", "external"])("resolves the configured %s archive inside the selected recovery roots", kind => {
  const f = fixture();
  const originalArchive = kind === "nested" ? path.join(f.data, "custom/archive") : path.join(f.root, "external-archive");
  createCatalog(originalArchive, 3);
  const snapshot = path.join(f.root, "snapshot");
  fs.cpSync(f.data, snapshot, { recursive: true });
  const candidates = [{ root: f.data, destination: snapshot }];
  const archived = kind === "nested" ? path.join(snapshot, "custom/archive") : path.join(f.root, "external-snapshot");
  createCatalog(archived, 2);
  if (kind === "external") candidates.push({ root: originalArchive, destination: archived });
  const env = { CLOUDX_DOCUMENTATION_DATA_DIR: originalArchive };
  expect(inspectSnapshotCompatibility(f.release, env, f.data, candidates)).toMatchObject({ compatible: true, archiveSchema: 2 });
  expect(inspectDataCompatibility(f.release, env, f.data)).toMatchObject({ compatible: false, archiveSchema: 3 });
});

it("rejects a snapshot lacking the configured external archive or having ambiguous coverage", () => {
  const f = fixture();
  const external = path.join(f.root, "external-archive");
  createCatalog(external, 1);
  const snapshot = path.join(f.root, "snapshot");
  fs.cpSync(f.data, snapshot, { recursive: true });
  const candidate = { root: f.data, destination: snapshot };
  expect(() => inspectSnapshotCompatibility(f.release, { CLOUDX_DOCUMENTATION_DATA_DIR: external }, f.data, [candidate])).toThrow("cover each configured data root exactly once");
  expect(() => inspectSnapshotCompatibility(f.release, f.env, f.data, [candidate, candidate])).toThrow("cover each configured data root exactly once");
});

it.each(["relative", "/", ""]) ("rejects unsafe configured data root %j", data => {
  const f = fixture();
  expect(() => inspectDataCompatibility(f.release, f.env, data)).toThrow("absolute non-root paths");
  expect(() => inspectDataCompatibility(f.release, { CLOUDX_DOCUMENTATION_DATA_DIR: data }, f.data)).toThrow("absolute non-root paths");
});

it.each(["archive", "catalog", "sessions", "WAL", "snapshot"])("rejects redirected %s paths without following them", kind => {
  const f = fixture();
  createCatalog(f.archive, 1);
  const target = kind === "archive" ? f.archive : kind === "catalog" ? f.catalog : kind === "sessions" ? path.join(f.data, "sessions.json")
    : kind === "WAL" ? `${f.catalog}-wal` : path.join(f.root, "snapshot");
  if (fs.existsSync(target)) fs.renameSync(target, `${target}-original`);
  else fs.mkdirSync(`${target}-original`);
  fs.symlinkSync(`${target}-original`, target);
  if (kind === "snapshot") expect(() => inspectSnapshotCompatibility(f.release, f.env, f.data, [{ root: f.data, destination: target }])).toThrow("without symlinks");
  else expect(() => inspectDataCompatibility(f.release, f.env, f.data)).toThrow(/without symlinks|owned regular file/);
});

it("reads the selected target's terminal contracts without importing its runtime", () => {
  const f = fixture();
  const terminal = path.join(f.release, "apps/server/src/terminal");
  fs.mkdirSync(terminal);
  for (const name of ["TerminalRuntimeReceipt", "TerminalSupervisorRuntime", "NodePtyTerminalProcess", "DurableTerminalProcess"])
    fs.copyFileSync(new URL(`../apps/server/src/terminal/${name}.ts`, import.meta.url), path.join(terminal, `${name}.ts`));
  expect(inspectTargetRuntime(f.release)).toEqual({ brokerProtocol: 1, supervisorContract: "execution-json-v1", persistentSessions: true });
  fs.unlinkSync(path.join(terminal, "TerminalRuntimeReceipt.ts"));
  expect(inspectTargetRuntime(f.release)).toMatchObject({ brokerProtocol: null, persistentSessions: true });
  fs.writeFileSync(path.join(terminal, "NodePtyTerminalProcess.ts"), "const helper = 'mutable helper path';");
  expect(inspectTargetRuntime(f.release).supervisorContract).toBeNull();
});

it("does not claim persistent terminal compatibility for a target without broker/session ownership", () => {
  const f = fixture();
  expect(inspectTargetRuntime(f.release)).toEqual({ brokerProtocol: null, supervisorContract: null, persistentSessions: false });
});

function fixture({ target = 2 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-data-contract-"));
  roots.push(root);
  const release = path.join(root, "release"), data = path.join(root, "data"), archive = path.join(data, "documentation");
  const catalogSource = path.join(release, "services/documentation-indexer/src/cloudx_documentation_indexer/catalog_schema.py");
  const sessionSource = path.join(release, "apps/server/src/workspace/SessionStateStore.ts");
  fs.mkdirSync(path.dirname(catalogSource), { recursive: true });
  fs.mkdirSync(path.dirname(sessionSource), { recursive: true });
  fs.mkdirSync(data);
  fs.writeFileSync(catalogSource, `SCHEMA_VERSION = ${target}\nraise RuntimeError('Target source must never be executed by inspection')\n`);
  fs.copyFileSync(new URL("../apps/server/src/workspace/SessionStateStore.ts", import.meta.url), sessionSource);
  fs.writeFileSync(path.join(data, "sessions.json"), JSON.stringify({ version: 1, sessions: [] }));
  return { root, release, data, archive, catalog: path.join(archive, "catalog.sqlite"), env: {}, catalogSource, sessionSource };
}

function inMemoryTargetFixture() {
  const f = fixture();
  fs.unlinkSync(f.sessionSource);
  for (const relative of ["apps/server/src/sessionStore.ts", "apps/server/src/terminal/TerminalProcess.ts"]) {
    const destination = path.join(f.release, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, execFileSync("git", ["show", `224a75ef7b3efced05b2c6b3b136250d9a532dc3:${relative}`], { cwd: new URL("..", import.meta.url), encoding: "utf8" }));
  }
  return f;
}

function createCatalog(root, version) {
  fs.mkdirSync(root, { recursive: true });
  execFileSync("python3", ["-I", "-S", "-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('CREATE TABLE IF NOT EXISTS retained (value TEXT)'); db.execute('PRAGMA user_version='+sys.argv[2]); db.commit(); db.close()", path.join(root, "catalog.sqlite"), String(version)]);
}

function forgeFixture() {
  const f = fixture();
  for (const name of ['ForgeWorkflowService', 'ForgeWorkflowValidation', 'ForgeRuntime']) {
    const relative = `apps/server/src/forge/${name}.ts`;
    fs.mkdirSync(path.dirname(path.join(f.release, relative)), { recursive: true });
    fs.copyFileSync(relative, path.join(f.release, relative));
  }
  const id = '11111111-1111-4111-8111-111111111111';
  const revision = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'b'.repeat(40) };
  const worker = { kind: 'review', draft: { id, headSha: revision.headSha }, reviewBaseline: { reviewId: id, revision },
    completion: { reviewScope: { kind: 'initial', current: revision }, report: { kind: 'review', headSha: revision.headSha } } };
  const store = path.join(f.data, `plugin-data/forge-${createHash('sha256').update('forge').digest('hex')}.json`);
  fs.mkdirSync(path.dirname(store));
  fs.writeFileSync(store, JSON.stringify([worker]));
  return { ...f, worker, store };
}

it('checks Forge review evidence for both the active profile and a selected snapshot without changing either', () => {
  const f = forgeFixture();
  const snapshot = path.join(f.root, 'snapshot');
  fs.cpSync(f.data, snapshot, { recursive: true });
  const before = fs.readFileSync(f.store);
  expect(inspectDataCompatibility(f.release, {}, f.data)).toMatchObject({ compatible: true, forgePresent: true,
    forgeReviewEvidence: true, targetForgeReviewEvidence: 'native' });
  expect(inspectSnapshotCompatibility(f.release, {}, f.data, [{ root: f.data, destination: snapshot }])).toMatchObject({ compatible: true });
  f.worker.reviewBaseline.reviewId = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(snapshot, path.relative(f.data, f.store)), JSON.stringify([f.worker]));
  expect(inspectSnapshotCompatibility(f.release, {}, f.data, [{ root: f.data, destination: snapshot }])).toMatchObject({ compatible: false });
  expect(fs.readFileSync(f.store)).toEqual(before);
});

it.each([
  ['stale review', worker => { worker.draft.id = '22222222-2222-4222-8222-222222222222'; }],
  ['different head', worker => { worker.reviewBaseline.revision.headSha = 'c'.repeat(40); }],
  ['invalid identity', worker => { worker.draft.id = worker.reviewBaseline.reviewId = 'invalid'; }],
  ['invalid commit', worker => { worker.reviewBaseline.revision.baseSha = 'main'; }],
  ['missing latest review', worker => { delete worker.draft; worker.reviewHistory = {}; }],
  ['invalid revision', worker => { worker.reviewBaseline.revision = null; }],
  ['issue worker', worker => { worker.kind = 'issue'; }],
  ['null scope', worker => { worker.completion.reviewScope = null; }],
  ['missing current comparison', worker => { delete worker.completion.reviewScope.current; }],
  ['unexpected previous comparison', worker => { worker.completion.reviewScope.previous = worker.reviewBaseline.revision; }],
  ['incremental without previous comparison', worker => { worker.completion.reviewScope.kind = 'incremental'; }],
  ['mismatched merge base', worker => { worker.completion.reviewScope = { kind: 'incremental', current: worker.reviewBaseline.revision,
    previous: { ...worker.reviewBaseline.revision, mergeBaseSha: 'c'.repeat(40) } }; }],
  ['mismatched report', worker => { worker.completion.report.headSha = 'c'.repeat(40); }],
  ['mismatched attempt', worker => { worker.attemptId = '22222222-2222-4222-8222-222222222222'; worker.headSha = 'c'.repeat(40); }],
])('rejects %s in saved Forge evidence before activation', (_name, change) => {
  const f = forgeFixture();
  change(f.worker);
  const content = JSON.stringify([f.worker]);
  fs.writeFileSync(f.store, content);
  expect(inspectDataCompatibility(f.release, {}, f.data)).toMatchObject({ compatible: false });
  expect(fs.readFileSync(f.store, 'utf8')).toBe(content);
});

it.each(['service', 'reader', 'runtime'])('requires a recognized Forge evidence %s when the profile contains review metadata', missing => {
  const f = forgeFixture();
  fs.unlinkSync(path.join(f.release, 'apps/server/src/forge', {
    service: 'ForgeWorkflowService.ts', reader: 'ForgeWorkflowValidation.ts', runtime: 'ForgeRuntime.ts',
  }[missing]));
  expect(inspectDataCompatibility(f.release, {}, f.data)).toMatchObject({ compatible: false, targetForgeReviewEvidence: null });
  fs.writeFileSync(f.store, '[]');
  expect(inspectDataCompatibility(f.release, {}, f.data)).toMatchObject({ compatible: true, forgeReviewEvidence: false });
});

it.each(['null', '{}', '[null]', '[[]]', '[1]'])('rejects malformed Forge stores: %s', content => {
  const f = forgeFixture();
  fs.writeFileSync(f.store, content);
  expect(() => inspectDataCompatibility(f.release, {}, f.data)).toThrow('valid worker list');
});

it('does not follow a redirected Forge workflow file', () => {
  const f = forgeFixture();
  fs.renameSync(f.store, `${f.store}.original`);
  fs.symlinkSync(`${f.store}.original`, f.store);
  expect(() => inspectDataCompatibility(f.release, {}, f.data)).toThrow('owned regular file');
});
