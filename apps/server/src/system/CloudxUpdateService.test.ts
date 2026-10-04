import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxUpdateChannel, CloudxUpdatePreview, CloudxUpdateBackupCleanup } from "@cloudx/shared";
import { CloudxUpdateService } from "./CloudxUpdateService.js";

const installed = "a".repeat(40);
const target = "b".repeat(40);
const selection = { channel: "main" as const, targetCommit: target };
const backupId = "11111111-1111-4111-8111-111111111111";
const retained = { backups: [{ id: `${backupId}:snapshot`, runId: backupId, kind: "snapshot", sourceCommit: installed,
  targetCommit: target, createdAt: "2026-10-04T03:02:05Z", outcome: "succeeded", path: `/state/settings-update/${backupId}/snapshot`,
  logicalBytes: 8192, allocatedBytes: 8192, reclaimableBytes: 4096 }] };
const reviewed = { ...retained, id: backupId, createdAt: "2026-10-04T04:00:00Z", reclaimableBytes: 4096, estimateNote: "Shared allocation can retain bytes." };
const cleaning: CloudxUpdateBackupCleanup = { id: backupId, state: "running", startedAt: reviewed.createdAt,
  results: [{ id: retained.backups[0]!.id, runId: backupId, path: retained.backups[0]!.path, status: "pending", deletedLogicalBytes: 0 }],
  freeSpace: [{ path: "/state", availableBytesBefore: 1024, availableBytesAfter: null }] };
const checked = (channel: CloudxUpdateChannel = "main", currentCommit = installed): Omit<CloudxUpdatePreview, "runtime"> => ({
  channel, currentCommit, checkedAt: "2026-09-15T00:00:00Z", state: "available",
  target: { commit: target, name: "main", url: `https://github.com/davidomil/cloudx/commit/${target}` },
  changelog: [], changelogComplete: true,
});

