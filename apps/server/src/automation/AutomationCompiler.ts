import type { AutomationCatalogResponse, AutomationEdge, AutomationGraphDocument, AutomationNode, AutomationNodeCatalogEntry, AutomationPortDescriptor, AutomationValidationDiagnostic, AutomationValidationSummary } from "@cloudx/shared";
import { automationEntryWithDynamicPorts } from "@cloudx/shared";

import { AutomationTypeService } from "./AutomationTypeService.js";

export class AutomationCompiler {
  constructor(private readonly typeService: AutomationTypeService) {}

  validate(graph: AutomationGraphDocument, catalog: AutomationCatalogResponse): AutomationValidationSummary {
    const diagnostics: AutomationValidationDiagnostic[] = [];
    if (graph.schemaVersion !== 1) {
      diagnostics.push(error("schema-version", "Automation graph schemaVersion must be 1."));
    }
    const catalogByType = new Map(catalog.nodes.map((entry) => [entry.typeId, entry]));
    const entryForNode = (node: AutomationNode): AutomationNodeCatalogEntry | undefined => {
      const entry = catalogByType.get(node.typeId);
      return entry ? automationEntryWithDynamicPorts(entry, node.config) : undefined;
    };
    const nodesById = new Map<string, AutomationNode>();
    for (const node of graph.nodes) {
      if (nodesById.has(node.id)) {
        diagnostics.push(error("duplicate-node", `Duplicate node id: ${node.id}.`, node.id));
      }
      nodesById.set(node.id, node);
      if (!catalogByType.has(node.typeId)) {
        diagnostics.push(error("unknown-node-type", `Unknown node type: ${node.typeId}.`, node.id));
      }
    }
    if (!graph.nodes.some((node) => entryForNode(node)?.kind === "trigger")) {
      diagnostics.push(error("missing-trigger", "Automation graph requires at least one trigger node."));
    }
    const dataIncoming = new Map<string, AutomationEdge[]>();
    const execOutgoing = new Map<string, AutomationEdge>();
    for (const edge of graph.edges) {
      const source = nodesById.get(edge.sourceNodeId);
      const target = nodesById.get(edge.targetNodeId);
      if (!source) {
        diagnostics.push(error("missing-source-node", `Edge source node does not exist: ${edge.sourceNodeId}.`, undefined, edge.id));
        continue;
      }
      if (!target) {
        diagnostics.push(error("missing-target-node", `Edge target node does not exist: ${edge.targetNodeId}.`, undefined, edge.id));
        continue;
      }
      const sourceEntry = entryForNode(source);
      const targetEntry = entryForNode(target);
      if (!sourceEntry || !targetEntry) {
        continue;
      }
      const sourcePort = sourceEntry.outputs.find((port) => port.id === edge.sourcePortId);
      const targetPort = targetEntry.inputs.find((port) => port.id === edge.targetPortId);
      if (!sourcePort) {
        diagnostics.push(error("missing-source-port", `Source port ${edge.sourcePortId} does not exist on ${sourceEntry.title}.`, source.id, edge.id, edge.sourcePortId));
        continue;
      }
      if (!targetPort) {
        diagnostics.push(error("missing-target-port", `Target port ${edge.targetPortId} does not exist on ${targetEntry.title}.`, target.id, edge.id, edge.targetPortId));
        continue;
      }
      if (sourcePort.kind !== edge.kind || targetPort.kind !== edge.kind) {
        diagnostics.push(error("port-kind-mismatch", `Edge ${edge.id} is ${edge.kind}, but connects ${sourcePort.kind} to ${targetPort.kind}.`, target.id, edge.id));
        continue;
      }
      if (sourcePort.connectable === false || targetPort.connectable === false) {
        diagnostics.push(error("non-connectable-port", `Edge ${edge.id} connects a config-only value. Use a visible typed port instead.`, target.id, edge.id, targetPort.id));
        continue;
      }
      if (edge.kind === "exec") {
        const key = `${source.id}:${sourcePort.id}`;
        const existing = execOutgoing.get(key);
        if (existing) {
          diagnostics.push(error("duplicate-program-flow", `${sourceEntry.title} output ${sourcePort.label} can only continue to one node.`, source.id, edge.id, sourcePort.id));
        } else {
          execOutgoing.set(key, edge);
        }
      }
      if (edge.kind === "data") {
        if (!this.typeService.isAssignable(sourcePort.type, targetPort.type)) {
          diagnostics.push(error("type-mismatch", `Cannot connect ${this.typeService.format(sourcePort.type)} to ${this.typeService.format(targetPort.type)}. Add an explicit converter node.`, target.id, edge.id, edge.targetPortId));
        }
        const key = `${target.id}:${targetPort.id}`;
        dataIncoming.set(key, [...(dataIncoming.get(key) ?? []), edge]);
      }
    }
    for (const node of graph.nodes) {
      const entry = entryForNode(node);
      if (!entry) {
        continue;
      }
      for (const port of entry.inputs.filter((port) => port.kind === "data" && port.required)) {
        const configured = Object.prototype.hasOwnProperty.call(node.config ?? {}, port.id);
        const wired = (dataIncoming.get(`${node.id}:${port.id}`) ?? []).length > 0;
        if (!configured && !wired) {
          diagnostics.push(error("missing-required-input", `${entry.title} requires input ${port.label}.`, node.id, undefined, port.id));
        }
      }
    }
    return { valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"), diagnostics };
  }

  nodeEntry(node: AutomationNode, catalog: AutomationCatalogResponse): AutomationNodeCatalogEntry | undefined {
    const entry = catalog.nodes.find((candidate) => candidate.typeId === node.typeId);
    return entry ? automationEntryWithDynamicPorts(entry, node.config) : undefined;
  }

  port(entry: AutomationNodeCatalogEntry, direction: "input" | "output", id: string): AutomationPortDescriptor | undefined {
    const ports = direction === "input" ? entry.inputs : entry.outputs;
    return ports.find((port) => port.id === id);
  }
}

function error(code: string, message: string, nodeId?: string, edgeId?: string, portId?: string): AutomationValidationDiagnostic {
  return { severity: "error", code, message, nodeId, edgeId, portId };
}
