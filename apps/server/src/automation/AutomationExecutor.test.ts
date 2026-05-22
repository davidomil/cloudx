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

  it("creates variables and evaluates array primitives", async () => {
    const run = await new AutomationExecutor().execute(variableArrayGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["2"]));
  });

  it("evaluates string operation primitives", async () => {
    const run = await new AutomationExecutor().execute(stringOperationGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["world", "brave", "true"]));
  });

  it("evaluates Python-style f-string primitives with dynamic inputs", async () => {
    const run = await new AutomationExecutor().execute(fStringGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(['Hi "hello", total=3.50, literal {ok}']));
  });

  it("evaluates math operation primitives", async () => {
    const run = await new AutomationExecutor().execute(mathOperationGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["10", "8", "3"]));
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

function event(): TriggerEvent {
  return {
    id: "event-1",
    triggerId: "test.started",
    source: { kind: "test" },
    payload: { text: "hello", folderName: "feature-folder" },
    emittedAt: new Date(0).toISOString()
  };
}
