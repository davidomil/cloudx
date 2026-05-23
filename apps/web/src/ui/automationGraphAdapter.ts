import type { Edge, Node, XYPosition } from "@xyflow/react";
import type {
  AutomationCatalogResponse,
  AutomationEdge,
  AutomationEdgeRoute,
  AutomationGroup,
  AutomationNodeCatalogEntry,
  AutomationPortKind
} from "@cloudx/shared";
import { DEFAULT_AUTOMATION_ALLOWED_SAFETY, automationEntryWithDynamicPorts } from "@cloudx/shared";

export interface AutomationNodeData extends Record<string, unknown> {
  entry: AutomationNodeCatalogEntry;
  config?: Record<string, unknown>;
}

export interface AutomationEdgeData extends Record<string, unknown> {
  kind: AutomationPortKind;
  routeOffsetX?: number;
  routeOffsetY?: number;
  onRouteChange?: (edgeId: string, route: AutomationEdgeRoute) => void;
}

export type FlowNode = Node<AutomationNodeData, "automation">;
export type FlowEdge = Edge<AutomationEdgeData, "automation">;

export function flowFromGraph(group: AutomationGroup, catalog: AutomationCatalogResponse): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const catalogByType = new Map(catalog.nodes.map((entry) => [entry.typeId, entry]));
  return {
    nodes: group.graph.nodes.map((node) => ({
      id: node.id,
      type: "automation",
      position: node.position,
      data: {
        entry: automationEntryWithDynamicPorts(catalogByType.get(node.typeId) ?? missingEntry(node.typeId), node.config ?? {}),
        config: node.config ?? {}
      }
    })),
    edges: group.graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      sourceHandle: handleForPort(edge.kind, "out", edge.sourcePortId),
      target: edge.targetNodeId,
      targetHandle: handleForPort(edge.kind, "in", edge.targetPortId),
      type: "automation",
      reconnectable: true,
      animated: edge.kind === "exec",
      data: flowEdgeData(edge.kind, edge.route)
    }))
  };
}

export function graphFromFlow(nodes: FlowNode[], edges: FlowEdge[], baseGraph?: AutomationGroup["graph"]): AutomationGroup["graph"] {
  return {
    schemaVersion: 1,
    nodes: nodes.map((node) => ({
      id: node.id,
      typeId: node.data.entry.typeId,
      position: node.position,
      config: node.data.config ?? {}
    })),
    edges: edges.map((edge): AutomationEdge => normalizeAutomationGraphEdge({
      id: edge.id,
      kind: handleKind(edge.sourceHandle),
      sourceNodeId: edge.source,
      sourcePortId: handlePort(edge.sourceHandle),
      targetNodeId: edge.target,
      targetPortId: handlePort(edge.targetHandle),
      ...routeGraphPatch(edgeRouteFromData(edge.data))
    })),
    variables: [...(baseGraph?.variables ?? [])],
    ...(baseGraph?.allowedSafety ? { allowedSafety: [...baseGraph.allowedSafety] } : {})
  };
}

export function automationGraphsEqual(left: AutomationGroup["graph"] | undefined, right: AutomationGroup["graph"] | undefined): boolean {
  return stableStringify(normalizeAutomationGraph(left)) === stableStringify(normalizeAutomationGraph(right));
}

export interface RoutedEdgePath {
  path: string;
  control: XYPosition;
  sourceBreak: XYPosition;
  targetBreak: XYPosition;
}

export function routedEdgePath(sourceX: number, sourceY: number, targetX: number, targetY: number, route?: AutomationEdgeRoute): RoutedEdgePath {
  const breakX = (sourceX + targetX) / 2 + (route?.offsetX ?? 0);
  const control = {
    x: breakX,
    y: (sourceY + targetY) / 2
  };
  const sourceBreak = { x: breakX, y: sourceY };
  const targetBreak = { x: breakX, y: targetY };
  const points = compactOrthogonalPoints([
    { x: sourceX, y: sourceY },
    sourceBreak,
    targetBreak,
    { x: targetX, y: targetY }
  ]);
  return {
    path: pathFromOrthogonalPoints(points),
    control,
    sourceBreak,
    targetBreak
  };
}

