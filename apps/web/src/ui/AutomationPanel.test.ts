import { describe, expect, it } from "vitest";

import type { AutomationCatalogResponse, AutomationGroup, AutomationNodeCatalogEntry, AutomationSafety } from "@cloudx/shared";
import { AUTOMATION_FSTRING_TYPE_ID } from "@cloudx/shared";

import {
  automationMiniMapTheme,
  automationAllowedSafetyWithToggle,
  automationGraphFromPanelState,
  connectionPlanForEntry,
  compatibilityFromConnectionState,
  defaultConfigForEntry,
  automationStatusFromError,
  portTooltipText,
  groupedPaletteEntries,
  newAutomationGroup,
  nextAutomationGroupName,
  normalizedAutomationGroupName,
  paletteGroupForEntry,
  palettePositionFromPoint,
  paletteStateFromPoint,
  primitiveConfigSummary,
  portTooltipPlacementFromRect,
  searchPaletteStateFromRects,
  selectedAutomationGroupAfterDelete,
  shouldClosePaletteForPointer
} from "./AutomationPanel.js";
import { automationGraphsEqual, flowFromGraph, graphFromFlow, routedEdgePath } from "./automationGraphAdapter.js";
import { automationTypeAssignable, connectedDataInputIds, connectionIsValid, dataInputConflictEdges, deleteEdgesForHandle, hasProgramFlowConflict, programFlowConflictEdges, removeConnectionConflicts, removeProgramFlowConflicts } from "./automationConnection.js";

