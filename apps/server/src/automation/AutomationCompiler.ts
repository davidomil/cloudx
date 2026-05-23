import type { AutomationCatalogResponse, AutomationEdge, AutomationGraphDocument, AutomationNode, AutomationNodeCatalogEntry, AutomationPortDescriptor, AutomationValidationDiagnostic, AutomationValidationSummary } from "@cloudx/shared";
import { automationEntryWithDynamicPorts, automationSafetyAllowed } from "@cloudx/shared";

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
    const variablesByName = new Set<string>();
    for (const variable of graph.variables ?? []) {
      const name = variable.name.trim();
      if (!name || name !== variable.name) {
        diagnostics.push(error("invalid-variable-name", "Automation variable names must be non-empty trimmed strings."));
        continue;
      }
      if (variablesByName.has(name)) {
        diagnostics.push(error("duplicate-variable", `Duplicate variable name: ${name}.`));
      }
      variablesByName.add(name);
      if (variable.defaultValue !== undefined && !this.typeService.isAssignable(this.typeService.valueToType(variable.defaultValue), variable.type)) {
        diagnostics.push(
          error(
            "variable-default-type-mismatch",
            `Variable ${name} default is ${this.typeService.format(this.typeService.valueToType(variable.defaultValue))}, but declares ${this.typeService.format(variable.type)}.`
          )
        );
      }
    }
    const dataIncoming = new Map<string, AutomationEdge[]>();
    const execOutgoing = new Map<string, AutomationEdge>();
    const edgesById = new Set<string>();
    const execEdges: AutomationEdge[] = [];
    for (const edge of graph.edges) {
      if (edgesById.has(edge.id)) {
        diagnostics.push(error("duplicate-edge", `Duplicate edge id: ${edge.id}.`, undefined, edge.id));
      }
      edgesById.add(edge.id);
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
      const sourcePort = portForEdge(sourceEntry.outputs, edge.sourcePortId, edge.kind);
      const targetPort = portForEdge(targetEntry.inputs, edge.targetPortId, edge.kind);
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
        execEdges.push(edge);
      }
      if (edge.kind === "data") {
        if (!this.typeService.isAssignable(sourcePort.type, targetPort.type)) {
          diagnostics.push(error("type-mismatch", `Cannot connect ${this.typeService.format(sourcePort.type)} to ${this.typeService.format(targetPort.type)}. Add an explicit converter node.`, target.id, edge.id, edge.targetPortId));
        }
        const key = `${target.id}:${targetPort.id}`;
        const incoming = dataIncoming.get(key) ?? [];
        if (incoming.length > 0) {
          diagnostics.push(error("duplicate-data-input", `${targetEntry.title} input ${targetPort.label} can only receive one data connection.`, target.id, edge.id, targetPort.id));
        }
        dataIncoming.set(key, [...incoming, edge]);
      }
    }
    diagnostics.push(...programFlowCycleDiagnostics(execEdges));
    for (const node of graph.nodes) {
      const entry = entryForNode(node);
      if (!entry) {
        continue;
      }
      if (entry.kind === "function" && !automationSafetyAllowed(entry.safety, graph.allowedSafety)) {
        diagnostics.push(error("automation-safety-policy", `${entry.title} requires ${entry.safety} automation safety. Enable ${entry.safety} for this graph before it can run.`, node.id));
      }
      for (const port of entry.inputs.filter((port) => port.kind === "data" && port.required)) {
        const configured = hasConfiguredValue(node, port.id);
        const wired = (dataIncoming.get(`${node.id}:${port.id}`) ?? []).length > 0;
        if (!configured && !wired && !this.defaultMatchesPort(port)) {
          diagnostics.push(error("missing-required-input", `${entry.title} requires input ${port.label}.`, node.id, undefined, port.id));
        }
      }
      for (const port of entry.inputs.filter((port) => port.kind === "data")) {
        const configured = hasConfiguredValue(node, port.id);
        const wired = (dataIncoming.get(`${node.id}:${port.id}`) ?? []).length > 0;
        if (hasUsableDefault(port) && !this.defaultMatchesPort(port)) {
          diagnostics.push(
            error(
              "default-type-mismatch",
              `${entry.title} default input ${port.label} is ${this.typeService.format(this.typeService.valueToType(port.defaultValue))}, but requires ${this.typeService.format(port.type)}.`,
              node.id,
              undefined,
              port.id
            )
          );
        }
        if (configured && !wired && !this.typeService.isAssignable(this.typeService.valueToType(node.config?.[port.id]), port.type)) {
          diagnostics.push(
            error(
              "config-type-mismatch",
              `${entry.title} configured input ${port.label} is ${this.typeService.format(this.typeService.valueToType(node.config?.[port.id]))}, but requires ${this.typeService.format(port.type)}.`,
              node.id,
              undefined,
              port.id
            )
          );
        }
      }
    }
    return { valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"), diagnostics };
  }

  nodeEntry(node: AutomationNode, catalog: AutomationCatalogResponse): AutomationNodeCatalogEntry | undefined {
    const entry = catalog.nodes.find((candidate) => candidate.typeId === node.typeId);
    return entry ? automationEntryWithDynamicPorts(entry, node.config) : undefined;
  }

  port(entry: AutomationNodeCatalogEntry, direction: "input" | "output", id: string, kind?: AutomationPortDescriptor["kind"]): AutomationPortDescriptor | undefined {
    const ports = direction === "input" ? entry.inputs : entry.outputs;
    return ports.find((port) => port.id === id && (!kind || port.kind === kind));
  }

  private defaultMatchesPort(port: AutomationPortDescriptor): boolean {
    return hasUsableDefault(port) && this.typeService.isAssignable(this.typeService.valueToType(port.defaultValue), port.type);
  }
}

function hasConfiguredValue(node: AutomationNode, portId: string): boolean {
  return Object.prototype.hasOwnProperty.call(node.config ?? {}, portId) && node.config?.[portId] !== undefined;
}

function hasUsableDefault(port: AutomationPortDescriptor): boolean {
  return port.defaultValue !== undefined;
}

function portForEdge(ports: AutomationPortDescriptor[], id: string, kind: AutomationPortDescriptor["kind"]): AutomationPortDescriptor | undefined {
  return ports.find((port) => port.id === id && port.kind === kind);
}

function programFlowCycleDiagnostics(edges: AutomationEdge[]): AutomationValidationDiagnostic[] {
  return edges
    .filter((edge) => edge.sourceNodeId === edge.targetNodeId || hasProgramFlowPath(edge.targetNodeId, edge.sourceNodeId, edges, edge.id))
    .map((edge) => error("program-flow-cycle", "Program-flow edges cannot form cycles.", edge.targetNodeId, edge.id, edge.targetPortId));
}

function hasProgramFlowPath(sourceNodeId: string, targetNodeId: string, edges: AutomationEdge[], ignoredEdgeId: string): boolean {
  const outgoing = new Map<string, AutomationEdge[]>();
  for (const edge of edges) {
    if (edge.id === ignoredEdgeId) {
      continue;
    }
    outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge]);
  }
  const visited = new Set<string>();
  const queue = [sourceNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetNodeId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const edge of outgoing.get(current) ?? []) {
      queue.push(edge.targetNodeId);
    }
  }
  return false;
}

function error(code: string, message: string, nodeId?: string, edgeId?: string, portId?: string): AutomationValidationDiagnostic {
  return { severity: "error", code, message, nodeId, edgeId, portId };
}
