import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxUpdateChannel, CloudxUpdatePreview } from "@cloudx/shared";
import { CloudxUpdateService } from "./CloudxUpdateService.js";

const installed = "a".repeat(40);
const target = "b".repeat(40);
const selection = { channel: "main" as const, targetCommit: target };
const checked = (channel: CloudxUpdateChannel = "main", currentCommit = installed): CloudxUpdatePreview => ({
  channel, currentCommit, checkedAt: "2026-09-15T00:00:00Z", state: "available",
  target: { commit: target, name: "main", url: `https://github.com/davidomil/cloudx/commit/${target}` },
  changelog: [], changelogComplete: true,
});

describe("CloudxUpdateService", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-update-service-")); });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  function fixture() {
    const execute = vi.fn(async (file: string, _args: string[]) => ({ stdout: file === "git" ? installed : '{"available":true}' }));
    const catalog = { preview: vi.fn(async (channel: CloudxUpdateChannel, currentCommit: string) => checked(channel, currentCommit)) };
    const service = new CloudxUpdateService(dataDir, execute, catalog);
    return { execute, catalog, service };
  }

  it("keeps local run monitoring independent of remote release lookup", async () => {
    const { service, execute, catalog } = fixture();
    expect(await service.status()).toEqual({ available: true });
    expect(execute).toHaveBeenCalledWith(process.execPath, [
      path.resolve("scripts/settings-update.mjs"), "status", dataDir, String(process.pid),
    ], { cwd: path.resolve("."), timeout: 30_000, maxBuffer: 65536, encoding: "utf8" });
    expect(catalog.preview).not.toHaveBeenCalled();
  });

  it("uses the installed checkout when managed build modules live in a separate release directory", async () => {
    vi.stubEnv("CLOUDX_INSTALL_ROOT", dataDir);
    try {
      const { service, execute } = fixture();
      await service.status();
      expect(execute).toHaveBeenCalledWith(process.execPath, [path.join(dataDir, "scripts/settings-update.mjs"), "status", dataDir, String(process.pid)],
        { cwd: dataDir, timeout: 30_000, maxBuffer: 65536, encoding: "utf8" });
      await service.preview();
      expect(execute).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], expect.objectContaining({ cwd: dataDir }));
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects a relative installed-checkout setting", () => {
    vi.stubEnv("CLOUDX_INSTALL_ROOT", "relative/path");
    try { expect(() => fixture()).toThrow("absolute checkout path"); }
    finally { vi.unstubAllEnvs(); }
  });

  it("keeps status and the next update on the independent coordinator after a downgrade", async () => {
    const coordinator = path.join(dataDir, "retained-coordinator");
    vi.stubEnv("CLOUDX_INSTALL_ROOT", dataDir);
    vi.stubEnv("CLOUDX_UPDATE_COORDINATOR_ROOT", coordinator);
    try {
      const { service, execute } = fixture();
      await service.status();
      await service.preview();
      await service.start({ channel: "main", targetCommit: target });
      const calls = execute.mock.calls.filter(([file]) => file === process.execPath);
      expect(calls.every(([, args]) => args[0] === path.join(coordinator, "scripts/settings-update.mjs"))).toBe(true);
      expect(calls.at(-1)?.[1]).toEqual([path.join(coordinator, "scripts/settings-update.mjs"), "start", dataDir, String(process.pid), target]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects a relative coordinator setting", () => {
    vi.stubEnv("CLOUDX_UPDATE_COORDINATOR_ROOT", "relative/coordinator");
    try { expect(() => fixture()).toThrow("absolute coordinator path"); }
    finally { vi.unstubAllEnvs(); }
  });

  it("defaults to main and persists the chosen release cycle across service restarts", async () => {
    const { service, execute, catalog } = fixture();
    expect((await service.preview()).channel).toBe("main");
    expect((await service.selectChannel("releases")).channel).toBe("releases");
    const restarted = new CloudxUpdateService(dataDir, execute, catalog);
    expect((await restarted.preview()).channel).toBe("releases");
    expect(fs.readdirSync(dataDir)).toEqual(["cloudx-update-channel.json"]);
  });

  it("pins the checked release commit when starting the managed installer", async () => {
    const { service, execute } = fixture();
    await service.selectChannel("releases");
    expect(await service.start({ channel: "releases", targetCommit: target })).toEqual({ available: true });
    expect(execute).toHaveBeenLastCalledWith(process.execPath, [
      path.resolve("scripts/settings-update.mjs"), "start", dataDir, String(process.pid), target,
    ], { cwd: path.resolve("."), timeout: 30_000, maxBuffer: 65536, encoding: "utf8" });
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
    let finish!: (preview: CloudxUpdatePreview) => void;
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
    const service = new CloudxUpdateService(dataDir, async () => ({ stdout }));
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
});
