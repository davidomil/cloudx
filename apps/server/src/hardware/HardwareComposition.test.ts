import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentOwner, HardwareItem, HardwareMutationResult, HardwareStateView, OperationReceipt, WorkspaceTab } from "@cloudx/shared";
import { DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES, DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES, type AppConfig } from "../config.js";
import { DEFAULT_ASR_TIMEOUT_MS } from "../asrClient.js";
import { DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES } from "../documentation/DocumentationClient.js";
import { buildServer, buildServices, type AppServices } from "../server.js";
import { ConfigSecretStore } from "../configSecretStore.js";
import { emptyHardwareState, HardwareStore } from "./HardwareStore.js";

const fixtures: { root: string; app: FastifyInstance }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, root } of fixtures.splice(0)) { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
});

async function fixture(beforeStart?: (services: AppServices, dataDir: string) => Promise<void>): Promise<{ root: string; app: FastifyInstance; services: AppServices }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-hardware-composition-"));
  const config: AppConfig = {
    host: "127.0.0.1", port: 3001, trustedOrigins: ["http://127.0.0.1:3001", "http://localhost"], logLevel: "silent", allowedRoots: [root],
    asrUrl: "http://127.0.0.1:1", asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS, voiceModel: "gpt-5.3-codex-spark", documentationUrl: "http://127.0.0.1:1",
    dataDir: path.join(root, ".cloudx"), webDistDir: path.join(root, "missing-web-dist"), appServerEnabled: false, automationStartDisabled: true,
    terminalReplayBytes: 1024, voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES, documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
    documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES
  };
  const services = buildServices(config);
  await beforeStart?.(services, config.dataDir);
  const app = await buildServer(config, services);
  fixtures.push({ root, app });
  return { root, app, services };
}

async function action(app: FastifyInstance, actionName: string, input: Record<string, unknown>) {
  const response = await app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action: actionName, input } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().result;
}

async function mutation(app: FastifyInstance, actionName: string, input: Record<string, unknown>): Promise<HardwareMutationResult> {
  return action(app, actionName, { requestId: randomUUID(), ...input });
}

async function settled(app: FastifyInstance, receipt: OperationReceipt): Promise<OperationReceipt> {
  const deadline = Date.now() + 3000;
  while (true) {
    const current = (await action(app, "hardware.receipt.get", { requestId: receipt.requestId })).receipt as OperationReceipt;
    if (current.state !== "running") return current;
    if (Date.now() >= deadline) throw new Error("Production Hardware receipt did not settle.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function createReadySsh(app: FastifyInstance, root: string): Promise<HardwareItem> {
  const identity = path.join(root, "emulation-identity");
  const hosts = path.join(root, "emulation-known-hosts");
  await fs.writeFile(identity, "No connection is opened in composition tests.\n", { mode: 0o600 });
  await fs.writeFile(hosts, "No network probe is performed by inventory.\n", { mode: 0o600 });
  const created = await mutation(app, "hardware.items.create", {
    newGroupName: "Lab host",
    item: { name: "Build host", description: "Production route fixture", enabled: true, typeId: "hardware.ssh", configVersion: 1,
      config: { host: "127.0.0.1", port: 22222, username: "tester", auth: { kind: "identity_file", path: identity }, knownHostsFile: hosts, connectTimeoutMs: 1000 },
      tagIds: [], notes: "Do not reboot. No hardware access is opened by this test.", statuses: [], hooks: {} }
  });
  expect(created.receipt.state).toBe("succeeded");
  return created.receipt.result!.item as unknown as HardwareItem;
}

async function savedHardwareAndInterruptedRegistration(dataDir: string) {
  const registration = `ssh-registration-${randomUUID()}`, login = `ssh-password-${randomUUID()}`;
  const state = emptyHardwareState(); state.revision = 7;
  await fs.mkdir(path.join(dataDir, "hardware"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "hardware/state.json"), JSON.stringify(state));
  await new ConfigSecretStore(dataDir).update({ global: { preserved: "private-global-marker" }, plugins: { hardware: {
    [registration]: "private-registration-marker", [login]: "private-login-marker"
  } } });
  return { registration, login, secrets: path.join(dataDir, "secrets/config-secrets.json") };
}

function failStartupStorage(faults: { hardware: boolean; secrets: boolean }) {
  const original = fs.open, attempts = { hardware: 0, secrets: 0 };
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await original(...args);
    const name = String(args[0]);
    const area = /\/\.state-.*\.tmp$/.test(name) ? "hardware" : /\/secrets\/config-secrets\..*\.tmp$/.test(name) ? "secrets" : undefined;
    if (area) {
      attempts[area]++;
      if (faults[area]) vi.spyOn(file, "writeFile").mockRejectedValueOnce(Object.assign(new Error("ENOSPC private-registration-marker"), { code: "ENOSPC" }));
    }
    return file;
  });
  return attempts;
}

