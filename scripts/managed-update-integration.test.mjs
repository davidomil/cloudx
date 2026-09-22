import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { MANAGED_INTEGRATION_FILES, prepareManagedIntegration } from "./managed-update-integration.mjs";
import { SettingsUpdater } from "./settings-update.mjs";
import { verifySnapshot } from "./managed-update-store.mjs";
import { UpdateHost } from "./managed-update.mjs";
import { verifyHistoricalTerminals } from "./managed-update-readiness.mjs";

const coordinator = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("retains managed Settings and independent terminal readiness in a historical build without changing its Git revision", () => {
  const release = fixture();
  const head = git(release, ["rev-parse", "HEAD"]);
  const integration = prepareManagedIntegration(release, coordinator);
  expect(integration).toEqual({ version: 1, files: MANAGED_INTEGRATION_FILES, independentReadiness: true });
  for (const relative of integration.files) expect(fs.readFileSync(path.join(release, relative))).toEqual(fs.readFileSync(path.join(coordinator, relative)));
  expect(git(release, ["rev-parse", "HEAD"])).toBe(head);
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
  expect(manifest.map(entry => entry.path)).toEqual(expect.arrayContaining([...MANAGED_INTEGRATION_FILES,
    "scripts/managed-update-integration.mjs", "scripts/managed-update-readiness.mjs"]));
  const next = { run: { id: "22222222-2222-4222-8222-222222222222" } };
  const { SettingsUpdater: RetainedUpdater } = await import(pathToFileURL(path.join(record.coordinator, "scripts/settings-update.mjs")));
  new RetainedUpdater({ repoRoot: coordinator, home }).stage(next);
  const nextManifest = JSON.parse(fs.readFileSync(path.join(next.coordinator, "bundle.json"), "utf8"));
  expect(() => verifySnapshot(next.coordinator, nextManifest)).not.toThrow();
  expect(next.coordinator).not.toBe(record.coordinator);
});

it.each(["command", "invalid JSON", "incomplete result"])("reports historical terminal %s failure before runtime attestation", failure => {
  const host = Object.create(UpdateHost.prototype);
  Object.assign(host, { target: { kind: "web", origin: "https://127.0.0.1:3001" }, envConfig: {}, paths: { dataDir: coordinator },
    runner: { sleep() {}, capture() { return { status: 0, stdout: '{"status":"ready"}\n200', stderr: "" }; }, inspect(command) {
      if (command === "curl") return '{"status":"ready"}';
      if (failure === "command") throw new Error("private child diagnostic");
      return failure === "invalid JSON" ? "invalid" : '{"broker":"ready"}';
    } } });
  expect(() => host.verify({ coordinator, transition: { release: coordinator, integration: { independentReadiness: true } } }))
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
function fixture(service = "historical Settings", server = "/api/ready") {
  const root = directory();
  git(root, ["init"]);
  git(root, ["config", "user.name", "CloudX Test"]);
  git(root, ["config", "user.email", "test@invalid"]);
  for (const [relative, content] of [[MANAGED_INTEGRATION_FILES[0], service], ["apps/server/src/server.ts", server]]) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "TEST: historical update integration"]);
  return root;
}
