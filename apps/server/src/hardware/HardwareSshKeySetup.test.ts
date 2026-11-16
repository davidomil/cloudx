import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HardwareConnectionCheckContext, HardwareTypeProvider } from "@cloudx/plugin-api";
import type { HardwareItem, HardwareMutationResult, HardwareOwner, JsonObject, OperationReceipt, ProviderOutcome, SshConfig } from "@cloudx/shared";
import { HardwareService } from "./HardwareService.js";
import { HardwareStore } from "./HardwareStore.js";
import { ConfigSecretStore } from "../configSecretStore.js";
import { HardwareSshPasswords } from "./HardwareSshPasswords.js";

const user: HardwareOwner = { kind: "user", userId: "local" };
const agent: HardwareOwner = { kind: "agent", tabId: "tab", executionId: "execution", providerId: "codex" };
const roots: string[] = [], services: HardwareService[] = [];
const completed = <T>(value: T): ProviderOutcome<T> => ({ state: "completed", value });
const config = (host: string): SshConfig => ({ host, port: 22, username: "tester", auth: { kind: "agent" }, connectTimeoutMs: 1000 });
const passwordRef = () => `ssh-registration-${randomUUID()}`;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-key-setup-")); roots.push(root);
  const close = vi.fn(async () => completed(null));
  const identity = path.join(root, "identity");
  const setupKey = vi.fn(async (candidate: SshConfig, _input: JsonObject, context: HardwareConnectionCheckContext): Promise<ProviderOutcome<JsonObject>> => {
    context.registerCleanup(close);
    return completed({ config: { ...candidate, auth: { kind: "identity_file", path: identity } }, connectionCheck: { online: true, diagnostics: { exitCode: 0 } } } as unknown as JsonObject);
  });
  const checkConnection = vi.fn(async () => completed({ online: true }));
  const provider: HardwareTypeProvider<SshConfig> = {
    descriptor: { id: "hardware.ssh", ownerPluginId: "hardware", apiVersion: 1, configVersion: 1, displayName: "SSH", description: "Controlled setup", configSchema: { type: "object" }, operations: [] },
    parseConfig: value => value as SshConfig,
    inspectEndpoint: async value => ({ ready: true, blockers: [], resourceKeys: [`ssh:${value.host}:${value.port}`] }),
    describeAccess: () => ({ summary: "SSH", details: {} }),
    connect: async () => { throw new Error("Key setup must not open managed access."); }, setupKey, checkConnection,
  };
  const registry = { values: () => [provider], get: () => provider };
  const discardCredential = vi.fn(async (_id: string) => {}), discardSavedPassword = vi.fn(async (_id: string) => {});
  const options = { dataDir: root, registry, resolveCredential: vi.fn(async (_id: string) => "private one-time value"), discardCredential, discardSavedPassword, ownerState: () => "active" as const };
  const service = new HardwareService(options); services.push(service); await service.init();
  return { root, identity, service, provider, registry, options, setupKey, checkConnection, close, discardCredential, discardSavedPassword };
}