async function expectUnavailableWithoutSecrets(app: FastifyInstance) {
  const state = await app.inject({ url: "/api/hardware/state" });
  expect(state.statusCode, state.body).toBe(200);
  expect(state.json()).toMatchObject({ readiness: { state: "unavailable" } });
  const diagnostics = await app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action: "hardware.diagnostics", input: {} } });
  expect(diagnostics.statusCode, diagnostics.body).toBe(200);
  expect(diagnostics.json()).toMatchObject({ result: { readiness: { state: "unavailable" } } });
  expect((await app.inject({ url: "/api/plugins" })).statusCode).toBe(200);
  for (const response of [state, diagnostics, await app.inject({ url: "/api/config" })])
    for (const secret of ["private-registration-marker", "private-login-marker", "private-global-marker"])
      expect(response.body).not.toContain(secret);
  const blocked = await app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action: "hardware.groups.create", input: { requestId: randomUUID(), name: "Blocked while cleanup is incomplete" } } });
  expect(blocked.statusCode, blocked.body).toBe(503);
  expect(blocked.body).not.toContain("private-registration-marker");
  return state.json<HardwareStateView>();
}

describe("Hardware production composition", () => {
  it("defers password cleanup after failed Hardware startup and requires cleanup to succeed before reconciliation admits work", async () => {
    const faults = { hardware: true, secrets: true };
    let saved!: Awaited<ReturnType<typeof savedHardwareAndInterruptedRegistration>>;
    let attempts!: ReturnType<typeof failStartupStorage>;
    const { app, root, services } = await fixture(async (_services, dataDir) => {
      saved = await savedHardwareAndInterruptedRegistration(dataDir);
      attempts = failStartupStorage(faults);
    });
    await expectUnavailableWithoutSecrets(app);
    expect(attempts).toEqual({ hardware: 1, secrets: 0 });
    expect(await fs.readFile(saved.secrets, "utf8")).toContain("private-registration-marker");
    faults.hardware = false;
    const failedRecovery = await app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action: "hardware.reconcile", input: { requestId: randomUUID() } } });
    expect(failedRecovery.statusCode, failedRecovery.body).toBe(503);
    expect(failedRecovery.json()).toMatchObject({ code: "STORE_UNAVAILABLE", details: { errno: "ENOSPC", phase: "registration_password_cleanup" } });
    expect(failedRecovery.body).not.toContain("private-registration-marker");
    expect(attempts.secrets).toBe(1);
    await expectUnavailableWithoutSecrets(app);
    expect(await fs.readFile(saved.secrets, "utf8")).toContain("private-registration-marker");
    faults.secrets = false;
    await expectUnavailableWithoutSecrets(app);
    const recovered = await action(app, "hardware.reconcile", { requestId: randomUUID() });
    expect(recovered).toMatchObject({ readiness: { state: "ready" } });
    expect(attempts.secrets).toBe(2);
    const secrets = await fs.readFile(saved.secrets, "utf8");
    expect(secrets).not.toContain("private-registration-marker");
    expect(secrets).toContain("private-login-marker");
    expect(secrets).toContain("private-global-marker");
    await expect(services.hardwarePasswords!.resolve(saved.registration)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    const item = await createReadySsh(app, root);
    const provider = services.plugins.get("hardware").hardwareTypes!.find(type => type.descriptor.id === "hardware.ssh")!;
    const check = vi.spyOn(provider, "checkConnection").mockImplementation(async (_config, context) => {
      expect(await fs.readFile(saved.secrets, "utf8")).not.toContain("private-registration-marker");
      context.registerCleanup(async () => ({ state: "completed", value: null }));
      return { state: "completed", value: { online: true } };
    });
    const checked = await mutation(app, "hardware.connection.check", { hardwareId: item.id, expectedItemRevision: item.revision });
    expect((await settled(app, checked.receipt)).state).toBe("succeeded");
    expect(check).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(root, ".cloudx/hardware/state.json"), "utf8")).not.toContain("private-registration-marker");
  });

  it("keeps failed registration cleanup alone unavailable until explicit reconciliation completes it", async () => {
    const faults = { hardware: false, secrets: true };
    let saved!: Awaited<ReturnType<typeof savedHardwareAndInterruptedRegistration>>;
    let attempts!: ReturnType<typeof failStartupStorage>;
    const { app, services } = await fixture(async (_services, dataDir) => {
      saved = await savedHardwareAndInterruptedRegistration(dataDir);
      attempts = failStartupStorage(faults);
    });
    const unavailable = await expectUnavailableWithoutSecrets(app);
    expect(unavailable.readiness).toMatchObject({ recovery: { errno: "ENOSPC", phase: "registration_password_cleanup" } });
    expect(attempts.secrets).toBe(1);
    faults.secrets = false;
    const clear = services.hardwarePasswords!.clearRegistrationPasswords.bind(services.hardwarePasswords!);
    let entered = false, complete!: () => void;
    const gate = new Promise<void>(resolve => { complete = resolve; });
    vi.spyOn(services.hardwarePasswords!, "clearRegistrationPasswords").mockImplementationOnce(async () => { entered = true; await gate; await clear(); });
    const recovery = Promise.resolve(app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action: "hardware.reconcile", input: { requestId: randomUUID() } } }));
    try {
      await vi.waitFor(() => { expect(entered).toBe(true); });
      await expectUnavailableWithoutSecrets(app);
      expect(await fs.readFile(saved.secrets, "utf8")).toContain("private-registration-marker");
    } finally { complete(); }
    const recovered = await recovery;
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({ result: { readiness: { state: "ready" } } });
    expect(attempts.secrets).toBe(2);
    expect(await fs.readFile(saved.secrets, "utf8")).not.toContain("private-registration-marker");
  });

  it("does not mutate registration secrets while a competing writer prevents Hardware startup", async () => {
    let saved!: Awaited<ReturnType<typeof savedHardwareAndInterruptedRegistration>>;
    let writer!: HardwareStore;
    let discard!: ReturnType<typeof vi.spyOn>;
    try {
      const { app } = await fixture(async (services, dataDir) => {
        saved = await savedHardwareAndInterruptedRegistration(dataDir);
        writer = new HardwareStore(dataDir); await writer.init();
        discard = vi.spyOn(services.hardwarePasswords!, "clearRegistrationPasswords");
      });
      await expectUnavailableWithoutSecrets(app);
      expect(discard).not.toHaveBeenCalled();
      expect(await fs.readFile(saved.secrets, "utf8")).toContain("private-registration-marker");
      await writer.dispose();
      expect(await action(app, "hardware.reconcile", { requestId: randomUUID() })).toMatchObject({ readiness: { state: "ready" } });
      expect(discard).toHaveBeenCalledOnce();
      expect(await fs.readFile(saved.secrets, "utf8")).not.toContain("private-registration-marker");
    } finally { await writer?.dispose(); }
  });

  it("preserves newly staged registration passwords when later storage reconciliation does not need startup cleanup", async () => {
    const { app, services } = await fixture();
    const registration = `ssh-registration-${randomUUID()}`;
    await services.hardwarePasswords!.save(registration, "private-new-registration-marker");
    const discard = vi.spyOn(services.hardwarePasswords!, "clearRegistrationPasswords");
    expect(await action(app, "hardware.reconcile", { requestId: randomUUID() })).toMatchObject({ readiness: { state: "ready" } });
    expect(discard).not.toHaveBeenCalled();
    expect(await services.hardwarePasswords!.resolve(registration)).toBe("private-new-registration-marker");
  });

  it("keeps the server and operator recovery routes available when Hardware startup state is corrupt", async () => {
    const corrupt = '{"schemaVersion":1}';
    const { app, root } = await fixture(async (_services, dataDir) => {
      await fs.mkdir(path.join(dataDir, "hardware"), { recursive: true });
      await fs.writeFile(path.join(dataDir, "hardware/state.json"), corrupt);
    });
    const state = await app.inject({ url: "/api/hardware/state" });
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json()).toMatchObject({ readiness: { state: "unavailable", recovery: { phase: expect.any(String), nextAction: expect.any(String) } } });
    const diagnostics = await action(app, "hardware.diagnostics", {});
    expect(diagnostics).toMatchObject({ lastConfirmedState: false, readiness: state.json().readiness });
    const reconcile = await app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action: "hardware.reconcile", input: { requestId: randomUUID() } } });
    expect(reconcile.statusCode, reconcile.body).toBe(503);
    expect(await action(app, "hardware.diagnostics", {})).toMatchObject({ readiness: { state: "unavailable" } });
    expect((await app.inject({ url: "/api/plugins" })).statusCode).toBe(200);
    expect(await fs.readFile(path.join(root, ".cloudx/hardware/state.json"), "utf8")).toBe(corrupt);
  });

  it("installs the native panel, both provider types, and four default system skills without selecting a user template", async () => {
    const { app, services } = await fixture();
    const plugins = await app.inject({ method: "GET", url: "/api/plugins" });
    expect(plugins.statusCode).toBe(200);
    expect(plugins.json().plugins).toContainEqual(expect.objectContaining({ id: "hardware", displayName: "Hardware", creatable: true }));
    const plugin = services.plugins.get("hardware");
    expect(plugin.uiContributions).toContainEqual(expect.objectContaining({ renderer: "hardware.panel", slot: "plugin.panel", targetPluginId: "hardware" }));
    expect(plugin.hardwareTypes!.map(type => type.descriptor.id)).toEqual(["hardware.ssh", "hardware.uart"]);
    const catalog = await services.pluginContributionsReady!;
    const expectedSkills = ["hardware-discover", "hardware-reserve", "hardware-access", "hardware-release"];
    expect(catalog.systemSkills.filter(skill => expectedSkills.includes(skill.id))).toHaveLength(4);
    expect(catalog.skills.filter(skill => expectedSkills.includes(skill.id))).toHaveLength(0);
    for (const template of catalog.templates) expect(template.skillIds.some(id => expectedSkills.includes(id))).toBe(false);
    const systemRoot = services.rulesSkills!.catalogRoot();
    for (const id of expectedSkills) {
      const text = await fs.readFile(path.join(systemRoot, "system-skills", id, "SKILL.md"), "utf8");
      expect(text).toContain("CLOUDX_HARDWARE_HELPER");
      expect(text).toContain("requestId");
    }
    expect(catalog.systemRules).toContainEqual(expect.objectContaining({ id: "hardware-access-policy", text: expect.stringContaining("Do not reboot") }));
    const helper = path.join(systemRoot, "system-skills", "hardware-discover", "scripts", "hardware-helper.mjs");
    expect((await fs.stat(helper)).mode & 0o111).not.toBe(0);
    expect(await fs.readFile(helper, "utf8")).toContain("CLOUDX_HARDWARE_CONTEXT");
    const state = await app.inject({ method: "GET", url: "/api/hardware/state" });
    expect(state.statusCode).toBe(200);
    expect(state.headers["cache-control"]).toBe("no-store");
    expect(state.json().types.map((type: { id: string }) => type.id)).toEqual(["hardware.ssh", "hardware.uart"]);
    expect(state.json().readiness.state).toBe("ready");
  });

  it("allows requested unmanaged hardware in the installed guidance while retaining managed access controls", async () => {
    const { services } = await fixture();
    const catalog = await services.pluginContributionsReady!;
    const rule = catalog.systemRules.find(rule => rule.id === "hardware-access-policy")!;
    const skills = catalog.systemSkills.filter(skill => skill.id.startsWith("hardware-"));
    expect(skills).toHaveLength(4);
    const instructions = await Promise.all(skills.map(skill => fs.readFile(path.join(services.rulesSkills!.catalogRoot(), "system-skills", skill.id, "SKILL.md"), "utf8")));
    for (const text of [rule.text, ...instructions]) {
      expect(text).toContain("For hardware not managed by the plugin, use ordinary SSH, UART, or host tools when the user requests it.");
      expect(text).toContain("No Hardware registration, reservation, or helper is required for that unmanaged hardware.");
      expect(text).toContain("complete inventory");
      expect(text).toContain("known physical aliases");
      expect(text).toContain("Registered items remain managed when disabled, held, ineligible, or unavailable.");
      expect(text).toContain("A missing helper or failed lookup does not prove that a target is unmanaged.");
      expect(text).toContain("Do not treat a denied reservation or an unknown outcome as permission for raw access to managed hardware.");
      expect(text).toContain("Release explicitly when work ends, including known failures.");
      expect(text).toContain("Closing the owning AI tab revokes its managed access and requests automatic release after cleanup.");
      expect(text).toContain("Reopening the tab requires a new reservation; it cannot inherit the old claim.");
      expect(text).toContain("The user can release a hold manually from Hardware.");
      expect(text).toContain("A lost heartbeat, completed turn, idle tab, browser disconnect, or server detach does not release a reservation.");
    }
    expect(rule.text).toContain("reserve a suitable item exclusively");
    expect(rule.text).toContain("Use the exact reservation generation for managed access");
    expect(rule.text).toContain("reread all notes");
    for (const text of instructions) {
      expect(text).toContain("If managed access is needed and the helper is unavailable, deliberately relaunch the AI tab");
      expect(text).not.toContain("If unavailable, deliberately relaunch the AI tab");
      expect(text).toContain("Unknown effects retain the claim");
      expect(text).toContain("A changed execution or attempt cannot inherit a claim");
    }
  });

  it("persists management edits through actual routes and returns field errors without resetting state", async () => {
    const { app, root } = await fixture();
    const item = await createReadySsh(app, root);
    expect(item.notes).toContain("Do not reboot");
    const tag = await mutation(app, "hardware.tags.create", { label: "ARM64", description: "Build architecture" });
    expect(tag.receipt.state).toBe("succeeded");
    const state = (await app.inject({ method: "GET", url: "/api/hardware/state" })).json() as HardwareStateView;
    expect(state.items[0]!.availability).toBe("available");
    expect(state.tags[0]!.label).toBe("ARM64");
    const updated = await mutation(app, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { notes: "Do not reboot. Use the isolated test account.", tagIds: [state.tags[0]!.id] } });
    expect(updated.receipt.state).toBe("succeeded");
    const read = await action(app, "hardware.items.get", { hardwareId: item.id });
    expect(read.item.notes).toBe("Do not reboot. Use the isolated test account.");
    expect(read.item.notesRevision).toBe(item.notesRevision + 1);
    expect(read.item.tagIds).toEqual([state.tags[0]!.id]);
    const invalid = await app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action: "hardware.items.update", input: { requestId: randomUUID(), hardwareId: item.id, expectedItemRevision: read.item.revision, patch: { config: { ...item.config, port: 0 } } } } });
    expect(invalid.statusCode).not.toBe(200);
    const reread = await action(app, "hardware.items.get", { hardwareId: item.id });
    expect(reread.item).toEqual(read.item);
    const saved = JSON.parse(await fs.readFile(path.join(root, ".cloudx", "hardware", "state.json"), "utf8"));
    expect(saved.items[0].notes).toBe(read.item.notes);
  });

  it("inherits Host and Origin admission for every hardware boundary", async () => {
    const { app } = await fixture();
    const before = (await app.inject({ method: "GET", url: "/api/hardware/state" })).json();
    for (const headers of [
      { host: "attacker.example:3001", origin: "http://attacker.example:3001" },
      { host: "127.0.0.1:3001", origin: "http://attacker.example:3001" }
    ]) {
      for (const request of [
        { method: "GET" as const, url: "/api/hardware/state" },
        { method: "PUT" as const, url: `/api/hardware/ssh-passwords/ssh-registration-${randomUUID()}`, payload: { password: "private-password-marker" } },
        { method: "POST" as const, url: "/api/hardware/actions", payload: { action: "hardware.tags.create", input: { requestId: randomUUID(), label: "Forbidden" } } },
        { method: "POST" as const, url: "/api/hardware/actions", payload: { action: "hardware.reconcile", input: { requestId: randomUUID() } } },
        { method: "POST" as const, url: "/api/hardware/actions", payload: { action: "hardware.diagnostics", input: {} } },
        { method: "POST" as const, url: "/api/hardware/agent", payload: { action: "hardware.items.list", tabId: "fake", executionId: "fake", input: {} } }
      ]) {
        const response = await app.inject({ ...request, headers });
        expect(response.statusCode).toBe(403);
      }
    }
    const after = (await app.inject({ method: "GET", url: "/api/hardware/state" })).json();
    expect(after.revision).toBe(before.revision);
    expect(after.tags).toEqual([]);
  });

  it("stages route passwords only in memory, preserves legacy login reads, and clears interrupted setup credentials on startup", async () => {
    const persistent = `ssh-password-${randomUUID()}`;
    const interrupted = `ssh-registration-${randomUUID()}`;
    const { app, root, services } = await fixture(async (services, dataDir) => {
      await new ConfigSecretStore(dataDir).update({ global: {}, plugins: { hardware: {
        [persistent]: "private-login-marker", [interrupted]: "private-registration-marker"
      } } });
      await services.hardwarePasswords!.save(interrupted, "private-registration-marker");
    });
    expect(await services.hardwarePasswords!.resolve(persistent)).toBe("private-login-marker");
    await expect(services.hardwarePasswords!.resolve(interrupted)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    const rejected = await app.inject({ method: "PUT", url: `/api/hardware/ssh-passwords/${persistent}`, payload: { password: "rejected-login-marker" } });
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(await services.hardwarePasswords!.resolve(persistent)).toBe("private-login-marker");
    const saved = `ssh-registration-${randomUUID()}`;
    const response = await app.inject({ method: "PUT", url: `/api/hardware/ssh-passwords/${saved}`, payload: { password: "private-route-marker" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ credentialRefId: saved });
    expect(await services.hardwarePasswords!.resolve(saved)).toBe("private-route-marker");
    const created = await mutation(app, "hardware.items.create", {
      newGroupName: "Password lab",
      item: { name: "Password target", description: "Private authentication fixture", enabled: true, typeId: "hardware.ssh", configVersion: 1,
        config: { host: "127.0.0.1", port: 22223, username: "tester", auth: { kind: "password", credentialRefId: persistent }, connectTimeoutMs: 1000 },
        tagIds: [], notes: "No real network connection is opened by this test.", statuses: [], hooks: {} }
    });
    expect(created.receipt.state).toBe("succeeded");
    const item = created.receipt.result!.item as unknown as HardwareItem;
    const provider = services.plugins.get("hardware").hardwareTypes!.find(type => type.descriptor.id === "hardware.ssh")!;
    const received: string[] = [];
    vi.spyOn(provider, "checkConnection").mockImplementation(async (_config, context) => {
      received.push(await context.resolveCredential(saved));
      context.registerCleanup(async () => ({ state: "completed", value: null }));
      return { state: "completed", value: { online: true } };
    });
    const checked = await mutation(app, "hardware.connection.check", { hardwareId: item.id, expectedItemRevision: item.revision,
      config: { ...item.config, auth: { kind: "password", credentialRefId: saved } } });
    expect(await settled(app, checked.receipt)).toMatchObject({ state: "succeeded", result: { draft: true, connectionCheck: { online: true } } });
    vi.spyOn(provider, "connect").mockImplementation(async (_config, context) => {
      received.push(await context.resolveCredential(persistent));
      const close = async () => ({ state: "completed" as const, value: null });
      context.registerCleanup(close);
      return { state: "completed", value: { close, invoke: async () => ({ state: "completed", value: {} }) } };
    });
    const reserved = await mutation(app, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Verify private password resolution" });
    expect((await settled(app, reserved.receipt)).state).toBe("succeeded");
    const claim = (await services.hardware!.snapshot({ kind: "user", userId: "local" })).reservations[0]!;
    const opened = await mutation(app, "hardware.access.open", { reservationId: claim.reservationId, generation: claim.generation });
    expect((await settled(app, opened.receipt)).state).toBe("succeeded");
    expect(received).toEqual(["private-route-marker", "private-login-marker"]);
    const state = await app.inject({ method: "GET", url: "/api/hardware/state" });
    expect(state.body).not.toContain("private-route-marker");
    expect((await app.inject({ method: "GET", url: "/api/config" })).body).not.toContain("private-route-marker");
    expect(await fs.readFile(path.join(root, ".cloudx", "hardware", "state.json"), "utf8")).not.toContain("private-route-marker");
    const secrets = await fs.readFile(path.join(root, ".cloudx", "secrets", "config-secrets.json"), "utf8");
    expect(secrets).toContain("private-login-marker");
    for (const marker of ["private-route-marker", "private-registration-marker", "rejected-login-marker"]) expect(secrets).not.toContain(marker);
    expect((await fs.stat(path.join(root, ".cloudx", "secrets", "config-secrets.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps discovery hooks read-only and derives ownership independently of targetTabId", async () => {
    const { app, services, root } = await fixture();
    const item = await createReadySsh(app, root);
    await mutation(app, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Composition ownership validation" });
    const now = new Date().toISOString();
    const target: WorkspaceTab = { id: "target-ai", pluginId: "codex-terminal", title: "Target AI", cwd: root, status: "running", indicator: { color: "green", label: "OK", updatedAt: now }, createdAt: now, updatedAt: now };
    vi.spyOn(services.sessions, "getTab").mockReturnValue(target);
    const execute = vi.spyOn(services.hardware!, "execute");
    const listed = await app.inject({ method: "POST", url: "/api/hooks/hardware.items.list", payload: { targetTabId: target.id, input: { ownedByMe: true } } });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().result.items).toHaveLength(1);
    expect(execute).toHaveBeenLastCalledWith("hardware.items.list", { ownedByMe: true }, { kind: "user", userId: "local" });
    expect(services.hooks!.list().filter(hook => hook.id.startsWith("hardware.")).map(hook => hook.id)).toEqual(["hardware.tags.list", "hardware.types.list", "hardware.statuses.list", "hardware.items.list", "hardware.items.get", "hardware.reservations.list"]);
    const impersonated = await app.inject({ method: "POST", url: "/api/hardware/agent", payload: { tabId: target.id, executionId: "pretend-execution", action: "hardware.reserve", input: { requestId: randomUUID(), hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Forged request" } } });
    expect(impersonated.statusCode).toBe(403);
    const state = (await app.inject({ method: "GET", url: "/api/hardware/state" })).json() as HardwareStateView;
    expect(state.reservations).toHaveLength(1);
    expect(state.reservations[0]!.owner).toEqual({ kind: "user", userId: "local" });
  });

  it("does not clear unknown remote effects after an operator cancels active work without acknowledging uncertainty", async () => {
    const { app, services, root } = await fixture();
    let dispatched!: () => void;
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    const provider = services.plugins.get("hardware").hardwareTypes!.find(type => type.descriptor.id === "hardware.ssh")!;
    vi.spyOn(provider, "connect").mockImplementation(async (_config, context) => {
      const close = async () => ({ state: "completed" as const, value: null });
      context.registerCleanup(close);
      return { state: "completed", value: { close, invoke: async (_operation, _input, signal) => new Promise(resolve => {
        dispatched();
        const unknown = () => resolve({ state: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "Local cancellation cannot prove the remote job ended." } });
        signal.addEventListener("abort", unknown, { once: true });
        if (signal.aborted) unknown();
      }) } };
    });
    const item = await createReadySsh(app, root);
    const acquired = await mutation(app, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Override cancellation regression" });
    const ref = { reservationId: acquired.reservation!.reservationId, generation: acquired.reservation!.generation };
    const opened = await mutation(app, "hardware.access.open", ref);
    expect((await settled(app, opened.receipt)).state).toBe("succeeded");
    const operation = await mutation(app, "hardware.access.invoke", { ...ref, operationId: "ssh.exec", input: { script: "emulated remote work", timeoutMs: 5000, maxOutputBytes: 128 } });
    await started;
    const before = (await app.inject({ method: "GET", url: "/api/hardware/state" })).json() as HardwareStateView;
    const override = await mutation(app, "hardware.forceRelease", { target: { kind: "reservation", ...ref }, expectedHoldRevision: before.reservations[0]!.revision, reason: "Cancel local client without accepting unresolved remote work", acceptUnresolvedExternalActivity: false });
    expect((await settled(app, operation.receipt)).state).toBe("unknown");
    expect((await settled(app, override.receipt)).state).toBe("unknown");
    const after = (await app.inject({ method: "GET", url: "/api/hardware/state" })).json() as HardwareStateView;
    expect(after.reservations).toHaveLength(1);
    expect(after.reservations[0]!.state).toBe("recovery_required");
    expect(after.items[0]!.availability).toBe("held");
    const held = after.reservations[0]!;
    const acknowledged = await mutation(app, "hardware.forceRelease", { target: { kind: "reservation", reservationId: held.reservationId, generation: held.generation }, expectedHoldRevision: held.revision, reason: "Operator inspected the remote job and explicitly accepts its unresolved activity", acceptUnresolvedExternalActivity: true });
    expect((await settled(app, acknowledged.receipt)).state).toBe("succeeded");
    expect((await app.inject({ method: "GET", url: "/api/hardware/state" })).json().reservations).toHaveLength(0);
  });

  it("rejects an authenticated reservation when the exact execution changes before domain admission", async () => {
    const { app, services, root } = await fixture();
    const item = await createReadySsh(app, root);
    const now = new Date().toISOString();
    const tab: WorkspaceTab = { id: "admission-ai", pluginId: "codex-terminal", title: "Admission AI", cwd: root, status: "running", indicator: { color: "green", label: "OK", updatedAt: now }, createdAt: now, updatedAt: now };
    let current: AgentOwner = { kind: "agent", tabId: tab.id, providerId: "codex", executionId: "original-execution" };
    vi.spyOn(services.sessions, "listTabs").mockReturnValue([tab]);
    vi.spyOn(services.sessions, "getTab").mockReturnValue(tab);
    vi.spyOn(services.sessions, "agentProvider").mockReturnValue("codex");
    vi.spyOn(services.sessions, "agentLineage").mockImplementation(() => ({ executionId: current.executionId }));
    vi.spyOn(services.hardwareContexts!, "owner").mockImplementation(async () => current);
    const context = (await services.hardwareContexts!.prepare(tab.id))!;
    const authenticate = services.hardwareContexts!.authenticate.bind(services.hardwareContexts!);
    vi.spyOn(services.hardwareContexts!, "authenticate").mockImplementation(async request => {
      const authenticated = await authenticate(request);
      current = { ...current, executionId: "replacement-execution" };
      return authenticated;
    });
    const response = await app.inject({ method: "POST", url: "/api/hardware/agent", headers: { authorization: `Bearer ${context.capability}` },
      payload: { tabId: tab.id, executionId: context.owner.executionId, action: "hardware.reserve", input: { requestId: randomUUID(), hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Must reject stale authenticated execution" } } });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("OWNER_CHANGED");
    expect((await app.inject({ method: "GET", url: "/api/hardware/state" })).json().reservations).toHaveLength(0);
  });
});