describe("AutomationPanel helpers", () => {
  it("routes minimap colors through theme variables", () => {
    expect(automationMiniMapTheme).toMatchObject({
      bgColor: "var(--automation-minimap-background)",
      maskColor: "var(--automation-minimap-mask)",
      maskStrokeColor: "var(--automation-minimap-mask-stroke)",
      nodeColor: "var(--automation-minimap-node)",
      nodeStrokeColor: "var(--automation-minimap-node-stroke)"
    });
  });

  it("round-trips graph documents through React Flow nodes and edges", () => {
    const group = groupFixture();
    const flow = flowFromGraph(group, catalogFixture());

    expect(flow.nodes).toHaveLength(2);
    expect(flow.edges[0]).toMatchObject({ source: "trigger", sourceHandle: "exec:out:exec", target: "log", targetHandle: "exec:in:exec" });
    expect(graphFromFlow(flow.nodes, flow.edges, group.graph)).toMatchObject(group.graph);
    expect(automationGraphsEqual(graphFromFlow(flow.nodes, flow.edges, group.graph), group.graph)).toBe(true);
    expect(automationGraphsEqual({ ...group.graph, edges: [...group.graph.edges].reverse() }, group.graph)).toBe(true);
    expect(automationGraphsEqual({ ...group.graph, nodes: group.graph.nodes.map((node) => (node.id === "log" ? { ...node, config: { message: "changed" } } : node)) }, group.graph)).toBe(false);
  });

  it("preserves full port ids when React Flow handle ids contain delimiters", () => {
    const group = {
      ...groupFixture(),
      graph: {
        ...groupFixture().graph,
        edges: [
          {
            id: "colon-data",
            kind: "data" as const,
            sourceNodeId: "trigger",
            sourcePortId: "metadata:label",
            targetNodeId: "log",
            targetPortId: "message:body"
          }
        ]
      }
    };
    const flow = flowFromGraph(group, catalogFixture());

    expect(flow.edges[0]).toMatchObject({ sourceHandle: "data:out:metadata:label", targetHandle: "data:in:message:body" });
    expect(graphFromFlow(flow.nodes, flow.edges, group.graph).edges[0]).toMatchObject({
      sourcePortId: "metadata:label",
      targetPortId: "message:body"
    });
  });

  it("preserves graph variables when serializing React Flow state", () => {
    const group = {
      ...groupFixture(),
      graph: {
        ...groupFixture().graph,
        allowedSafety: ["read", "write", "external"] as AutomationSafety[],
        variables: [{ name: "branch", type: { kind: "string" as const }, defaultValue: "main" }]
      }
    };
    const flow = flowFromGraph(group, catalogFixture());

    expect(graphFromFlow(flow.nodes, flow.edges, group.graph).variables).toEqual(group.graph.variables);
    expect(graphFromFlow(flow.nodes, flow.edges, group.graph).allowedSafety).toEqual(["read", "write", "external"]);
  });

  it("strips stale saved safety policy when the panel returns to default safety", () => {
    const group = {
      ...groupFixture(),
      graph: {
        ...groupFixture().graph,
        allowedSafety: ["read", "write", "external"] as AutomationSafety[],
        variables: [{ name: "branch", type: { kind: "string" as const }, defaultValue: "main" }]
      }
    };
    const flow = flowFromGraph(group, catalogFixture());

    expect(automationAllowedSafetyWithToggle(["read", "write", "external"], "external", false)).toBeUndefined();
    const defaultSafetyGraph = automationGraphFromPanelState(flow.nodes, flow.edges, group.graph, undefined);
    expect(defaultSafetyGraph.allowedSafety).toBeUndefined();
    expect(defaultSafetyGraph.variables).toEqual(group.graph.variables);
    expect(defaultSafetyGraph.edges).toEqual(group.graph.edges);
    expect(automationGraphFromPanelState(flow.nodes, flow.edges, group.graph, ["read", "write", "external"]).allowedSafety).toEqual(["read", "write", "external"]);
  });

  it("compares missing safety policy using the server default policy semantics", () => {
    const graph = groupFixture().graph;

    expect(automationGraphsEqual(graph, { ...graph, allowedSafety: ["read", "write"] })).toBe(true);
    expect(automationGraphsEqual(graph, { ...graph, allowedSafety: [] })).toBe(false);
  });

  it("normalizes dragged connector routes through two-elbow orthogonal graph edges", () => {
    const group = {
      ...groupFixture(),
      graph: {
        ...groupFixture().graph,
        edges: [{ ...groupFixture().graph.edges[0]!, route: { offsetX: 42, offsetY: -35 } }]
      }
    };
    const flow = flowFromGraph(group, catalogFixture());

    expect(flow.edges[0]?.type).toBe("automation");
    expect(flow.edges[0]?.data).toMatchObject({ kind: "exec", routeOffsetX: 42 });
    expect(flow.edges[0]?.data).not.toHaveProperty("routeOffsetY");
    expect(graphFromFlow(flow.nodes, flow.edges, group.graph).edges[0]).toMatchObject({ route: { offsetX: 42 } });
    expect(automationGraphsEqual(graphFromFlow(flow.nodes, flow.edges, group.graph), group.graph)).toBe(true);
    expect(routedEdgePath(0, 0, 100, 100, { offsetX: 20, offsetY: 30 })).toMatchObject({
      path: "M 0 0 L 70 0 L 70 100 L 100 100",
      control: { x: 70, y: 50 },
      sourceBreak: { x: 70, y: 0 },
      targetBreak: { x: 70, y: 100 }
    });
    expect(routedEdgePath(0, 0, 100, 0).path).toBe("M 0 0 L 100 0");
    expect(routedEdgePath(0, 0, 100, 100).path).toBe("M 0 0 L 50 0 L 50 100 L 100 100");
  });

  it("builds new disabled automation groups with unique default names", () => {
    expect(normalizedAutomationGroupName("  New   workflow  ")).toBe("New workflow");
    expect(normalizedAutomationGroupName("   ")).toBeUndefined();
    expect(nextAutomationGroupName([{ name: "New automation" }, { name: "new automation 2" }])).toBe("New automation 3");
    expect(newAutomationGroup("Deploy", "automation-id", "2026-05-22T00:00:00.000Z")).toEqual({
      id: "automation-id",
      name: "Deploy",
      enabled: false,
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
      graph: {
        schemaVersion: 1,
        nodes: [],
        edges: [],
        variables: []
      }
    });
  });

  it("selects the next available automation after deleting the current group", () => {
    const previousGroups = [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }];

    expect(selectedAutomationGroupAfterDelete(previousGroups, [{ id: "alpha" }, { id: "gamma" }], "beta", "beta")?.id).toBe("gamma");
    expect(selectedAutomationGroupAfterDelete(previousGroups, [{ id: "alpha" }, { id: "beta" }], "gamma", "gamma")?.id).toBe("beta");
    expect(selectedAutomationGroupAfterDelete(previousGroups, [{ id: "beta" }, { id: "gamma" }], "alpha", "gamma")?.id).toBe("gamma");
    expect(selectedAutomationGroupAfterDelete([{ id: "alpha" }], [], "alpha", "alpha")).toBeUndefined();
  });

  it("uses automation type compatibility for connections", () => {
    const flow = flowFromGraph(groupFixture(), catalogFixture());
    const byType = new Map(catalogFixture().nodes.map((entry) => [entry.typeId, entry]));

    expect(automationTypeAssignable({ kind: "string" }, { kind: "unknown" })).toBe(true);
    expect(automationTypeAssignable({ kind: "unknown" }, { kind: "string" })).toBe(false);
    expect(automationTypeAssignable({ kind: "object", properties: { name: { kind: "string" } }, required: [] }, { kind: "object", properties: { name: { kind: "string" } }, required: ["name"] })).toBe(false);
    expect(
      connectionIsValid(
        {
          source: "trigger",
          sourceHandle: "data:out:text",
          target: "log",
          targetHandle: "data:in:message"
        },
        flow.nodes,
        byType
      )
    ).toBe(true);
    expect(
      connectionIsValid(
        {
          source: "trigger",
          sourceHandle: "data:out:text",
          target: "log",
          targetHandle: "exec:in:exec"
        },
        flow.nodes,
        byType
      )
    ).toBe(false);
    expect(
      connectionIsValid(
        {
          source: "trigger",
          sourceHandle: "data:out:text",
          target: "log",
          targetHandle: "exec:in:message"
        },
        flow.nodes,
        byType
      )
    ).toBe(false);
    expect(
      connectionIsValid(
        {
          source: "trigger",
          sourceHandle: "data:out:payload",
          target: "log",
          targetHandle: "data:in:message"
        },
        flow.nodes,
        byType
      )
    ).toBe(false);
  });

  it("resolves same-name data and exec handles by kind during connection validation", () => {
    const catalog = sameNamePortCatalogFixture();
    const flow = flowFromGraph(groupFixture(), catalog);
    const byType = new Map(catalog.nodes.map((entry) => [entry.typeId, entry]));

    expect(
      connectionIsValid(
        {
          source: "trigger",
          sourceHandle: "data:out:exec",
          target: "log",
          targetHandle: "data:in:exec"
        },
        flow.nodes,
        byType
      )
    ).toBe(true);
    expect(
      connectionIsValid(
        {
          source: "trigger",
          sourceHandle: "exec:out:exec",
          target: "log",
          targetHandle: "exec:in:exec"
        },
        flow.nodes,
        byType
      )
    ).toBe(true);
  });

  it("resolves connector palette compatibility by handle kind when port ids overlap", () => {
    const catalog = sameNamePortCatalogFixture();
    const flow = flowFromGraph(groupFixture(), catalog);
    const byType = new Map(catalog.nodes.map((entry) => [entry.typeId, entry]));

    expect(
      compatibilityFromConnectionState(
        { fromHandle: { id: "data:out:exec", nodeId: "trigger", type: "source" } } as never,
        flow.nodes,
        byType
      )
    ).toMatchObject({
      handleId: "data:out:exec",
      kind: "data",
      type: { kind: "string" }
    });
    expect(
      compatibilityFromConnectionState(
        { fromHandle: { id: "exec:out:exec", nodeId: "trigger", type: "source" } } as never,
        flow.nodes,
        byType
      )
    ).toMatchObject({
      handleId: "exec:out:exec",
      kind: "exec",
      type: { kind: "exec" }
    });
  });

  it("rejects self-cycles before they reach graph validation", () => {
    const flow = flowFromGraph(groupFixture(), catalogFixture());
    const byType = new Map(catalogFixture().nodes.map((entry) => [entry.typeId, entry]));

    expect(
      connectionIsValid(
        {
          source: "log",
          sourceHandle: "exec:out:exec",
          target: "log",
          targetHandle: "exec:in:exec"
        },
        flow.nodes,
        byType,
        flow.edges
      )
    ).toBe(false);
  });

  it("prevents one exec output from connecting to multiple program-flow targets", () => {
    const flow = flowFromGraph(groupFixture(), catalogFixture());
    const byType = new Map(catalogFixture().nodes.map((entry) => [entry.typeId, entry]));
    const connection = {
      source: "trigger",
      sourceHandle: "exec:out:exec",
      target: "log",
      targetHandle: "exec:in:exec"
    };
    const alternateTarget = { ...flow.nodes[1]!, id: "notify", position: { x: 400, y: 0 } };
    const movedConnection = { ...connection, target: "notify" };

    expect(hasProgramFlowConflict(connection, flow.edges)).toBe(true);
    expect(programFlowConflictEdges(connection, flow.edges).map((edge) => edge.id)).toEqual(["edge"]);
    expect(connectionIsValid(connection, flow.nodes, byType, flow.edges)).toBe(false);
    expect(connectionIsValid(movedConnection, [...flow.nodes, alternateTarget], byType, flow.edges)).toBe(false);
    expect(connectionIsValid(connection, flow.nodes, byType, flow.edges, "edge")).toBe(true);
    expect(connectionIsValid(movedConnection, [...flow.nodes, alternateTarget], byType, flow.edges, undefined, { allowProgramFlowReplacement: true })).toBe(true);
  });

  it("replaces an existing exec edge when a connected program-flow output is dragged again", () => {
    const flow = flowFromGraph(groupFixture(), catalogFixture());
    const replacement = {
      source: "trigger",
      sourceHandle: "exec:out:exec",
      target: "notify",
      targetHandle: "exec:in:exec"
    };
    const unrelatedDataEdge = {
      id: "data-edge",
      source: "trigger",
      sourceHandle: "data:out:text",
      target: "log",
      targetHandle: "data:in:message"
    };

    expect(removeProgramFlowConflicts(replacement, [...flow.edges, unrelatedDataEdge]).map((edge) => edge.id)).toEqual(["data-edge"]);
  });

  it("prevents ambiguous duplicate data inputs and supports deliberate replacement", () => {
    const flow = flowFromGraph(groupFixture(), catalogFixture());
    const byType = new Map(catalogFixture().nodes.map((entry) => [entry.typeId, entry]));
    const existingDataEdge = {
      id: "data-edge",
      source: "trigger",
      sourceHandle: "data:out:text",
      target: "log",
      targetHandle: "data:in:message"
    };
    const replacement = {
      source: "trigger",
      sourceHandle: "data:out:text",
      target: "log",
      targetHandle: "data:in:message"
    };

    expect(dataInputConflictEdges(replacement, [existingDataEdge]).map((edge) => edge.id)).toEqual(["data-edge"]);
    expect(connectionIsValid(replacement, flow.nodes, byType, [existingDataEdge])).toBe(false);
    expect(connectionIsValid(replacement, flow.nodes, byType, [existingDataEdge], undefined, { allowDataInputReplacement: true })).toBe(true);
    expect(connectionIsValid(replacement, flow.nodes, byType, [existingDataEdge], "data-edge")).toBe(true);
    expect(removeConnectionConflicts(replacement, [existingDataEdge, ...flow.edges]).map((edge) => edge.id)).toEqual(["edge"]);
  });

  it("removes edges attached to a right-clicked handle", () => {
    const flow = flowFromGraph(groupFixture(), catalogFixture());

    expect(deleteEdgesForHandle(flow.edges, { nodeId: "trigger", handleId: "exec:out:exec" })).toHaveLength(0);
    expect(deleteEdgesForHandle(flow.edges, { nodeId: "trigger", handleId: "data:out:text" })).toHaveLength(1);
  });

  it("detects data input ports that are filled by incoming connections", () => {
    const flow = flowFromGraph(groupFixture(), catalogFixture());
    const dataEdge = {
      id: "data-edge",
      source: "trigger",
      sourceHandle: "data:out:text",
      target: "log",
      targetHandle: "data:in:message"
    };

    expect(Array.from(connectedDataInputIds("log", [...flow.edges, dataEdge]))).toEqual(["message"]);
    expect(Array.from(connectedDataInputIds("trigger", flow.edges))).toEqual([]);
  });

  it("groups palette entries by plugin before built-in categories", () => {
    const groups = groupedPaletteEntries(paletteEntries(), "");

    expect(groups.map((group) => group.title)).toEqual(["Plugin: automation", "Plugin: standard-terminal", "CloudX Core", "Primitives", "Converters"]);
    expect(groups.find((group) => group.id === "plugin:standard-terminal")?.entries.map((entry) => entry.title)).toEqual(["Enter Text"]);
    expect(paletteGroupForEntry(paletteEntries()[0])).toEqual({ id: "plugin:standard-terminal", title: "Plugin: standard-terminal" });
  });

  it("filters palette entries across title, description, ids, and plugin groups", () => {
    const groups = groupedPaletteEntries(paletteEntries(), "terminal");

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: "plugin:standard-terminal", title: "Plugin: standard-terminal" });
    expect(groups[0].entries.map((entry) => entry.typeId)).toEqual(["hook:standard-terminal.enterText"]);
  });

  it("filters connector palettes by direct and converter-compatible entries", () => {
    const entries = compatiblePaletteEntries();
    const compatibility = {
      nodeId: "trigger",
      handleId: "data:out:text",
      handleType: "source" as const,
      kind: "data" as const,
      type: { kind: "string" as const }
    };
    const groups = groupedPaletteEntries(entries, "", compatibility);

    expect(groups.flatMap((group) => group.entries.map((entry) => entry.typeId)).sort()).toEqual(["converter:string.number", "hook:number", "hook:text"].sort());
    expect(connectionPlanForEntry(entries.find((entry) => entry.typeId === "hook:number")!, compatibility, entries)?.converter?.typeId).toBe("converter:string.number");
  });

  it("omits config-only ports from connector palette compatibility", () => {
    const entries = [
      ...compatiblePaletteEntries(),
      {
        typeId: "hook:configOnly",
        kind: "function" as const,
        title: "Config Only",
        description: "Accepts a non-connectable value.",
        inputs: [{ id: "payload", label: "Payload", kind: "data" as const, direction: "input" as const, type: { kind: "unknown" as const }, connectable: false }],
        outputs: []
      }
    ];
    const compatibility = {
      nodeId: "trigger",
      handleId: "data:out:text",
      handleType: "source" as const,
      kind: "data" as const,
      type: { kind: "string" as const }
    };

    expect(connectionPlanForEntry(entries.find((entry) => entry.typeId === "hook:configOnly")!, compatibility, entries)).toBeUndefined();
    expect(groupedPaletteEntries(entries, "", compatibility).flatMap((group) => group.entries.map((entry) => entry.typeId))).not.toContain("hook:configOnly");
  });

  it("keeps exec targets visible when a connected program-flow output will be replaced", () => {
    const flow = flowFromGraph(groupFixture(), catalogFixture());
    const compatibility = {
      nodeId: "trigger",
      handleId: "exec:out:exec",
      handleType: "source" as const,
      kind: "exec" as const,
      type: { kind: "exec" as const }
    };

    expect(connectionPlanForEntry(catalogFixture().nodes[1]!, compatibility, catalogFixture().nodes, flow.edges)).toMatchObject({
      direction: "from-origin",
      entryPortId: "exec"
    });
    expect(groupedPaletteEntries(catalogFixture().nodes, "", compatibility, flow.edges).flatMap((group) => group.entries.map((entry) => entry.typeId))).toContain("primitive:log");
  });

  it("plans converters when a new source node is dropped for an existing target input", () => {
    const entries = compatiblePaletteEntries();
    const compatibility = {
      nodeId: "target",
      handleId: "data:in:amount",
      handleType: "target" as const,
      kind: "data" as const,
      type: { kind: "number" as const }
    };

    expect(connectionPlanForEntry(entries.find((entry) => entry.typeId === "hook:textSource")!, compatibility, entries)?.converter?.typeId).toBe("converter:string.number");
    expect(groupedPaletteEntries(entries, "", compatibility).flatMap((group) => group.entries.map((entry) => entry.typeId))).toContain("hook:textSource");
  });

  it("builds inspector defaults for optional simple data inputs", () => {
    expect(defaultConfigForEntry(simpleInputEntry())).toEqual({ title: "", retries: 0, enabled: false });
  });

  it("uses catalog default values and option defaults in inspector config", () => {
    expect(defaultConfigForEntry(optionInputEntry())).toEqual({ pluginId: "codex-terminal", templateId: "focused", mode: "row" });
  });

  it("expands f-string node inputs from configured input names", () => {
    const now = new Date(0).toISOString();
    const group: AutomationGroup = {
      id: "group-fstring",
      name: "F-String",
      enabled: false,
      createdAt: now,
      updatedAt: now,
      graph: {
        schemaVersion: 1,
        nodes: [{ id: "format", typeId: AUTOMATION_FSTRING_TYPE_ID, position: { x: 0, y: 0 }, config: { template: "Hello {name}", inputNames: ["name", "count"] } }],
        edges: [],
        variables: []
      }
    };

    const flow = flowFromGraph(group, { nodes: [fStringEntry()] });

    expect(defaultConfigForEntry(fStringEntry())).toMatchObject({ template: "Hello {value}", inputNames: ["value"], value: "" });
    expect(flow.nodes[0]?.data.entry.inputs.map((port) => port.id)).toEqual(["name", "count"]);
    expect(primitiveConfigSummary(flow.nodes[0]!.data.entry, flow.nodes[0]!.data.config ?? {})).toContain("Template: Hello {name}");
  });

  it("summarizes primitive configured values for canvas nodes", () => {
    expect(primitiveConfigSummary(catalogFixture().nodes[1]!, { message: "New worktree created" })).toBe("Message: New worktree created");
    expect(primitiveConfigSummary(constantEntry(), { value: 42 })).toBe("Value: 42");
    expect(primitiveConfigSummary(defaultedPrimitiveInputEntry(), { value: null })).toBe("Value: null");
    expect(primitiveConfigSummary(paletteEntries()[0]!, { value: "ignored" })).toBeUndefined();
  });

  it("builds useful port hover text from descriptions, types, defaults, and choices", () => {
    expect(portTooltipText(optionInputEntry().inputs[0]!)).toContain("Workspace plugin to create");
    expect(portTooltipText(optionInputEntry().inputs[0]!)).toContain("Choices: Codex Terminal");
    expect(portTooltipText(optionInputEntry().inputs[0]!)).toContain("Format: string");
  });

  it("places port tooltips in the viewport instead of inside clipped nodes", () => {
    expect(portTooltipPlacementFromRect({ left: 280, right: 340, top: 305, bottom: 325 }, "input", { width: 1440, height: 900 })).toEqual({
      left: 280,
      top: 333,
      width: 280,
      maxHeight: 260
    });
    expect(portTooltipPlacementFromRect({ left: 1340, right: 1420, top: 305, bottom: 325 }, "output", { width: 1440, height: 900 }).left).toBe(1140);
    expect(portTooltipPlacementFromRect({ left: 2, right: 50, top: 305, bottom: 325 }, "input", { width: 360, height: 700 }).left).toBe(10);
    expect(portTooltipPlacementFromRect({ left: 200, right: 280, top: 770, bottom: 790 }, "input", { width: 900, height: 800 }).top).toBe(502);
  });

  it("only dismisses the palette for left pointer events outside the palette element", () => {
    expect(shouldClosePaletteForPointer(2, null, null)).toBe(false);
    expect(shouldClosePaletteForPointer(0, null, null)).toBe(true);
  });

  it("keeps the context palette inside the viewport", () => {
    expect(palettePositionFromPoint(187, 349, 390, 844)).toEqual({ x: 50, y: 349 });
    expect(palettePositionFromPoint(-20, 900, 390, 844)).toEqual({ x: 10, y: 414 });
  });

  it("keeps flow placement at the pointer even when the palette is screen-clamped", () => {
    expect(paletteStateFromPoint(400, 900, 390, 844, (point) => ({ x: point.x + 1, y: point.y + 2 }))).toMatchObject({
      x: 50,
      y: 414,
      flowX: 401,
      flowY: 902
    });
  });

  it("opens toolbar search palettes under the input and places new nodes in the canvas center", () => {
    expect(
      searchPaletteStateFromRects(
        { left: 620, top: 40, bottom: 72, width: 220, height: 32 },
        800,
        600,
        (point) => ({ x: point.x + 1, y: point.y + 2 }),
        { left: 120, top: 96, bottom: 596, width: 560, height: 500 }
      )
    ).toEqual({
      x: 460,
      y: 80,
      flowX: 401,
      flowY: 348
    });
  });

  it("formats automation action errors for status text", () => {
    expect(automationStatusFromError("Save", new Error("network down"))).toBe("Save failed: network down");
    expect(automationStatusFromError("Run", "bad response")).toBe("Run failed: bad response");
  });
});

