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

  it("adds a target tab selector to plugin-owned automation hooks", async () => {
    const service = new AutomationCatalogService(
      new AutomationTypeService(),
      () => [],
      () => [pluginHookDescriptor()],
      (source) => ({
        options: source === "workspace.tabs" ? [{ value: "tab-1", label: "Terminal" }] : [],
        defaultValue: source === "workspace.tabs" ? "tab-1" : undefined
      })
    );

    const hook = (await service.catalog()).nodes.find((entry) => entry.typeId === "hook:test.enterText");

    expect(hook?.inputs.map((port) => port.id)).toEqual(["exec", "targetTabId", "text"]);
    expect(hook?.inputs.find((port) => port.id === "targetTabId")).toMatchObject({
      label: "Target Tab",
      required: false,
      automationRole: "pluginTargetTab",
      type: { kind: "string" },
      options: { source: "workspace.tabs", values: [{ value: "tab-1", label: "Terminal" }] }
    });
    expect(hook?.inputs.find((port) => port.id === "targetTabId")?.defaultValue).toBeUndefined();
  });

  it("keeps schema-owned plugin targetTabId inputs as hook payload fields", async () => {
    const service = new AutomationCatalogService(
      new AutomationTypeService(),
      () => [],
      () => [pluginHookDescriptorWithTargetTabInput()]
    );

    const hook = (await service.catalog()).nodes.find((entry) => entry.typeId === "hook:test.targetAwareAction");

    expect(hook?.inputs.map((port) => port.id)).toEqual(["exec", "targetTabId", "text"]);
    expect(hook?.inputs.find((port) => port.id === "targetTabId")).toMatchObject({
      label: "Action Target",
      required: true,
      type: { kind: "string" }
    });
    expect(hook?.inputs.find((port) => port.id === "targetTabId")?.automationRole).toBeUndefined();
  });

  it("keeps reserved trigger payload output unique while exposing same-name exec data by kind", async () => {
    const service = new AutomationCatalogService(
      new AutomationTypeService(),
      () => [reservedNameTriggerDescriptor()],
      () => []
    );

    const trigger = (await service.catalog()).nodes.find((entry) => entry.typeId === "trigger:test.reservedNames");
    const payloadPorts = trigger?.outputs.filter((port) => port.kind === "data" && port.id === "payload") ?? [];

    expect(payloadPorts).toHaveLength(1);
    expect(payloadPorts[0]).toMatchObject({ label: "Payload", connectable: false });
    expect(trigger?.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "exec", kind: "exec" }),
        expect.objectContaining({ id: "exec", kind: "data", label: "Exec" }),
        expect.objectContaining({ id: "text", kind: "data" })
      ])
    );
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
        summary: { type: "string", description: "Short summary." },
        automationEffects: {
          type: "array",
          description: "Explicit automation effects.",
          "x-cloudx-connectable": false,
          items: { type: "object", additionalProperties: true }
        }
      },
      additionalProperties: false
    }
  };
}

function pluginHookDescriptor(): HookDescriptor {
  return {
    id: "test.enterText",
    owner: { kind: "plugin", pluginId: "test" },
    title: "Enter Text",
    description: "Send text to a plugin tab.",
    exposures: ["automation"],
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to send." }
      },
      required: ["text"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  };
}

function pluginHookDescriptorWithTargetTabInput(): HookDescriptor {
  return {
    id: "test.targetAwareAction",
    owner: { kind: "plugin", pluginId: "test" },
    title: "Target Aware Action",
    description: "Sends a payload field named targetTabId.",
    exposures: ["automation"],
    inputSchema: {
      type: "object",
      properties: {
        targetTabId: { type: "string", title: "Action Target" },
        text: { type: "string", description: "Text to send." }
      },
      required: ["targetTabId", "text"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  };
}

function reservedNameTriggerDescriptor(): TriggerDescriptor {
  return {
    id: "test.reservedNames",
    owner: { kind: "plugin", pluginId: "test" },
    title: "Reserved Names",
    description: "A trigger with payload fields that overlap built-in ports.",
    exposures: ["automation"],
    payloadSchema: {
      type: "object",
      properties: {
        exec: { type: "string", description: "Payload field named exec." },
        payload: { type: "string", description: "Payload field named payload." },
        text: { type: "string", description: "Payload text." }
      },
      required: ["exec", "payload", "text"],
      additionalProperties: false
    }
  };
}
