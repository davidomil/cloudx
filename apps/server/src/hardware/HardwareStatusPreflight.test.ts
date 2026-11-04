import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type { BashScript, HardwareItem, HardwareItemDraft, HardwareMutationResult, HardwareOwner, OperationReceipt } from "@cloudx/shared";
import { PathPolicy } from "../pathPolicy.js";
import { HardwareService } from "./HardwareService.js";

const owner: HardwareOwner = { kind: "user", userId: "local" };
const fixtures: Array<{ root: string; service: HardwareService }> = [];
let sequence = 0;
afterEach(async () => {
  for (const { root, service } of fixtures.splice(0)) { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-status-preflight-"));
  const provider: HardwareTypeProvider<Record<string, never>> = {
    descriptor: { id: "fixture.device", ownerPluginId: "fixture", apiVersion: 1, configVersion: 1, displayName: "Fixture", description: "No device access", configSchema: { type: "object" }, operations: [] },
    parseConfig: () => ({}), inspectEndpoint: async () => ({ resourceKeys: [], ready: true, blockers: [] }),
    describeAccess: () => ({ summary: "Fixture", details: {} }),
    connect: async () => { throw new Error("This test must not open device access."); },
  };
  const service = new HardwareService({ dataDir: root, registry: { values: () => [provider], get: () => provider }, pathPolicy: new PathPolicy([root]) });
  fixtures.push({ root, service }); await service.init();
  const mutate = (action: string, input: Record<string, unknown>) => service.execute(action, { requestId: `preflight-${++sequence}`, ...input }, owner) as Promise<HardwareMutationResult>;
  await mutate("hardware.groups.create", { name: "Lab" });
  await mutate("hardware.statuses.create", { label: "Online", valueType: "boolean" });
  const state = await service.snapshot(owner), definitionId = state.statusDefinitions[0].id;
  const script = (cwd: string): BashScript => ({ source: `printf dispatched > '${path.join(root, "dispatched")}'; printf true`, cwd, timeoutMs: 1000, maxOutputBytes: 4096, credentialRefIds: [] });
  const status = (cwd: string, revision = 1) => ({ revision, definitionId, source: "command" as const, script: script(cwd), maxAgeMs: 60_000, intervalMs: null });
  const draft: HardwareItemDraft = { name: "Target", description: "", enabled: true, physicalResourceId: state.groups[0].id, typeId: provider.descriptor.id, configVersion: 1, config: {}, tagIds: [], notes: "", statuses: [], hooks: {} };
  const create = async (patch: Partial<HardwareItemDraft> = {}) => { await mutate("hardware.items.create", { item: { ...draft, ...patch } }); return (await service.snapshot(owner)).items.at(-1)!.item; };
  const update = (item: HardwareItem, patch: Partial<HardwareItemDraft>) => mutate("hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch });
  const refresh = async (item: HardwareItem) => settled(service, (await mutate("hardware.statuses.refresh", { hardwareId: item.id })).receipt);
  return { root, service, mutate, script, status, create, update, refresh };
}

async function settled(service: HardwareService, receipt: OperationReceipt): Promise<OperationReceipt> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await service.execute("hardware.receipt.get", { requestId: receipt.requestId }, owner) as { receipt: OperationReceipt };
    if (result.receipt.state !== "running") return result.receipt;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Hardware operation did not settle.");
}

describe("Hardware script directory preflight", () => {
  it.each(["create", "update"])("saves root-cwd scripts on %s and runs the status and both hooks in root", async mode => {
    const f = await fixture();
    const script = (name: string) => ({ ...f.script("/"), source: `pwd -P > '${path.join(f.root, name)}'` });
    const patch = { statuses: [{ ...f.status("/"), script: script("status-cwd") }], hooks: { beforeReserve: script("before-reserve-cwd"), onRelease: script("on-release-cwd") } };
    let item: HardwareItem;
    if (mode === "create") item = await f.create(patch);
    else { item = await f.create(); await f.update(item, patch); item = (await f.service.snapshot(owner)).items[0].item; }
    for (const name of ["status-cwd", "before-reserve-cwd", "on-release-cwd"]) await expect(fs.stat(path.join(f.root, name))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.refresh(item)).state).toBe("succeeded");
    expect((await f.service.snapshot(owner)).items[0].observations).toMatchObject([{ state: "known", value: true }]);
    const reserved = await f.mutate("hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Run root-cwd hooks" });
    expect((await settled(f.service, reserved.receipt)).state).toBe("succeeded");
    const claim = (await f.service.snapshot(owner)).reservations[0]; expect(claim.state).toBe("active");
    const released = await f.mutate("hardware.release", { reservationId: claim.reservationId, generation: claim.generation });
    expect((await settled(f.service, released.receipt)).state).toBe("succeeded");
    for (const name of ["status-cwd", "before-reserve-cwd", "on-release-cwd"]) expect(await fs.readFile(path.join(f.root, name), "utf8")).toBe("/\n");
    expect((await f.service.snapshot(owner)).reservations).toEqual([]);
  });

  it.each(["status", "beforeReserve", "onRelease"] as const)("rejects a forbidden %s directory on create and update without executing", async kind => {
    const f = await fixture();
    const patch = kind === "status" ? { statuses: [f.status("/etc")] } : { hooks: { [kind]: f.script("/etc") } };
    await expect(f.create(patch)).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("working directory") });
    expect((await f.service.snapshot(owner)).items).toEqual([]);
    const item = await f.create();
    await expect(f.update(item, patch)).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("working directory") });
    expect((await f.service.snapshot(owner)).items[0].item).toEqual(item);
    await expect(fs.stat(path.join(f.root, "dispatched"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["/./", "//", "/..", "/ ", " /", ".", "../", ""])("does not admit the root alias or relative cwd %j on create or update", async cwd => {
    const f = await fixture(), patch = { statuses: [f.status(cwd)] };
    await expect(f.create(patch)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const item = await f.create();
    await expect(f.update(item, patch)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await f.service.snapshot(owner)).items[0].item).toEqual(item);
    await expect(fs.stat(path.join(f.root, "dispatched"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a workspace symlink to root subject to the custom path policy", async () => {
    const f = await fixture(), cwd = path.join(f.root, "root-link"); await fs.symlink("/", cwd);
    await expect(f.create({ statuses: [f.status(cwd)] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const item = await f.create();
    await expect(f.update(item, { statuses: [f.status(cwd)] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await f.service.snapshot(owner)).items[0].item).toEqual(item);
    await expect(fs.stat(path.join(f.root, "dispatched"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing", "file"])("rejects a %s working directory before saving a status script", async kind => {
    const f = await fixture(), cwd = path.join(f.root, kind);
    if (kind === "file") await fs.writeFile(cwd, "not a directory");
    await expect(f.create({ statuses: [f.status(cwd)] })).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("working directory") });
    const item = await f.create();
    await expect(f.update(item, { statuses: [f.status(cwd)] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await f.service.snapshot(owner)).items[0].item).toEqual(item);
    await expect(fs.stat(path.join(f.root, "dispatched"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails a removed directory without a recovery hold and permits saving a correction", async () => {
    const f = await fixture(), cwd = path.join(f.root, "removed-after-save"); await fs.mkdir(cwd);
    const item = await f.create({ statuses: [f.status(cwd)] }); await fs.rmdir(cwd);
    expect(await f.refresh(item)).toMatchObject({ state: "failed", error: { code: "STATUS_CHECK_FAILED" }, result: { diagnostics: [{ errorCode: "INVALID_INPUT", stderr: expect.stringContaining("working directory"), cleanupConfirmed: true }] } });
    expect((await f.service.snapshot(owner)).checkHolds).toEqual([]);
    await expect(fs.stat(path.join(f.root, "dispatched"))).rejects.toMatchObject({ code: "ENOENT" });
    const corrected = await f.update(item, { statuses: [f.status(f.root, 2)] }); expect(corrected.receipt.state).toBe("succeeded");
    expect(await f.refresh((await f.service.snapshot(owner)).items[0].item)).toMatchObject({ state: "succeeded" });
    expect((await f.service.snapshot(owner)).items[0].observations[0]).toMatchObject({ state: "known", value: true, bindingRevision: 2 });
    expect(await fs.readFile(path.join(f.root, "dispatched"), "utf8")).toBe("dispatched");
  });

  it("rechecks an admitted directory whose target moved outside the allowed roots", async () => {
    const f = await fixture(), cwd = path.join(f.root, "rebound-after-save"); await fs.mkdir(cwd);
    const item = await f.create({ statuses: [f.status(cwd)] }); await fs.rmdir(cwd); await fs.symlink(os.tmpdir(), cwd);
    expect(await f.refresh(item)).toMatchObject({ state: "failed", error: { code: "STATUS_CHECK_FAILED" }, result: { diagnostics: [{ errorCode: "INVALID_INPUT", cleanupConfirmed: true }] } });
    expect((await f.service.snapshot(owner)).checkHolds).toEqual([]);
    await expect(fs.stat(path.join(f.root, "dispatched"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates a fresh successful observation when its next check cannot use the directory", async () => {
    const f = await fixture(), cwd = path.join(f.root, "removed-after-measurement"); await fs.mkdir(cwd);
    const binding = { ...f.status(cwd), requiredForReserve: { equals: true } };
    const item = await f.create({ statuses: [binding] });
    expect(await f.refresh(item)).toMatchObject({ state: "succeeded" });
    expect((await f.service.snapshot(owner)).items[0].availability).toBe("available");
    await fs.rmdir(cwd); await fs.rm(path.join(f.root, "dispatched"));
    expect((await f.refresh(item)).state).toBe("failed");
    const state = await f.service.snapshot(owner);
    expect(state.checkHolds).toEqual([]);
    expect(state.items[0].observations).toMatchObject([{ state: "error", errorCode: "INVALID_INPUT" }]);
    expect(state.items[0].observations[0]).not.toHaveProperty("value");
    expect(state.items[0].availability).toBe("ineligible");
    await expect(fs.stat(path.join(f.root, "dispatched"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps timed-out status effects held for recovery", async () => {
    const f = await fixture();
    const binding = f.status(f.root); binding.script = { ...binding.script, source: "sleep 10", timeoutMs: 100 };
    const item = await f.create({ statuses: [binding] });
    expect(await f.refresh(item)).toMatchObject({ state: "unknown" });
    expect((await f.service.snapshot(owner)).checkHolds).toMatchObject([{ state: "recovery_required" }]);
    await expect(f.update(item, { statuses: [] })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  });

  it.each(["beforeReserve", "onRelease"] as const)("keeps a reservation held when its %s directory is removed after saving", async hook => {
    const f = await fixture(), cwd = path.join(f.root, "removed-hook-directory"); await fs.mkdir(cwd);
    const item = await f.create({ hooks: { [hook]: f.script(cwd) } });
    let result: HardwareMutationResult;
    if (hook === "beforeReserve") {
      await fs.rmdir(cwd);
      result = await f.mutate("hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Test preflight" });
    } else {
      const reserved = await f.mutate("hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Test preflight" });
      await fs.rmdir(cwd);
      result = await f.mutate("hardware.release", { reservationId: reserved.reservation!.reservationId, generation: reserved.reservation!.generation });
    }
    expect(await settled(f.service, result.receipt)).toMatchObject({ state: "failed", error: { code: "HOOK_FAILED" }, result: { diagnostics: { errorCode: "INVALID_INPUT", cleanupConfirmed: true } } });
    expect((await f.service.snapshot(owner)).reservations).toMatchObject([{ state: "recovery_required" }]);
    await expect(fs.stat(path.join(f.root, "dispatched"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
