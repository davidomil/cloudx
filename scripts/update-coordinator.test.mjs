import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { COORDINATOR_FILES, stageInstalledUpdater } from "./update-coordinator.mjs";
import { verifySnapshot } from "./managed-update-store.mjs";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-installed-updater-"));
  roots.push(root);
  return root;
}

it("packages a complete verified updater with a historical server build and loads its entry points", () => {
  const release = directory();
  const installed = stageInstalledUpdater(sourceRoot, release);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "bundle.json"), "utf8"));
  expect(installed).toBe(path.join(release, "apps/server/dist/updater"));
  expect(manifest.map(entry => entry.path)).toEqual(COORDINATOR_FILES);
  expect(() => verifySnapshot(installed, manifest)).not.toThrow();
  expect(execFileSync(process.execPath, ["--input-type=module", "--eval", `
    for (const file of ['settings-update.mjs', 'managed-update.mjs', 'update-cloudx.mjs']) {
      await import(new URL('scripts/' + file, process.argv[1]));
    }
    console.log('loaded');
  `, `${pathToFileURL(installed).href}/`], { encoding: "utf8", timeout: 10_000 }).trim()).toBe("loaded");
});

it("refreshes the installed bundle from its own source on the next build without changing a saved run bundle", async () => {
  const source = directory();
  for (const relative of COORDINATOR_FILES) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relative), file);
  }
  const installed = stageInstalledUpdater(source);
  const { SettingsUpdater } = await import(pathToFileURL(path.join(installed, "scripts/settings-update.mjs")));
  const record = { run: { id: "11111111-1111-4111-8111-111111111111" } };
  new SettingsUpdater({ repoRoot: source, home: source }).stage(record);
  const guard = "scripts/terminal-upgrade-recovery.mjs";
  const savedGuard = fs.readFileSync(path.join(record.coordinator, guard));
  fs.appendFileSync(path.join(source, guard), "\nexport const installedRevision = 'updated';\n");
  stageInstalledUpdater(source);
  expect(fs.readFileSync(path.join(installed, guard), "utf8")).toContain("installedRevision = 'updated'");
  expect(fs.readFileSync(path.join(record.coordinator, guard))).toEqual(savedGuard);
  new SettingsUpdater({ repoRoot: source, home: source }).stage(record);
  expect(fs.readFileSync(path.join(record.coordinator, guard))).toEqual(savedGuard);
});
