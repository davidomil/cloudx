// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentLaunchRecord } from "@cloudx/shared";
import { ClaudeLaunchInspection } from "./ClaudeLaunchInspection.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });
const record: AgentLaunchRecord = {
  providerId: "claude", tabId: "worker-1", executionId: "execution-1", accountId: "account-1", version: "2.1.316",
  command: "/vendor/claude", cwd: "/workspace", recordedAt: "2026-11-01T00:00:00.000Z", arguments: ["--model", "claude-opus-5-5", "--", "[omitted]"],
  environmentKeys: ["ANTHROPIC_API_KEY"], enforcedEnvironmentKeys: ["CLAUDE_CONFIG_DIR"],
  skillSelections: [{ name: "docx", source: "synced", selected: true, available: false }],
  configurationSources: [{ path: "/overlay/settings.json", state: "file", sha256: "a".repeat(64) }, { path: "/workspace/.claude/settings.json", state: "missing" }],
};
async function mount(read: () => Promise<AgentLaunchRecord | undefined> = async () => record) {
  const call = vi.fn(async () => ({ launchRecord: await read() }));
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(ClaudeLaunchInspection, { callHook: call as never })));
  const input = container.querySelector("input")!;
  async function fill(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
  return { container, call, fill, button: container.querySelector("button")! };
}

it("shows historical account/version/arguments and source evidence without claiming current native state", async () => {
  const view = await mount();
  expect(view.button.disabled).toBe(true);
  await view.fill("../escape"); expect(view.button.disabled).toBe(true);
  await view.fill("worker-1"); await act(async () => view.button.click());
  expect(view.call).toHaveBeenCalledExactlyOnceWith("claude-settings.inspect-launch", { tabId: "worker-1" });
  for (const text of ["2.1.316", "account-1", "execution-1", "ANTHROPIC_API_KEY", "SHA-256", "missing", "Prompt text", "later skill discovery", "docx", "synced", "Missing"]) expect(view.container.textContent).toContain(text);
});

it("does not substitute current settings for a missing record", async () => {
  const view = await mount(async () => undefined);
  await view.fill("worker-1"); await act(async () => view.button.click());
  expect(view.container.textContent).toContain("Historical version, account and arguments remain unobserved");
  expect(view.container.querySelector('[aria-label="Recorded agent launch"]')).toBeNull();
});

it("discards a result after the requested tab changes", async () => {
  let complete!: (value: AgentLaunchRecord) => void;
  const result = new Promise<AgentLaunchRecord>(resolve => { complete = resolve; });
  const view = await mount(() => result);
  await view.fill("worker-1"); await act(async () => view.button.click());
  await view.fill("worker-2");
  await act(async () => { complete(record); await result; });
  expect(view.container.querySelector('[aria-label="Recorded agent launch"]')).toBeNull();
  expect(view.button.disabled).toBe(false);
});

it("reports an inaccessible owned record without displaying the error contents", async () => {
  const view = await mount(async () => { throw new Error("private diagnostics"); });
  await view.fill("worker-1"); await act(async () => view.button.click());
  expect(view.container.textContent).toContain("Launch record unavailable");
  expect(view.container.textContent).not.toContain("private diagnostics");
});
