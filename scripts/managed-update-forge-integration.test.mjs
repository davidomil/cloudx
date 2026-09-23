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
function historical(file) {
  if (!sources.has(file)) sources.set(file, execFileSync('git', ['show', `2e69451b065e265db2a296e465ed306a33ab8f88:${file}`], { encoding: 'utf8' }));
  return sources.get(file);
}
afterEach(cleanupHistoricalForge);

it('preserves the native reader/writer contract and accepts an already integrated historical target', () => {
  expect(prepareManagedForgeIntegration(maintained, maintained)).toEqual({});
  const migrated = prepareManagedForgeIntegration(historical, maintained);
  expect(Object.keys(migrated)).toEqual(FORGE_INTEGRATION_FILES);
  expect(prepareManagedForgeIntegration(file => migrated[file] ?? historical(file), maintained)).toEqual({});
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
