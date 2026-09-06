// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexStateSourcesResponse } from "@cloudx/shared";
import { getCodexStateSources } from "../api.js";
import { CodexStateSourceSelect } from "./CodexStateSourceSelect.js";

vi.mock("../api.js", () => ({ getCodexStateSources: vi.fn() }));
const fetchSources = vi.mocked(getCodexStateSources);
let root: Root | undefined;
const actGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let priorAct: boolean | undefined;
beforeEach(() => {
  priorAct = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  try {
    await act(async () => root?.unmount());
  } finally {
    root = undefined;
    document.body.replaceChildren();
    vi.resetAllMocks();
    if (priorAct === undefined) delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
    else actGlobal.IS_REACT_ACT_ENVIRONMENT = priorAct;
  }
});
const catalog: CodexStateSourcesResponse = {
  sources: [
    {
      sourceId: "shared",
      kind: "shared",
      label: "Shared sessions",
      updatedAt: null,
    },
    ...["YQ", "Yg"].map((key) => ({
      sourceId: `legacy:${key}`,
      kind: "legacy" as const,
      label: "Review",
      updatedAt: "2026-09-01T00:00:00.000Z",
    })),
  ],
};

function pending() {
  let resolve!: (value: CodexStateSourcesResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CodexStateSourcesResponse>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function mount(onChange = vi.fn(), value = "") {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(createElement(CodexStateSourceSelect, { value, onChange })),
  );
  return { container, onChange };
}
describe("CodexStateSourceSelect", () => {
  it("keeps the selectable source key case distinct from dialog label styling", async () => {
    fetchSources.mockResolvedValueOnce(catalog);
    const { container } = await mount(vi.fn(), "legacy:Yg");
    const detail = container.querySelector<HTMLDivElement>(
      '[aria-label="Selected session source key"]',
    )!;
    expect(detail.textContent).toBe("legacy:Yg");
    expect(detail.style.textTransform).toBe("none");
    expect(detail.style.userSelect).toBe("text");
  });

  it("loads without auto-selecting, filters duplicate owners and selects the exact full key", async () => {
    const request = pending();
    fetchSources.mockReturnValueOnce(request.promise);
    const { container, onChange } = await mount();
    expect(container.textContent).toContain("Loading session sources");
    await act(async () => request.resolve(catalog));
    expect(onChange).not.toHaveBeenCalled();
    const select = container.querySelector("select")!;
    expect(select.value).toBe("");
    expect(select.options).toHaveLength(4);
    await act(async () => {
      select.value = "legacy:Yg";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("legacy:Yg");
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "legacy:Yg");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(select.options).toHaveLength(2);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "absent");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("No matching session sources");
    expect(fetchSources).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"])(
    "aborts unmounted requests and ignores late %s across reopen",
    async (completion) => {
      const old = pending();
      const current = pending();
      fetchSources
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const first = await mount();
      const signal = fetchSources.mock.calls[0]![0]!;
      await act(async () => root!.unmount());
      root = undefined;
      expect(signal.aborted).toBe(true);
      const second = await mount();
      await act(async () => {
        if (completion === "resolve") old.resolve(catalog);
        else old.reject(new Error("stale failure"));
      });
      expect(first.onChange).not.toHaveBeenCalled();
      expect(second.container.textContent).toContain("Loading session sources");
      expect(second.container.textContent).not.toContain("stale failure");
      await act(async () => current.resolve({ sources: [] }));
      expect(second.container.textContent).toContain(
        "No session sources available",
      );
      expect(fetchSources).toHaveBeenCalledTimes(2);
    },
  );

  it("shows an error without retrying or selecting a source", async () => {
    fetchSources.mockRejectedValueOnce(
      new Error("Source inventory unavailable"),
    );
    const { container, onChange } = await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Source inventory unavailable",
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(fetchSources).toHaveBeenCalledTimes(1);
  });
});
