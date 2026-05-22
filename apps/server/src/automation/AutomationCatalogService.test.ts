import { describe, expect, it } from "vitest";

import type { HookDescriptor, TriggerDescriptor } from "@cloudx/shared";

import { AutomationCatalogService } from "./AutomationCatalogService.js";
import { AutomationTypeService } from "./AutomationTypeService.js";

describe("AutomationCatalogService", () => {
  it("turns structured schemas into reusable leaf ports and config-only objects", async () => {
    const service = new AutomationCatalogService(
      new AutomationTypeService(),
      () => [triggerDescriptor()],
      () => [hookDescriptor()],
      (source) => ({
        options: [{ value: "focused", label: "Focused" }],
        defaultValue: source === "workspace.layoutTemplates" ? "focused" : undefined
      })
    );

    const catalog = await service.catalog();
    const trigger = catalog.nodes.find((entry) => entry.typeId === "trigger:test.worktreeCreated");
    const hook = catalog.nodes.find((entry) => entry.typeId === "hook:test.createWindow");

    expect(trigger?.outputs.map((port) => port.id)).toEqual(["exec", "payload", "folderName", "path"]);
    expect(trigger?.outputs.find((port) => port.id === "payload")).toMatchObject({ connectable: false });

    expect(hook?.inputs.map((port) => port.id)).toEqual(["exec", "templateId", "indicator.color", "indicator.label", "metadata"]);
    expect(hook?.inputs.find((port) => port.id === "indicator.color")).toMatchObject({
      label: "Color",
      required: true,
      type: { kind: "string" }
    });
    expect(hook?.inputs.find((port) => port.id === "metadata")).toMatchObject({
      connectable: false,
      type: { kind: "object" }
    });
    expect(hook?.inputs.find((port) => port.id === "templateId")).toMatchObject({
      defaultValue: "focused",
      options: { source: "workspace.layoutTemplates", values: [{ value: "focused", label: "Focused" }] }
    });

    expect(hook?.outputs.map((port) => port.id)).toEqual(["exec", "window.id", "window.name", "window.defaultCwd", "summary"]);
    expect(hook?.outputs.find((port) => port.id === "window.id")).toMatchObject({ label: "ID" });
    expect(hook?.outputs.find((port) => port.id === "window.defaultCwd")).toMatchObject({ label: "Default CWD" });
    expect(hook?.outputs.find((port) => port.id === "window")).toBeUndefined();
    expect(hook?.outputs.find((port) => port.id === "workspace")).toBeUndefined();
    expect(hook?.outputs.find((port) => port.id === "result")).toBeUndefined();
  });
});

function triggerDescriptor(): TriggerDescriptor {
  return {
    id: "test.worktreeCreated",
    owner: { kind: "plugin", pluginId: "worktree-manager" },
    title: "Worktree Created",
    description: "A worktree was created.",
    exposures: ["automation"],
    payloadSchema: {
      type: "object",
      properties: {
        folderName: { type: "string", description: "Created folder name." },
        path: { type: "string", description: "Created folder path." }
      },
      required: ["folderName", "path"],
      additionalProperties: false
    }
  };
}

function hookDescriptor(): HookDescriptor {
  return {
    id: "test.createWindow",
    owner: { kind: "app" },
    title: "Create Window",
    description: "Creates a window.",
    exposures: ["automation"],
    inputSchema: {
      type: "object",
      properties: {
        templateId: { type: "string", description: "Layout template.", "x-cloudx-option-source": "workspace.layoutTemplates" },
        indicator: {
          type: "object",
          description: "Nested indicator value.",
          properties: {
            color: { type: "string", enum: ["green", "yellow", "red"], description: "Indicator color." },
            label: { type: "string", description: "Indicator label." }
          },
          required: ["color", "label"],
          additionalProperties: false
        },
        metadata: { type: "object", description: "Arbitrary metadata object." }
      },
      required: ["indicator"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {
        window: {
          type: "object",
          properties: {
            id: { type: "string", description: "Window id." },
            name: { type: "string", description: "Window name." },
            defaultCwd: { type: "string", description: "Window default cwd." }
          },
          additionalProperties: false
        },
        workspace: {
          type: "object",
          description: "Full workspace state.",
          "x-cloudx-connectable": false,
          additionalProperties: true
        },
        summary: { type: "string", description: "Short summary." }
      },
      additionalProperties: false
    }
  };
}