export function flowEdgeData(kind: AutomationPortKind, route?: AutomationEdgeRoute): AutomationEdgeData {
  return {
    kind,
    ...normalizedRouteData(route)
  };
}

export function edgeRouteFromData(data: AutomationEdgeData | undefined): AutomationEdgeRoute | undefined {
  return normalizedRoute(data?.routeOffsetX);
}

export function handleKind(handle: string | null | undefined): AutomationPortKind {
  return handle?.startsWith("exec:") ? "exec" : "data";
}

export function handlePort(handle: string | null | undefined): string {
  if (!handle) {
    return "";
  }
  const firstSeparator = handle.indexOf(":");
  const secondSeparator = firstSeparator === -1 ? -1 : handle.indexOf(":", firstSeparator + 1);
  return secondSeparator === -1 ? "" : handle.slice(secondSeparator + 1);
}

export function handleForPort(kind: AutomationPortKind, direction: "in" | "out", portId: string): string {
  return `${kind}:${direction}:${portId}`;
}

function normalizeAutomationGraph(graph: AutomationGroup["graph"] | undefined): unknown {
  if (!graph) {
    return undefined;
  }
  return {
    schemaVersion: graph.schemaVersion,
    nodes: [...graph.nodes]
      .map((node) => ({
        id: node.id,
        typeId: node.typeId,
        position: node.position,
        config: node.config ?? {}
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...graph.edges].map(normalizeAutomationGraphEdge).sort((left, right) => left.id.localeCompare(right.id)),
    variables: [...(graph.variables ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
    allowedSafety: [...(graph.allowedSafety ?? DEFAULT_AUTOMATION_ALLOWED_SAFETY)].sort()
  };
}

function normalizeAutomationGraphEdge(edge: AutomationEdge): AutomationEdge {
  return {
    id: edge.id,
    kind: edge.kind,
    sourceNodeId: edge.sourceNodeId,
    sourcePortId: edge.sourcePortId,
    targetNodeId: edge.targetNodeId,
    targetPortId: edge.targetPortId,
    ...routeGraphPatch(normalizedRoute(edge.route?.offsetX))
  };
}

function routeGraphPatch(route: AutomationEdgeRoute | undefined): { route?: AutomationEdgeRoute } {
  return route ? { route } : {};
}

function normalizedRouteData(route: AutomationEdgeRoute | undefined): Pick<AutomationEdgeData, "routeOffsetX" | "routeOffsetY"> {
  const normalized = normalizedRoute(route?.offsetX);
  return normalized ? { routeOffsetX: normalized.offsetX } : {};
}

function normalizedRoute(offsetX: unknown): AutomationEdgeRoute | undefined {
  const x = finiteRouteNumber(offsetX);
  return x === undefined ? undefined : { offsetX: x };
}

function finiteRouteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return Math.abs(rounded) >= 1 ? rounded : undefined;
}

function compactOrthogonalPoints(points: XYPosition[]): XYPosition[] {
  return points.reduce<XYPosition[]>((result, point) => {
    const previous = result[result.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) {
      return result;
    }
    const beforePrevious = result[result.length - 2];
    if (beforePrevious && previous && pointsAreCollinear(beforePrevious, previous, point)) {
      result[result.length - 1] = point;
      return result;
    }
    result.push(point);
    return result;
  }, []);
}

function pointsAreCollinear(first: XYPosition, second: XYPosition, third: XYPosition): boolean {
  return (first.x === second.x && second.x === third.x) || (first.y === second.y && second.y === third.y);
}

function pathFromOrthogonalPoints(points: XYPosition[]): string {
  const [first, ...rest] = points;
  if (!first) {
    return "";
  }
  return [`M ${first.x} ${first.y}`, ...rest.map((point) => `L ${point.x} ${point.y}`)].join(" ");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function missingEntry(typeId: string): AutomationNodeCatalogEntry {
  return {
    typeId,
    kind: "primitive",
    title: "Missing Node",
    description: `Catalog entry ${typeId} is no longer available.`,
    inputs: [],
    outputs: []
  };
}
