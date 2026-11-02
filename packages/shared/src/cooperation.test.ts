import { describe, expect, it } from "vitest";
import { codePointOffset, isCooperationId, type CooperationConnection, type CooperationItem } from "./cooperation.js";
import { boundsIntersect, cooperationAnchorMatches, connectionIntersectsRegion, connectionLabelCenter, connectionPolyline, itemBounds, itemPortWorld, polylineMidpoint, segmentIntersectsBounds } from "./cooperationGeometry.js";

const item = (id: string, x = 0, rotation = 0): CooperationItem => ({ id, kind: "shape", revision: 1,
  geometry: { x, y: 0, width: 100, height: 100, rotation }, createdBy: "user:local", updatedBy: "user:local",
  content: { title: id, label: id, shape: "rectangle" } });
const edge: CooperationConnection = { id: "edge", revision: 1, from: { itemId: "a", port: "east" }, to: { itemId: "b", port: "west" },
  direction: "forward", description: "relates", waypoints: [[150, 50], [150, 200]], createdBy: "user:local", updatedBy: "user:local" };

describe("cooperation geometry shared by permission checks and canvas", () => {
  it("rotates ports and rendered bounds about the item centre", () => {
    expect(itemPortWorld(item("a", 0, 90), "east")).toEqual([50, 100]);
    const bounds = itemBounds({ geometry: { x: 0, y: 0, width: 100, height: 200, rotation: 90 } });
    expect(bounds.x).toBeCloseTo(-50);
    expect(bounds.width).toBeCloseTo(200);
  });
  it("uses the persisted world polyline and half arc length for its label", () => {
    const items = [item("a"), item("b", 300)];
    expect(connectionPolyline(edge, items)).toEqual([[100, 50], [150, 50], [150, 200], [300, 50]]);
    expect(connectionLabelCenter(edge, items)[1]).toBeGreaterThan(100);
    expect(polylineMidpoint([[1, 2], [1, 2]])).toEqual([1, 2]);
    expect(() => connectionPolyline(edge, [])).toThrow("live items");
    expect(() => polylineMidpoint([])).toThrow();
  });
  it("protects stroke width and label space even when both endpoints are outside", () => {
    const items = [item("a"), item("b", 300)];
    expect(connectionIntersectsRegion(edge, items, { x: 145, y: 100, width: 10, height: 10 })).toBe(true);
    const straight = { ...edge, waypoints: [] };
    expect(connectionIntersectsRegion(straight, items, { x: 110, y: 30, width: 5, height: 5 })).toBe(true);
    expect(segmentIntersectsBounds([0, 0], [10, 0], { x: 1, y: 1, width: 1, height: 1 })).toBe(false);
    expect(segmentIntersectsBounds([0, 0], [10, 10], { x: 8, y: 0, width: 1, height: 1 })).toBe(false);
  });
  it("stores selected text offsets as Unicode code points", () => {
    const text = "🔎 Review café receipt routing with Claude.";
    expect(codePointOffset(text, text.indexOf("café"))).toBe(9);
    expect(cooperationAnchorMatches(text, { start: 9, end: 21, exact: "café receipt", prefix: "🔎 Review ", suffix: " routing" })).toBe(true);
    expect(cooperationAnchorMatches(text, { start: 10, end: 22, exact: "café receipt", prefix: "", suffix: "" })).toBe(false);
    expect(isCooperationId("../escape")).toBe(false);
    expect(isCooperationId("tab-1")).toBe(true);
  });

  it("treats sub-micro-unit boundary contact as protected", () => {
    const first = { x: 0, y: 0, width: 10, height: 10 };
    expect(boundsIntersect(first, { x: 10.0000005, y: 0, width: 1, height: 1 })).toBe(true);
    expect(boundsIntersect(first, { x: 10.000002, y: 0, width: 1, height: 1 })).toBe(false);
    expect(segmentIntersectsBounds([0, 10.0000005], [10, 10.0000005], first)).toBe(true);
  });
});
