import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HardwareConnectionCheckContext, HardwareTypeProvider } from "@cloudx/plugin-api";
import type { HardwareConnectionResult, HardwareItem, HardwareMutationResult, HardwareOwner, JsonObject, OperationReceipt, ProviderOutcome, SshConfig } from "@cloudx/shared";
import { HardwareService } from "./HardwareService.js";

const operator: HardwareOwner = { kind: "user", userId: "local" };
const agent: HardwareOwner = { kind: "agent", tabId: "tab", executionId: "execution", providerId: "codex" };
const services: HardwareService[] = [], roots: string[] = [];
let requestSequence = 0;
const completed = <T>(value: T): ProviderOutcome<T> => ({ state: "completed", value });
const config = (host: string): SshConfig => ({ host, port: 22, username: "tester", auth: { kind: "agent" }, connectTimeoutMs: 1000 });

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-connections-")); roots.push(root);
  const close = vi.fn(async () => completed(null));
  const checkConnection = vi.fn(async (_config: SshConfig, context: HardwareConnectionCheckContext): Promise<ProviderOutcome<HardwareConnectionResult>> => {
    context.registerCleanup(close);
    return completed({ online: true, diagnostics: { state: "exited", exitCode: 0 } });
  });
  const connect = vi.fn(async () => { throw new Error("A connection check must not open managed access."); });
  const unavailable = new Set<string>();
  const provider: HardwareTypeProvider<SshConfig> = {
    descriptor: { id: "hardware.ssh", ownerPluginId: "hardware", apiVersion: 1, configVersion: 1, displayName: "SSH", description: "Controlled SSH login", configSchema: { type: "object" }, operations: [] },
    parseConfig(value) { const candidate = value as SshConfig; if (typeof candidate?.host !== "string" || !candidate.host) throw new Error("Choose an SSH host."); return candidate; },
    inspectEndpoint: async candidate => ({ resourceKeys: [`ssh:${candidate.host.toLowerCase()}:${candidate.port}`], ready: !unavailable.has(candidate.host), blockers: unavailable.has(candidate.host) ? ["Local SSH prerequisites unavailable"] : [] }),
    describeAccess: () => ({ summary: "Controlled SSH", details: {} }), connect, checkConnection,
  };
  const registry = { values: () => [provider], get: (id: string) => { if (id !== provider.descriptor.id) throw new Error("Provider missing"); return provider; } };
  const service = new HardwareService({ dataDir: root, registry, ownerState: () => "active" }); services.push(service); await service.init();
  return { root, service, provider, registry, checkConnection, close, connect, unavailable };
}

function mutate(service: HardwareService, action: string, input: Record<string, unknown>, owner = operator) {
  return service.execute(action, { requestId: `connection-${++requestSequence}`, ...input }, owner) as Promise<HardwareMutationResult>;
}

async function addItem(service: HardwareService, host = "first.example", options: { group?: string; enabled?: boolean; config?: SshConfig; hooks?: HardwareItem["hooks"] } = {}) {
  const result = await mutate(service, "hardware.items.create", {
    ...(options.group ? {} : { newGroupName: `Rack ${++requestSequence}` }),
    item: { name: host, description: "", enabled: options.enabled ?? true, physicalResourceId: options.group ?? "", typeId: "hardware.ssh", configVersion: 1, config: options.config ?? config(host), tagIds: [], notes: "", statuses: [], hooks: options.hooks ?? {} },
  });
  return result.receipt.result!.item as unknown as HardwareItem;
}

async function requireScheduledStatus(service: HardwareService, item: HardwareItem, cwd: string) {
  const created = await mutate(service, "hardware.statuses.create", { label: "Required readiness", valueType: "boolean" });
  const definitionId = (created.receipt.result!.statusDefinition as unknown as { id: string }).id;
  const updated = await mutate(service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { statuses: [{ revision: 1, definitionId, source: "command", script: { source: "printf checked >> required-checks; exit 0", cwd, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] }, maxAgeMs: 60_000, intervalMs: 1000, requiredForReserve: { equals: true } }] } });
  return { item: updated.receipt.result!.item as unknown as HardwareItem, definitionId };
}

