import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FORGE_EVIDENCE_FILE, FORGE_INTEGRATION_FILES, FORGE_RUNTIME_FILE, FORGE_SERVICE_FILE,
  FORGE_VALIDATION_FILE, prepareManagedForgeIntegration } from './managed-update-forge-integration.mjs';
import { prepareManagedIntegration } from './managed-update-integration.mjs';
import { cleanupHistoricalForge, historicalForge } from './helpers/managed-update-forge-history-fixture.mjs';

const sources = new Map();
const maintained = file => fs.readFileSync(file, 'utf8');
function historical(file, commit = '2e69451b065e265db2a296e465ed306a33ab8f88') {
  const key = `${commit}:${file}`;
  if (!sources.has(key)) sources.set(key, execFileSync('git', ['show', key], { encoding: 'utf8' }));
  return sources.get(key);
}
afterEach(cleanupHistoricalForge);

it.each(['2e69451b065e265db2a296e465ed306a33ab8f88', 'c664071e04091db6be78df09d8c91a1975e9313c'])('preserves the native reader/writer contract and accepts integrated %s', commit => {
  const target = file => historical(file, commit);
  expect(prepareManagedForgeIntegration(maintained, maintained)).toEqual({});
  const migrated = prepareManagedForgeIntegration(target, maintained);
  expect(Object.keys(migrated)).toEqual(FORGE_INTEGRATION_FILES);
  expect(prepareManagedForgeIntegration(file => migrated[file] ?? target(file), maintained)).toEqual({});
});

it.each([
  ['7604d8d', [FORGE_SERVICE_FILE]],
  ['2f28a100cd765b8c209e85fdacb03b03a57ba0df', [FORGE_VALIDATION_FILE, FORGE_SERVICE_FILE]],
])('adds continuation to native %s without replacing its comparison and ownership implementation', (commit, files) => {
  const target = file => historical(file, commit);
  const migrated = prepareManagedForgeIntegration(target, maintained);
  expect(Object.keys(migrated)).toEqual(files);
  expect(prepareManagedForgeIntegration(file => migrated[file] ?? target(file), maintained)).toEqual({});
});

it.each(['a9613faf', '2e69451b', 'c664071e'])('adds continuation to previously integrated %s targets', async commit => {
  const source = historical('scripts/managed-update-forge-integration.mjs', '540da2c');
  const previous = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const target = file => historical(file, commit);
  const integrated = previous.prepareManagedForgeIntegration(target, maintained);
  const migrated = prepareManagedForgeIntegration(file => integrated[file] ?? target(file), maintained);
  expect(Object.keys(migrated)).toEqual([FORGE_SERVICE_FILE]);
  expect(prepareManagedForgeIntegration(file => migrated[file] ?? integrated[file] ?? target(file), maintained)).toEqual({});
});

it('rejects an unrecognized native reviewer selection', () => {
  expect(() => prepareManagedForgeIntegration(file => {
    const source = historical(file, '2f28a100cd765b8c209e85fdacb03b03a57ba0df');
    return file === FORGE_SERVICE_FILE ? source.replace('&& !worker.retainedWorkspace &&', '&& worker.status === "paused" &&') : source;
  }, maintained)).toThrow('does not recognize the target reviewer selection');
});

it.each([
  [FORGE_RUNTIME_FILE, '    let mergeBases: string[];'],
  [FORGE_SERVICE_FILE, '            worker.draft = { ...parseReview(report), status: "draft" };'],
  [FORGE_VALIDATION_FILE, 'function parseSavedReview(value: unknown): ForgeReviewDraft {'],
])('rejects an unrecognized separate-review-worker contract in %s', (file, anchor) => {
  expect(() => prepareManagedForgeIntegration(name => {
    const source = historical(name, 'c664071e04091db6be78df09d8c91a1975e9313c');
    return name === file ? source.replace(anchor, 'unknown contract') : source;
  }, maintained)).toThrow('does not recognize');
});

it.each([
  [FORGE_SERVICE_FILE, 'worker.attemptId = randomUUID();'],
  [FORGE_SERVICE_FILE, 'private async completeAttempt(worker: ForgeWorker): Promise<boolean> {'],
  [FORGE_VALIDATION_FILE, 'if (worker.autoReview !== undefined) {'],
  [FORGE_RUNTIME_FILE, 'private serialize<T>(id: string, name: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>'],
])('rejects an unrecognized target contract in %s', (file, anchor) => {
  expect(() => prepareManagedForgeIntegration(name => name === file ? historical(name).replace(anchor, 'unknown contract') : historical(name), maintained))
    .toThrow('does not recognize');
});

it('rejects partial native evidence support', () => {
  expect(() => prepareManagedForgeIntegration(file => file === FORGE_RUNTIME_FILE ? maintained(file) : historical(file), maintained))
    .toThrow('does not recognize');
});

it('requires the maintained runtime methods and the integrated validation helper', () => {
  expect(() => prepareManagedForgeIntegration(historical, file => file === FORGE_RUNTIME_FILE ? '' : maintained(file)))
    .toThrow('missing its maintained runtime methods');
  const migrated = prepareManagedForgeIntegration(historical, maintained);
  expect(() => prepareManagedForgeIntegration(file => file === FORGE_EVIDENCE_FILE ? '' : migrated[file], maintained))
    .toThrow('does not recognize the target evidence contract');
});

it.each(FORGE_INTEGRATION_FILES)('preserves an operator edit to %s before any historical integration writes', file => {
  const history = historicalForge(undefined, { integrate: false });
  const destination = path.join(history.root, file);
  fs.appendFileSync(destination, '\n// operator edit\n');
  const before = new Map(FORGE_INTEGRATION_FILES.map(relative => [relative, fs.existsSync(path.join(history.root, relative))
    ? fs.readFileSync(path.join(history.root, relative)) : undefined]));
  expect(() => prepareManagedIntegration(history.root)).toThrow(`conflicts with local changes to ${file}`);
  for (const [relative, content] of before) {
    const full = path.join(history.root, relative);
    expect(fs.existsSync(full) ? fs.readFileSync(full) : undefined).toEqual(content);
  }
}, 15000);
