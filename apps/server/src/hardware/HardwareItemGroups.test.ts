import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type { HardwareItem, HardwareMutationResult, HardwareOwner } from "@cloudx/shared";
import { HardwareService } from "./HardwareService.js";

const user: HardwareOwner = { kind: "user", userId: "local" };
const services: HardwareService[] = [];
const directories: string[] = [];
let request = 0;

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-item-groups-"));
  directories.push(directory);
  const provider: HardwareTypeProvider<unknown> = {
    descriptor: { id: "fixture.device", ownerPluginId: "fixture", apiVersion: 1, configVersion: 1, displayName: "Fixture", description: "A configured device", configSchema: { type: "object" }, operations: [] },
    parseConfig: value => value,
    inspectEndpoint: async () => ({ resourceKeys: ["endpoint:device"], ready: true, blockers: [] }),
    describeAccess: () => ({ summary: "Fixture", details: {} }),
    connect: async () => { throw new Error("Editing an item must not open its endpoint."); },
  };
  const service = new HardwareService({ dataDir: directory, registry: { values: () => [provider], get: () => provider } });
  services.push(service);
  await service.init();
  await mutate(service, "hardware.items.create", { newGroupName: "Original rack", item: { name: "Target", description: "", enabled: true, physicalResourceId: "", typeId: provider.descriptor.id, configVersion: 1, config: {}, tagIds: [], notes: "Do not reboot.", statuses: [], hooks: {} } });
  const item = (await service.snapshot(user)).items[0].item;
  const update = (extra: Record<string, unknown> = {}) => ({ requestId: `edit-${++request}`, hardwareId: item.id, expectedItemRevision: item.revision, newGroupName: "New rack", patch: { name: "Moved target" }, ...extra });
  return { service, item, update };
}

async function mutate(service: HardwareService, action: string, input: Record<string, unknown>) {
  return service.execute(action, { requestId: `group-test-${++request}`, ...input }, user) as Promise<HardwareMutationResult>;
}

describe("create a physical group while editing hardware", () => {
  it("saves the new group and the edited item in one revision, and replays only the saved receipt", async () => {
    const { service, item, update } = await fixture();
    const before = await service.snapshot(user);
    const input = update();
    const result = await mutate(service, "hardware.items.update", input);
    const after = await service.snapshot(user);
    const moved = result.receipt.result!.item as unknown as HardwareItem;
    expect(after.groups).toHaveLength(2);
    expect(after.groups.find(group => group.id === moved.physicalResourceId)?.name).toBe("New rack");
    expect(moved).toMatchObject({ id: item.id, name: "Moved target", revision: item.revision + 1, notesRevision: item.notesRevision });
    expect(moved.physicalResourceId).not.toBe(item.physicalResourceId);
    expect(after.revision).toBe(before.revision + 1);
    expect((await mutate(service, "hardware.items.update", input)).receipt.runId).toBe(result.receipt.runId);
    expect((await service.snapshot(user)).groups).toHaveLength(2);
  });

  it("rejects a duplicate group name without changing the item or leaving an orphan group", async () => {
    const { service, item, update } = await fixture();
    await expect(mutate(service, "hardware.items.update", update({ newGroupName: "original RACK" }))).rejects.toMatchObject({ code: "DUPLICATE_LABEL" });
    const state = await service.snapshot(user);
    expect(state.groups).toHaveLength(1);
    expect(state.items[0].item).toEqual(item);
  });

  it("rejects a stale item revision before creating the group", async () => {
    const { service, item, update } = await fixture();
    await mutate(service, "hardware.items.update", { hardwareId: item.id, expectedItemRevision: item.revision, patch: { notes: "Updated notes." } });
    await expect(mutate(service, "hardware.items.update", update())).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const state = await service.snapshot(user);
    expect(state.groups).toHaveLength(1);
    expect(state.items[0].item).toMatchObject({ physicalResourceId: item.physicalResourceId, notes: "Updated notes." });
  });

  it("keeps a held physical resource in its original group and rolls back group creation", async () => {
    const { service, item, update } = await fixture();
    await mutate(service, "hardware.reserve", { hardwareId: item.id, expectedItemRevision: item.revision, purpose: "Current task" });
    await expect(mutate(service, "hardware.items.update", update())).rejects.toMatchObject({ code: "RESERVATION_CONFLICT" });
    const state = await service.snapshot(user);
    expect(state.groups).toHaveLength(1);
    expect(state.items[0].item).toEqual(item);
    expect(state.reservations).toHaveLength(1);
    expect(state.reservations[0].resourceKeys).toContain(`physical:${item.physicalResourceId}`);
  });

  it("keeps the prior item and group when the new configuration is invalid", async () => {
    const { service, item, update } = await fixture();
    await expect(mutate(service, "hardware.items.update", update({ patch: { name: "" } }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const state = await service.snapshot(user);
    expect(state.groups).toHaveLength(1);
    expect(state.items[0].item).toEqual(item);
  });

  it("moves the item to a new group without requiring other item edits", async () => {
    const { service, item, update } = await fixture();
    await mutate(service, "hardware.items.update", update({ patch: {} }));
    const state = await service.snapshot(user);
    expect(state.groups.find(group => group.id === state.items[0].item.physicalResourceId)?.name).toBe("New rack");
    expect(state.items[0].item).toMatchObject({ name: item.name, config: item.config, revision: item.revision + 1 });
  });

  it("does not split aliases of one endpoint across physical groups", async () => {
    const { service, item, update } = await fixture();
    const { id: _id, revision: _revision, notesRevision: _notesRevision, ...draft } = item;
    await mutate(service, "hardware.items.create", { item: { ...draft, name: "Alias" } });
    await expect(mutate(service, "hardware.items.update", update())).rejects.toMatchObject({ code: "ENDPOINT_CONFLICT" });
    const state = await service.snapshot(user);
    expect(state.groups).toHaveLength(1);
    expect(state.items).toHaveLength(2);
    expect(state.items.every(summary => summary.item.physicalResourceId === item.physicalResourceId)).toBe(true);
  });
});
