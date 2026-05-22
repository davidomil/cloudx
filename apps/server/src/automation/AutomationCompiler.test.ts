import { describe, expect, it } from "vitest";

import type { AutomationCatalogResponse, AutomationGraphDocument } from "@cloudx/shared";
import { AUTOMATION_FSTRING_TYPE_ID, automationFStringInputPorts } from "@cloudx/shared";

import { AutomationCompiler } from "./AutomationCompiler.js";
import { AutomationTypeService, EXEC_TYPE, NUMBER_TYPE, STRING_TYPE } from "./AutomationTypeService.js";

const catalog: AutomationCatalogResponse = {
  nodes: [
    {
      typeId: "trigger:test",
      kind: "trigger",
      title: "Test Trigger",
      description: "Starts tests.",
      triggerId: "test",
      inputs: [],
      outputs: [
        { id: "exec", label: "Start", kind: "exec", direction: "output", type: EXEC_TYPE },
        { id: "payload", label: "Payload", kind: "data", direction: "output", type: { kind: "object", properties: {}, required: [] }, connectable: false },
        { id: "text", label: "Text", kind: "data", direction: "output", type: STRING_TYPE }
      ]
    },
    {
      typeId: "hook:needsNumber",
      kind: "function",
      title: "Needs Number",
      description: "Requires a number.",
      hookId: "needsNumber",
      inputs: [
        { id: "exec", label: "Run", kind: "exec", direction: "input", type: EXEC_TYPE },
        { id: "count", label: "Count", kind: "data", direction: "input", type: NUMBER_TYPE, required: true }
      ],
      outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: EXEC_TYPE }]
    }
  ]
};

const fStringCatalog: AutomationCatalogResponse = {
  nodes: [
    ...catalog.nodes,
    {
      typeId: AUTOMATION_FSTRING_TYPE_ID,
      kind: "primitive",
      title: "F-String",
      description: "Formats text.",
      inputs: automationFStringInputPorts(),
      outputs: [{ id: "value", label: "Value", kind: "data", direction: "output", type: STRING_TYPE }]
    }
  ]
};

describe("AutomationCompiler", () => {
  it("rejects incompatible data edges and missing required inputs", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook", typeId: "hook:needsNumber", position: { x: 200, y: 0 } }
      ],
      edges: [
        {
          id: "bad-type",
          kind: "data",
          sourceNodeId: "trigger",
          sourcePortId: "text",
          targetNodeId: "hook",
          targetPortId: "count"
        }
      ]
    };

    expect(compiler.validate(graph, catalog)).toMatchObject({
      valid: false,
      diagnostics: [expect.objectContaining({ code: "type-mismatch" })]
    });
    expect(compiler.validate({ ...graph, edges: [] }, catalog).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing-required-input" })])
    );
  });

  it("accepts required inputs supplied by node config", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook", typeId: "hook:needsNumber", position: { x: 200, y: 0 }, config: { count: 3 } }
      ],
      edges: [
        {
          id: "exec",
          kind: "exec",
          sourceNodeId: "trigger",
          sourcePortId: "exec",
          targetNodeId: "hook",
          targetPortId: "exec"
        }
      ]
    };

    expect(compiler.validate(graph, catalog)).toEqual({ valid: true, diagnostics: [] });
  });

  it("rejects edges connected to config-only object ports", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook", typeId: "hook:needsNumber", position: { x: 200, y: 0 }, config: { count: 3 } }
      ],
      edges: [
        {
          id: "payload-count",
          kind: "data",
          sourceNodeId: "trigger",
          sourcePortId: "payload",
          targetNodeId: "hook",
          targetPortId: "count"
        }
      ]
    };

    expect(compiler.validate(graph, catalog).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "non-connectable-port", edgeId: "payload-count", portId: "count" })])
    );
  });

  it("rejects multiple outgoing exec edges from the same program-flow output", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook-a", typeId: "hook:needsNumber", position: { x: 200, y: 0 }, config: { count: 1 } },
        { id: "hook-b", typeId: "hook:needsNumber", position: { x: 200, y: 160 }, config: { count: 2 } }
      ],
      edges: [
        { id: "exec-a", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "hook-a", targetPortId: "exec" },
        { id: "exec-b", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "hook-b", targetPortId: "exec" }
      ]
    };

    expect(compiler.validate(graph, catalog).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate-program-flow", edgeId: "exec-b", nodeId: "trigger", portId: "exec" })])
    );
  });

  it("validates f-string dynamic input ports from node config", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "format", typeId: AUTOMATION_FSTRING_TYPE_ID, position: { x: 200, y: 0 }, config: { template: "Hello {name}", inputNames: ["name"] } }
      ],
      edges: [{ id: "text-format", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "format", targetPortId: "name" }]
    };

    expect(compiler.validate(graph, fStringCatalog)).toEqual({ valid: true, diagnostics: [] });
  });
});
