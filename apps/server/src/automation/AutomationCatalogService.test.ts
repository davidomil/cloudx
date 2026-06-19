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

  it("uses purposeful fallback descriptions when hook schemas omit field descriptions", async () => {
    const service = new AutomationCatalogService(
      new AutomationTypeService(),
      () => [],
      () => [jiraLikeHookDescriptor(), genericHookDescriptor()]
    );

    const jiraHook = (await service.catalog()).nodes.find((entry) => entry.typeId === "hook:jira.issue.transition");
    const genericHook = (await service.catalog()).nodes.find((entry) => entry.typeId === "hook:test.generic");

    expect(jiraHook?.inputs.find((port) => port.id === "issueIdOrKey")?.description).toBe("Jira issue key or numeric issue ID this node reads or modifies.");
    expect(jiraHook?.inputs.find((port) => port.id === "comment")?.description).toBe("Plain-text Jira comment added while performing this operation.");
    expect(genericHook?.inputs.find((port) => port.id === "enabled")?.description).toBe("Enabled flag used by Generic Hook.");
    expect(genericHook?.outputs.find((port) => port.id === "result")?.description).toBe("Result returned by Generic Hook.");
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

  it("catalogs comparison, sleep, Python, bash, and Codex execution primitives with typed ports", async () => {
    const catalog = await new AutomationCatalogService(new AutomationTypeService(), () => [], () => []).catalog();
    const numberCompare = catalog.nodes.find((entry) => entry.typeId === "primitive:number.compare");
    const numberRange = catalog.nodes.find((entry) => entry.typeId === "primitive:number.range");
    const stringCompare = catalog.nodes.find((entry) => entry.typeId === "primitive:string.compare");
    const sleep = catalog.nodes.find((entry) => entry.typeId === "primitive:sleep");
    const python = catalog.nodes.find((entry) => entry.typeId === "primitive:python.exec");
    const bash = catalog.nodes.find((entry) => entry.typeId === "primitive:bash.exec");
    const codex = catalog.nodes.find((entry) => entry.typeId === "primitive:codex.exec");

    expect(numberCompare).toMatchObject({
      kind: "primitive",
      inputs: expect.arrayContaining([
        expect.objectContaining({ id: "left", type: { kind: "number" } }),
        expect.objectContaining({ id: "operator", type: { kind: "string" } })
      ]),
      outputs: [expect.objectContaining({ id: "value", type: { kind: "boolean" } })]
    });
    expect(numberRange?.inputs.find((port) => port.id === "mode")?.options?.values.map((option) => option.value)).toEqual(["inclusive", "exclusive", "outsideInclusive", "outsideExclusive"]);
    expect(stringCompare?.inputs.find((port) => port.id === "operator")?.options?.values.map((option) => option.value)).toEqual(["equals", "notEquals", "contains", "startsWith", "endsWith"]);
    expect(sleep).toMatchObject({
      inputs: [expect.objectContaining({ id: "exec" }), expect.objectContaining({ id: "durationMs", type: { kind: "number" } })],
      outputs: [expect.objectContaining({ id: "exec" })]
    });
    expect(python).toMatchObject({
      safety: "external",
      inputs: expect.arrayContaining([
        expect.objectContaining({ id: "exec", kind: "exec" }),
        expect.objectContaining({ id: "code", type: { kind: "string" }, codeEditor: expect.objectContaining({ language: "python" }) }),
        expect.objectContaining({ id: "cloudxHooks", type: { kind: "boolean" } }),
        expect.objectContaining({ id: "parseJson", type: { kind: "boolean" } })
      ]),
      outputs: expect.arrayContaining([
        expect.objectContaining({ id: "stdout", type: { kind: "string" } }),
        expect.objectContaining({ id: "stderr", type: { kind: "string" } }),
        expect.objectContaining({ id: "exitCode", type: { kind: "number" } }),
        expect.objectContaining({ id: "json", type: { kind: "unknown" } }),
        expect.objectContaining({ id: "hookResults", type: expect.objectContaining({ kind: "array" }) })
      ])
    });
    const pythonCompletions = python?.inputs.find((port) => port.id === "code")?.codeEditor?.completions ?? [];
    expect(pythonCompletions.map((completion) => completion.label)).toEqual(expect.arrayContaining(["cloudx.call_hook"]));
    expect(pythonCompletions.find((completion) => completion.label === "cloudx.call_hook")).toMatchObject({
      detail: "Queue a CloudX hook call.",
      info: expect.stringContaining("Do not include the automation node prefix \"hook:\"")
    });
    expect(bash).toMatchObject({
      safety: "external",
      inputs: expect.arrayContaining([
        expect.objectContaining({ id: "exec", kind: "exec" }),
        expect.objectContaining({ id: "script", type: { kind: "string" }, codeEditor: expect.objectContaining({ language: "bash" }) }),
        expect.objectContaining({ id: "parseJson", type: { kind: "boolean" } })
      ]),
      outputs: expect.arrayContaining([
        expect.objectContaining({ id: "stdout", type: { kind: "string" } }),
        expect.objectContaining({ id: "stderr", type: { kind: "string" } }),
        expect.objectContaining({ id: "exitCode", type: { kind: "number" } }),
        expect.objectContaining({ id: "json", type: { kind: "unknown" } })
      ])
    });
    expect(codex).toMatchObject({
      safety: "external",
      inputs: expect.arrayContaining([
        expect.objectContaining({ id: "exec", kind: "exec" }),
        expect.objectContaining({ id: "prompt", type: { kind: "string" } }),
        expect.objectContaining({ id: "profile", type: { kind: "string" } }),
        expect.objectContaining({ id: "sandbox", options: { values: expect.arrayContaining([expect.objectContaining({ value: "read-only" })]) } }),
        expect.objectContaining({ id: "approvalPolicy", options: { values: expect.arrayContaining([expect.objectContaining({ value: "never" })]) } })
      ]),
      outputs: expect.arrayContaining([
        expect.objectContaining({ id: "finalMessage", type: { kind: "string" } }),
        expect.objectContaining({ id: "stderr", type: { kind: "string" } }),
        expect.objectContaining({ id: "exitCode", type: { kind: "number" } }),
        expect.objectContaining({ id: "jsonEvents", type: expect.objectContaining({ kind: "array" }) })
      ])
    });
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

function jiraLikeHookDescriptor(): HookDescriptor {
  return {
    id: "jira.issue.transition",
    owner: { kind: "plugin", pluginId: "jira" },
    title: "Transition Jira Issue",
    description: "Move a Jira issue.",
    exposures: ["automation"],
    inputSchema: {
      type: "object",
      properties: {
        issueIdOrKey: { type: "string" },
        comment: { type: "string" }
      },
      required: ["issueIdOrKey"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  };
}

function genericHookDescriptor(): HookDescriptor {
  return {
    id: "test.generic",
    owner: { kind: "app" },
    title: "Generic Hook",
    description: "Tests fallback descriptions.",
    exposures: ["automation"],
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" }
      },
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {
        result: { type: "string" }
      },
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
