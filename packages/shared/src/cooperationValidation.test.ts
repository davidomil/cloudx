import { afterEach, describe, expect, it, vi } from "vitest";
import type { CooperationBoard } from "./cooperation.js";

const board: CooperationBoard = { schemaVersion: 1, boardId: "board", title: "Design", revision: 0, status: "draft", eventCursor: 0,
  members: [], items: [], connections: [], regions: [], reactions: [], threads: [], assets: [] };

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe("cooperation board validation", () => {
  it("loads shared contracts without compiling an unused board schema", async () => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const shared = await import("./index.js");
    expect(shared.UI_RENDERER_STATUS_DOT).toBeDefined();
    expect(compile).not.toHaveBeenCalled();
  });

  it.each(["parse", "guard"])("compiles one validator on first %s and shares it between parsing and type guards", async first => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const { parseCooperationBoard, isCooperationBoard } = await import("./cooperation.js");
    expect(compile).not.toHaveBeenCalled();
    if (first === "guard") expect(isCooperationBoard(board)).toBe(true);
    else expect(parseCooperationBoard(board)).toBe(board);
    expect(isCooperationBoard(board)).toBe(true);
    expect(isCooperationBoard({ ...board, schemaVersion: 2 })).toBe(false);
    expect(() => parseCooperationBoard({ ...board, title: "" })).toThrow("Invalid cooperation board");
    expect(parseCooperationBoard(board)).toBe(board);
    expect(compile).toHaveBeenCalledTimes(1);
  });
});
