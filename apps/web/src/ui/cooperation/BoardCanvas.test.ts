// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NodeChange, ReactFlowProps } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CooperationBoard } from "@cloudx/shared";
import { BoardCanvas } from "./BoardCanvas.js";

const flow = vi.hoisted(() => ({ props: undefined as ReactFlowProps | undefined, store: { setState: vi.fn() }, instance: {} }));
vi.mock("@xyflow/react", async importOriginal => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  ReactFlow: (props: ReactFlowProps) => { flow.props = props; return null; },
  useReactFlow: () => flow.instance,
  useStoreApi: () => flow.store,
}));

let root: Root;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const board = (): CooperationBoard => ({ schemaVersion: 1, boardId: "board", title: "Layout", revision: 7, status: "draft", eventCursor: 0, members: [], connections: [], regions: [], reactions: [], threads: [], assets: [], items: ["first", "second"].map((id, index) => ({ id, kind: "shape", revision: 2, createdBy: "user:local", updatedBy: "user:local", geometry: { x: index * 300, y: 40, width: 180, height: 100, rotation: 0 }, content: { title: id, label: id, shape: "rectangle" } })) });

async function setup(overrides: Partial<ComponentProps<typeof BoardCanvas>> = {}) {
  const onOperations = vi.fn();
  let props: ComponentProps<typeof BoardCanvas> = { board: board(), tool: "none", selected: [], readOnly: false, busy: false, showChanges: true, miniMap: false, snap: true, ink: [], setInk: vi.fn(), penColor: "#ffffff", penWidth: 2, onViewport: vi.fn(), onReady: vi.fn(), onSelection: vi.fn(), onCreate: vi.fn(), onOperations, onInspect: vi.fn(), onContext: vi.fn(), onThread: vi.fn(), onOriginal: vi.fn(), onError: vi.fn(), ...overrides };
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const render = async (next: Partial<typeof props> = {}) => { props = { ...props, ...next }; await act(async () => root.render(createElement(BoardCanvas, props))); };
  await render();
  const change = async (changes: NodeChange[]) => act(async () => flow.props!.onNodesChange!(changes));
  return { onOperations, render, change };
}

describe("saved canvas movement", () => {
  it("removes the empty-board welcome once the board contains a zone", async () => {
    const snapshot = board(); snapshot.items = [];
    const { render } = await setup({ board: snapshot });
    expect(document.querySelector(".cooperation-canvas-welcome")).not.toBeNull();
    await render({ board: { ...snapshot, regions: [{ id: "zone", title: "Plan", revision: 1, ownerActor: "agent:planner", mode: "wip", protectedItemIds: [], geometry: { x: 0, y: 0, width: 600, height: 400, rotation: 0 } }] } });
    expect(document.querySelector(".cooperation-canvas-welcome")).toBeNull();
  });
  it("saves completed keyboard positions together at the observed board revision", async () => {
    const { onOperations, change } = await setup();
    await change([{ type: "position", id: "first", position: { x: 20, y: 40 }, dragging: false }, { type: "position", id: "second", position: { x: 320, y: 40 }, dragging: false }]);
    expect(onOperations).toHaveBeenCalledExactlyOnceWith([
      { kind: "updateItem", itemId: "first", patch: { geometry: { x: 20, y: 40, width: 180, height: 100, rotation: 0 } } },
      { kind: "updateItem", itemId: "second", patch: { geometry: { x: 320, y: 40, width: 180, height: 100, rotation: 0 } } },
    ], 7);
  });

  it("saves a pointer movement once, using its first movement revision even after a remote snapshot", async () => {
    const { onOperations, change, render } = await setup();
    await change([{ type: "position", id: "first", position: { x: 80, y: 40 }, dragging: true }]);
    expect(onOperations).not.toHaveBeenCalled();
    await render({ board: { ...board(), revision: 8 } });
    await change([{ type: "position", id: "first", position: { x: 100, y: 40 }, dragging: false }]);
    await act(async () => flow.props!.onNodeDragStop?.({} as never, flow.props!.nodes![0]!, flow.props!.nodes!));
    expect(onOperations).toHaveBeenCalledExactlyOnceWith([{ kind: "updateItem", itemId: "first", patch: { geometry: { x: 100, y: 40, width: 180, height: 100, rotation: 0 } } }], 7);
    onOperations.mockClear();
    await change([{ type: "position", id: "first", position: { x: 20, y: 40 }, dragging: false }]);
    expect(onOperations).toHaveBeenCalledWith(expect.any(Array), 8);
  });
  it("pins the pointer down revision before its first movement and starts without dropping a coarse event", async () => {
    const { onOperations, change, render } = await setup();
    expect(flow.props!.nodeDragThreshold).toBe(0);
    await act(async () => flow.props!.onNodeDragStart?.({} as never, flow.props!.nodes![0]!, flow.props!.nodes!));
    await render({ board: { ...board(), revision: 8 } });
    await change([{ type: "position", id: "first", position: { x: 60, y: 40 }, dragging: false }]);
    expect(onOperations).toHaveBeenCalledWith([{ kind: "updateItem", itemId: "first", patch: { geometry: { x: 60, y: 40, width: 180, height: 100, rotation: 0 } } }], 7);
  });

  it("does not save selection, measurement, unchanged, incomplete or deleted-item position events", async () => {
    const { onOperations, change } = await setup();
    await change([{ type: "select", id: "first", selected: true }, { type: "dimensions", id: "first", dimensions: { width: 180, height: 100 } }, { type: "position", id: "first", position: { x: 0, y: 40 }, dragging: false }, { type: "position", id: "second", dragging: false }, { type: "position", id: "gone", position: { x: 20, y: 40 }, dragging: false }]);
    expect(onOperations).not.toHaveBeenCalled();
  });

  it.each([{ readOnly: true }, { busy: true }, { tool: "pan" as const }, { tool: "note" as const }])("does not save movement while canvas controls disallow it: %j", async overrides => {
    const { onOperations, change } = await setup(overrides);
    await change([{ type: "position", id: "first", position: { x: 20, y: 40 }, dragging: false }]);
    expect(onOperations).not.toHaveBeenCalled();
  });
});
