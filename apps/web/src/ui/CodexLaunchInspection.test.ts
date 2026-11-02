// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexLaunchPolicyInspection } from "@cloudx/shared";
import { CodexLaunchInspection } from "./CodexLaunchInspection.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });
const inspection: CodexLaunchPolicyInspection = {
  tabId: "worker-1", sourcePath: "/data/codex-launches/worker-1/config.toml", observation: "generated-config-on-disk",
  values: { web_search: "live" }, skills: [{ path: "/skills/imagegen", source: "native-vendor-cache", available: true, enabled: true, freshDefault: "enabled", provenance: "Shared-cache artifact; selected-CLI version provenance unverified" }],
  serverEnvironmentKeys: ["OPENAI_API_KEY"], unresolvedLayers: ["Live process values remain unresolved."],
};
async function mount(read: () => Promise<CodexLaunchPolicyInspection> = async () => inspection) {
  const call = vi.fn(async (_hook: string, _input?: Record<string, unknown>) => ({ inspection: await read() }));
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(CodexLaunchInspection, { callHook: call as never })));
  const input = container.querySelector("input")!;
  async function fill(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
  return { container, call, fill, button: container.querySelector("button")! };
}

it("requires a valid owned launch ID and shows actual recorded selection with its observation limits", async () => {
  const view = await mount();
  expect(view.button.disabled).toBe(true);
  await view.fill("../escape"); expect(view.button.disabled).toBe(true);
  await view.fill("worker-1");
  await act(async () => view.button.click());
  expect(view.call).toHaveBeenCalledExactlyOnceWith("codex-settings.inspect-launch", { tabId: "worker-1" });
  expect(view.container.textContent).toContain("native-vendor-cache");
  expect(view.container.textContent).toContain("SKILL.md present");
  expect(view.container.textContent).toContain("Recorded launch selection");
  expect(view.container.textContent).toContain("version provenance unverified");
  expect(view.container.textContent).toContain("OPENAI_API_KEY");
  expect(view.container.textContent).toContain("Live process values remain unresolved");
});

it("discards an in-flight inspection after the requested ID changes", async () => {
  let complete!: (value: CodexLaunchPolicyInspection) => void;
  const read = new Promise<CodexLaunchPolicyInspection>(resolve => { complete = resolve; });
  const view = await mount(() => read);
  await view.fill("worker-1"); await act(async () => view.button.click());
  await view.fill("worker-2");
  await act(async () => { complete(inspection); await read; });
  expect(view.container.textContent).not.toContain("Observed generated file:");
  expect(view.button.disabled).toBe(false);
});
