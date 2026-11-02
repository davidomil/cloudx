import type { CooperationConnection, CooperationGeometry, CooperationItem, CooperationPoint, CooperationPort } from "./cooperation.js";

export interface CooperationBounds { x: number; y: number; width: number; height: number }
export const COOPERATION_GEOMETRY_EPSILON = 0.000001;

export function itemPointWorld(geometry: CooperationGeometry, point: CooperationPoint): CooperationPoint {
  const angle = geometry.rotation * Math.PI / 180;
  const dx = point[0] - geometry.width / 2;
  const dy = point[1] - geometry.height / 2;
  return [geometry.x + geometry.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
    geometry.y + geometry.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle)];
}

export function itemPortWorld(item: Pick<CooperationItem, "geometry">, port: CooperationPort): CooperationPoint {
  const { width, height } = item.geometry;
  const ports: Record<CooperationPort, CooperationPoint> = {
    center: [width / 2, height / 2], north: [width / 2, 0], east: [width, height / 2],
    south: [width / 2, height], west: [0, height / 2]
  };
  return itemPointWorld(item.geometry, ports[port]);
}

export function itemBounds(item: Pick<CooperationItem, "geometry">): CooperationBounds {
  const { width, height } = item.geometry;
  const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(point => itemPointWorld(item.geometry, point as CooperationPoint));
  const xs = corners.map(point => point[0]);
  const ys = corners.map(point => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function boundsIntersect(a: CooperationBounds, b: CooperationBounds): boolean {
  return a.x <= b.x + b.width + COOPERATION_GEOMETRY_EPSILON && a.x + a.width + COOPERATION_GEOMETRY_EPSILON >= b.x &&
    a.y <= b.y + b.height + COOPERATION_GEOMETRY_EPSILON && a.y + a.height + COOPERATION_GEOMETRY_EPSILON >= b.y;
}

export function connectionPolyline(connection: CooperationConnection, items: readonly CooperationItem[]): CooperationPoint[] {
  const source = items.find(item => item.id === connection.from.itemId);
  const target = items.find(item => item.id === connection.to.itemId);
  if (!source || !target) throw new Error("Connection endpoints must reference live items.");
  return [itemPortWorld(source, connection.from.port), ...connection.waypoints, itemPortWorld(target, connection.to.port)];
}

export function polylineMidpoint(points: readonly CooperationPoint[]): CooperationPoint {
  if (!points.length) throw new Error("A polyline requires a point.");
  const distances = points.slice(1).map((point, i) => Math.hypot(point[0] - points[i][0], point[1] - points[i][1]));
  let remaining = distances.reduce((sum, distance) => sum + distance, 0) / 2;
  for (let i = 0; i < distances.length; i++) {
    if (remaining <= distances[i] && distances[i] > 0) {
      const ratio = remaining / distances[i];
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * ratio, points[i][1] + (points[i + 1][1] - points[i][1]) * ratio];
    }
    remaining -= distances[i];
  }
  return points[0];
}

export function connectionLabelCenter(connection: CooperationConnection, items: readonly CooperationItem[]): CooperationPoint {
  return polylineMidpoint(connectionPolyline(connection, items));
}

export function connectionLabelBounds(connection: CooperationConnection, items: readonly CooperationItem[]): CooperationBounds {
  const [x, y] = connectionLabelCenter(connection, items);
  return { x: x - 100, y: y - 24, width: 200, height: 48 };
}

export function segmentIntersectsBounds(from: CooperationPoint, to: CooperationPoint, bounds: CooperationBounds, padding = 0): boolean {
  const min = [bounds.x - padding - COOPERATION_GEOMETRY_EPSILON, bounds.y - padding - COOPERATION_GEOMETRY_EPSILON];
  const max = [bounds.x + bounds.width + padding + COOPERATION_GEOMETRY_EPSILON, bounds.y + bounds.height + padding + COOPERATION_GEOMETRY_EPSILON];
  let entering = 0;
  let leaving = 1;
  for (let axis = 0; axis < 2; axis++) {
    const delta = to[axis] - from[axis];
    if (Math.abs(delta) < Number.EPSILON) {
      if (from[axis] < min[axis] || from[axis] > max[axis]) return false;
    } else {
      const a = (min[axis] - from[axis]) / delta;
      const b = (max[axis] - from[axis]) / delta;
      entering = Math.max(entering, Math.min(a, b));
      leaving = Math.min(leaving, Math.max(a, b));
      if (entering > leaving) return false;
    }
  }
  return true;
}

export function connectionIntersectsRegion(connection: CooperationConnection, items: readonly CooperationItem[], region: CooperationBounds): boolean {
  const points = connectionPolyline(connection, items);
  return boundsIntersect(connectionLabelBounds(connection, items), region) ||
    points.slice(1).some((point, i) => segmentIntersectsBounds(points[i], point, region, 1));
}

export function cooperationAnchorMatches(text: string, anchor: { start: number; end: number; exact: string; prefix: string; suffix: string }): boolean {
  const points = Array.from(text);
  return anchor.start < anchor.end && anchor.end <= points.length &&
    points.slice(anchor.start, anchor.end).join("") === anchor.exact &&
    points.slice(0, anchor.start).join("").endsWith(anchor.prefix) &&
    points.slice(anchor.end).join("").startsWith(anchor.suffix);
}
