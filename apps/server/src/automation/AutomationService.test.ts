import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AutomationGroup } from "@cloudx/shared";

import { HookRegistry } from "../hooks/HookRegistry.js";
import { TriggerRegistry } from "../triggers/TriggerRegistry.js";
import { AutomationCatalogService } from "./AutomationCatalogService.js";
import { AutomationCompiler } from "./AutomationCompiler.js";
import { AutomationExecutor } from "./AutomationExecutor.js";
import { AutomationRepository } from "./AutomationRepository.js";
import { AutomationService } from "./AutomationService.js";
import { AutomationTypeService } from "./AutomationTypeService.js";

describe("AutomationService", () => {
  it("fans one trigger out to enabled groups and skips disabled groups", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register({
      id: "fake.started",
      owner: { kind: "app" },
      title: "Fake Started",
      description: "Starts fake automation.",
      exposures: ["automation"],
      payloadSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      }
    });
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: (input) => ({ text: input.text })
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(group("enabled-a", true));
    await service.saveGroup(group("enabled-b", true));
    await service.saveGroup(group("disabled", false));

    await triggers.emit("fake.started", { text: "go" }, { kind: "test" });
    const runs = await waitForRuns(repository, 2);

    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.groupId).sort()).toEqual(["enabled-a", "enabled-b"]);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
  });
});

async function waitForRuns(repository: AutomationRepository, count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runs = await repository.listRuns();
    if (runs.length >= count) {
      return runs;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return repository.listRuns();
}

function group(id: string, enabled: boolean): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id,
    name: id,
    enabled,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:fake.started", position: { x: 0, y: 0 } },
        { id: "record", typeId: "hook:fake.record", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "record", targetPortId: "exec" },
        { id: "text", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "record", targetPortId: "text" }
      ]
    }
  };
}
