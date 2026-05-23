import { describe, expect, it } from "vitest";

import type { JsonSchemaLike } from "@cloudx/plugin-api";
import type { AutomationCatalogResponse, AutomationGroup, TriggerEvent } from "@cloudx/shared";

import { HookRegistry } from "../hooks/HookRegistry.js";
import { AutomationCatalogService } from "./AutomationCatalogService.js";
import { AutomationExecutor } from "./AutomationExecutor.js";
import { AutomationTypeService } from "./AutomationTypeService.js";

describe("AutomationExecutor", () => {
  it("runs a trigger-to-hook graph and records trace output", async () => {
    const hooks = new HookRegistry();
    hooks.register({
      id: "test.echo",
      owner: { kind: "app" },
      title: "Echo",
      description: "Echo text.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: (input, context) => ({ echoed: input.text, caller: context.caller.kind })
    });

    const run = await new AutomationExecutor().execute(group(), event(), catalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["Running Test Trigger.", "Echo completed.", "finished"]));
  });

  it("keeps the reserved trigger payload output stable when payload fields collide", async () => {
    const hooks = new HookRegistry();
    let receivedValue: unknown;
    hooks.register({
      id: "test.capturePayload",
      owner: { kind: "app" },
      title: "Capture Payload",
      description: "Captures the full trigger payload.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "object" }
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: (input) => {
        receivedValue = input.value;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(payloadCollisionGroup(), payloadCollisionEvent(), payloadCollisionCatalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(receivedValue).toEqual({ payload: "shadow", text: "hello" });
  });

  it("passes trigger exec payload fields through data edges without blocking program flow", async () => {
    const hooks = new HookRegistry();
    let receivedValue: unknown;
    hooks.register({
      id: "test.captureExecField",
      owner: { kind: "app" },
      title: "Capture Exec Field",
      description: "Captures a payload field named exec.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" }
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: (input) => {
        receivedValue = input.value;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(execPayloadFieldGroup(), execPayloadFieldEvent(), execPayloadFieldCatalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(receivedValue).toBe("payload-exec");
  });

  it("uses catalog input defaults when a node has no configured value or data edge", async () => {
    const hooks = new HookRegistry();
    let received = "";
    hooks.register({
      id: "test.defaulted",
      owner: { kind: "app" },
      title: "Defaulted",
      description: "Reads a default.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: (input) => {
        received = String(input.text);
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(defaultValueGroup(), event(), defaultValueCatalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(received).toBe("from-catalog");
  });

  it("passes plugin hook targetTabId through call context without adding it to hook input", async () => {
    const hooks = new HookRegistry();
    let receivedInput: Record<string, unknown> | undefined;
    let receivedTargetTabId: string | undefined;
    hooks.register({
      id: "test.pluginAction",
      owner: { kind: "plugin", pluginId: "fake-plugin" },
      title: "Plugin Action",
      description: "Captures context.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: (input, context) => {
        receivedInput = input;
        receivedTargetTabId = context.targetTabId;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(targetTabGroup(), event(), targetTabCatalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(receivedInput).toEqual({ text: "hello" });
    expect(receivedTargetTabId).toBe("tab-2");
  });

  it("keeps schema-owned plugin targetTabId values in hook input", async () => {
    const hooks = new HookRegistry();
    let receivedInput: Record<string, unknown> | undefined;
    let receivedTargetTabId: string | undefined;
    hooks.register({
      id: "test.schemaTargetTab",
      owner: { kind: "plugin", pluginId: "fake-plugin" },
      title: "Schema Target Tab",
      description: "Captures a schema-owned targetTabId.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          targetTabId: { type: "string" },
          text: { type: "string" }
        },
        required: ["targetTabId", "text"],
        additionalProperties: false
      },
      execute: (input, context) => {
        receivedInput = input;
        receivedTargetTabId = context.targetTabId;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(schemaOwnedTargetTabGroup(), event(), schemaOwnedTargetTabCatalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(receivedInput).toEqual({ targetTabId: "payload-tab", text: "hello" });
    expect(receivedTargetTabId).toBeUndefined();
  });

  it("blocks unsafe hooks at execution time even if validation is bypassed", async () => {
    const hooks = new HookRegistry();
    let called = false;
    hooks.register({
      id: "test.external",
      owner: { kind: "app" },
      title: "External",
      description: "External action.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => {
        called = true;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(externalHookGroup(), event(), externalHookCatalog(), hooks);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("requires external automation safety");
    expect(called).toBe(false);
  });

  it("reconstructs nested hook inputs and exposes nested hook outputs as leaf ports", async () => {
    const hooks = new HookRegistry();
    let createInput: Record<string, unknown> | undefined;
    let notifyInput: Record<string, unknown> | undefined;
    hooks.register({
      id: "test.createWindow",
      owner: { kind: "app" },
      title: "Create Window",
      description: "Creates a window.",
      exposures: ["automation"],
      inputSchema: nestedCreateInputSchema(),
      outputSchema: nestedCreateOutputSchema(),
      execute: (input) => {
        createInput = input;
        return {
          window: {
            id: "window-1",
            name: (input.indicator as Record<string, unknown>).label,
            defaultCwd: "/tmp/feature"
          }
        };
      }
    });
    hooks.register({
      id: "test.notify",
      owner: { kind: "app" },
      title: "Notify",
      description: "Sends a notification.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" }
        },
        required: ["title"],
        additionalProperties: false
      },
      execute: (input) => {
        notifyInput = input;
        return {};
      }
    });

    const catalog = await nestedCatalog();
    const run = await new AutomationExecutor().execute(nestedHookGroup(), event(), catalog, hooks);

    expect(run.status).toBe("succeeded");
    expect(createInput).toEqual({ indicator: { color: "green", label: "feature-folder" } });
    expect(notifyInput).toEqual({ title: "feature-folder" });
  });

  it("rejects unsafe dotted hook input paths without polluting object prototypes", async () => {
    const hooks = new HookRegistry();
    hooks.register({
      id: "test.unsafe",
      owner: { kind: "app" },
      title: "Unsafe",
      description: "Uses an unsafe dotted input path.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: true
      },
      execute: () => ({})
    });

    const run = await new AutomationExecutor().execute(unsafePathGroup(), event(), unsafePathCatalog(), hooks);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Unsafe automation path segment: __proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("creates variables and evaluates array primitives", async () => {
    const run = await new AutomationExecutor().execute(variableArrayGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["2"]));
  });

  it("invalidates cached data node outputs after variable writes inside loops", async () => {
    const run = await new AutomationExecutor().execute(whileVariableMutationGroup(), event(), await primitiveCatalog(), new HookRegistry(), { maxSteps: 50 });

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["done"]));
    expect(run.error).toBeUndefined();
  });

  it("evaluates string operation primitives", async () => {
    const run = await new AutomationExecutor().execute(stringOperationGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["world", "brave", "true"]));
  });

  it("rejects unsafe regular expression primitives before matching text", async () => {
    const run = await new AutomationExecutor().execute(regexPrimitiveGroup("primitive:string.regex.test", { pattern: "(a+)+$", text: `${"a".repeat(32)}!` }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("regular expression is too complex");
  });

  it("rejects invalid regular expression flags before matching text", async () => {
    const run = await new AutomationExecutor().execute(regexPrimitiveGroup("primitive:string.regex.extract", { pattern: "hello", flags: "ii", text: "hello" }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("has an invalid regular expression");
  });

  it("rejects non-boolean control-flow conditions instead of using truthiness", async () => {
    const run = await new AutomationExecutor().execute(nonBooleanConditionGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("requires condition to be a boolean");
    expect(run.trace.map((entry) => entry.message)).not.toContain("true branch");
  });

  it("lets explicit string-template config values override variables even when nullish", async () => {
    const run = await new AutomationExecutor().execute(nullTemplateOverrideGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["Hello "]));
    expect(run.trace.map((entry) => entry.message)).not.toContain("Hello fallback");
  });

  it("resolves string-template payload paths through owned nested fields only", async () => {
    const run = await new AutomationExecutor().execute(stringTemplatePayloadPathGroup(), nestedPayloadEvent(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["User Ada / inherited="]));
    expect(run.trace.map((entry) => entry.message)).not.toContain("Object");
  });

  it("evaluates Python-style f-string primitives with dynamic inputs", async () => {
    const run = await new AutomationExecutor().execute(fStringGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(['Hi "hello", total=3.50, literal {ok}']));
  });

  it("does not resolve inherited properties from f-string payload paths", async () => {
    const run = await new AutomationExecutor().execute(fStringInheritedPayloadGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["payload="]));
    expect(run.trace.map((entry) => entry.message)).not.toContain("payload=Object");
  });

  it("rejects oversized f-string templates before parsing", async () => {
    const run = await new AutomationExecutor().execute(fStringFormatGroup("x".repeat(50_001)), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Node format f-string template exceeds 50000 characters.");
  });

  it("rejects oversized f-string format widths before padding", async () => {
    const run = await new AutomationExecutor().execute(fStringFormatGroup("{name:10001s}", ["name"], { name: "hello" }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("F-string format width exceeds 10000.");
  });

  it("rejects oversized f-string numeric precision before formatting", async () => {
    const run = await new AutomationExecutor().execute(fStringFormatGroup("total={count:.101f}", ["count"], { count: 3.5 }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("F-string format precision exceeds 100.");
  });

  it("treats zero general f-string precision as one significant digit", async () => {
    const run = await new AutomationExecutor().execute(fStringFormatGroup("total={count:.0g}", ["count"], { count: 3.5 }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["total=4"]));
  });

  it("rejects f-string integer precision instead of ignoring it", async () => {
    const run = await new AutomationExecutor().execute(fStringFormatGroup("total={count:.1d}", ["count"], { count: 3.5 }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("F-string precision is not supported for d integer formats.");
  });

  it("rejects f-string output that grows beyond the render cap", async () => {
    const inputNames = Array.from({ length: 21 }, (_value, index) => `name${index}`);
    const template = inputNames.map((name) => `{${name}:10000s}`).join("");
    const run = await new AutomationExecutor().execute(fStringFormatGroup(template, inputNames), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("F-string output exceeds 200000 characters.");
  });

  it("evaluates math operation primitives", async () => {
    const run = await new AutomationExecutor().execute(mathOperationGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["10", "8", "3"]));
  });

  it("rejects non-object JSON values from the string-to-object converter", async () => {
    for (const value of ["42", "[1]"]) {
      const run = await new AutomationExecutor().execute(nonObjectJsonConverterGroup(value), event(), await primitiveCatalog(), new HookRegistry());

      expect(run.status).toBe("failed");
      expect(run.error).toContain("requires a JSON object");
    }
  });
});

function catalog(): AutomationCatalogResponse {
  return {
    nodes: [
      {
        typeId: "trigger:test.started",
        kind: "trigger",
        title: "Test Trigger",
        description: "Starts the graph.",
        triggerId: "test.started",
        inputs: [],
        outputs: [
          { id: "exec", label: "Start", kind: "exec", direction: "output", type: { kind: "exec" } },
          { id: "text", label: "Text", kind: "data", direction: "output", type: { kind: "string" } }
        ]
      },
      {
        typeId: "hook:test.echo",
        kind: "function",
        title: "Echo",
        description: "Echo text.",
        hookId: "test.echo",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "text", label: "Text", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      },
      {
        typeId: "primitive:log",
        kind: "primitive",
        title: "Log",
        description: "Log a message.",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "message", label: "Message", kind: "data", direction: "input", type: { kind: "unknown" } }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function payloadCollisionCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      {
        typeId: "trigger:test.started",
        kind: "trigger",
        title: "Test Trigger",
        description: "Starts the graph.",
        triggerId: "test.started",
        inputs: [],
        outputs: [
          { id: "exec", label: "Start", kind: "exec", direction: "output", type: { kind: "exec" } },
          { id: "payload", label: "Payload", kind: "data", direction: "output", type: { kind: "object", properties: {}, required: [] } }
        ]
      },
      {
        typeId: "hook:test.capturePayload",
        kind: "function",
        title: "Capture Payload",
        description: "Captures the full trigger payload.",
        hookId: "test.capturePayload",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "value", label: "Value", kind: "data", direction: "input", type: { kind: "object", properties: {}, required: [] }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function execPayloadFieldCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      {
        typeId: "trigger:test.started",
        kind: "trigger",
        title: "Test Trigger",
        description: "Starts tests.",
        triggerId: "test.started",
        inputs: [],
        outputs: [
          { id: "exec", label: "Start", kind: "exec", direction: "output", type: { kind: "exec" } },
          { id: "payload", label: "Payload", kind: "data", direction: "output", type: { kind: "object", properties: {}, required: [] } },
          { id: "exec", label: "Exec Field", kind: "data", direction: "output", type: { kind: "string" } }
        ]
      },
      {
        typeId: "hook:test.captureExecField",
        kind: "function",
        title: "Capture Exec Field",
        description: "Captures a payload field named exec.",
        hookId: "test.captureExecField",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "value", label: "Value", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function payloadCollisionGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-payload-collision",
    name: "Payload Collision",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "capture", typeId: "hook:test.capturePayload", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "payload-capture", kind: "data", sourceNodeId: "trigger", sourcePortId: "payload", targetNodeId: "capture", targetPortId: "value" }
      ]
    }
  };
}

function execPayloadFieldGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-exec-payload-field",
    name: "Exec Payload Field",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "capture", typeId: "hook:test.captureExecField", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "exec-field-capture", kind: "data", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "value" }
      ]
    }
  };
}

function targetTabCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      catalog().nodes[0]!,
      {
        typeId: "hook:test.pluginAction",
        kind: "function",
        title: "Plugin Action",
        description: "Captures context.",
        pluginId: "fake-plugin",
        hookId: "test.pluginAction",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "targetTabId", label: "Target Tab", kind: "data", direction: "input", type: { kind: "string" }, automationRole: "pluginTargetTab", required: true },
          { id: "text", label: "Text", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function schemaOwnedTargetTabCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      catalog().nodes[0]!,
      {
        typeId: "hook:test.schemaTargetTab",
        kind: "function",
        title: "Schema Target Tab",
        description: "Captures a schema-owned targetTabId.",
        pluginId: "fake-plugin",
        hookId: "test.schemaTargetTab",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "targetTabId", label: "Target Tab", kind: "data", direction: "input", type: { kind: "string" }, required: true },
          { id: "text", label: "Text", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function schemaOwnedTargetTabGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-schema-target-tab",
    name: "Schema Target Tab",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "plugin", typeId: "hook:test.schemaTargetTab", position: { x: 200, y: 0 }, config: { targetTabId: "payload-tab" } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "plugin", targetPortId: "exec" },
        { id: "data-1", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "plugin", targetPortId: "text" }
      ]
    }
  };
}

function externalHookCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      catalog().nodes[0]!,
      {
        typeId: "hook:test.external",
        kind: "function",
        title: "External",
        description: "External action.",
        hookId: "test.external",
        safety: "external",
        inputs: [{ id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } }],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

async function primitiveCatalog(): Promise<AutomationCatalogResponse> {
  return {
    nodes: [
      catalog().nodes[0]!,
      ...(await new AutomationCatalogService(new AutomationTypeService(), () => [], () => []).catalog()).nodes
    ]
  };
}

async function nestedCatalog(): Promise<AutomationCatalogResponse> {
  return await new AutomationCatalogService(
    new AutomationTypeService(),
    () => [
      {
        id: "test.started",
        owner: { kind: "plugin", pluginId: "test" },
        title: "Test Trigger",
        description: "Starts the graph.",
        exposures: ["automation"],
        payloadSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            folderName: { type: "string" }
          },
          required: ["text", "folderName"],
          additionalProperties: false
        }
      }
    ],
    () => [
      {
        id: "test.createWindow",
        owner: { kind: "app" },
        title: "Create Window",
        description: "Creates a window.",
        exposures: ["automation"],
        inputSchema: nestedCreateInputSchema(),
        outputSchema: nestedCreateOutputSchema()
      },
      {
        id: "test.notify",
        owner: { kind: "app" },
        title: "Notify",
        description: "Sends a notification.",
        exposures: ["automation"],
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" }
          },
          required: ["title"],
          additionalProperties: false
        }
      }
    ]
  ).catalog();
}

function nestedCreateInputSchema(): JsonSchemaLike {
  return {
    type: "object",
    properties: {
      indicator: {
        type: "object",
        properties: {
          color: { type: "string" },
          label: { type: "string" }
        },
        required: ["color", "label"],
        additionalProperties: false
      }
    },
    required: ["indicator"],
    additionalProperties: false
  };
}

function nestedCreateOutputSchema(): JsonSchemaLike {
  return {
    type: "object",
    properties: {
      window: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          defaultCwd: { type: "string" }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  };
}

function group(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-1",
    name: "Group",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "echo", typeId: "hook:test.echo", position: { x: 200, y: 0 } },
        { id: "log", typeId: "primitive:log", position: { x: 400, y: 0 }, config: { message: "finished" } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "echo", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "echo", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "data-1", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "echo", targetPortId: "text" }
      ]
    }
  };
}

function nestedHookGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-nested",
    name: "Nested Hook Ports",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "create", typeId: "hook:test.createWindow", position: { x: 200, y: 0 }, config: { "indicator.color": "green" } },
        { id: "notify", typeId: "hook:test.notify", position: { x: 400, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "create", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "create", sourcePortId: "exec", targetNodeId: "notify", targetPortId: "exec" },
        { id: "folder-label", kind: "data", sourceNodeId: "trigger", sourcePortId: "folderName", targetNodeId: "create", targetPortId: "indicator.label" },
        { id: "window-notify", kind: "data", sourceNodeId: "create", sourcePortId: "window.name", targetNodeId: "notify", targetPortId: "title" }
      ]
    }
  };
}

function unsafePathCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      catalog().nodes[0]!,
      {
        typeId: "hook:test.unsafe",
        kind: "function",
        title: "Unsafe",
        description: "Uses an unsafe dotted input path.",
        hookId: "test.unsafe",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "__proto__.polluted", label: "Unsafe", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function unsafePathGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-unsafe-path",
    name: "Unsafe Path",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "unsafe", typeId: "hook:test.unsafe", position: { x: 200, y: 0 }, config: { "__proto__.polluted": "yes" } }
      ],
      edges: [{ id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "unsafe", targetPortId: "exec" }]
    }
  };
}

function variableArrayGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-array",
    name: "Array Variables",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "array", typeId: "primitive:array.literal", position: { x: 120, y: 140 }, config: { items: "[\"a\"]" } },
        { id: "append", typeId: "primitive:array.append", position: { x: 320, y: 140 }, config: { item: "b" } },
        { id: "create", typeId: "primitive:variables.create", position: { x: 240, y: 0 }, config: { name: "items" } },
        { id: "get", typeId: "primitive:variables.get", position: { x: 470, y: 140 }, config: { name: "items" } },
        { id: "length", typeId: "primitive:array.length", position: { x: 650, y: 140 } },
        { id: "log", typeId: "primitive:log", position: { x: 500, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "create", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "create", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "array-append", kind: "data", sourceNodeId: "array", sourcePortId: "value", targetNodeId: "append", targetPortId: "array" },
        { id: "append-create", kind: "data", sourceNodeId: "append", sourcePortId: "value", targetNodeId: "create", targetPortId: "initial" },
        { id: "get-length", kind: "data", sourceNodeId: "get", sourcePortId: "value", targetNodeId: "length", targetPortId: "array" },
        { id: "length-log", kind: "data", sourceNodeId: "length", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function whileVariableMutationGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-while-variable",
    name: "While Variable Mutation",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "create-flag", typeId: "primitive:variables.create", position: { x: 180, y: 0 }, config: { name: "continue", initial: true } },
        { id: "get-flag", typeId: "primitive:variables.get", position: { x: 360, y: 160 }, config: { name: "continue" } },
        { id: "while", typeId: "primitive:while", position: { x: 360, y: 0 } },
        { id: "stop", typeId: "primitive:variables.set", position: { x: 560, y: 120 }, config: { name: "continue", value: false } },
        { id: "log", typeId: "primitive:log", position: { x: 560, y: 0 }, config: { message: "done" } }
      ],
      edges: [
        { id: "exec-create", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "create-flag", targetPortId: "exec" },
        { id: "exec-while", kind: "exec", sourceNodeId: "create-flag", sourcePortId: "exec", targetNodeId: "while", targetPortId: "exec" },
        { id: "condition", kind: "data", sourceNodeId: "get-flag", sourcePortId: "value", targetNodeId: "while", targetPortId: "condition" },
        { id: "body-stop", kind: "exec", sourceNodeId: "while", sourcePortId: "body", targetNodeId: "stop", targetPortId: "exec" },
        { id: "done-log", kind: "exec", sourceNodeId: "while", sourcePortId: "done", targetNodeId: "log", targetPortId: "exec" }
      ],
      variables: []
    }
  };
}

function stringOperationGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-string",
    name: "String Operations",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "append", typeId: "primitive:string.append", position: { x: 120, y: 120 }, config: { text: "Hello", suffix: " world" } },
        { id: "insert", typeId: "primitive:string.insert", position: { x: 300, y: 120 }, config: { insert: " brave", index: 5 } },
        { id: "extract", typeId: "primitive:string.regex.extract", position: { x: 500, y: 120 }, config: { pattern: "brave\\s+(\\w+)", group: 1 } },
        { id: "split", typeId: "primitive:string.split", position: { x: 500, y: 230 }, config: { separator: " " } },
        { id: "get", typeId: "primitive:array.get", position: { x: 680, y: 230 }, config: { index: 1 } },
        { id: "test", typeId: "primitive:string.regex.test", position: { x: 680, y: 340 }, config: { pattern: "HELLO", flags: "i" } },
        { id: "log-world", typeId: "primitive:log", position: { x: 720, y: 0 } },
        { id: "log-brave", typeId: "primitive:log", position: { x: 920, y: 0 } },
        { id: "log-test", typeId: "primitive:log", position: { x: 1120, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log-world", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "log-world", sourcePortId: "exec", targetNodeId: "log-brave", targetPortId: "exec" },
        { id: "exec-3", kind: "exec", sourceNodeId: "log-brave", sourcePortId: "exec", targetNodeId: "log-test", targetPortId: "exec" },
        { id: "append-insert", kind: "data", sourceNodeId: "append", sourcePortId: "value", targetNodeId: "insert", targetPortId: "text" },
        { id: "insert-extract", kind: "data", sourceNodeId: "insert", sourcePortId: "value", targetNodeId: "extract", targetPortId: "text" },
        { id: "extract-log", kind: "data", sourceNodeId: "extract", sourcePortId: "value", targetNodeId: "log-world", targetPortId: "message" },
        { id: "insert-split", kind: "data", sourceNodeId: "insert", sourcePortId: "value", targetNodeId: "split", targetPortId: "text" },
        { id: "split-get", kind: "data", sourceNodeId: "split", sourcePortId: "value", targetNodeId: "get", targetPortId: "array" },
        { id: "get-log", kind: "data", sourceNodeId: "get", sourcePortId: "value", targetNodeId: "log-brave", targetPortId: "message" },
        { id: "insert-test", kind: "data", sourceNodeId: "insert", sourcePortId: "value", targetNodeId: "test", targetPortId: "text" },
        { id: "test-log", kind: "data", sourceNodeId: "test", sourcePortId: "value", targetNodeId: "log-test", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function regexPrimitiveGroup(typeId: "primitive:string.regex.test" | "primitive:string.regex.extract", config: Record<string, unknown>): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: `group-${typeId}`,
    name: "Regex Primitive",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "regex", typeId, position: { x: 200, y: 120 }, config },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "regex-log", kind: "data", sourceNodeId: "regex", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function nonBooleanConditionGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-non-boolean-condition",
    name: "Non Boolean Condition",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "if", typeId: "primitive:if", position: { x: 200, y: 0 }, config: { condition: "false" } },
        { id: "log-true", typeId: "primitive:log", position: { x: 420, y: 0 }, config: { message: "true branch" } },
        { id: "log-false", typeId: "primitive:log", position: { x: 420, y: 160 }, config: { message: "false branch" } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "if", targetPortId: "exec" },
        { id: "if-true", kind: "exec", sourceNodeId: "if", sourcePortId: "true", targetNodeId: "log-true", targetPortId: "exec" },
        { id: "if-false", kind: "exec", sourceNodeId: "if", sourcePortId: "false", targetNodeId: "log-false", targetPortId: "exec" }
      ],
      variables: []
    }
  };
}

function nullTemplateOverrideGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-null-template",
    name: "Null Template Override",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "format", typeId: "primitive:stringTemplate", position: { x: 160, y: 120 }, config: { template: "Hello ${name}", name: null } },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "format-log", kind: "data", sourceNodeId: "format", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: [{ name: "name", type: { kind: "string" }, defaultValue: "fallback" }]
    }
  };
}

function stringTemplatePayloadPathGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-string-template-payload-path",
    name: "String Template Payload Path",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "format", typeId: "primitive:stringTemplate", position: { x: 160, y: 120 }, config: { template: "User ${payload.user.profile.name} / inherited=${payload.user.constructor.name}" } },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "format-log", kind: "data", sourceNodeId: "format", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function fStringGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-fstring",
    name: "F-String",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "format", typeId: "primitive:string.fstring", position: { x: 160, y: 120 }, config: { template: "Hi {name!r}, total={count:.2f}, literal {{ok}}", inputNames: ["name", "count"], count: 3.5 } },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "name-format", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "format", targetPortId: "name" },
        { id: "format-log", kind: "data", sourceNodeId: "format", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function fStringInheritedPayloadGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-fstring-inherited-payload",
    name: "F-String Inherited Payload",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "format", typeId: "primitive:string.fstring", position: { x: 160, y: 120 }, config: { template: "payload={payload.constructor.name}", inputNames: [] } },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "format-log", kind: "data", sourceNodeId: "format", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function fStringFormatGroup(template: string, inputNames: string[] = [], extraConfig: Record<string, unknown> = {}): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-fstring-format",
    name: "F-String Format",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "format", typeId: "primitive:string.fstring", position: { x: 160, y: 120 }, config: { template, inputNames, ...extraConfig } },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "format-log", kind: "data", sourceNodeId: "format", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function mathOperationGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-math",
    name: "Math Operations",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "add", typeId: "primitive:math.add", position: { x: 120, y: 120 }, config: { left: 2, right: 3 } },
        { id: "multiply", typeId: "primitive:math.multiply", position: { x: 300, y: 120 }, config: { right: 4 } },
        { id: "divide", typeId: "primitive:math.divide", position: { x: 480, y: 120 }, config: { right: 2 } },
        { id: "power", typeId: "primitive:math.power", position: { x: 300, y: 230 }, config: { left: 2, right: 3 } },
        { id: "ceil", typeId: "primitive:math.ceil", position: { x: 480, y: 230 }, config: { value: 2.2 } },
        { id: "log-divide", typeId: "primitive:log", position: { x: 680, y: 0 } },
        { id: "log-power", typeId: "primitive:log", position: { x: 880, y: 0 } },
        { id: "log-ceil", typeId: "primitive:log", position: { x: 1080, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log-divide", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "log-divide", sourcePortId: "exec", targetNodeId: "log-power", targetPortId: "exec" },
        { id: "exec-3", kind: "exec", sourceNodeId: "log-power", sourcePortId: "exec", targetNodeId: "log-ceil", targetPortId: "exec" },
        { id: "add-multiply", kind: "data", sourceNodeId: "add", sourcePortId: "value", targetNodeId: "multiply", targetPortId: "left" },
        { id: "multiply-divide", kind: "data", sourceNodeId: "multiply", sourcePortId: "value", targetNodeId: "divide", targetPortId: "left" },
        { id: "divide-log", kind: "data", sourceNodeId: "divide", sourcePortId: "value", targetNodeId: "log-divide", targetPortId: "message" },
        { id: "power-log", kind: "data", sourceNodeId: "power", sourcePortId: "value", targetNodeId: "log-power", targetPortId: "message" },
        { id: "ceil-log", kind: "data", sourceNodeId: "ceil", sourcePortId: "value", targetNodeId: "log-ceil", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function nonObjectJsonConverterGroup(value: string): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-string-to-object",
    name: "String To Object",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "convert", typeId: "converter:string.toObject", position: { x: 120, y: 120 }, config: { value } },
        { id: "log", typeId: "primitive:log", position: { x: 360, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "convert-log", kind: "data", sourceNodeId: "convert", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function defaultValueCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      catalog().nodes[0]!,
      {
        typeId: "hook:test.defaulted",
        kind: "function",
        title: "Defaulted",
        description: "Reads a default.",
        hookId: "test.defaulted",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "text", label: "Text", kind: "data", direction: "input", type: { kind: "string" }, required: true, defaultValue: "from-catalog" }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function defaultValueGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-default",
    name: "Default Values",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "defaulted", typeId: "hook:test.defaulted", position: { x: 200, y: 0 } }
      ],
      edges: [{ id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "defaulted", targetPortId: "exec" }]
    }
  };
}

function targetTabGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-target-tab",
    name: "Target Tab",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "plugin", typeId: "hook:test.pluginAction", position: { x: 200, y: 0 }, config: { targetTabId: "tab-2" } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "plugin", targetPortId: "exec" },
        { id: "data-1", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "plugin", targetPortId: "text" }
      ]
    }
  };
}

function externalHookGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-external",
    name: "External",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "external", typeId: "hook:test.external", position: { x: 200, y: 0 } }
      ],
      edges: [{ id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "external", targetPortId: "exec" }]
    }
  };
}

function event(): TriggerEvent {
  return {
    id: "event-1",
    triggerId: "test.started",
    source: { kind: "test" },
    payload: { text: "hello", folderName: "feature-folder" },
    emittedAt: new Date(0).toISOString()
  };
}

function nestedPayloadEvent(): TriggerEvent {
  return {
    ...event(),
    id: "event-nested-payload",
    payload: {
      text: "hello",
      folderName: "feature-folder",
      user: {
        profile: {
          name: "Ada"
        }
      }
    }
  };
}

function payloadCollisionEvent(): TriggerEvent {
  return {
    id: "event-payload-collision",
    triggerId: "test.started",
    source: { kind: "test" },
    payload: { payload: "shadow", text: "hello" },
    emittedAt: new Date(0).toISOString()
  };
}

function execPayloadFieldEvent(): TriggerEvent {
  return {
    id: "event-exec-payload-field",
    triggerId: "test.started",
    source: { kind: "test" },
    payload: { exec: "payload-exec", payload: "shadow", text: "hello" },
    emittedAt: new Date(0).toISOString()
  };
}
