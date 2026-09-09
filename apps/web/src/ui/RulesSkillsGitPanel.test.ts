// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RulesSkillsGitState } from "@cloudx/shared";

import { RulesSkillsGitPanel } from "./RulesSkillsGitPanel.js";

const checkout: RulesSkillsGitState = { isRepository: true, rootPath: "/catalog", branch: "main", originUrl: "git@example.test:team/catalog.git", hasChanges: false, hasCommits: true };
const roots: Root[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount(overrides: Partial<Parameters<typeof RulesSkillsGitPanel>[0]> = {}) {
  const props = {
    onLoadGit: vi.fn(async () => checkout),
    onSetGitOrigin: vi.fn(async (originUrl: string) => ({ ...checkout, originUrl })),
    onPullGit: vi.fn(async (_expectedOriginUrl: string) => checkout),
    onPushGit: vi.fn(async (_expectedOriginUrl: string) => checkout),
    disabled: false,
    hasUnsavedChanges: false,
    ...overrides
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  function TestPanel() {
    const [git, setGit] = useState<RulesSkillsGitState>();
    const [actions] = useState(() => ({
      onLoadGit: async () => { const state = await props.onLoadGit(); setGit(state); return state; },
      onSetGitOrigin: async (originUrl: string) => { const state = await props.onSetGitOrigin(originUrl); setGit(state); return state; },
      onPullGit: async (expectedOriginUrl: string) => { const state = await props.onPullGit(expectedOriginUrl); setGit(state); return state; },
      onPushGit: async (expectedOriginUrl: string) => { const state = await props.onPushGit(expectedOriginUrl); setGit(state); return state; }
    }));
    return createElement(RulesSkillsGitPanel, { ...props, ...actions, git });
  }
  await act(async () => root.render(createElement(TestPanel)));
  return { container, props };
}

function button(container: Element, label: string) {
  const found = [...container.querySelectorAll("button")].find(element => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(container: Element, label: string) { await act(async () => button(container, label).click()); }
async function setOrigin(container: Element, value: string) {
  const input = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("rules and skills Git controls", () => {
  it("shows the catalog root and explains when a Git checkout is required", async () => {
    const { container } = await mount({ onLoadGit: async () => ({ ...checkout, isRepository: false, branch: undefined, originUrl: undefined, hasCommits: false }) });
    expect(container.textContent).toContain("/catalog");
    expect(container.textContent).toContain("Use an existing Git checkout at this catalog root");
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("Push commits");
  });

  it("adds a missing origin and enables synchronization only after saving it", async () => {
    const { container, props } = await mount({ onLoadGit: async () => ({ ...checkout, originUrl: undefined }) });
    expect(button(container, "Pull").disabled).toBe(true);
    expect(button(container, "Push commits").disabled).toBe(true);
    await setOrigin(container, " git@example.test:new/catalog.git ");
    expect(button(container, "Pull").disabled).toBe(true);
    await click(container, "Save origin");
    expect(props.onSetGitOrigin).toHaveBeenCalledWith("git@example.test:new/catalog.git");
    expect(container.querySelector("input")!.value).toBe("git@example.test:new/catalog.git");
    expect(container.textContent).toContain("Origin saved.");
    expect(button(container, "Pull").disabled).toBe(false);
  });

  it("preserves an edited origin across status refresh and supports updating it", async () => {
    const { container, props } = await mount();
    await setOrigin(container, "git@example.test:other/catalog.git");
    await click(container, "Refresh Git status");
    expect(props.onLoadGit).toHaveBeenCalledTimes(2);
    expect(container.querySelector("input")!.value).toBe("git@example.test:other/catalog.git");
    expect(button(container, "Push commits").disabled).toBe(true);
    await click(container, "Save origin");
    expect(props.onSetGitOrigin).toHaveBeenCalledWith("git@example.test:other/catalog.git");
    await click(container, "Push commits");
    expect(props.onPushGit).toHaveBeenCalledExactlyOnceWith("git@example.test:other/catalog.git");
    expect(container.textContent).toContain("Commits pushed to origin.");
  });

  it("disables concurrent actions while pulling and reports a refreshed catalog on success", async () => {
    const pulling = deferred<RulesSkillsGitState>();
    const { container, props } = await mount({ onPullGit: vi.fn(() => pulling.promise) });
    await click(container, "Pull");
    expect(container.textContent).toContain("Pulling…");
    expect([...container.querySelectorAll("button")].every(element => element.disabled)).toBe(true);
    expect(container.querySelector("input")!.disabled).toBe(true);
    await click(container, "Pull");
    expect(props.onPullGit).toHaveBeenCalledExactlyOnceWith(checkout.originUrl);
    await act(async () => pulling.resolve(checkout));
    expect(container.textContent).toContain("Rules and skills refreshed.");
    expect(button(container, "Pull").disabled).toBe(false);
  });

  it("uses the same normalized origin for synchronization checks and pull and push requests", async () => {
    const { container, props } = await mount();
    await setOrigin(container, `  ${checkout.originUrl}  `);

    expect(button(container, "Pull").disabled).toBe(false);
    await click(container, "Pull");
    expect(props.onPullGit).toHaveBeenCalledExactlyOnceWith(checkout.originUrl);
    expect(button(container, "Push commits").disabled).toBe(false);
    await click(container, "Push commits");

    expect(props.onPushGit).toHaveBeenCalledExactlyOnceWith(checkout.originUrl);
  });

  it("reports actionable errors and allows an explicit retry", async () => {
    const onPushGit = vi.fn().mockRejectedValueOnce(new Error("Origin rejected a non-fast-forward push.")).mockResolvedValue(checkout);
    const { container } = await mount({ onPushGit });
    await click(container, "Push commits");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Origin rejected a non-fast-forward push.");
    expect(button(container, "Push commits").disabled).toBe(false);
    await click(container, "Push commits");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Commits pushed to origin.");
  });

  it("shows a failed initial status request and recovers only on manual refresh", async () => {
    const onLoadGit = vi.fn().mockRejectedValueOnce(new Error("Git is unavailable.")).mockResolvedValue(checkout);
    const { container } = await mount({ onLoadGit });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Git is unavailable.");
    expect(onLoadGit).toHaveBeenCalledTimes(1);
    await click(container, "Refresh Git status");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Branch: main");
  });

  it.each([
    { reason: "unsaved browser edits", state: checkout, unsaved: true, pullDisabled: true, pushDisabled: false },
    { reason: "uncommitted checkout files", state: { ...checkout, hasChanges: true }, unsaved: false, pullDisabled: true, pushDisabled: false },
    { reason: "a detached HEAD", state: { ...checkout, branch: undefined }, unsaved: false, pullDisabled: true, pushDisabled: true },
    { reason: "an unborn branch", state: { ...checkout, hasCommits: false }, unsaved: false, pullDisabled: true, pushDisabled: true }
  ])("protects synchronization with $reason", async ({ state, unsaved, pullDisabled, pushDisabled }) => {
    const { container } = await mount({ onLoadGit: async () => state, hasUnsavedChanges: unsaved });
    expect(button(container, "Pull").disabled).toBe(pullDisabled);
    expect(button(container, "Push commits").disabled).toBe(pushDisabled);
  });

  it("retains an unsaved origin and reports a failed save", async () => {
    const { container } = await mount({ onSetGitOrigin: async () => { throw new Error("Unsupported origin URL."); } });
    await setOrigin(container, "invalid origin");
    await click(container, "Save origin");
    expect(container.querySelector("input")!.value).toBe("invalid origin");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unsupported origin URL.");
    expect(button(container, "Pull").disabled).toBe(true);
  });
});
