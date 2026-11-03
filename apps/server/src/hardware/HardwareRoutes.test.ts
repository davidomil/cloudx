import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type { AgentOwner, HardwareMutationResult, HardwareStateView, OperationReceipt } from "@cloudx/shared";
import { AgentHardwareContext, HARDWARE_HELPER_PATH } from "./AgentHardwareContext.js";
import { HardwareService } from "./HardwareService.js";
import { HardwareTypeRegistry } from "./HardwareTypeRegistry.js";
import { registerHardwareRoutes } from "./HardwareRoutes.js";
import { PathPolicy } from "../pathPolicy.js";

const run = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-http-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  let owner: AgentOwner = { kind: "agent", tabId: "agent-1", providerId: "codex", executionId: "execution-1" };
  let endpoint = "http://127.0.0.1:1/api/hardware/agent";
  const contexts = new AgentHardwareContext({ dataDir: root, endpoint: () => endpoint, binding: tabId => tabId === owner.tabId ? owner : undefined });
  const provider: HardwareTypeProvider<unknown> = {
    descriptor: { id: "fixture.device", ownerPluginId: "fixture", apiVersion: 1, configVersion: 1, displayName: "Fixture", description: "Emulated device",
      configSchema: { type: "object", additionalProperties: false }, operations: [{ id: "device.measure", description: "Read measurement", inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", properties: { measurement: { type: "number" } }, required: ["measurement"], additionalProperties: false } }] },
    parseConfig: value => value,
    inspectEndpoint: async () => ({ resourceKeys: ["fixture:endpoint"], ready: true, blockers: [] }), describeAccess: () => ({ summary: "Emulator", details: {} }),
    connect: async (_config, context) => {
      const close = async () => ({ state: "completed" as const, value: null });
      context.registerCleanup(close);
      return { state: "completed", value: { close, invoke: async () => ({ state: "completed", value: { measurement: 42 } }) } };
    }
  };
  const hardware = new HardwareService({ dataDir: root, pathPolicy: new PathPolicy([root]), registry: new HardwareTypeRegistry([{ id: "fixture", hardwareTypes: [provider] }]), ownerState: () => "active" });
  await hardware.init();
  cleanups.push(() => hardware.dispose());
  const app = Fastify();
  let requests = 0;
  app.addHook("onRequest", async () => { requests++; });
  await registerHardwareRoutes(app, hardware, contexts);
  await app.ready();
  cleanups.push(() => app.close());
  let sequence = 0;
  const management = (action: string, input: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action, input: { requestId: `operator-${++sequence}`, ...input } } });
  const agent = async (action: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const locator = (await contexts.prepare(owner.tabId))!;
    return app.inject({ method: "POST", url: "/api/hardware/agent", headers: { authorization: `Bearer ${locator.capability}` }, payload: { tabId: owner.tabId, executionId: owner.executionId, action, input: { requestId: `agent-${++sequence}`, ...input }, ...extra } });
  };
  await management("hardware.groups.create", { name: "Lab" });
  const group = (await hardware.snapshot({ kind: "user", userId: "local" })).groups[0];
  const created = await management("hardware.items.create", { item: { name: "Target", description: "Emulated", enabled: true, physicalResourceId: group.id, typeId: "fixture.device", configVersion: 1, config: {}, tagIds: [], notes: "Do not reboot. Follow the recorded deployment procedure.", statuses: [], hooks: {} } });
  expect(created.statusCode).toBe(200);
  const item = (await hardware.snapshot({ kind: "user", userId: "local" })).items[0].item;
  return { root, hardware, app, contexts, item, management, agent, owner: () => owner, change: (next: AgentOwner) => { owner = next; }, requests: () => requests,
    listen: async () => { await app.listen({ port: 0, host: "127.0.0.1" }); endpoint = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/hardware/agent`; } };
}

async function settled(f: Awaited<ReturnType<typeof fixture>>, receipt: OperationReceipt, agent = true) {
  let observed: OperationReceipt | undefined;
  await vi.waitFor(async () => {
    const response = agent ? await f.agent("hardware.receipt.get", { requestId: receipt.requestId }) : await f.management("hardware.receipt.get", { requestId: receipt.requestId });
    expect(response.statusCode).toBe(200);
    observed = response.json<{ result: { receipt: OperationReceipt } }>().result.receipt;
    expect(observed.state).not.toBe("running");
  });
  return observed!;
}

it("runs the authenticated reservation, notes, managed access, and release workflow through actual HTTP routes", async () => {
  const f = await fixture();
  const state = await f.app.inject({ url: "/api/hardware/state" });
  expect(state.headers["cache-control"]).toBe("no-store");
  expect(state.json<HardwareStateView>().currentOwner).toEqual({ kind: "user", userId: "local" });
  expect(state.body).not.toContain("capability");
  const response = await f.agent("hardware.reserve", { hardwareId: f.item.id, expectedItemRevision: f.item.revision, purpose: "Deployment test" });
  expect(response.statusCode).toBe(200);
  const result = response.json<{ result: HardwareMutationResult }>().result;
  expect((await settled(f, result.receipt)).state).toBe("succeeded");
  const claim = (await f.hardware.snapshot(f.owner())).reservations[0];
  expect(claim.owner).toEqual(f.owner());
  expect((await f.agent("hardware.items.get", { hardwareId: f.item.id })).body).toContain("Do not reboot.");
  const ref = { reservationId: claim.reservationId, generation: claim.generation };
  const opened = await f.agent("hardware.access.open", ref);
  expect((await settled(f, opened.json<{ result: HardwareMutationResult }>().result.receipt)).state).toBe("succeeded");
  const invoked = await f.agent("hardware.access.invoke", { ...ref, operationId: "device.measure", input: {} });
  const measured = await settled(f, invoked.json<{ result: HardwareMutationResult }>().result.receipt);
  expect(measured).toMatchObject({ state: "succeeded", result: { measurement: 42 } });
  const released = await f.agent("hardware.release", ref);
  expect((await settled(f, released.json<{ result: HardwareMutationResult }>().result.receipt)).state).toBe("succeeded");
  expect((await f.hardware.snapshot(f.owner())).items[0].availability).toBe("available");
});

it("rejects spoofed owners and revokes stale execution access without giving claims to replacements", async () => {
  const f = await fixture();
  expect((await f.agent("hardware.groups.create", { name: "Unauthorized" })).statusCode).toBe(403);
  expect((await f.agent("hardware.items.list", {}, { owner: { kind: "user", userId: "local" } })).statusCode).toBe(400);
  expect((await f.app.inject({ method: "POST", url: "/api/hardware/actions", payload: { action: "hardware.reserve", input: {}, targetTabId: "agent-1" } })).statusCode).toBe(400);
  const locator = (await f.contexts.prepare(f.owner().tabId))!;
  f.change({ ...f.owner(), executionId: "execution-2" });
  const response = await f.app.inject({ method: "POST", url: "/api/hardware/agent", headers: { authorization: `Bearer ${locator.capability}` }, payload: { tabId: "agent-1", executionId: "execution-1", action: "hardware.items.list", input: {} } });
  expect(response.statusCode).toBe(403);
  expect(response.json().code).toBe("FORBIDDEN");
});

it("uses the installed helper against the real server and rejects unsafe input before dispatch", async () => {
  const f = await fixture();
  await f.listen();
  await f.contexts.prepare(f.owner().tabId);
  const env = { PATH: process.env.PATH, CLOUDX_HARDWARE_CONTEXT: f.contexts.contextPath(f.owner()) };
  const helper = (...args: string[]) => run(process.execPath, [HARDWARE_HELPER_PATH, ...args], { env });
  expect(JSON.parse((await helper("context")).stdout).owner).toEqual(f.owner());
  expect(JSON.parse((await helper("items", "get", "--id", f.item.id)).stdout).result.item.notes).toContain("Do not reboot.");
  const input = path.join(f.root, "query.json");
  await fs.writeFile(input, "{}");
  const link = path.join(f.root, "query-link.json");
  await fs.symlink(input, link);
  const before = f.requests();
  await expect(helper("items", "list", "--input", link)).rejects.toMatchObject({ stderr: expect.stringContaining("ELOOP") });
  await expect(helper("items", "list", "--unknown", input)).rejects.toMatchObject({ stderr: expect.stringContaining("supported option") });
  await expect(helper("reserve", "--input", input, "--id", "other")).rejects.toMatchObject({ stderr: expect.stringContaining("one structured") });
  expect(f.requests()).toBe(before);
});
