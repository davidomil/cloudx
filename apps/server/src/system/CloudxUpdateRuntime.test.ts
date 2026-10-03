import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxUpdateChannel, CloudxUpdatePreview } from "@cloudx/shared";
import { CloudxUpdateService } from "./CloudxUpdateService.js";
import { registerCloudxUpdateRoutes } from "./CloudxUpdateRoutes.js";
import { RuntimeBuild } from "./RuntimeBuild.js";

const olderCommit = "a".repeat(40);
const currentCommit = "b".repeat(40);
const builtAt = "2026-09-15T00:00:00.000Z";

describe("Settings running-build evidence", () => {
  let root: string;
  let directory: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-update-runtime-"));
    directory = path.join(root, "apps/server/dist");
    fs.mkdirSync(directory, { recursive: true });
    vi.stubEnv("CLOUDX_INSTALL_ROOT", root);
    vi.stubEnv("CLOUDX_UPDATE_COORDINATOR_ROOT", path.join(root, "old-coordinator"));
    const updater = path.join(directory, "updater");
    fs.mkdirSync(path.join(updater, "scripts"), { recursive: true });
    const bytes = "export {};\n";
    const entries = ["settings-update.mjs", "managed-update.mjs"].map(name => {
      fs.writeFileSync(path.join(updater, "scripts", name), bytes);
      return { path: `scripts/${name}`, type: "file", size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    fs.writeFileSync(path.join(updater, "bundle.json"), JSON.stringify(entries));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function recordBuild(commit: string, sourceDirty = false) {
    const artifact = `export const commit = ${JSON.stringify(commit)};`;
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const artifacts = { "index.js": digest(artifact) };
    fs.writeFileSync(path.join(directory, "index.js"), artifact);
    fs.writeFileSync(path.join(directory, "runtime-build.json"), JSON.stringify({
      version: 1, commit, builtAt, sourceDirty, nodeVersion: process.version,
      lockSha256: digest("lockfile"), artifactSha256: digest(JSON.stringify(artifacts)), artifacts,
    }));
  }

  function installation(runtime: RuntimeBuild, commit = currentCommit) {
    const checkout = { commit };
    const running = { available: true, run: { id: "update-1", state: "running", startedAt: builtAt, message: "Rebuilding CloudX." } };
    const execute = vi.fn(async (file: string, args: string[]) => ({
      stdout: file === "git" ? checkout.commit : JSON.stringify(args[1] === "start" ? running : { available: true }),
    }));
    const catalog = { preview: vi.fn(async (channel: CloudxUpdateChannel, currentCommit: string): Promise<Omit<CloudxUpdatePreview, "runtime">> => ({
      channel, currentCommit, checkedAt: builtAt, state: "current",
      target: { commit: currentCommit, name: "main", url: `https://github.com/davidomil/cloudx/commit/${currentCommit}` },
      changelog: [], changelogComplete: true,
    })) };
    return { checkout, execute, running, service: new CloudxUpdateService(path.join(root, "data"), execute, catalog, runtime, undefined, path.join(directory, "updater")) };
  }

  it("keeps the older startup identity after checkout and artifacts advance, and routes same-commit repair through the coordinator", async () => {
    recordBuild(olderCommit);
    const runtime = new RuntimeBuild(directory);
    const { checkout, execute, running, service } = installation(runtime, olderCommit);
    const app = Fastify();
    registerCloudxUpdateRoutes(app, service, ["http://localhost"]);
    try {
      const original = await app.inject({ url: "/api/system/update/preview" });
      expect(original.json()).toMatchObject({ currentCommit: olderCommit, runtime: { verification: "verified", commit: olderCommit } });

      checkout.commit = currentCommit;
      recordBuild(currentCommit);
      expect(new RuntimeBuild(directory).identity).toMatchObject({ verification: "verified", build: { commit: currentCommit } });
      const preview = await app.inject({ url: "/api/system/update/preview" });
      expect(preview.statusCode).toBe(200);
      expect(preview.headers["cache-control"]).toBe("no-store");
      expect(preview.json()).toMatchObject({
        state: "current", currentCommit, target: { commit: currentCommit },
        runtime: { verification: "verified", commit: olderCommit, builtAt, sourceDirty: false },
      });

      const repair = await app.inject({ method: "POST", url: "/api/system/update", headers: { origin: "http://localhost" },
        payload: { channel: "main", targetCommit: currentCommit } });
      expect(repair.statusCode).toBe(202);
      expect(repair.json()).toEqual(running);
      expect(execute).toHaveBeenLastCalledWith(process.execPath, [
        path.join(directory, "updater/scripts/settings-update.mjs"), "start", path.join(root, "data"), String(process.pid), currentCommit,
      ], expect.objectContaining({ cwd: root }));
    } finally { await app.close(); }
  });

  it.each(["missing", "invalid", "changed artifacts"])("keeps %s startup evidence unverified even after the on-disk build is repaired", async evidence => {
    recordBuild(currentCommit);
    if (evidence === "missing") fs.unlinkSync(path.join(directory, "runtime-build.json"));
    if (evidence === "invalid") fs.writeFileSync(path.join(directory, "runtime-build.json"), "{}");
    if (evidence === "changed artifacts") fs.writeFileSync(path.join(directory, "index.js"), "replacement build");
    const runtime = new RuntimeBuild(directory);
    const { service } = installation(runtime);
    const beforeRepair = await service.preview();
    expect(beforeRepair).toMatchObject({ state: "current", currentCommit, runtime: { verification: "unverified", reason: expect.any(String) } });
    expect(beforeRepair.runtime).not.toHaveProperty("commit");

    recordBuild(currentCommit);
    expect(new RuntimeBuild(directory).identity.verification).toBe("verified");
    expect((await service.preview()).runtime).toEqual(beforeRepair.runtime);
  });

  it.each([false, true])("reports a matching verified running commit and its actual dirty-source status: %s", async sourceDirty => {
    recordBuild(currentCommit, sourceDirty);
    const { service } = installation(new RuntimeBuild(directory));
    const preview = await service.preview();
    expect(preview.currentCommit).toBe(currentCommit);
    expect(preview.runtime).toEqual({ verification: "verified", commit: currentCommit, builtAt, sourceDirty });
    expect(preview.runtime).not.toHaveProperty("pid");
    expect(preview.runtime).not.toHaveProperty("artifactSha256");
  });
});