const mutate = (service: HardwareService, action: string, input: Record<string, unknown>, owner: HardwareOwner = user) => service.execute(action, { requestId: randomUUID(), ...input }, owner) as Promise<HardwareMutationResult>;
async function addItem(service: HardwareService, host = "saved.example", group?: string, auth?: SshConfig["auth"]) {
  const value = config(host);
  if (auth) value.auth = auth;
  const result = await mutate(service, "hardware.items.create", { ...(group ? {} : { newGroupName: randomUUID() }), item: {
    name: host, description: "", enabled: true, physicalResourceId: group ?? "", typeId: "hardware.ssh", configVersion: 1, config: value, tagIds: [], notes: "", statuses: [], hooks: {},
  } });
  return result.receipt.result!.item as unknown as HardwareItem;
}
const setup = (service: HardwareService, item: HardwareItem, extra: Record<string, unknown> = {}, owner: HardwareOwner = user) => mutate(service, "hardware.ssh.setupKey", { hardwareId: item.id, expectedItemRevision: item.revision, config: item.config, credentialRefId: passwordRef(), timeoutMs: 1000, ...extra }, owner);
async function settled(service: HardwareService, receipt: OperationReceipt) {
  let current = receipt;
  await vi.waitFor(async () => {
    current = (await service.execute("hardware.receipt.get", { requestId: receipt.requestId }, user) as { receipt: OperationReceipt }).receipt;
    expect(current.state).not.toBe("running");
  });
  return current;
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe("SSH key setup for edited machines", () => {
  it("holds saved and proposed aliases before setup, returns a verified draft, and never saves the machine implicitly", async () => {
    const f = await fixture(), item = await addItem(f.service), alias = await addItem(f.service, "alias.example", item.physicalResourceId);
    const start = gate(), finish = gate(), reference = passwordRef();
    f.setupKey.mockImplementationOnce(async (candidate, input, context) => {
      context.registerCleanup(f.close);
      const stored = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
      expect(stored.checkHolds).toMatchObject([{ hardwareId: item.id, resourceKeys: expect.arrayContaining([`physical:${item.physicalResourceId}`, "ssh:saved.example:22", "ssh:alias.example:22", "ssh:draft.example:22"]) }]);
      expect(input).toEqual({ hardwareId: item.id, credentialRefId: reference, timeoutMs: 1000 });
      expect(await context.resolveCredential(reference)).toBe("private one-time value");
      start.resolve(); await finish.promise;
      return completed({ config: { ...candidate, auth: { kind: "identity_file", path: f.identity } }, connectionCheck: { online: true } } as unknown as JsonObject);
    });
    try {
      const result = await setup(f.service, item, { config: config("draft.example"), credentialRefId: reference }); await start.promise;
      await expect(mutate(f.service, "hardware.reserve", { hardwareId: alias.id, expectedItemRevision: alias.revision, purpose: "Must wait" }, agent)).rejects.toMatchObject({ code: "CHECK_IN_PROGRESS" });
      finish.resolve();
      expect(await settled(f.service, result.receipt)).toMatchObject({ state: "succeeded", result: { hardwareId: item.id, draft: true, connectionCheck: { online: true }, sshKeyConfig: { host: "draft.example", auth: { kind: "identity_file", path: f.identity } } } });
      const state = await f.service.snapshot(user);
      expect(state.items.find(value => value.item.id === item.id)?.item).toEqual(item);
      expect(state.items.find(value => value.item.id === item.id)?.connectionCheck).toBeUndefined();
      expect(state.checkHolds).toEqual([]); expect(state.reservations).toEqual([]);
      expect(f.checkConnection).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(1);
      expect(f.discardCredential).toHaveBeenCalledWith(reference);
      expect(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8")).not.toContain("private one-time value");
    } finally { finish.resolve(); }
  });

  it("replays the original setup receipt without installing the key or resolving the password again", async () => {
    const f = await fixture(), item = await addItem(f.service), input = { requestId: randomUUID(), credentialRefId: passwordRef() };
    const first = await setup(f.service, item, input); await settled(f.service, first.receipt);
    const replay = await setup(f.service, item, input);
    expect(replay.receipt.runId).toBe(first.receipt.runId); expect(f.setupKey).toHaveBeenCalledTimes(1);
    expect(f.discardCredential).toHaveBeenCalledTimes(1);
  });

  it.each(["stale", "agent", "raw-password", "bad-reference", "deadline", "missing-provider"])("rejects %s setup before contacting a machine", async scenario => {
    const f = await fixture(), item = await addItem(f.service);
    if (scenario === "missing-provider") f.provider.setupKey = undefined;
    const extra = scenario === "stale" ? { expectedItemRevision: item.revision + 1 } : scenario === "raw-password" ? { password: "forbidden raw value" } : scenario === "bad-reference" ? { credentialRefId: "arbitrary" } : scenario === "deadline" ? { timeoutMs: 120001 } : {};
    await expect(setup(f.service, item, extra, scenario === "agent" ? agent : user)).rejects.toMatchObject({ code: scenario === "stale" ? "REVISION_CONFLICT" : scenario === "agent" ? "FORBIDDEN" : "INVALID_INPUT" });
    expect(f.setupKey).not.toHaveBeenCalled(); expect(f.discardCredential).not.toHaveBeenCalled();
  });

  it("rejects a held proposed endpoint without using the password", async () => {
    const f = await fixture(), item = await addItem(f.service), other = await addItem(f.service, "other.example");
    await mutate(f.service, "hardware.reserve", { hardwareId: other.id, expectedItemRevision: other.revision, purpose: "Other owner" }, agent);
    await expect(setup(f.service, item, { config: config("other.example") })).rejects.toMatchObject({ code: "ENDPOINT_CONFLICT" });
    expect(f.setupKey).not.toHaveBeenCalled();
  });

  it("reports rejected authentication, releases the hold after cleanup, and does not offer key configuration", async () => {
    const f = await fixture(), item = await addItem(f.service);
    f.setupKey.mockImplementationOnce(async (_value, _input, context) => { context.registerCleanup(f.close); return { state: "failed", effects: "none", error: { code: "SSH_AUTH_FAILED", message: "Password rejected." }, diagnostics: { exitCode: 255 } }; });
    const result = await settled(f.service, (await setup(f.service, item)).receipt);
    expect(result).toMatchObject({ state: "failed", error: { code: "SSH_AUTH_FAILED" }, result: { connectionCheck: { online: false, diagnostics: { exitCode: 255 } } } });
    expect(result.result?.sshKeyConfig).toBeUndefined(); expect((await f.service.snapshot(user)).checkHolds).toEqual([]);
  });

  it.each(["online-false", "wrong-auth", "changed-host", "extra-output", "missing-cleanup"])("keeps %s output held instead of offering an unverified key", async scenario => {
    const f = await fixture(), item = await addItem(f.service);
    f.setupKey.mockImplementationOnce(async (value, _input, context) => {
      if (scenario !== "missing-cleanup") context.registerCleanup(f.close);
      return completed({ config: { ...value, ...(scenario === "changed-host" ? { host: "unheld.example" } : {}), auth: scenario === "wrong-auth" ? { kind: "agent" } : { kind: "identity_file", path: f.identity } }, connectionCheck: { online: scenario !== "online-false" }, ...(scenario === "extra-output" ? { unexpected: true } : {}) } as unknown as JsonObject);
    });
    const result = await settled(f.service, (await setup(f.service, item)).receipt);
    expect(result.state).toBe("unknown"); expect(result.result?.sshKeyConfig).toBeUndefined();
    expect((await f.service.snapshot(user)).checkHolds).toMatchObject([{ hardwareId: item.id, state: "recovery_required" }]);
    expect(f.discardCredential).not.toHaveBeenCalled();
  });

  it("retains uncertain cleanup and diagnostics across restart without repeating registration", async () => {
    const f = await fixture(), item = await addItem(f.service);
    f.setupKey.mockImplementationOnce(async (_value, _input, context) => { context.registerCleanup(f.close); return { state: "unknown", error: { code: "SSH_KEY_REGISTRATION_UNKNOWN", message: "Inspect the possible remote key." }, diagnostics: { interrupted: true, stderr: "Registration interrupted" } }; });
    const result = await settled(f.service, (await setup(f.service, item)).receipt);
    expect(result).toMatchObject({ state: "unknown", result: { connectionCheck: { online: false, diagnostics: { interrupted: true } } } });
    expect(result.result?.sshKeyConfig).toBeUndefined(); await f.service.dispose();
    const restarted = new HardwareService(f.options); services.push(restarted); await restarted.init();
    const state = await restarted.snapshot(user);
    expect(state.checkHolds).toMatchObject([{ hardwareId: item.id, state: "recovery_required" }]);
    expect(state.receipts.find(receipt => receipt.requestId === result.requestId)).toMatchObject({ result: { connectionCheck: { diagnostics: { stderr: "Registration interrupted" } } } });
    expect(f.setupKey).toHaveBeenCalledTimes(1); expect(f.discardCredential).not.toHaveBeenCalled();
  });

  it("does not offer a key if the saved revision changes during setup", async () => {
    const f = await fixture(), item = await addItem(f.service), start = gate(), finish = gate();
    f.setupKey.mockImplementationOnce(async (value, _input, context) => { context.registerCleanup(f.close); start.resolve(); await finish.promise; return completed({ config: { ...value, auth: { kind: "identity_file", path: f.identity } }, connectionCheck: { online: true } } as unknown as JsonObject); });
    try {
      const result = await setup(f.service, item); await start.promise;
      await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { notes: "New notes" } });
      finish.resolve();
      const receipt = await settled(f.service, result.receipt);
      expect(receipt).toMatchObject({ state: "unknown", error: { code: "SSH_KEY_SETUP_SUPERSEDED" } });
      expect(receipt.result?.sshKeyConfig).toBeUndefined(); expect(f.discardCredential).not.toHaveBeenCalled();
    } finally { finish.resolve(); }
  });

  it("rejects a revision change during preflight inspection before installing any key", async () => {
    const f = await fixture(), item = await addItem(f.service), inspecting = gate(), inspected = gate();
    const inspect = f.provider.inspectEndpoint;
    let inspections = 0;
    f.provider.inspectEndpoint = async value => {
      if (++inspections === 3) { inspecting.resolve(); await inspected.promise; }
      return inspect(value);
    };
    try {
      const result = await setup(f.service, item); await inspecting.promise;
      await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { notes: "New revision before dispatch" } });
      inspected.resolve();
      const receipt = await settled(f.service, result.receipt);
      expect(receipt).toMatchObject({ state: "failed", error: { code: "REVISION_CONFLICT" } });
      expect(f.setupKey).not.toHaveBeenCalled(); expect((await f.service.snapshot(user)).checkHolds).toEqual([]);
    } finally { inspected.resolve(); }
  });

  it("does not persist a temporary password reference as a machine login", async () => {
    const f = await fixture(), item = await addItem(f.service);
    await expect(mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { config: { ...item.config, auth: { kind: "password", credentialRefId: passwordRef() } } } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await f.service.snapshot(user)).items[0].item).toEqual(item);
  });

  it("rechecks the item revision when queued setup completion becomes durable", async () => {
    const f = await fixture(), item = await addItem(f.service), start = gate(), finish = gate(), writingMetadata = gate(), commitMetadata = gate();
    f.setupKey.mockImplementationOnce(async (value, _input, context) => { context.registerCleanup(f.close); start.resolve(); await finish.promise; return completed({ config: { ...value, auth: { kind: "identity_file", path: f.identity } }, connectionCheck: { online: true } } as unknown as JsonObject); });
    const write = HardwareStore.prototype.write;
    vi.spyOn(HardwareStore.prototype, "write").mockImplementation(async function (this: HardwareStore, next) {
      if (next.items.some(value => value.id === item.id && value.notes === "Queued notes") && !next.receipts.some(record => record.action === "hardware.ssh.setupKey" && record.receipt.state !== "running")) {
        writingMetadata.resolve(); await commitMetadata.promise;
      }
      return write.call(this, next);
    });
    const finishSpy = vi.spyOn(f.service as unknown as { finish(...args: unknown[]): Promise<void> }, "finish");
    try {
      const result = await setup(f.service, item); await start.promise;
      const edit = mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { notes: "Queued notes" } });
      await writingMetadata.promise; finish.resolve();
      await vi.waitFor(() => expect(finishSpy).toHaveBeenCalled());
      commitMetadata.resolve(); await edit;
      const receipt = await settled(f.service, result.receipt);
      expect(receipt).toMatchObject({ state: "unknown", error: { code: "SSH_KEY_SETUP_SUPERSEDED" } });
      expect(receipt.result?.sshKeyConfig).toBeUndefined();
      expect((await f.service.snapshot(user)).checkHolds).toMatchObject([{ state: "recovery_required" }]);
    } finally { finish.resolve(); commitMetadata.resolve(); }
  });

  it("retires a saved password only after a durable switch to key authentication", async () => {
    const f = await fixture(), credentialRefId = `ssh-password-${randomUUID()}`;
    const item = await addItem(f.service, "legacy.example", undefined, { kind: "password", credentialRefId });
    f.discardSavedPassword.mockImplementationOnce(async id => {
      const stored = JSON.parse(await fs.readFile(path.join(f.root, "hardware/state.json"), "utf8"));
      expect(stored.items[0].config.auth).toEqual({ kind: "identity_file", path: f.identity }); expect(id).toBe(credentialRefId);
    });
    const prepared = await settled(f.service, (await setup(f.service, item, { credentialRefId })).receipt);
    expect(f.discardSavedPassword).not.toHaveBeenCalled();
    await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { config: prepared.result!.sshKeyConfig } });
    expect(f.discardSavedPassword).toHaveBeenCalledWith(credentialRefId);
  });

  it("keeps an old saved password when another item still uses it", async () => {
    const f = await fixture(), credentialRefId = `ssh-password-${randomUUID()}`, auth = { kind: "password" as const, credentialRefId };
    const item = await addItem(f.service, "legacy.example", undefined, auth); await addItem(f.service, "sibling.example", undefined, auth);
    await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { config: { ...item.config, auth: { kind: "identity_file", path: f.identity } } } });
    expect(f.discardSavedPassword).not.toHaveBeenCalled();
  });

  it("reports failed password retirement while preserving the successful key configuration", async () => {
    const f = await fixture(), credentialRefId = `ssh-password-${randomUUID()}`;
    const item = await addItem(f.service, "legacy.example", undefined, { kind: "password", credentialRefId });
    f.discardSavedPassword.mockRejectedValueOnce(new Error("Private storage unavailable"));
    const result = await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { config: { ...item.config, auth: { kind: "identity_file", path: f.identity } } } });
    expect(result.receipt).toMatchObject({ state: "succeeded", result: { passwordRetirement: { state: "failed" } } });
    expect((await f.service.snapshot(user)).items[0].item.config.auth).toEqual({ kind: "identity_file", path: f.identity });
    expect(JSON.stringify(result)).not.toContain("Private storage unavailable");
  });

  it("keeps a converted machine's password when its preparation hook still resolves that credential", async () => {
    const f = await fixture(), credentialRefId = `ssh-password-${randomUUID()}`;
    const passwords = new HardwareSshPasswords(f.root);
    await new ConfigSecretStore(f.root).update({ global: {}, plugins: { hardware: { [credentialRefId]: "legacy hook fixture" } } });
    f.options.resolveCredential.mockImplementation(id => passwords.resolve(id));
    f.discardSavedPassword.mockImplementation(id => passwords.discardSavedPassword(id));
    let item = await addItem(f.service, "legacy.example", undefined, { kind: "password", credentialRefId });
    item = (await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { hooks: { beforeReserve: { source: "exit 0", cwd: f.root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [credentialRefId] } } } })).receipt.result!.item as unknown as HardwareItem;
    const result = await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { config: { ...item.config, auth: { kind: "identity_file", path: f.identity } } } });
    expect(result.receipt.result?.passwordRetirement).toMatchObject({ state: "retained" });
    expect(await passwords.resolve(credentialRefId)).toBe("legacy hook fixture");
    const saved = result.receipt.result!.item as unknown as HardwareItem;
    const reserved = await mutate(f.service, "hardware.reserve", { hardwareId: saved.id, expectedItemRevision: saved.revision, purpose: "Preparation still needs its credential" });
    expect(await settled(f.service, reserved.receipt)).toMatchObject({ state: "succeeded" });
    expect(f.discardSavedPassword).not.toHaveBeenCalled();
  });

  it.each(["sibling-hook", "status-command", "nested-provider-config"])("keeps the password referenced by %s", async scenario => {
    const f = await fixture(), credentialRefId = `ssh-password-${randomUUID()}`;
    const item = await addItem(f.service, "legacy.example", undefined, { kind: "password", credentialRefId });
    const sibling = await addItem(f.service, "sibling.example");
    const script = { source: "exit 0", cwd: f.root, timeoutMs: 1000, maxOutputBytes: 100, credentialRefIds: [credentialRefId] };
    let patch: Record<string, unknown>;
    if (scenario === "sibling-hook") patch = { hooks: { onRelease: script } };
    else if (scenario === "status-command") {
      const created = await mutate(f.service, "hardware.statuses.create", { label: "Readiness", valueType: "boolean" });
      const definitionId = (created.receipt.result!.statusDefinition as JsonObject).id;
      patch = { statuses: [{ definitionId, revision: 1, source: "command", script, maxAgeMs: 60000, intervalMs: null }] };
    } else patch = { config: { ...sibling.config, providerCredentials: { nested: [credentialRefId] } } };
    await mutate(f.service, "hardware.items.update", { hardwareId: sibling.id, expectedItemRevision: sibling.revision, patch });
    const result = await mutate(f.service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { config: { ...item.config, auth: { kind: "identity_file", path: f.identity } } } });
    expect(result.receipt.result?.passwordRetirement).toMatchObject({ state: "retained" });
    expect(f.discardSavedPassword).not.toHaveBeenCalled();
  });
});
