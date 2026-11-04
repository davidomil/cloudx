import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HardwareAccessContext, HardwareTypeProvider } from "@cloudx/plugin-api";
import type { HardwareMutationResult, HardwareOwner, JsonObject, OperationReceipt, ProviderOutcome } from "@cloudx/shared";
import { HardwareService } from "./HardwareService.js";
import { PathPolicy } from "../pathPolicy.js";

const user: HardwareOwner = { kind: "user", userId: "local" };
const agent: HardwareOwner = { kind: "agent", providerId: "codex", tabId: "tab", executionId: "execution" };
const roots: string[] = [], services: HardwareService[] = [];
let sequence = 0;
const requestId = () => `registration-${++sequence}`;
const credentialRefId = "ssh-registration-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
afterEach(async () => { vi.restoreAllMocks(); await Promise.allSettled(services.splice(0).map(service => service.dispose())); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const completed = (): ProviderOutcome<null> => ({ state: "completed", value: null });
async function settled(service: HardwareService, receipt: OperationReceipt) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await service.execute("hardware.receipt.get", { requestId: receipt.requestId }, user) as { receipt: OperationReceipt };
    if (result.receipt.state !== "running") return result.receipt;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("SSH registration did not settle.");
}
const mutate = (service: HardwareService, action: string, input: Record<string, unknown>, owner: HardwareOwner = user) => service.execute(action, { requestId: requestId(), ...input }, owner) as Promise<HardwareMutationResult>;

type RegisterKey = NonNullable<HardwareTypeProvider<JsonObject>["registerKey"]>;
async function fixture(options: { owner?: HardwareOwner; typeId?: string; registerKey?: RegisterKey; missingMethod?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-registration-")); roots.push(root);
  const trace: string[] = [], discardCredential = vi.fn(async (_id: string) => { trace.push("discarded"); });
  const resolveCredential = vi.fn(async () => "private-password");
  const close = vi.fn(async () => { trace.push("closed"); return completed(); });
  const registerKey = vi.fn<RegisterKey>(options.registerKey ?? (async (_config, _input, context) => { context.registerCleanup(close); trace.push("registered"); return { state: "completed", value: { registered: true } }; }));
  const connect = vi.fn<HardwareTypeProvider<JsonObject>["connect"]>(async (_config, context) => { context.registerCleanup(async () => completed()); return { state: "completed", value: { close: async () => completed(), invoke: async () => ({ state: "completed", value: {} }) } }; });
  const provider: HardwareTypeProvider<JsonObject> = { descriptor: { id: options.typeId ?? "hardware.ssh", ownerPluginId: "hardware", apiVersion: 1, configVersion: 1, displayName: "SSH fixture", description: "Controlled key registration", configSchema: { type: "object" }, operations: [] }, parseConfig: value => value as JsonObject, inspectEndpoint: async () => ({ resourceKeys: ["ssh:fixture"], ready: true, blockers: [] }), describeAccess: () => ({ summary: "SSH fixture", details: {} }), connect, ...(!options.missingMethod ? { registerKey } : {}) };
  const registry = { values: () => [provider], get: () => provider };
  const service = new HardwareService({ dataDir: root, registry, pathPolicy: new PathPolicy([root]), ownerState: () => "active", resolveCredential, discardCredential }); services.push(service); await service.init();
  const group = await mutate(service, "hardware.groups.create", { name: "Target" });
  const groupId = (group.receipt.result!.group as JsonObject).id;
  await mutate(service, "hardware.items.create", { item: { name: "SSH target", description: "", enabled: true, physicalResourceId: groupId, typeId: provider.descriptor.id, configVersion: 1, config: {}, tagIds: [], notes: "", statuses: [], hooks: {} } });
  const item = (await service.snapshot(user)).items[0].item;
  const reserved = await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Register the public key" }, options.owner ?? user);
  const claim = reserved.reservation!, ref = { reservationId: claim.reservationId, generation: claim.generation };
  return { root, service, registry, provider, registerKey, connect, close, trace, discardCredential, resolveCredential, ref };
}

describe("SSH key registration before managed access", () => {
  it("persists admission, registers before connect, drains cleanup, and deduplicates the original request", async () => {
    const f = await fixture();
    f.registerKey.mockImplementation(async (_config, input, context) => {
      const disk = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
      expect(disk.receipts.at(-1).receipt.state).toBe("running"); expect(disk.reservations[0].activeOperationIds).toContain(disk.receipts.at(-1).receipt.runId);
      context.registerCleanup(f.close); expect(await context.resolveCredential(String(input.credentialRefId))).toBe("private-password");
      f.trace.push("registered"); return { state: "completed", value: { registered: true } };
    });
    const input = { requestId: requestId(), ...f.ref, timeoutMs: 1000, credentialRefId };
    const result = await f.service.execute("hardware.ssh.registerKey", input, user) as HardwareMutationResult;
    expect(await settled(f.service, result.receipt)).toMatchObject({ state: "succeeded", result: { registered: true } });
    await vi.waitFor(() => expect(f.discardCredential).toHaveBeenCalledWith(credentialRefId));
    expect(f.trace).toEqual(["registered", "closed", "discarded"]); expect(f.connect).not.toHaveBeenCalled();
    expect(f.registerKey.mock.calls[0][1]).toEqual({ timeoutMs: 1000, credentialRefId });
    const replay = await f.service.execute("hardware.ssh.registerKey", input, user) as HardwareMutationResult;
    expect(replay.receipt.runId).toBe(result.receipt.runId); expect(f.registerKey).toHaveBeenCalledTimes(1); expect(f.discardCredential).toHaveBeenCalledTimes(1);
    expect(f.service.ownerClaims()[0]).toMatchObject({ state: "active", accessState: "closed" });
    expect(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8")).not.toContain("private-password");
  });

  it.each(["agent", "foreign", "stale", "open", "missing", "non-ssh"])("rejects %s registration without provider dispatch or credential deletion", async scenario => {
    const f = await fixture({ owner: scenario === "agent" ? agent : user, missingMethod: scenario === "missing", typeId: scenario === "non-ssh" ? "hardware.uart" : undefined });
    if (scenario === "open") await settled(f.service, (await mutate(f.service, "hardware.access.open", f.ref)).receipt);
    const before = await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8");
    const owner = scenario === "agent" ? agent : scenario === "foreign" ? { kind: "user" as const, userId: "another" } : user;
    await expect(mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, generation: f.ref.generation + (scenario === "stale" ? 1 : 0), timeoutMs: 1000, credentialRefId }, owner)).rejects.toMatchObject({ code: { agent: "FORBIDDEN", foreign: "OWNER_CHANGED", stale: "STALE_RESERVATION", open: "INVALID_PHASE", missing: "INVALID_INPUT", "non-ssh": "INVALID_INPUT" }[scenario] });
    expect(f.registerKey).not.toHaveBeenCalled(); expect(f.discardCredential).not.toHaveBeenCalled(); expect(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8")).toBe(before);
  });

  it.each([{ timeoutMs: 0 }, { timeoutMs: 3_600_001 }, { timeoutMs: "1000" }, { password: "must-not-be-an-action-field" }, { credentialRefId: "untrusted-reference" }])("rejects invalid action fields %j before admission", async invalid => {
    const f = await fixture();
    await expect(mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId, ...invalid })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(f.registerKey).not.toHaveBeenCalled(); expect(f.discardCredential).not.toHaveBeenCalled();
  });

  it("keeps a changed endpoint held without registering or deleting credentials", async () => {
    const f = await fixture(); f.provider.inspectEndpoint = async () => ({ resourceKeys: ["ssh:changed"], ready: true, blockers: [] });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId });
    expect(result.receipt.state).toBe("unknown"); expect(f.service.ownerClaims()[0].state).toBe("recovery_required");
    expect(f.registerKey).not.toHaveBeenCalled(); expect(f.discardCredential).not.toHaveBeenCalled();
  });

  it("rechecks endpoint identity immediately before dispatch and settles the accepted request without effects", async () => {
    const f = await fixture(); let inspections = 0;
    f.provider.inspectEndpoint = async () => ({ resourceKeys: [++inspections === 1 ? "ssh:fixture" : "ssh:changed"], ready: true, blockers: [] });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId });
    expect((await settled(f.service, result.receipt)).state).toBe("unknown"); expect(f.registerKey).not.toHaveBeenCalled();
    expect(f.service.ownerClaims()[0]).toMatchObject({ state: "recovery_required", accessState: "closed" });
    await vi.waitFor(() => expect(f.discardCredential).toHaveBeenCalledTimes(1));
  });

  it("times out a dispatched registration, confirms cleanup, and keeps the remote outcome held", async () => {
    const f = await fixture();
    f.registerKey.mockImplementation(async (_config, _input, context) => {
      context.registerCleanup(f.close);
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { state: "unknown", error: { code: "DEADLINE", message: "Registration result unknown." } };
    });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 5, credentialRefId });
    expect((await settled(f.service, result.receipt)).state).toBe("unknown"); expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.service.ownerClaims()[0]).toMatchObject({ state: "recovery_required", accessState: "closed" });
    await vi.waitFor(() => expect(f.discardCredential).toHaveBeenCalledTimes(1));
  });

  it("requires managed cleanup even when the provider claims registration succeeded", async () => {
    const f = await fixture(); f.registerKey.mockResolvedValueOnce({ state: "completed", value: { registered: true } });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId });
    expect(await settled(f.service, result.receipt)).toMatchObject({ state: "unknown", error: { code: "CLEANUP_UNCONFIRMED" } });
    expect(f.service.ownerClaims()[0]).toMatchObject({ state: "recovery_required", accessState: "unknown" }); expect(f.discardCredential).not.toHaveBeenCalled();
  });

  it("preserves cleanup registered by an earlier rejected connection attempt", async () => {
    const f = await fixture(), priorCleanup = vi.fn(async () => completed());
    f.connect.mockImplementationOnce(async (_config, context) => { context.registerCleanup(priorCleanup); return { state: "failed", effects: "none", error: { code: "AUTH_REJECTED", message: "Authentication was rejected." } }; });
    const opened = await mutate(f.service, "hardware.access.open", f.ref); expect((await settled(f.service, opened.receipt)).state).toBe("failed");
    expect(f.service.ownerClaims()[0]).toMatchObject({ state: "active", accessState: "closed" });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId });
    expect((await settled(f.service, result.receipt)).state).toBe("succeeded"); expect(priorCleanup).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(f.discardCredential).toHaveBeenCalledTimes(1));
  });

  it("requires registration's own cleanup even when an earlier connection registered a closer", async () => {
    const f = await fixture(), priorCleanup = vi.fn(async () => completed());
    f.connect.mockImplementationOnce(async (_config, context) => { context.registerCleanup(priorCleanup); return { state: "failed", effects: "none", error: { code: "AUTH_REJECTED", message: "Authentication was rejected." } }; });
    await settled(f.service, (await mutate(f.service, "hardware.access.open", f.ref)).receipt);
    f.registerKey.mockResolvedValueOnce({ state: "completed", value: { registered: true } });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId });
    expect((await settled(f.service, result.receipt)).state).toBe("unknown"); expect(priorCleanup).toHaveBeenCalledTimes(1);
    expect(f.service.ownerClaims()[0]).toMatchObject({ state: "recovery_required", accessState: "unknown" }); expect(f.discardCredential).not.toHaveBeenCalled();
  });

  it("does not discard until the actual provider promise settles after bounded timeout and confirmed cleanup", async () => {
    const f = await fixture(), finish = gate();
    f.registerKey.mockImplementation(async (_config, _input, context) => { context.registerCleanup(f.close); await finish.promise; return { state: "unknown", error: { code: "LOST", message: "Registration reply missing." } }; });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 5, credentialRefId });
    expect((await settled(f.service, result.receipt)).state).toBe("unknown"); expect(f.close).toHaveBeenCalledTimes(1); expect(f.discardCredential).not.toHaveBeenCalled();
    finish.resolve(); await vi.waitFor(() => expect(f.discardCredential).toHaveBeenCalledTimes(1));
  });

  it("keeps a proven no-effect rejection active and discards its quiescent temporary credential", async () => {
    const f = await fixture(); f.registerKey.mockResolvedValueOnce({ state: "failed", effects: "none", error: { code: "CREDENTIAL_UNAVAILABLE", message: "The selected credential is unavailable." } });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId });
    expect(await settled(f.service, result.receipt)).toMatchObject({ state: "failed", error: { code: "CREDENTIAL_UNAVAILABLE" } });
    expect(f.service.ownerClaims()[0]).toMatchObject({ state: "active", accessState: "closed" }); expect(f.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.discardCredential).toHaveBeenCalledTimes(1));
  });

  it("drains registered cleanup before the reservation release lane can finish", async () => {
    const f = await fixture(), started = gate(), cleaning = gate(), finish = gate();
    f.registerKey.mockImplementation(async (_config, _input, context) => {
      context.registerCleanup(async () => { cleaning.resolve(); await finish.promise; return completed(); }); started.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true })); await finish.promise;
      return { state: "unknown", error: { code: "INTERRUPTED", message: "Registration outcome unknown." } };
    });
    const registration = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId }); await started.promise;
    const release = await mutate(f.service, "hardware.release", f.ref); await cleaning.promise;
    const pending = await f.service.execute("hardware.receipt.get", { requestId: release.receipt.requestId }, user) as { receipt: OperationReceipt };
    expect(pending.receipt.state).toBe("running"); expect(f.discardCredential).not.toHaveBeenCalled(); finish.resolve();
    expect((await settled(f.service, registration.receipt)).state).toBe("unknown"); expect((await settled(f.service, release.receipt)).state).toBe("unknown");
    expect(f.service.ownerClaims()[0].state).toBe("recovery_required"); await vi.waitFor(() => expect(f.discardCredential).toHaveBeenCalledTimes(1));
  });

  it("preserves persistent password references and preserves the remote outcome when transient discard fails", async () => {
    const f = await fixture();
    const persistent = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId: "ssh-password-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect((await settled(f.service, persistent.receipt)).state).toBe("succeeded"); expect(f.discardCredential).not.toHaveBeenCalled();
    f.discardCredential.mockRejectedValueOnce(new Error("Private storage deletion failed"));
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId });
    expect((await settled(f.service, result.receipt)).state).toBe("succeeded");
    await vi.waitFor(async () => expect((await f.service.snapshot(user)).history.some(event => event.kind === "credential_discard_failed")).toBe(true));
    expect(f.service.ownerClaims()[0].state).toBe("active");
  });

  it("retains an unknown outcome and waits for provider cleanup before deleting a one-time credential", async () => {
    const f = await fixture(), started = gate(), quiesced = gate(), cleaning = gate();
    f.registerKey.mockImplementation(async (_config, _input, context) => {
      context.registerCleanup(async () => { cleaning.resolve(); await quiesced.promise; f.trace.push("closed"); return completed(); }); started.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true })); await quiesced.promise;
      return { state: "unknown", error: { code: "INTERRUPTED", message: "Remote registration completion is unknown." } };
    });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId }); await started.promise;
    await f.service.ownerUnknown(user, "Owner no longer confirmed"); await cleaning.promise;
    expect(f.discardCredential).not.toHaveBeenCalled(); quiesced.resolve();
    expect((await settled(f.service, result.receipt)).state).toBe("unknown");
    await vi.waitFor(() => expect(f.discardCredential).toHaveBeenCalledTimes(1)); expect(f.trace).toEqual(["closed", "discarded"]);
    expect(f.service.ownerClaims()[0].state).toBe("recovery_required");
  });

  it("retains cleanup and the original receipt when an override fences the registration generation", async () => {
    const f = await fixture(), started = gate();
    f.registerKey.mockImplementation(async (_config, _input, context) => {
      context.registerCleanup(f.close); started.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { state: "unknown", error: { code: "INTERRUPTED", message: "Registration outcome unknown." } };
    });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId }); await started.promise;
    const claim = f.service.ownerClaims()[0];
    const override = await mutate(f.service, "hardware.forceRelease", { target: { kind: "reservation", ...f.ref }, expectedHoldRevision: claim.revision, reason: "Inspect remote key state", acceptUnresolvedExternalActivity: false });
    expect((await settled(f.service, result.receipt)).state).toBe("unknown"); expect((await settled(f.service, override.receipt)).state).toBe("unknown");
    await vi.waitFor(() => expect(f.discardCredential).toHaveBeenCalledTimes(1)); expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.service.ownerClaims()[0]).toMatchObject({ state: "recovery_required", generation: f.ref.generation + 1 });
  });

  it("restores an admitted registration as unknown without replay or guessed credential deletion", async () => {
    const f = await fixture(), started = gate(), finish = gate();
    f.registerKey.mockImplementation(async (_config, _input, context) => { context.registerCleanup(f.close); started.resolve(); await finish.promise; return { state: "unknown", error: { code: "LOST", message: "Registration reply missing." } }; });
    const result = await mutate(f.service, "hardware.ssh.registerKey", { ...f.ref, timeoutMs: 1000, credentialRefId }); await started.promise;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-registration-restore-")); roots.push(root); await fs.mkdir(path.join(root, "hardware"));
    await fs.copyFile(path.join(f.root, "hardware/state.json"), path.join(root, "hardware/state.json"));
    const discardCredential = vi.fn(), restored = new HardwareService({ dataDir: root, registry: f.registry, ownerState: () => "active", discardCredential }); services.push(restored); await restored.init();
    const receipt = await restored.execute("hardware.receipt.get", { requestId: result.receipt.requestId }, user) as { receipt: OperationReceipt };
    expect(receipt.receipt.state).toBe("unknown"); expect(restored.ownerClaims()[0].state).toBe("recovery_required"); expect(f.registerKey).toHaveBeenCalledTimes(1); expect(discardCredential).not.toHaveBeenCalled(); finish.resolve();
  });
});