function catalogFixture(): AutomationCatalogResponse {
  return {
    nodes: [
      {
        typeId: "trigger:test",
        kind: "trigger",
        title: "Test Trigger",
        description: "Start.",
        triggerId: "test",
        inputs: [],
        outputs: [
          { id: "exec", label: "Start", kind: "exec", direction: "output", type: { kind: "exec" } },
          { id: "payload", label: "Payload", kind: "data", direction: "output", type: { kind: "object", properties: {}, required: [] }, connectable: false },
          { id: "text", label: "Text", kind: "data", direction: "output", type: { kind: "string" } }
        ]
      },
      {
        typeId: "primitive:log",
        kind: "primitive",
        title: "Log",
        description: "Log.",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "message", label: "Message", kind: "data", direction: "input", type: { kind: "unknown" } }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function sameNamePortCatalogFixture(): AutomationCatalogResponse {
  const catalog = catalogFixture();
  return {
    nodes: catalog.nodes.map((entry) => {
      if (entry.typeId === "trigger:test") {
        return {
          ...entry,
          outputs: [...entry.outputs, { id: "exec", label: "Exec Field", kind: "data", direction: "output", type: { kind: "string" } }]
        };
      }
      if (entry.typeId === "primitive:log") {
        return {
          ...entry,
          inputs: [...entry.inputs, { id: "exec", label: "Exec Field", kind: "data", direction: "input", type: { kind: "string" } }]
        };
      }
      return entry;
    })
  };
}

function groupFixture(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group",
    name: "Group",
    enabled: false,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test", position: { x: 0, y: 0 } },
        { id: "log", typeId: "primitive:log", position: { x: 200, y: 0 }, config: { message: "done" } }
      ],
      edges: [{ id: "edge", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" }],
      variables: []
    }
  };
}

function paletteEntries(): AutomationNodeCatalogEntry[] {
  return [
    {
      typeId: "hook:standard-terminal.enterText",
      kind: "function",
      title: "Enter Text",
      description: "Send text to a shell.",
      pluginId: "standard-terminal",
      hookId: "standard-terminal.enterText",
      inputs: [],
      outputs: []
    },
    {
      typeId: "trigger:automation.runStarted",
      kind: "trigger",
      title: "Run Started",
      description: "Fire when automation starts.",
      pluginId: "automation",
      triggerId: "automation.runStarted",
      inputs: [],
      outputs: []
    },
    {
      typeId: "hook:workspace.tabs.create",
      kind: "function",
      title: "Create Tab",
      description: "Open a workspace tab.",
      hookId: "workspace.tabs.create",
      inputs: [],
      outputs: []
    },
    {
      typeId: "primitive:log",
      kind: "primitive",
      title: "Log",
      description: "Write a log line.",
      inputs: [],
      outputs: []
    },
    {
      typeId: "converter:string.number",
      kind: "converter",
      title: "String To Number",
      description: "Convert text into a number.",
      inputs: [],
      outputs: []
    }
  ];
}

function compatiblePaletteEntries(): AutomationNodeCatalogEntry[] {
  return [
    {
      typeId: "hook:text",
      kind: "function",
      title: "Use Text",
      description: "Accept text.",
      inputs: [{ id: "text", label: "Text", kind: "data", direction: "input", type: { kind: "string" } }],
      outputs: []
    },
    {
      typeId: "hook:number",
      kind: "function",
      title: "Use Number",
      description: "Accept a number.",
      inputs: [{ id: "amount", label: "Amount", kind: "data", direction: "input", type: { kind: "number" } }],
      outputs: []
    },
    {
      typeId: "hook:boolean",
      kind: "function",
      title: "Use Boolean",
      description: "Accept a flag.",
      inputs: [{ id: "flag", label: "Flag", kind: "data", direction: "input", type: { kind: "boolean" } }],
      outputs: []
    },
    {
      typeId: "hook:textSource",
      kind: "function",
      title: "Read Text",
      description: "Produce text.",
      inputs: [],
      outputs: [{ id: "text", label: "Text", kind: "data", direction: "output", type: { kind: "string" } }]
    },
    {
      typeId: "converter:string.number",
      kind: "converter",
      title: "String To Number",
      description: "Convert text into a number.",
      inputs: [{ id: "value", label: "Value", kind: "data", direction: "input", type: { kind: "string" } }],
      outputs: [{ id: "value", label: "Value", kind: "data", direction: "output", type: { kind: "number" } }]
    }
  ];
}

function simpleInputEntry(): AutomationNodeCatalogEntry {
  return {
    typeId: "hook:simple",
    kind: "function",
    title: "Simple Inputs",
    description: "Collect values.",
    inputs: [
      { id: "title", label: "Title", kind: "data", direction: "input", type: { kind: "string" } },
      { id: "retries", label: "Retries", kind: "data", direction: "input", type: { kind: "number" } },
      { id: "enabled", label: "Enabled", kind: "data", direction: "input", type: { kind: "boolean" } },
      { id: "payload", label: "Payload", kind: "data", direction: "input", type: { kind: "object" } }
    ],
    outputs: []
  };
}

function optionInputEntry(): AutomationNodeCatalogEntry {
  return {
    typeId: "hook:options",
    kind: "function",
    title: "Options",
    description: "Collect option values.",
    inputs: [
      {
        id: "pluginId",
        label: "Plugin",
        kind: "data",
        direction: "input",
        type: { kind: "string" },
        description: "Workspace plugin to create.",
        required: true,
        options: { source: "plugins.creatable", values: [{ value: "codex-terminal", label: "Codex Terminal" }] }
      },
      {
        id: "templateId",
        label: "Template",
        kind: "data",
        direction: "input",
        type: { kind: "string" },
        defaultValue: "focused",
        options: { source: "rulesSkills.templates", values: [{ value: "focused", label: "Focused" }] }
      },
      {
        id: "mode",
        label: "Mode",
        kind: "data",
        direction: "input",
        type: { kind: "string" },
        defaultValue: "row",
        options: { values: [{ value: "row", label: "Row" }, { value: "column", label: "Column" }] }
      }
    ],
    outputs: []
  };
}

function constantEntry(): AutomationNodeCatalogEntry {
  return {
    typeId: "primitive:constant.number",
    kind: "primitive",
    title: "Number",
    description: "Provide a configured number value.",
    inputs: [],
    outputs: [{ id: "value", label: "Value", kind: "data", direction: "output", type: { kind: "number" } }]
  };
}

function defaultedPrimitiveInputEntry(): AutomationNodeCatalogEntry {
  return {
    typeId: "primitive:defaulted",
    kind: "primitive",
    title: "Defaulted",
    description: "Uses an input default.",
    inputs: [{ id: "value", label: "Value", kind: "data", direction: "input", type: { kind: "string" }, defaultValue: "fallback" }],
    outputs: []
  };
}

function fStringEntry(): AutomationNodeCatalogEntry {
  return {
    typeId: AUTOMATION_FSTRING_TYPE_ID,
    kind: "primitive",
    title: "F-String",
    description: "Render a Python-style f-string template from named dynamic inputs.",
    inputs: [{ id: "value", label: "Value", kind: "data", direction: "input", type: { kind: "unknown" } }],
    outputs: [{ id: "value", label: "Value", kind: "data", direction: "output", type: { kind: "string" } }]
  };
}
