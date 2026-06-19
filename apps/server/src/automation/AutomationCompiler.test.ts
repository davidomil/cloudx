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

  it("resolves same-name data and exec ports by edge kind", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const sameNameCatalog: AutomationCatalogResponse = {
      nodes: [
        {
          ...catalog.nodes[0]!,
          outputs: [
            ...catalog.nodes[0]!.outputs,
            { id: "exec", label: "Exec Field", kind: "data", direction: "output", type: NUMBER_TYPE }
          ]
        },
        {
          ...catalog.nodes[1]!,
          inputs: [
            ...catalog.nodes[1]!.inputs,
            { id: "exec", label: "Exec Field", kind: "data", direction: "input", type: NUMBER_TYPE }
          ]
        }
      ]
    };
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook", typeId: "hook:needsNumber", position: { x: 200, y: 0 } }
      ],
      edges: [
        {
          id: "exec-flow",
          kind: "exec",
          sourceNodeId: "trigger",
          sourcePortId: "exec",
          targetNodeId: "hook",
          targetPortId: "exec"
        },
        {
          id: "exec-data",
          kind: "data",
          sourceNodeId: "trigger",
          sourcePortId: "exec",
          targetNodeId: "hook",
          targetPortId: "exec"
        },
        {
          id: "count-data",
          kind: "data",
          sourceNodeId: "trigger",
          sourcePortId: "exec",
          targetNodeId: "hook",
          targetPortId: "count"
        }
      ]
    };

    expect(compiler.validate(graph, sameNameCatalog)).toEqual({ valid: true, diagnostics: [] });
  });

  it("accepts required inputs supplied by catalog defaults", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const defaultedCatalog: AutomationCatalogResponse = {
      nodes: [
        catalog.nodes[0]!,
        {
          typeId: "hook:defaultedNumber",
          kind: "function",
          title: "Defaulted Number",
          description: "Uses a default number.",
          hookId: "defaultedNumber",
          inputs: [
            { id: "exec", label: "Run", kind: "exec", direction: "input", type: EXEC_TYPE },
            { id: "count", label: "Count", kind: "data", direction: "input", type: NUMBER_TYPE, required: true, defaultValue: 3 }
          ],
          outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: EXEC_TYPE }]
        }
      ]
    };
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook", typeId: "hook:defaultedNumber", position: { x: 200, y: 0 } }
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

    expect(compiler.validate(graph, defaultedCatalog)).toEqual({ valid: true, diagnostics: [] });
  });

  it("rejects catalog defaults that do not match input port types", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const defaultedCatalog: AutomationCatalogResponse = {
      nodes: [
        catalog.nodes[0]!,
        {
          typeId: "hook:badDefault",
          kind: "function",
          title: "Bad Default",
          description: "Uses a default with the wrong type.",
          hookId: "badDefault",
          inputs: [
            { id: "exec", label: "Run", kind: "exec", direction: "input", type: EXEC_TYPE },
            { id: "count", label: "Count", kind: "data", direction: "input", type: NUMBER_TYPE, required: true, defaultValue: "three" }
          ],
          outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: EXEC_TYPE }]
        }
      ]
    };
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook", typeId: "hook:badDefault", position: { x: 200, y: 0 } }
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

    expect(compiler.validate(graph, defaultedCatalog).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "default-type-mismatch", nodeId: "hook", portId: "count" })])
    );
  });

  it("rejects configured node values that do not match input port types", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook", typeId: "hook:needsNumber", position: { x: 200, y: 0 }, config: { count: "three" } }
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

    expect(compiler.validate(graph, catalog).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "config-type-mismatch", nodeId: "hook", portId: "count" })])
    );
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

  it("rejects multiple incoming data edges to the same input", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook", typeId: "hook:needsNumber", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "count-a", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "hook", targetPortId: "count" },
        { id: "count-b", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "hook", targetPortId: "count" }
      ]
    };

    expect(compiler.validate(graph, catalog).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate-data-input", edgeId: "count-b", nodeId: "hook", portId: "count" })])
    );
  });

  it("rejects duplicate edge ids", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook-a", typeId: "hook:needsNumber", position: { x: 200, y: 0 }, config: { count: 1 } },
        { id: "hook-b", typeId: "hook:needsNumber", position: { x: 400, y: 0 }, config: { count: 2 } }
      ],
      edges: [
        { id: "exec", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "hook-a", targetPortId: "exec" },
        { id: "exec", kind: "exec", sourceNodeId: "hook-a", sourcePortId: "exec", targetNodeId: "hook-b", targetPortId: "exec" }
      ]
    };

    expect(compiler.validate(graph, catalog).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate-edge", edgeId: "exec" })])
    );
  });

  it("rejects ambiguous variable definitions", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [{ id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } }],
      edges: [],
      variables: [
        { name: "branch", type: STRING_TYPE, defaultValue: "main" },
        { name: "branch", type: STRING_TYPE, defaultValue: "develop" },
        { name: " count ", type: NUMBER_TYPE, defaultValue: 1 },
        { name: "retries", type: NUMBER_TYPE, defaultValue: "three" }
      ]
    };

    expect(compiler.validate(graph, catalog).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-variable" }),
        expect.objectContaining({ code: "invalid-variable-name" }),
        expect.objectContaining({ code: "variable-default-type-mismatch" })
      ])
    );
  });

  it("rejects program-flow cycles", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "hook", typeId: "hook:needsNumber", position: { x: 200, y: 0 }, config: { count: 1 } }
      ],
      edges: [
        { id: "exec-hook", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "hook", targetPortId: "exec" },
        { id: "exec-loop", kind: "exec", sourceNodeId: "hook", sourcePortId: "exec", targetNodeId: "hook", targetPortId: "exec" }
      ]
    };

    expect(compiler.validate(graph, catalog).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "program-flow-cycle", edgeId: "exec-loop", nodeId: "hook" })])
    );
  });

  it("requires explicit graph safety policy for external and destructive automation nodes", () => {
    const compiler = new AutomationCompiler(new AutomationTypeService());
    const unsafeCatalog: AutomationCatalogResponse = {
      nodes: [
        catalog.nodes[0]!,
        {
          typeId: "hook:runShell",
          kind: "function",
          title: "Run Shell",
          description: "Runs a shell command.",
          hookId: "runShell",
          safety: "external",
          inputs: [{ id: "exec", label: "Run", kind: "exec", direction: "input", type: EXEC_TYPE }],
          outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: EXEC_TYPE }]
        },
        {
          typeId: "primitive:python.exec",
          kind: "primitive",
          title: "Run Python",
          description: "Runs Python.",
          safety: "external",
          inputs: [{ id: "exec", label: "Run", kind: "exec", direction: "input", type: EXEC_TYPE }],
          outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: EXEC_TYPE }]
        }
      ]
    };
    const graph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "shell", typeId: "hook:runShell", position: { x: 200, y: 0 } }
      ],
      edges: [{ id: "exec-shell", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "shell", targetPortId: "exec" }]
    };

    expect(compiler.validate(graph, unsafeCatalog).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "automation-safety-policy", nodeId: "shell" })])
    );
    expect(compiler.validate({ ...graph, allowedSafety: ["read", "write", "external"] }, unsafeCatalog)).toEqual({ valid: true, diagnostics: [] });

    const primitiveGraph: AutomationGraphDocument = {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "python", typeId: "primitive:python.exec", position: { x: 200, y: 0 } }
      ],
      edges: [{ id: "exec-python", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "python", targetPortId: "exec" }]
    };
    expect(compiler.validate(primitiveGraph, unsafeCatalog).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "automation-safety-policy", nodeId: "python" })])
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