async function settle(service: HardwareService, receipt: OperationReceipt) {
  let current = receipt;
  await vi.waitFor(async () => {
    current = (await service.execute("hardware.receipt.get", { requestId: receipt.requestId }, operator) as { receipt: OperationReceipt }).receipt;
    expect(current.state).not.toBe("running");
  });
  return current;
}

const check = (service: HardwareService, item: HardwareItem, draft?: SshConfig) => mutate(service, "hardware.connection.check", { hardwareId: item.id, expectedItemRevision: item.revision, ...(draft ? { config: draft } : {}) });
const schedule = (service: HardwareService) => (service as unknown as { checkScheduledStatuses(): Promise<void> }).checkScheduledStatuses();
async function idle(service: HardwareService) { await vi.waitFor(async () => expect((await service.snapshot(operator)).checkHolds).toEqual([])); }
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe("SSH connection checks", () => {
  it("persists the physical-group hold before a login and never runs reservation hooks or opens managed access", async () => {
    const f = await fixture(), started = gate(), finish = gate();
    let savedHold: unknown;
    const item = await addItem(f.service, "first.example", { hooks: { beforeReserve: { source: "touch forbidden-before", cwd: f.root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] }, onRelease: { source: "touch forbidden-release", cwd: f.root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] } } });
    const alias = await addItem(f.service, "alias.example", { group: item.physicalResourceId });
    f.checkConnection.mockImplementationOnce(async (_candidate, context) => {
      context.registerCleanup(f.close);
      const saved = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
      savedHold = saved.checkHolds;
      started.resolve(); await finish.promise; return completed({ online: true });
    });
    const operation = await check(f.service, item); await started.promise;
    expect(savedHold).toMatchObject([{ hardwareId: item.id, connectionCheck: { itemRevision: item.revision }, bindingRevisions: [], resourceKeys: expect.arrayContaining([`physical:${item.physicalResourceId}`, "ssh:first.example:22", "ssh:alias.example:22"]) }]);
    await expect(mutate(f.service, "hardware.reserve", { hardwareId: alias.id, expectedItemRevision: alias.revision, purpose: "Blocked by check" }, agent)).rejects.toMatchObject({ code: "CHECK_IN_PROGRESS" });
    finish.resolve(); expect(await settle(f.service, operation.receipt)).toMatchObject({ state: "succeeded", result: { hardwareId: item.id, draft: false, connectionCheck: { online: true, itemRevision: item.revision } } });
    expect(f.close).toHaveBeenCalledTimes(1); expect(f.connect).not.toHaveBeenCalled();
    expect(f.service.ownerClaims()).toEqual([]); await idle(f.service);
    expect((await fs.readdir(f.root)).filter(name => name.startsWith("forbidden"))).toEqual([]);
  });

  it("replaces a successful saved observation with a confirmed failed login", async () => {
    const f = await fixture(), item = await addItem(f.service);
    await settle(f.service, (await check(f.service, item)).receipt);
    f.checkConnection.mockImplementationOnce(async (_candidate, context) => { context.registerCleanup(f.close); return completed({ online: false, error: { code: "SSH_LOGIN_FAILED", message: "SSH login failed." }, diagnostics: { exitCode: 255 } }); });
    expect(await settle(f.service, (await check(f.service, item)).receipt)).toMatchObject({ state: "succeeded", result: { connectionCheck: { online: false, error: { code: "SSH_LOGIN_FAILED" }, diagnostics: { exitCode: 255 } } } });
    const current = (await f.service.snapshot(operator)).items[0];
    expect(current.connectionCheck).toMatchObject({ online: false, itemRevision: item.revision });
    expect(current.connectionCheck?.diagnostics).toBeUndefined(); expect(current.availability).toBe("available"); await idle(f.service);
  });

  it("retains a known provider failure's diagnostics while leaving the machine available", async () => {
    const f = await fixture(), item = await addItem(f.service);
    const diagnostics = { state: "exited", exitCode: 255, stderr: "Connection refused" };
    f.checkConnection.mockImplementationOnce(async (_candidate, context) => { context.registerCleanup(f.close); return { state: "failed", effects: "none", error: { code: "SSH_CONNECTION_FAILED", message: "SSH failed before remote dispatch." }, diagnostics }; });
    expect(await settle(f.service, (await check(f.service, item)).receipt)).toMatchObject({ state: "failed", error: { code: "SSH_CONNECTION_FAILED" }, result: { connectionCheck: { online: false, diagnostics } } });
    expect((await f.service.snapshot(operator)).items[0]).toMatchObject({ availability: "available", connectionCheck: { online: false, error: { code: "SSH_CONNECTION_FAILED" } } });
    await idle(f.service);
  });

  it("tests changed draft settings without saving them or publishing them as the saved target's status", async () => {
    const f = await fixture(), item = await addItem(f.service);
    await settle(f.service, (await check(f.service, item)).receipt);
    const prior = (await f.service.snapshot(operator)).items[0].connectionCheck;
    const before = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
    const draft = { ...config("replacement.example"), auth: { kind: "password" as const, credentialRefId: "ssh-password-opaque" } };
    const result = await settle(f.service, (await check(f.service, item, draft)).receipt);
    expect(result).toMatchObject({ state: "succeeded", result: { draft: true, connectionCheck: { online: true } } });
    expect(f.checkConnection.mock.calls.at(-1)?.[0]).toEqual(draft);
    const after = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
    expect(after.items).toEqual(before.items); expect(after.endpointKeys).toEqual(before.endpointKeys);
    expect((await f.service.snapshot(operator)).items[0].connectionCheck).toEqual(prior);
  });

  it("holds both old and proposed draft endpoint identities", async () => {
    const f = await fixture(), item = await addItem(f.service), started = gate(), finish = gate();
    f.checkConnection.mockImplementationOnce(async (_candidate, context) => { context.registerCleanup(f.close); started.resolve(); await finish.promise; return completed({ online: true }); });
    const operation = await check(f.service, item, config("replacement.example")); await started.promise;
    expect((await f.service.snapshot(operator)).checkHolds[0].resourceKeys).toEqual(expect.arrayContaining([`physical:${item.physicalResourceId}`, "ssh:first.example:22", "ssh:replacement.example:22"]));
    await expect(addItem(f.service, "replacement.example")).rejects.toMatchObject({ code: "CHECK_IN_PROGRESS" });
    finish.resolve(); await settle(f.service, operation.receipt);
  });

  it("rejects a draft which aliases another physical group even when that group is free", async () => {
    const f = await fixture(), item = await addItem(f.service); await addItem(f.service, "other.example");
    await expect(check(f.service, item, config("other.example"))).rejects.toMatchObject({ code: "ENDPOINT_CONFLICT" });
    expect(f.checkConnection).not.toHaveBeenCalled(); expect((await f.service.snapshot(operator)).checkHolds).toEqual([]);
  });

  it("does not let a changed draft bypass an existing group reservation", async () => {
    const f = await fixture(), item = await addItem(f.service);
    await mutate(f.service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Current work" }, agent);
    await expect(check(f.service, item, config("replacement.example"))).rejects.toMatchObject({ code: "RESERVATION_CONFLICT" });
    expect(f.checkConnection).not.toHaveBeenCalled();
  });

  it("checks every enabled free SSH item by default and does not grow the permanent request index or history", async () => {
    const f = await fixture(), first = await addItem(f.service), second = await addItem(f.service, "second.example");
    const before = await f.service.snapshot(operator);
    await schedule(f.service); await idle(f.service);
    expect(f.checkConnection).toHaveBeenCalledTimes(2);
    for (const item of (await f.service.snapshot(operator)).items) expect(item.connectionCheck).toMatchObject({ online: true, itemRevision: item.item.revision });
    await schedule(f.service); expect(f.checkConnection).toHaveBeenCalledTimes(2);
    expect((await f.service.snapshot(operator)).receipts).toEqual(before.receipts); expect((await f.service.snapshot(operator)).history).toEqual(before.history);
    const state = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
    expect(state.receipts).toHaveLength(before.receipts.length); expect(state.items.map((item: HardwareItem) => item.id)).toEqual([first.id, second.id]);
  });

  it("does not schedule disabled, held, locally unavailable, or explicitly disabled checks", async () => {
    const f = await fixture();
    await addItem(f.service, "disabled.example", { enabled: false });
    await addItem(f.service, "opt-out.example", { config: { ...config("opt-out.example"), onlineCheckIntervalMs: null } });
    await addItem(f.service, "unavailable.example"); f.unavailable.add("unavailable.example");
    const held = await addItem(f.service, "held.example");
    await mutate(f.service, "hardware.reserve", { hardwareId: held.id, expectedItemRevision: held.revision, purpose: "Do not contact" }, agent);
    await schedule(f.service); expect(f.checkConnection).not.toHaveBeenCalled();
  });

  it("includes disabled aliases when detecting a cross-group endpoint conflict", async () => {
    const f = await fixture(), item = await addItem(f.service);
    await addItem(f.service, "disabled-alias.example", { group: item.physicalResourceId, enabled: false });
    await addItem(f.service, "other.example");
    f.provider.inspectEndpoint = async candidate => ({ resourceKeys: [`ssh:${candidate.host === "disabled-alias.example" ? "other.example" : candidate.host}:22`], ready: true, blockers: [] });
    await schedule(f.service); expect(f.checkConnection).not.toHaveBeenCalled();
    await expect(check(f.service, item)).rejects.toMatchObject({ code: "ENDPOINT_CONFLICT" });
  });

  it.each(["before-hold", "after-hold"])("rechecks ordinary capacity during serialized background admission %s", async boundary => {
    const f = await fixture(); await addItem(f.service);
    const before = await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8");
    const capacity = (f.service as unknown as { capacity: { canSchedule(): boolean } }).capacity;
    const admission = vi.spyOn(capacity, "canSchedule").mockReturnValueOnce(true);
    if (boundary === "after-hold") admission.mockReturnValueOnce(true);
    admission.mockReturnValue(false);
    await schedule(f.service);
    expect(admission).toHaveBeenCalledTimes(boundary === "after-hold" ? 3 : 2); expect(f.checkConnection).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8")).toBe(before);
  });

  it("rechecks after the configured interval and expires observations predictably", async () => {
    const f = await fixture(), item = await addItem(f.service, "first.example", { config: { ...config("first.example"), onlineCheckIntervalMs: 1000 } });
    const clock = Date.now(), now = vi.spyOn(Date, "now").mockReturnValue(clock);
    await schedule(f.service); await idle(f.service);
    const observation = (await f.service.snapshot(operator)).items[0].connectionCheck!;
    expect(Date.parse(observation.expiresAt) - Date.parse(observation.checkedAt)).toBe(60_000);
    now.mockReturnValue(clock + 999); await schedule(f.service); expect(f.checkConnection).toHaveBeenCalledTimes(1);
    now.mockReturnValue(clock + 1001); await schedule(f.service); await idle(f.service); expect(f.checkConnection).toHaveBeenCalledTimes(2);
    expect((await f.service.snapshot(operator)).items[0].connectionCheck).toMatchObject({ itemRevision: item.revision });
  });

  it("alternates due command statuses and SSH checks instead of starving either at a one-second cadence", async () => {
    const f = await fixture(), item = await addItem(f.service, "first.example", { config: { ...config("first.example"), onlineCheckIntervalMs: 1000 } });
    const definition = await mutate(f.service, "hardware.statuses.create", { label: "Custom check", valueType: "boolean" });
    const definitionId = (definition.receipt.result!.statusDefinition as unknown as { id: string }).id;
    const updated = await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { statuses: [{ revision: 1, definitionId, source: "command", script: { source: "printf checked >> custom-checks; exit 0", cwd: f.root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [] }, maxAgeMs: 1000, intervalMs: 1000 }] } });
    const revision = (updated.receipt.result!.item as unknown as HardwareItem).revision;
    const clock = Date.now(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock);
    await schedule(f.service); await idle(f.service);
    expect(f.checkConnection).toHaveBeenCalledTimes(1);
    expect((await f.service.snapshot(operator)).items[0]).toMatchObject({ connectionCheck: { itemRevision: revision }, observations: [] });
    vi.setSystemTime(clock + 1000); await schedule(f.service); await idle(f.service);
    expect(f.checkConnection).toHaveBeenCalledTimes(1); expect(await fs.readFile(path.join(f.root, "custom-checks"), "utf8")).toBe("checked");
    vi.setSystemTime(clock + 2000); await schedule(f.service); await idle(f.service);
    expect(f.checkConnection).toHaveBeenCalledTimes(2); expect(await fs.readFile(path.join(f.root, "custom-checks"), "utf8")).toBe("checked");
    vi.setSystemTime(clock + 3000); await schedule(f.service); await idle(f.service);
    expect(f.checkConnection).toHaveBeenCalledTimes(2); expect(await fs.readFile(path.join(f.root, "custom-checks"), "utf8")).toBe("checkedchecked");
  });

  it("makes a later alias's required status eligible despite repeated one-second logins and slow endpoint inspection", async () => {
    const f = await fixture();
    const first = await addItem(f.service, "login.example", { config: { ...config("login.example"), onlineCheckIntervalMs: 1000 } });
    const later = await addItem(f.service, "required.example", { group: first.physicalResourceId, config: { ...config("required.example"), onlineCheckIntervalMs: null } });
    const required = await requireScheduledStatus(f.service, later, f.root);
    expect((await f.service.snapshot(operator)).items.find(summary => summary.item.id === later.id)?.availability).toBe("ineligible");
    const inspectEndpoint = f.provider.inspectEndpoint.bind(f.provider);
    f.provider.inspectEndpoint = async candidate => { await new Promise(resolve => setTimeout(resolve, 300)); return inspectEndpoint(candidate); };
    await vi.waitFor(async () => {
      const saved = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
      expect(saved.observations[later.id]).toContainEqual(expect.objectContaining({ definitionId: required.definitionId, state: "known", value: true }));
      expect(f.checkConnection.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(saved.checkHolds).toEqual([]);
    }, { timeout: 18_000, interval: 50 });
    const reserved = await mutate(f.service, "hardware.reserve", { hardwareId: later.id, expectedItemRevision: required.item.revision, purpose: "Use the ready alias while login monitoring remains enabled" }, agent);
    expect(reserved.reservation).toMatchObject({ hardwareId: later.id, state: "active" });
    expect(await fs.readFile(path.join(f.root, "required-checks"), "utf8")).toContain("checked");
  }, 25_000);

  it("admits one check per physical group per pass even after quick cleanup, while independent groups progress", async () => {
    const f = await fixture();
    clearInterval((f.service as unknown as { scheduler: ReturnType<typeof setInterval> }).scheduler);
    const first = await addItem(f.service, "login.example", { config: { ...config("login.example"), onlineCheckIntervalMs: 1000 } });
    const later = await addItem(f.service, "required.example", { group: first.physicalResourceId, config: { ...config("required.example"), onlineCheckIntervalMs: null } });
    const required = await requireScheduledStatus(f.service, later, f.root);
    await addItem(f.service, "independent.example");
    const checking = f.service as unknown as { checkConnection(input: Record<string, unknown>, owner: HardwareOwner, scheduled?: boolean): Promise<HardwareMutationResult | undefined> };
    const checkConnection = checking.checkConnection.bind(f.service);
    vi.spyOn(checking, "checkConnection").mockImplementation(async (...args) => { const result = await checkConnection(...args); await idle(f.service); return result; });
    const clock = Date.now(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock);
    await schedule(f.service); await idle(f.service);
    expect(f.checkConnection).toHaveBeenCalledTimes(2);
    expect(f.checkConnection.mock.calls.map(([candidate]) => candidate.host).sort()).toEqual(["independent.example", "login.example"]);
    await expect(fs.readFile(path.join(f.root, "required-checks"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    vi.setSystemTime(clock + 1000); await schedule(f.service); await idle(f.service);
    expect((await f.service.snapshot(operator)).items.find(summary => summary.item.id === later.id)).toMatchObject({ availability: "available", observations: [expect.objectContaining({ definitionId: required.definitionId, state: "known", value: true })] });
    expect(f.checkConnection).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(f.root, "required-checks"), "utf8")).toBe("checked");
  });

  it.each(["stale", "agent", "unknown-field", "invalid-config"])("rejects %s input before contacting a machine", async scenario => {
    const f = await fixture(), item = await addItem(f.service);
    const input = { hardwareId: item.id, expectedItemRevision: item.revision + (scenario === "stale" ? 1 : 0), ...(scenario === "unknown-field" ? { password: "must-never-be-accepted" } : {}), ...(scenario === "invalid-config" ? { config: { host: "" } } : {}) };
    await expect(mutate(f.service, "hardware.connection.check", input, scenario === "agent" ? agent : operator)).rejects.toMatchObject({ code: scenario === "stale" ? "REVISION_CONFLICT" : scenario === "agent" ? "FORBIDDEN" : "INVALID_INPUT" });
    expect(f.checkConnection).not.toHaveBeenCalled();
  });

  it("invalidates online status immediately after saved connection settings change", async () => {
    const f = await fixture(), item = await addItem(f.service); await settle(f.service, (await check(f.service, item)).receipt);
    await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { config: config("replacement.example") } });
    expect((await f.service.snapshot(operator)).items[0].connectionCheck).toBeUndefined();
  });

  it("rejects an unavailable connection-check capability before dispatch", async () => {
    const f = await fixture(), item = await addItem(f.service); f.provider.checkConnection = undefined;
    await expect(check(f.service, item)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await schedule(f.service); expect(f.checkConnection).not.toHaveBeenCalled();
  });

  it("keeps a draft result isolated when saved metadata changes during its execution", async () => {
    const f = await fixture(), item = await addItem(f.service), started = gate(), finish = gate();
    f.checkConnection.mockImplementationOnce(async (_candidate, context) => { context.registerCleanup(f.close); started.resolve(); await finish.promise; return completed({ online: true }); });
    const result = await check(f.service, item); await started.promise;
    await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { notes: "New notes" } });
    finish.resolve(); expect((await settle(f.service, result.receipt)).state).toBe("succeeded");
    expect((await f.service.snapshot(operator)).items[0]).toMatchObject({ item: { revision: item.revision + 1, notes: "New notes" } });
    expect((await f.service.snapshot(operator)).items[0].connectionCheck).toBeUndefined();
  });

  it("clears a proven pre-dispatch rejection without requiring a registered closer", async () => {
    const f = await fixture(), item = await addItem(f.service);
    f.checkConnection.mockResolvedValueOnce({ state: "failed", effects: "none", error: { code: "CREDENTIAL_UNAVAILABLE", message: "The saved SSH password is unavailable." } });
    expect(await settle(f.service, (await check(f.service, item)).receipt)).toMatchObject({ state: "failed", result: { connectionCheck: { online: false, error: { code: "CREDENTIAL_UNAVAILABLE" } } } });
    expect(f.close).not.toHaveBeenCalled(); await idle(f.service);
  });

  it.each(["missing-cleanup", "unknown-result", "invalid-result"])("keeps %s held instead of reporting it as an ordinary offline machine", async scenario => {
    const f = await fixture(), item = await addItem(f.service);
    f.checkConnection.mockImplementationOnce(async (_candidate, context) => {
      if (scenario !== "missing-cleanup") context.registerCleanup(f.close);
      return scenario === "unknown-result" ? { state: "unknown", error: { code: "UNCONFIRMED", message: "The provider cannot confirm the check outcome." }, diagnostics: { interrupted: true } }
        : completed(scenario === "invalid-result" ? { online: "yes" } as unknown as HardwareConnectionResult : { online: true });
    });
    expect((await settle(f.service, (await check(f.service, item)).receipt)).state).toBe("unknown");
    expect((await f.service.snapshot(operator)).checkHolds).toMatchObject([{ hardwareId: item.id, state: "recovery_required" }]);
    await schedule(f.service); expect(f.checkConnection).toHaveBeenCalledTimes(1);
  });

  it.each([
    { online: true, error: "invalid" },
    { online: false, error: { code: "x".repeat(129), message: "Too long" } },
    { online: false, error: { code: "FAILED", message: "x".repeat(4097) } },
    { online: true, diagnostics: "invalid" },
    { online: true, diagnostics: { value: Number.POSITIVE_INFINITY } },
  ])("rejects malformed connection output before exposing it in public state: %j", async value => {
    const f = await fixture(), item = await addItem(f.service);
    f.checkConnection.mockImplementationOnce(async (_candidate, context) => { context.registerCleanup(f.close); return completed(value as unknown as HardwareConnectionResult); });
    expect(await settle(f.service, (await check(f.service, item)).receipt)).toMatchObject({ state: "unknown", error: { code: "INVALID_PROVIDER_OUTPUT" }, result: { connectionCheck: { online: false, error: { code: "INVALID_PROVIDER_OUTPUT" } } } });
    expect((await f.service.snapshot(operator)).items[0].connectionCheck?.diagnostics).toBeUndefined();
  });

  it.each(["completed", "failed", "unknown"] as const)("retains %s provider diagnostics when managed cleanup is unconfirmed", async state => {
    const f = await fixture(), item = await addItem(f.service);
    const diagnostics = { state: "exited", exitCode: 255, interrupted: true, stderr: "[redacted]" };
    f.checkConnection.mockImplementationOnce(async (_candidate, context) => { context.registerCleanup(f.close); return state === "completed" ? completed({ online: false, diagnostics }) : state === "failed" ? { state: "failed", effects: "none", error: { code: "SSH_CONNECTION_FAILED", message: "SSH failed before remote dispatch." }, diagnostics } : { state: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "Login outcome unknown." }, diagnostics }; });
    f.close.mockResolvedValue({ state: "unknown", error: { code: "CLEANUP_UNKNOWN", message: "Local exit is unconfirmed." } });
    expect(await settle(f.service, (await check(f.service, item)).receipt)).toMatchObject({ state: "unknown", error: { code: "CLEANUP_UNCONFIRMED" }, result: { connectionCheck: { diagnostics } } });
    expect((await f.service.snapshot(operator)).checkHolds).toMatchObject([{ state: "recovery_required" }]);
  });

  it("prunes deleted-machine observations and gives a manually checked opted-out machine sixty seconds of freshness", async () => {
    const f = await fixture(), item = await addItem(f.service, "first.example", { config: { ...config("first.example"), onlineCheckIntervalMs: null } });
    await settle(f.service, (await check(f.service, item)).receipt);
    const observation = (await f.service.snapshot(operator)).items[0].connectionCheck!;
    expect(Date.parse(observation.expiresAt) - Date.parse(observation.checkedAt)).toBe(60_000);
    await mutate(f.service, "hardware.items.delete", { hardwareId: item.id, expectedItemRevision: item.revision });
    expect((f.service as unknown as { connectionChecks: Map<string, unknown> }).connectionChecks.size).toBe(0);
  });

  it("deduplicates a saved manual test by its exact request payload", async () => {
    const f = await fixture(), item = await addItem(f.service);
    const input = { requestId: "one-manual-check", hardwareId: item.id, expectedItemRevision: item.revision };
    const original = await mutate(f.service, "hardware.connection.check", input); await settle(f.service, original.receipt);
    expect((await mutate(f.service, "hardware.connection.check", input)).receipt.runId).toBe(original.receipt.runId);
    await expect(mutate(f.service, "hardware.connection.check", { ...input, config: config("different.example") })).rejects.toMatchObject({ code: "REQUEST_ID_REUSED" });
    expect(f.checkConnection).toHaveBeenCalledTimes(1);
  });

  it("discards successful runtime observations after a clean restart and checks again", async () => {
    const f = await fixture(), item = await addItem(f.service); await settle(f.service, (await check(f.service, item)).receipt); await f.service.dispose();
    const restored = new HardwareService({ dataDir: f.root, registry: f.registry }); services.push(restored); await restored.init();
    expect((await restored.snapshot(operator)).items[0].connectionCheck).toBeUndefined();
    await schedule(restored); await idle(restored); expect(f.checkConnection).toHaveBeenCalledTimes(2);
  });

  it("keeps unconfirmed managed probe cleanup held, including after restart, without replay", async () => {
    const f = await fixture(), item = await addItem(f.service);
    f.close.mockResolvedValue({ state: "unknown", error: { code: "CLEANUP_UNKNOWN", message: "The local SSH process did not confirm exit." } });
    const result = await settle(f.service, (await check(f.service, item)).receipt);
    expect(result).toMatchObject({ state: "unknown", error: { code: "CLEANUP_UNCONFIRMED" } });
    expect((await f.service.snapshot(operator)).checkHolds).toMatchObject([{ hardwareId: item.id, state: "recovery_required", connectionCheck: { itemRevision: item.revision } }]);
    await f.service.dispose();
    const restored = new HardwareService({ dataDir: f.root, registry: f.registry }); services.push(restored); await restored.init();
    expect((await restored.snapshot(operator)).checkHolds).toMatchObject([{ hardwareId: item.id, state: "recovery_required" }]);
    await schedule(restored); expect(f.checkConnection).toHaveBeenCalledTimes(1); expect((await restored.snapshot(operator)).items[0].connectionCheck).toBeUndefined();
  });

  it.each(["completed", "failed"] as const)("persists an unresolved background hold from a %s check across restart without creating a permanent request receipt", async state => {
    const f = await fixture(), item = await addItem(f.service);
    const diagnostics = { state: "exited", exitCode: state === "completed" ? 0 : 255 };
    if (state === "failed") f.checkConnection.mockImplementationOnce(async (_candidate, context) => { context.registerCleanup(f.close); return { state: "failed", effects: "none", error: { code: "SSH_CONNECTION_FAILED", message: "SSH failed before remote dispatch." }, diagnostics }; });
    const before = (await f.service.snapshot(operator)).receipts;
    f.close.mockResolvedValue({ state: "unknown", error: { code: "CLEANUP_UNKNOWN", message: "Local exit is unconfirmed." } });
    await schedule(f.service);
    await vi.waitFor(async () => expect((await f.service.snapshot(operator)).checkHolds).toMatchObject([{ hardwareId: item.id, state: "recovery_required", connectionCheck: { diagnostics } }]));
    expect((await f.service.snapshot(operator)).receipts).toEqual(before); await f.service.dispose();
    const restored = new HardwareService({ dataDir: f.root, registry: f.registry }); services.push(restored); await restored.init();
    expect((await restored.snapshot(operator)).checkHolds).toMatchObject([{ hardwareId: item.id, state: "recovery_required", connectionCheck: { diagnostics } }]);
    await schedule(restored); expect(f.checkConnection).toHaveBeenCalledTimes(1);
    const hold = (await restored.snapshot(operator)).checkHolds[0];
    const release = await mutate(restored, "hardware.forceRelease", { target: { kind: "system_check", runId: hold.runId, generation: hold.generation }, expectedHoldRevision: hold.revision, reason: "Operator reconciled the prior process", acceptUnresolvedExternalActivity: true });
    expect((await settle(restored, release.receipt)).state).toBe("succeeded"); await idle(restored);
  });

  it("bounds uncertain background diagnostics while preserving useful redacted output", async () => {
    const f = await fixture(); await addItem(f.service);
    f.checkConnection.mockImplementationOnce(async (_candidate, context) => { context.registerCleanup(f.close); return { state: "unknown", error: { code: "LOST_LOGIN", message: "The client did not confirm the login." }, diagnostics: { stdout: "[redacted]".repeat(10_000), exitCode: null } }; });
    await schedule(f.service);
    let diagnostics: JsonObject | undefined;
    await vi.waitFor(async () => { diagnostics = (await f.service.snapshot(operator)).checkHolds[0]?.connectionCheck?.diagnostics; expect(diagnostics).toBeDefined(); });
    expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThanOrEqual(64 * 1024);
    expect(diagnostics).toMatchObject({ truncated: true, preview: expect.stringContaining("[redacted]") });
  });

  it.each(["scheduled", "manual"] as const)("fences an overridden %s probe so its late result cannot update a replacement owner", async mode => {
    const f = await fixture(), item = await addItem(f.service), started = gate(), finish = gate();
    const diagnostics = { state: "exited", exitCode: null, signal: "SIGTERM", interrupted: true };
    f.checkConnection.mockImplementationOnce(async (_candidate, context) => { context.registerCleanup(f.close); started.resolve(); await finish.promise; return { state: "unknown", error: { code: "CANCELLED", message: "The check was cancelled." }, diagnostics }; });
    const manual = mode === "manual" ? await check(f.service, item) : undefined;
    if (!manual) await schedule(f.service); await started.promise;
    const hold = (await f.service.snapshot(operator)).checkHolds[0];
    const override = await mutate(f.service, "hardware.forceRelease", { target: { kind: "system_check", runId: hold.runId, generation: hold.generation }, expectedHoldRevision: hold.revision, reason: "Cancel this connection check", acceptUnresolvedExternalActivity: true });
    finish.resolve(); expect((await settle(f.service, override.receipt)).state).toBe("succeeded");
    if (manual) expect(await settle(f.service, manual.receipt)).toMatchObject({ state: "unknown", result: { connectionCheck: { diagnostics } } });
    const replacement = await mutate(f.service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Replacement work" }, agent);
    expect((await f.service.snapshot(operator)).items[0].connectionCheck).toBeUndefined();
    expect(f.service.ownerClaims()).toMatchObject([{ reservationId: replacement.reservation!.reservationId, generation: replacement.reservation!.generation, owner: agent, state: "active" }]);
  });
});
