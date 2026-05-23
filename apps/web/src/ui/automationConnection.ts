import { automationTypeAssignable, type AutomationNodeCatalogEntry, type AutomationPortDescriptor } from "@cloudx/shared";

import { handleKind, handlePort, type FlowNode } from "./automationGraphAdapter.js";

export interface ConnectionLike {
  id?: string;
  source: string | null;
  sourceHandle?: string | null;
  target: string | null;
  targetHandle?: string | null;
}

export interface ConnectionValidationOptions {
  allowProgramFlowReplacement?: boolean;
  allowDataInputReplacement?: boolean;
}

export interface AutomationHandleRef {
  nodeId: string;
  handleId: string;
}

export { automationTypeAssignable };

export function connectionIsValid(
  connection: ConnectionLike,
  nodes: FlowNode[],
  catalogByType: Map<string, AutomationNodeCatalogEntry>,
  edges: ConnectionLike[] = [],
  ignoredEdgeId?: string,
  options: ConnectionValidationOptions = {}
): boolean {
  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  if (!sourceNode || !targetNode || !connection.sourceHandle || !connection.targetHandle) {
    return false;
  }
  const sourceEntry = sourceNode.data.entry;
  const targetEntry = targetNode.data.entry;
  if (!sourceEntry || !targetEntry) {
    return false;
  }
  const sourceKind = handleKind(connection.sourceHandle);
  const targetKind = handleKind(connection.targetHandle);
  const sourcePort = sourceEntry.outputs.find((port) => port.kind === sourceKind && port.id === handlePort(connection.sourceHandle));
  const targetPort = targetEntry.inputs.find((port) => port.kind === targetKind && port.id === handlePort(connection.targetHandle));
  if (
    !sourcePort ||
    !targetPort ||
    sourcePort.kind !== targetPort.kind ||
    sourcePort.kind !== sourceKind ||
    targetPort.kind !== targetKind
  ) {
    return false;
  }
  if (!portIsConnectable(sourcePort) || !portIsConnectable(targetPort)) {
    return false;
  }
  if (sourcePort.kind === "exec" && hasProgramFlowConflict(connection, edges, ignoredEdgeId) && !options.allowProgramFlowReplacement) {
    return false;
  }
  if (sourcePort.kind === "data" && hasDataInputConflict(connection, edges, ignoredEdgeId) && !options.allowDataInputReplacement) {
    return false;
  }
  if (sourcePort.kind === "exec" && connectionCreatesCycle(connection, edges, ignoredEdgeId)) {
    return false;
  }
  return sourcePort.kind === "exec" || automationTypeAssignable(sourcePort.type, targetPort.type);
}

export function hasProgramFlowConflict(connection: ConnectionLike, edges: ConnectionLike[], ignoredEdgeId?: string): boolean {
  return programFlowConflictEdges(connection, edges, ignoredEdgeId).length > 0;
}

export function programFlowConflictEdges<T extends ConnectionLike>(connection: ConnectionLike, edges: T[], ignoredEdgeId?: string): T[] {
  if (!connection.source || !connection.sourceHandle || handleKind(connection.sourceHandle) !== "exec") {
    return [];
  }
  return edges.filter((edge) => edge.id !== ignoredEdgeId && edge.source === connection.source && edge.sourceHandle === connection.sourceHandle && handleKind(edge.sourceHandle) === "exec");
}

export function removeProgramFlowConflicts<T extends ConnectionLike>(connection: ConnectionLike | undefined, edges: T[], ignoredEdgeId?: string): T[] {
  if (!connection) {
    return edges;
  }
  const conflictIds = new Set(programFlowConflictEdges(connection, edges, ignoredEdgeId).map((edge) => edge.id).filter((id): id is string => typeof id === "string"));
  return conflictIds.size > 0 ? edges.filter((edge) => !edge.id || !conflictIds.has(edge.id)) : edges;
}

export function hasDataInputConflict(connection: ConnectionLike, edges: ConnectionLike[], ignoredEdgeId?: string): boolean {
  return dataInputConflictEdges(connection, edges, ignoredEdgeId).length > 0;
}

export function dataInputConflictEdges<T extends ConnectionLike>(connection: ConnectionLike, edges: T[], ignoredEdgeId?: string): T[] {
  if (!connection.target || !connection.targetHandle || handleKind(connection.targetHandle) !== "data") {
    return [];
  }
  return edges.filter((edge) => edge.id !== ignoredEdgeId && edge.target === connection.target && edge.targetHandle === connection.targetHandle && handleKind(edge.targetHandle) === "data");
}

export function removeDataInputConflicts<T extends ConnectionLike>(connection: ConnectionLike | undefined, edges: T[], ignoredEdgeId?: string): T[] {
  if (!connection) {
    return edges;
  }
  const conflictIds = new Set(dataInputConflictEdges(connection, edges, ignoredEdgeId).map((edge) => edge.id).filter((id): id is string => typeof id === "string"));
  return conflictIds.size > 0 ? edges.filter((edge) => !edge.id || !conflictIds.has(edge.id)) : edges;
}

export function removeConnectionConflicts<T extends ConnectionLike>(connection: ConnectionLike | undefined, edges: T[], ignoredEdgeId?: string): T[] {
  return removeDataInputConflicts(connection, removeProgramFlowConflicts(connection, edges, ignoredEdgeId), ignoredEdgeId);
}

export function connectionCreatesCycle(connection: ConnectionLike, edges: ConnectionLike[], ignoredEdgeId?: string): boolean {
  if (!connection.source || !connection.target || !connection.sourceHandle || handleKind(connection.sourceHandle) !== "exec") {
    return false;
  }
  if (connection.source === connection.target) {
    return true;
  }
  const outgoing = new Map<string, ConnectionLike[]>();
  for (const edge of edges) {
    if (edge.id === ignoredEdgeId || !edge.source || !edge.target || !edge.sourceHandle || handleKind(edge.sourceHandle) !== "exec") {
      continue;
    }
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }
  const queue = [connection.target];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === connection.source) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const edge of outgoing.get(current) ?? []) {
      if (edge.target) {
        queue.push(edge.target);
      }
    }
  }
  return false;
}

export function deleteEdgesForHandle<T extends ConnectionLike>(edges: T[], handle: AutomationHandleRef): T[] {
  return edges.filter((edge) => !edgeTouchesHandle(edge, handle));
}

export function connectedDataInputIds(nodeId: string | undefined, edges: ConnectionLike[]): Set<string> {
  if (!nodeId) {
    return new Set();
  }
  return new Set(
    edges
      .filter((edge) => edge.target === nodeId && edge.targetHandle && handleKind(edge.targetHandle) === "data")
      .map((edge) => handlePort(edge.targetHandle))
      .filter(Boolean)
  );
}

export function portIsConnectable(port: AutomationPortDescriptor): boolean {
  return port.connectable !== false;
}

function edgeTouchesHandle(edge: ConnectionLike, handle: AutomationHandleRef): boolean {
  return (edge.source === handle.nodeId && edge.sourceHandle === handle.handleId) || (edge.target === handle.nodeId && edge.targetHandle === handle.handleId);
}