describe("CloudxUpdateService", () => {
  let dataDir: string;
  let updaterRoot: string;
  beforeEach(() => {
    vi.stubEnv("CLOUDX_INSTALL_ROOT", path.resolve("."));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-update-service-"));
    updaterRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-installed-updater-"));
    fs.mkdirSync(path.join(updaterRoot, "scripts"));
    const bytes = "export {};\n";
    const manifest = ["settings-update.mjs", "managed-update.mjs"].map(name => {
      fs.writeFileSync(path.join(updaterRoot, "scripts", name), bytes);
      return { path: `scripts/${name}`, type: "file", size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    fs.writeFileSync(path.join(updaterRoot, "bundle.json"), JSON.stringify(manifest));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of [dataDir, updaterRoot]) fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const execute = vi.fn(async (file: string, _args: string[]) => ({ stdout: file === "git" ? installed : '{"available":true}' }));
    const catalog = { preview: vi.fn(async (channel: CloudxUpdateChannel, currentCommit: string) => checked(channel, currentCommit)) };
    const service = new CloudxUpdateService(dataDir, execute, catalog, undefined, undefined, updaterRoot);
    return { execute, catalog, service };
  }

  it("keeps local run monitoring independent of remote release lookup", async () => {
    const { service, execute, catalog } = fixture();
    expect(await service.status()).toEqual({ available: true });
    expect(execute).toHaveBeenCalledWith(process.execPath, [
      path.join(updaterRoot, "scripts/settings-update.mjs"), "status", dataDir, String(process.pid),
    ], { cwd: path.resolve("."), timeout: 30_000, maxBuffer: 65536, encoding: "utf8",
      env: expect.objectContaining({ CLOUDX_INSTALL_ROOT: path.resolve(".") }) });
    expect(catalog.preview).not.toHaveBeenCalled();
  });

  it("reassesses only the current saved run and pinned target without starting a host update", async () => {
    const { execute, catalog, service } = fixture();
    const id = "11111111-1111-4111-8111-111111111111";
    const status = { available: true, run: { id, state: "failed", targetCommit: target, resumable: true,
      message: "Insufficient capacity", startedAt: "2026-09-15T00:00:00Z" } };
    execute.mockResolvedValue({ stdout: JSON.stringify(status) });
    expect(await service.reassessCapacity({ ...selection, resumeRunId: id })).toEqual(status);
    expect(execute.mock.calls.at(-1)?.[1]).toEqual([path.join(updaterRoot, "scripts/settings-update.mjs"), "capacity", dataDir, String(process.pid), target, `--resume=${id}`]);
    expect(catalog.preview).not.toHaveBeenCalled();
    execute.mockClear();
    await expect(service.reassessCapacity({ ...selection, targetCommit: installed, resumeRunId: id })).rejects.toThrow("saved update changed");
    await expect(service.reassessCapacity(selection)).rejects.toThrow("saved update changed");
    expect(execute.mock.calls.every(([, args]) => args[1] === "status")).toBe(true);
  });

  it.each([false, true])("reconciles confirmed completed merges before %s update launch", async resume => {
    const { execute, catalog } = fixture();
    const id = "11111111-1111-4111-8111-111111111111";
    const run = { id, state: "failed", targetCommit: target, resumable: true, startedAt: "2026-09-15T00:00:00Z", message: "Forge blocked the update." };
    let reconciled = false;
    const forge = { reconcileCompletedMerges: vi.fn(async () => { reconciled = true; }) };
    execute.mockImplementation(async (file, _args) => {
      if (file === "git") return { stdout: installed };
      if (_args[1] === "start") expect(reconciled).toBe(true);
      return { stdout: JSON.stringify({ available: true, ...(resume ? { run } : {}) }) };
    });
    const service = new CloudxUpdateService(dataDir, execute, catalog, undefined, forge, updaterRoot);
    if (!resume) await service.preview();
    await service.start({ ...selection, ...(resume ? { resumeRunId: id } : {}) });
    expect(forge.reconcileCompletedMerges).toHaveBeenCalledOnce();
    expect(execute.mock.calls.at(-1)?.[1][1]).toBe("start");
  });

  it("leaves Forge state untouched while an update is already running", async () => {
    const { execute, catalog } = fixture();
    execute.mockResolvedValue({ stdout: JSON.stringify({ available: true,
      run: { id: "active", state: "running", startedAt: "2026-09-15T00:00:00Z", message: "Snapshotting" } }) });
    const forge = { reconcileCompletedMerges: vi.fn() };
    const service = new CloudxUpdateService(dataDir, execute, catalog, undefined, forge, updaterRoot);
    expect((await service.start(selection)).run?.state).toBe("running");
    expect(forge.reconcileCompletedMerges).not.toHaveBeenCalled();
  });

  it("returns the structured blocker when provider confirmation remains uncertain", async () => {
    const { execute, catalog } = fixture();
    const blocked = { available: true, forgeBlocker: { kind: "forge", workerId: "worker-149", issueNumber: 129,
      message: "The saved merge outcome remains uncertain.", recoveryAction: "Open Forge and Resume the worker." } };
    execute.mockResolvedValue({ stdout: JSON.stringify(blocked) });
    const forge = { reconcileCompletedMerges: vi.fn(async () => { throw new Error("Provider unavailable"); }) };
    const service = new CloudxUpdateService(dataDir, execute, catalog, undefined, forge, updaterRoot);
    expect(await service.start(selection)).toEqual(blocked);
    expect(execute.mock.calls.every(([, args]) => args[1] === "status")).toBe(true);
  });

  it("uses the installed checkout when managed build modules live in a separate release directory", async () => {
    vi.stubEnv("CLOUDX_INSTALL_ROOT", dataDir);
    try {
      const { service, execute } = fixture();
      await service.status();
      expect(execute).toHaveBeenCalledWith(process.execPath, [path.join(updaterRoot, "scripts/settings-update.mjs"), "status", dataDir, String(process.pid)],
        { cwd: dataDir, timeout: 30_000, maxBuffer: 65536, encoding: "utf8",
          env: expect.objectContaining({ CLOUDX_INSTALL_ROOT: dataDir }) });
      await service.preview();
      expect(execute).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], expect.objectContaining({ cwd: dataDir }));
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects a relative installed-checkout setting", () => {
    vi.stubEnv("CLOUDX_INSTALL_ROOT", "relative/path");
    try { expect(() => fixture()).toThrow("absolute checkout path"); }
    finally { vi.unstubAllEnvs(); }
  });

  it("uses the installed updater for status and new starts despite an inherited old coordinator", async () => {
    const coordinator = path.join(dataDir, "retained-coordinator");
    vi.stubEnv("CLOUDX_INSTALL_ROOT", dataDir);
    vi.stubEnv("CLOUDX_UPDATE_COORDINATOR_ROOT", coordinator);
    try {
      const { service, execute } = fixture();
      await service.status();
      await service.preview();
      await service.start({ channel: "main", targetCommit: target });
      const calls = execute.mock.calls.filter(([file]) => file === process.execPath);
      expect(calls.every(([, args]) => args[0] === path.join(updaterRoot, "scripts/settings-update.mjs"))).toBe(true);
      expect(calls.at(-1)?.[1]).toEqual([path.join(updaterRoot, "scripts/settings-update.mjs"), "start", dataDir, String(process.pid), target]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects a relative installed updater bundle", () => {
    expect(() => new CloudxUpdateService(dataDir, undefined, undefined, undefined, undefined, "relative/updater"))
      .toThrow("absolute bundle path");
  });

  it.each(["missing bundle", "invalid JSON", "empty inventory", "duplicate path", "escaped path", "missing entrypoint", "changed bytes", "file link", "directory link", "manifest link"])("rejects an installed updater with %s before execution", async scenario => {
    const manifestFile = path.join(updaterRoot, "bundle.json");
    const entries = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const script = path.join(updaterRoot, "scripts/settings-update.mjs");
    if (scenario === "missing bundle") fs.rmSync(manifestFile);
    else if (scenario === "invalid JSON") fs.writeFileSync(manifestFile, "{");
    else if (scenario === "empty inventory") fs.writeFileSync(manifestFile, "[]");
    else if (scenario === "duplicate path") fs.writeFileSync(manifestFile, JSON.stringify([...entries, entries[0]]));
    else if (scenario === "escaped path") fs.writeFileSync(manifestFile, JSON.stringify([{ ...entries[0], path: "../outside.mjs" }]));
    else if (scenario === "missing entrypoint") fs.writeFileSync(manifestFile, JSON.stringify(entries.slice(1)));
    else if (scenario === "changed bytes") fs.writeFileSync(script, "throw new Error('altered updater');");
    else if (scenario === "file link") { fs.rmSync(script); fs.symlinkSync(path.join(updaterRoot, "scripts/managed-update.mjs"), script); }
    else if (scenario === "directory link") {
      fs.renameSync(path.join(updaterRoot, "scripts"), path.join(updaterRoot, "linked-scripts"));
      fs.symlinkSync(path.join(updaterRoot, "linked-scripts"), path.join(updaterRoot, "scripts"));
    } else {
      fs.renameSync(manifestFile, `${manifestFile}.original`);
      fs.symlinkSync(`${manifestFile}.original`, manifestFile);
    }
    const { service, execute } = fixture();
    await expect(service.status()).rejects.toMatchObject({ statusCode: 503 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("defaults to main and persists the chosen release cycle across service restarts", async () => {
    const { service, execute, catalog } = fixture();
    expect((await service.preview()).channel).toBe("main");
    expect((await service.selectChannel("releases")).channel).toBe("releases");
    const restarted = new CloudxUpdateService(dataDir, execute, catalog, undefined, undefined, updaterRoot);
    expect((await restarted.preview()).channel).toBe("releases");
    expect(fs.readdirSync(dataDir)).toEqual(["cloudx-update-channel.json"]);
  });

  it("pins the checked release commit when starting the managed installer", async () => {
    const { service, execute } = fixture();
    await service.selectChannel("releases");
    expect(await service.start({ channel: "releases", targetCommit: target })).toEqual({ available: true });
    expect(execute).toHaveBeenLastCalledWith(process.execPath, [
      path.join(updaterRoot, "scripts/settings-update.mjs"), "start", dataDir, String(process.pid), target,
    ], { cwd: path.resolve("."), timeout: 30_000, maxBuffer: 65536, encoding: "utf8",
      env: expect.objectContaining({ CLOUDX_INSTALL_ROOT: path.resolve("."), PATH: process.env.PATH }) });
  });

  it.each(["never checked", "changed target", "changed channel", "changed checkout", "unavailable"])("rejects an unsafe launch: %s", async scenario => {
    const { service, catalog, execute } = fixture();
    const preview = checked();
    if (["ahead", "diverged", "unavailable"].includes(scenario)) preview.state = scenario as CloudxUpdatePreview["state"];
    catalog.preview.mockResolvedValue(preview);
    if (scenario !== "never checked") await service.preview();
    if (scenario === "changed channel") await service.selectChannel("releases");
    if (scenario === "changed checkout") execute.mockImplementation(async file => ({ stdout: file === "git" ? "c".repeat(40) : '{"available":true}' }));
    await expect(service.start({ ...selection, targetCommit: scenario === "changed target" ? "c".repeat(40) : target })).rejects.toMatchObject({ statusCode: 409 });
    expect(execute.mock.calls.some(([, args]) => args[1] === "start")).toBe(false);
  });

  it("allows dependency updates at the checked current commit", async () => {
    const { service, catalog, execute } = fixture();
    catalog.preview.mockResolvedValue({ ...checked(), state: "current", target: { ...checked().target!, commit: installed } });
    await service.preview();
    await service.start({ channel: "main", targetCommit: installed });
    expect(execute.mock.calls.at(-1)![1].at(-1)).toBe(installed);
  });

  it.each(["ahead", "diverged"] as const)("allows a checked %s target through the managed compatibility plan", async state => {
    const { service, catalog, execute } = fixture();
    catalog.preview.mockResolvedValue({ ...checked(), state });
    await service.preview();
    await service.start(selection);
    expect(execute.mock.calls.at(-1)![1].at(-1)).toBe(target);
  });

  it("passes explicit interruption consent with the checked target only", async () => {
    const { service, execute } = fixture();
    await service.preview();
    await service.start({ ...selection, confirmInterruption: true });
    expect(execute.mock.calls.at(-1)![1].slice(-2)).toEqual([target, "--confirm-interruption"]);
  });

  it.each(["failed", "prepared"])("resumes the persisted %s run without a remote or checkout lookup", async state => {
    const { service, execute, catalog } = fixture();
    const id = "11111111-1111-4111-8111-111111111111";
    const status = { available: true, run: { id, state, startedAt: "2026-09-15T00:00:00Z", message: "Resume the saved update.", targetCommit: target, resumable: true } };
    execute.mockResolvedValue({ stdout: JSON.stringify(status) });
    await service.start({ ...selection, resumeRunId: id, confirmInterruption: true });
    expect(execute.mock.calls.at(-1)![1].slice(-3)).toEqual([target, "--confirm-interruption", `--resume=${id}`]);
    expect(execute.mock.calls.some(([file]) => file === "git")).toBe(false);
    expect(catalog.preview).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "target"], ["failed", "identity"], ["failed", "not resumable"],
    ["prepared", "target"], ["prepared", "identity"], ["prepared", "not resumable"],
  ])("rejects a %s resume whose %s differs from the persisted run", async (state, scenario) => {
    const { service, execute } = fixture();
    const id = "11111111-1111-4111-8111-111111111111";
    execute.mockResolvedValue({ stdout: JSON.stringify({ available: true, run: { id, state, startedAt: "2026-09-15T00:00:00Z", message: "Resume the saved update.", targetCommit: target, resumable: scenario !== "not resumable" } }) });
    await expect(service.start({ ...selection, targetCommit: scenario === "target" ? installed : target,
      resumeRunId: scenario === "identity" ? "22222222-2222-4222-8222-222222222222" : id })).rejects.toMatchObject({ statusCode: 409 });
    expect(execute.mock.calls.some(([, args]) => args[1] === "start")).toBe(false);
  });

  it.each(["matching snapshot", "other snapshot", "other target", "no confirmation"])("binds data restoration to the latest recovery notice: %s", async scenario => {
    const { service, execute } = fixture();
    const id = "11111111-1111-4111-8111-111111111111";
    const snapshotId = "22222222-2222-4222-8222-222222222222";
    execute.mockResolvedValue({ stdout: JSON.stringify({ available: true,
      run: { id, state: "failed", startedAt: "2026-09-15T00:00:00Z", message: "Data compatibility requires restoration.", targetCommit: target, resumable: true },
      ...(scenario === "no confirmation" ? {} : { confirmation: { targetCommit: scenario === "other target" ? installed : target,
        message: "Replace active data with the saved snapshot; preserve newer data separately.", restoreSnapshotRunId: snapshotId } }),
    }) });
    const request = { ...selection, resumeRunId: id, restoreSnapshotRunId: scenario === "other snapshot" ? id : snapshotId };
    if (scenario === "matching snapshot") {
      await service.start(request);
      expect(execute.mock.calls.at(-1)![1].slice(-3)).toEqual([target, `--resume=${id}`, `--restore-snapshot=${snapshotId}`]);
    } else {
      await expect(service.start(request)).rejects.toMatchObject({ statusCode: 409 });
      expect(execute.mock.calls.some(([, args]) => args[1] === "start")).toBe(false);
    }
  });

  it("coalesces concurrent remote checks, while an explicit later check refreshes the target", async () => {
    const { service, catalog } = fixture();
    let finish!: (preview: Omit<CloudxUpdatePreview, "runtime">) => void;
    catalog.preview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = service.preview();
    const second = service.preview();
    await vi.waitFor(() => expect(catalog.preview).toHaveBeenCalledOnce());
    finish(checked());
    expect(await first).toEqual(await second);
    await service.preview();
    expect(catalog.preview).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed remote check from authorizing the old target", async () => {
    const { service, catalog } = fixture();
    await service.preview();
    catalog.preview.mockResolvedValue({ ...checked(), state: "unavailable", message: "GitHub rate limit reached." });
    await service.preview();
    await expect(service.start(selection)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("preserves a selected channel when its remote release check is unavailable", async () => {
    const { service, catalog } = fixture();
    catalog.preview.mockImplementation(async (channel, currentCommit) => ({ ...checked(channel, currentCommit), state: "unavailable" }));
    expect((await service.selectChannel("releases")).state).toBe("unavailable");
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "cloudx-update-channel.json"), "utf8"))).toEqual({ channel: "releases" });
  });

  it("rejects a launch when a concurrent refresh invalidates its target during the Git check", async () => {
    const { service, catalog, execute } = fixture();
    await service.preview();
    let finishGit!: (value: { stdout: string }) => void;
    let delayGit = true;
    execute.mockImplementation(async file => {
      if (file === "git" && delayGit) {
        delayGit = false;
        return new Promise(resolve => { finishGit = resolve; });
      }
      return { stdout: file === "git" ? installed : '{"available":true}' };
    });
    const starting = service.start(selection);
    await vi.waitFor(() => expect(finishGit).toBeTypeOf("function"));
    catalog.preview.mockResolvedValue({ ...checked(), state: "unavailable" });
    await service.preview();
    const rejected = expect(starting).rejects.toMatchObject({ statusCode: 409 });
    finishGit({ stdout: installed });
    await rejected;
    expect(execute.mock.calls.some(([, args]) => args[1] === "start")).toBe(false);
  });

  it("does not replace corrupt persisted channel settings with a default", async () => {
    const { service, catalog } = fixture();
    fs.writeFileSync(path.join(dataDir, "cloudx-update-channel.json"), '{"channel":"nightly"}');
    await expect(service.preview()).rejects.toMatchObject({ statusCode: 503 });
    expect(catalog.preview).not.toHaveBeenCalled();
  });

  it("rejects invalid channels and commits before invoking host commands", async () => {
    const { service, execute } = fixture();
    await expect(service.selectChannel("nightly" as CloudxUpdateChannel)).rejects.toThrow("releases or main");
    await expect(service.start({ channel: "main", targetCommit: "--upload-pack=bad" })).rejects.toThrow("checked target commit");
    expect(execute).not.toHaveBeenCalled();
  });

  it("prevents selection changes and duplicate starts during a launch", async () => {
    const { service, execute } = fixture();
    await service.preview();
    let finish!: (value: { stdout: string }) => void;
    execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = service.start(selection);
    await expect(service.selectChannel("releases")).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.start(selection)).rejects.toMatchObject({ statusCode: 409 });
    finish({ stdout: '{"available":true}' });
    await first;
  });

  it("preserves a running job and prevents changing its channel", async () => {
    const { service, execute } = fixture();
    const running = { available: true, run: { id: "running", state: "running", startedAt: "2026-09-15T00:00:00Z", message: "Updating." } };
    execute.mockResolvedValue({ stdout: JSON.stringify(running) });
    expect(await service.start(selection)).toEqual(running);
    await expect(service.selectChannel("releases")).rejects.toMatchObject({ statusCode: 409 });
    expect(fs.existsSync(path.join(dataDir, "cloudx-update-channel.json"))).toBe(false);
  });

  it.each(["invalid JSON", '{"available":"yes"}'])("rejects unverifiable runner output", async stdout => {
    const service = new CloudxUpdateService(dataDir, async () => ({ stdout }), undefined, undefined, undefined, updaterRoot);
    await expect(service.status()).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("could not be verified") });
  });

  it("rejects an unknown local revision without querying GitHub", async () => {
    const { service, execute, catalog } = fixture();
    execute.mockResolvedValue({ stdout: "HEAD" });
    await expect(service.preview()).rejects.toMatchObject({ statusCode: 503 });
    expect(catalog.preview).not.toHaveBeenCalled();
  });

  it("does not disclose subprocess output or attempt a second start when launch is uncertain", async () => {
    const { service, execute } = fixture();
    await service.preview();
    execute.mockImplementation(async (file, args) => {
      if (args[1] === "start") throw new Error("secret from stderr");
      return { stdout: file === "git" ? installed : '{"available":true}' };
    });
    await expect(service.start(selection)).rejects.toMatchObject({ statusCode: 503, message: expect.not.stringContaining("secret") });
    expect(execute.mock.calls.filter(([, args]) => args[1] === "start")).toHaveLength(1);
    expect(await service.status()).toEqual({ available: true });
  });

  it("uses verified installed updater commands for backup inventory, preview, progress and confirmed deletion", async () => {
    const { service, execute, catalog } = fixture();
    execute.mockImplementation(async (_file, args) => ({ stdout: JSON.stringify({
      backups: retained, "backup-preview": reviewed, "backup-cleanup-status": cleaning, "backup-cleanup": cleaning,
    }[args[1] as "backups" | "backup-preview" | "backup-cleanup-status" | "backup-cleanup"]) }));
    expect(await service.backups()).toEqual(retained);
    expect(await service.previewBackupCleanup()).toEqual(reviewed);
    expect(await service.backupCleanupStatus()).toEqual(cleaning);
    expect(await service.cleanBackups({ previewId: backupId, confirmPermanentDeletion: true })).toEqual(cleaning);
    const script = path.join(updaterRoot, "scripts/settings-update.mjs");
    expect(execute.mock.calls.map(([, args]) => args)).toEqual([
      [script, "backups", dataDir, String(process.pid)],
      [script, "backup-preview", dataDir, String(process.pid)],
      [script, "backup-cleanup-status", dataDir, String(process.pid)],
      [script, "backup-cleanup", dataDir, String(process.pid), `--preview=${backupId}`, "--confirm-permanent-deletion"],
    ]);
    expect(execute).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({
      cwd: path.resolve("."), timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: expect.objectContaining({ CLOUDX_INSTALL_ROOT: path.resolve(".") }),
    }));
    expect(catalog.preview).not.toHaveBeenCalled();
  });

  it("preserves absent and terminal cleanup outcomes across server restarts", async () => {
    const { service, execute, catalog } = fixture();
    execute.mockResolvedValueOnce({ stdout: "null" });
    expect(await service.backupCleanupStatus()).toBeNull();
    const completed = { ...cleaning, state: "completed", finishedAt: "2026-10-04T04:01:00Z",
      results: [{ ...cleaning.results[0]!, status: "failed", reason: "Permission denied; remaining data preserved.", deletedLogicalBytes: 1024 }],
      freeSpace: [{ path: "/state", availableBytesBefore: 1024, availableBytesAfter: 1024 }] };
    execute.mockResolvedValue({ stdout: JSON.stringify(completed) });
    const restarted = new CloudxUpdateService(dataDir, execute, catalog, undefined, undefined, updaterRoot);
    expect(await restarted.backupCleanupStatus()).toEqual(completed);
  });

  it.each(["backups", "previewBackupCleanup", "backupCleanupStatus", "cleanBackups"] as const)("rejects invalid installed output from %s", async method => {
    const { service, execute } = fixture();
    for (const stdout of ["invalid JSON", '{"backups":"everything"}']) {
      execute.mockResolvedValue({ stdout });
      await expect(service[method]({ previewId: backupId, confirmPermanentDeletion: true })).rejects.toMatchObject({ statusCode: 503 });
    }
  });

  it.each([false, true])("preserves structured stale-preview errors from a runner that exits unsuccessfully: %s", async unsuccessfulExit => {
    const { service, execute } = fixture();
    const stdout = JSON.stringify({ error: "The reviewed snapshot changed. Review a new preview.", statusCode: 409 });
    if (unsuccessfulExit) execute.mockRejectedValueOnce(Object.assign(new Error("process failed"), { stdout, stderr: "private diagnostic" }));
    else execute.mockResolvedValueOnce({ stdout });
    await expect(service.cleanBackups({ previewId: backupId, confirmPermanentDeletion: true })).rejects.toMatchObject({
      statusCode: 409, message: "The reviewed snapshot changed. Review a new preview.",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not expose unstructured subprocess output or retry uncertain deletion", async () => {
    const { service, execute } = fixture();
    execute.mockRejectedValueOnce(Object.assign(new Error("private diagnostic"), { stdout: "unexpected output", stderr: "private diagnostic" }));
    await expect(service.cleanBackups({ previewId: backupId, confirmPermanentDeletion: true })).rejects.toMatchObject({
      statusCode: 503, message: expect.not.stringContaining("private"),
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not claim a cleanup started when the durable operation is absent", async () => {
    const { service, execute } = fixture();
    execute.mockResolvedValueOnce({ stdout: "null" });
    await expect(service.cleanBackups({ previewId: backupId, confirmPermanentDeletion: true })).rejects.toMatchObject({ statusCode: 503 });
  });

  it("prevents update mutations and duplicate cleanup submissions while a cleanup launch is pending", async () => {
    const { service, execute } = fixture();
    let finish!: (value: { stdout: string }) => void;
    execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = service.cleanBackups({ previewId: backupId, confirmPermanentDeletion: true });
    await expect(service.start(selection)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.selectChannel("releases")).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.previewBackupCleanup()).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.cleanBackups({ previewId: backupId, confirmPermanentDeletion: true })).rejects.toMatchObject({ statusCode: 409 });
    finish({ stdout: JSON.stringify(cleaning) });
    expect(await first).toEqual(cleaning);
    execute.mockResolvedValueOnce({ stdout: JSON.stringify(reviewed) });
    expect(await service.previewBackupCleanup()).toEqual(reviewed);
  });

  it("rejects unconfirmed cleanup input and modified installed coordinator code before host execution", async () => {
    const { service, execute } = fixture();
    await expect(service.cleanBackups({ previewId: "../snapshot", confirmPermanentDeletion: true })).rejects.toThrow("explicitly confirm permanent deletion");
    fs.writeFileSync(path.join(updaterRoot, "scripts/managed-update.mjs"), "modified coordinator");
    await expect(service.backups()).rejects.toMatchObject({ statusCode: 503 });
    await expect(service.cleanBackups({ previewId: backupId, confirmPermanentDeletion: true })).rejects.toMatchObject({ statusCode: 503 });
    expect(execute).not.toHaveBeenCalled();
  });
});
