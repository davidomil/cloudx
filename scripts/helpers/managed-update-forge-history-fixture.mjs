import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { prepareManagedIntegration } from '../managed-update-integration.mjs';

export const FORGE_BEFORE_REVIEW_SCOPE = 'aec0d06e7f9087f9e912f6023cfbde5623f28178';
const require = createRequire(import.meta.url);
const roots = [];

export function historicalForge(commit = FORGE_BEFORE_REVIEW_SCOPE, { integrate = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudx-forge-history-'));
  roots.push(root);
  execFileSync('git', ['clone', '--shared', '--no-checkout', process.cwd(), root], { stdio: 'pipe' });
  execFileSync('git', ['checkout', '--detach', commit], { cwd: root, stdio: 'pipe' });
  const integration = integrate ? prepareManagedIntegration(root) : undefined;
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const compiled = ts.transpileModule(source, { fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
    const module = { exports: {} };
    modules.set(file, module);
    const dependency = name => {
      if (name.startsWith('@cloudx/')) return load(`packages/${name.slice(8)}/src/index.ts`);
      if (name.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(file), name)).replace(/\.js$/, '.ts'));
      return require(name);
    };
    const javascript = compiled.outputText.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(root, file)).href));
    new Function('require', 'module', 'exports', javascript)(dependency, module, module.exports);
    return module.exports;
  }
  return { root, integration, load,
    ...load('apps/server/src/forge/ForgeWorkflowService.ts'),
    ...load('apps/server/src/forge/ForgeWorkflowStore.ts'),
    ...load('apps/server/src/forge/ForgeRuntime.ts'),
    ...load('apps/server/src/plugins/PluginDataStore.ts') };
}

export function cleanupHistoricalForge() {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
