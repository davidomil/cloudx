import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FORGE_EVIDENCE_FILE, FORGE_INTEGRATION_FILES, FORGE_RUNTIME_FILE, FORGE_SERVICE_FILE,
  FORGE_VALIDATION_FILE, prepareManagedForgeIntegration } from './managed-update-forge-integration.mjs';
import { prepareManagedIntegration } from './managed-update-integration.mjs';
import { cleanupHistoricalForge, historicalForge, FORGE_WITH_HISTORICAL_DRAFTS } from './helpers/managed-update-forge-history-fixture.mjs';
import { prepareManagedForgeIntegration as preparePreviousForgeIntegration } from './fixtures/forge-history/previous-integration.mjs';

const sources = new Map();
const maintained = file => fs.readFileSync(file, 'utf8');
function historical(file, commit = 'aec0d06e7f9087f9e912f6023cfbde5623f28178') {
  const key = `${commit}:${file}`;
  if (!sources.has(key)) sources.set(key, execFileSync('git', ['show', key], { encoding: 'utf8' }));
  return sources.get(key);
}
afterEach(cleanupHistoricalForge);

it('preserves the exact historical sources before running migration regressions', () => {
  const history = historicalForge(FORGE_WITH_HISTORICAL_DRAFTS, { integrate: false });
  const blobs = [
    [path.join(history.root, FORGE_RUNTIME_FILE), 'd3aa2388711efa4368e470a54d31eee7a3f078b2'],
    [path.join(history.root, FORGE_SERVICE_FILE), 'b381c009be062a1353258cd28798d11a50fb4350'],
    [path.join(history.root, FORGE_VALIDATION_FILE), 'eb49841eab96e94859726539c3ec52463d6d07b4'],
    ['scripts/fixtures/forge-history/previous-integration.mjs', '0a5ac0720a046e56329c217af1ea6cf6261ae2bc'],
  ];
  for (const [file, blob] of blobs)
    expect(execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim()).toBe(blob);
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: history.root, encoding: 'utf8' })).toBe('');
});

it.each(['aec0d06e7f9087f9e912f6023cfbde5623f28178', 'c664071e04091db6be78df09d8c91a1975e9313c'])('preserves the native reader/writer contract and accepts integrated %s', commit => {
  const target = file => historical(file, commit);
  expect(prepareManagedForgeIntegration(maintained, maintained)).toEqual({});
  const migrated = prepareManagedForgeIntegration(target, maintained);
  expect(Object.keys(migrated)).toEqual(FORGE_INTEGRATION_FILES);
  expect(prepareManagedForgeIntegration(file => migrated[file] ?? target(file), maintained)).toEqual({});
});

it.each([
  [FORGE_WITH_HISTORICAL_DRAFTS, [FORGE_SERVICE_FILE]],
  ['2f28a100cd765b8c209e85fdacb03b03a57ba0df', [FORGE_VALIDATION_FILE, FORGE_SERVICE_FILE]],
])('adds continuation to native %s without replacing its comparison and ownership implementation', (commit, files) => {
  const history = historicalForge(commit, { integrate: false });
  const target = file => fs.readFileSync(path.join(history.root, file), 'utf8');
  const migrated = prepareManagedForgeIntegration(target, maintained);
  expect(Object.keys(migrated)).toEqual(files);
  expect(prepareManagedForgeIntegration(file => migrated[file] ?? target(file), maintained)).toEqual({});
});

it.each(['a9613faf', 'aec0d06e', 'c664071e'])('adds continuation to previously integrated %s targets', commit => {
  const target = file => historical(file, commit);
  const integrated = preparePreviousForgeIntegration(target, maintained);
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
