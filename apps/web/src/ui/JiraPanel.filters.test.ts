// @vitest-environment jsdom

import type { JiraFilterState, JiraSavedFilter } from "@cloudx/shared";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JiraPanel } from "./JiraPanel.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

describe("saved Jira filters", () => {
  it("restores the saved selection, creates a named JQL filter, edits it and returns to the configured dashboard on deletion", async () => {
    const fixture = filterFixture();
    await mount(fixture.callHook);
    expect(view().value).toBe("team");
    expect(detail()).toContain("Team work");

    await click("New filter");
    expect(button("Save filter").disabled).toBe(true);
    await fill("input", "Unassigned");
    await fill(".jira-filter-form textarea", "assignee IS EMPTY ORDER BY created DESC");
    await submit();
    expect(fixture.calls).toContainEqual(["jira.filters.save", { name: "Unassigned", jql: "assignee IS EMPTY ORDER BY created DESC" }]);
    expect(view().selectedOptions[0]?.textContent).toBe("Unassigned");
    expect(container.querySelector(".jira-filter-form")).toBeNull();

    await click("Edit filter");
    await fill("input", "Unassigned bugs");
    await fill(".jira-filter-form textarea", "assignee IS EMPTY AND type = Bug");
    await submit();
    expect(view().selectedOptions[0]?.textContent).toBe("Unassigned bugs");
    expect(fixture.calls).toContainEqual(["jira.filters.save", { id: "new", name: "Unassigned bugs", jql: "assignee IS EMPTY AND type = Bug" }]);

    await click("Delete filter");
    expect(view().value).toBe("");
    expect(detail()).toContain("Assigned work");
    expect(Array.from(view().options).map((option) => option.textContent)).not.toContain("Unassigned bugs");
    expect(fixture.calls).toContainEqual(["jira.dashboard.list", {}]);
  });

  it("preserves an unsaved draft on save failure and cancels editing without changing the selected filter", async () => {
    const fixture = filterFixture();
    fixture.failSave = true;
    await mount(fixture.callHook);
    await click("Edit filter");
    await fill("input", "Draft name");
    await submit();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Could not save filters");
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Draft name");
    expect(view().selectedOptions[0]?.textContent).toBe("Team");
    await click("Cancel");
    expect(container.querySelector(".jira-filter-form")).toBeNull();
    expect(view().disabled).toBe(false);
  });

  it("clears the previous issue and comment draft for an empty view", async () => {
    const fixture = filterFixture();
    await mount(fixture.callHook);
    await fill(".jira-comment-form textarea", "Comment for team issue");
    await select("empty");
    expect(detail()).toContain("Select a Jira issue.");
    expect(detail()).not.toContain("Team work");
    expect(container.textContent).toContain("No Jira issues matched");
    await select("team");
    expect(container.querySelector<HTMLTextAreaElement>(".jira-comment-form textarea")?.value).toBe("");
  });

  it.each(["success", "failure"])("ignores a late %s from a previously selected view", async (result) => {
    const fixture = filterFixture();
    const pending = deferred<Record<string, unknown>>();
    await mount(fixture.callHook);
    fixture.dashboard = (id) => id === "empty" ? pending.promise : Promise.resolve(dashboard(id));
    await select("empty");
    expect(detail()).not.toContain("Team work");
    await select("team");
    expect(detail()).toContain("Team work");
    await act(async () => {
      if (result === "success") pending.resolve(dashboard("empty"));
      else pending.reject(new Error("Stale query error"));
    });
    expect(detail()).toContain("Team work");
    expect(view().value).toBe("team");
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("shows a query error without old results and keeps the selected filter editable", async () => {
    const fixture = filterFixture();
    await mount(fixture.callHook);
    fixture.dashboard = async () => { throw new Error("Invalid JQL from Jira"); };
    await select("empty");
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Invalid JQL from Jira");
    expect(detail()).not.toContain("Team work");
    await click("Edit filter");
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Empty");
  });

  it("retries a failed filter-list load when Refresh is clicked", async () => {
    const fixture = filterFixture();
    const callHook: NonNullable<UiContributionRenderContext["callHook"]> = vi.fn()
      .mockRejectedValueOnce(new Error("Could not load filters"))
      .mockImplementation(fixture.callHook);
    await mount(callHook);
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Could not load filters");
    expect(button("New filter").disabled).toBe(true);
    await click("Refresh Jira");
    expect(detail()).toContain("Team work");
    expect(button("New filter").disabled).toBe(false);
  });

  it("does not start a dashboard request when a pending filter save finishes after unmount", async () => {
    const fixture = filterFixture();
    const pending = deferred<JiraFilterState>();
    const callHook: NonNullable<UiContributionRenderContext["callHook"]> = <T extends Record<string, unknown>>(hookId: string, input?: Record<string, unknown>) => hookId === "jira.filters.save"
      ? pending.promise as unknown as Promise<T>
      : fixture.callHook<T>(hookId, input);
    await mount(callHook);
    await click("Edit filter");
    await submit();
    const calls = fixture.calls.length;
    await act(async () => root.unmount());
    await act(async () => pending.resolve({ filters: [], selectedFilterId: null }));
    expect(fixture.calls).toHaveLength(calls);
  });
});

function filterFixture() {
  let state: JiraFilterState = {
    filters: [{ id: "team", name: "Team", jql: "project = TEAM" }, { id: "empty", name: "Empty", jql: "labels = missing" }],
    selectedFilterId: "team"
  };
  const fixture = {
    calls: [] as Array<[string, Record<string, unknown>]>,
    failSave: false,
    dashboard: (id: unknown) => Promise.resolve(dashboard(id)),
    callHook: async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}): Promise<T> => {
      fixture.calls.push([hookId, input]);
      if (hookId === "jira.filters.save") {
        if (fixture.failSave) throw new Error("Could not save filters");
        const filter = { ...input, id: input.id ?? "new" } as JiraSavedFilter;
        state = { filters: [...state.filters.filter((entry) => entry.id !== filter.id), filter], selectedFilterId: filter.id };
      }
      if (hookId === "jira.filters.select") state = { ...state, selectedFilterId: input.filterId as string | null };
      if (hookId === "jira.filters.delete") state = { filters: state.filters.filter((entry) => entry.id !== input.id), selectedFilterId: null };
      if (hookId.startsWith("jira.filters.")) return state as unknown as T;
      if (hookId === "jira.dashboard.list") return await fixture.dashboard(input.filterId) as T;
      if (hookId === "jira.issue.get") return { issue: issue(input.issueIdOrKey === "TEAM-1" ? "team" : undefined) } as unknown as T;
      if (hookId === "jira.issue.comments.list") return { comments: [] } as unknown as T;
      if (hookId === "jira.issue.transitions.list") return { transitions: [] } as unknown as T;
      throw new Error(`Unexpected hook ${hookId}`);
    }
  };
  return fixture;
}

function issue(filterId: unknown) {
  return { key: filterId === "team" ? "TEAM-1" : "ME-1", summary: filterId === "team" ? "Team work" : "Assigned work", url: "https://example.atlassian.net/browse/TEST-1" };
}

function dashboard(filterId: unknown): Record<string, unknown> {
  const issues = filterId === "empty" ? [] : [issue(filterId)];
  return { issues, groups: [{ id: "all", title: "All issues", issues }], jql: "resolution = EMPTY", groupBy: "none", sortBy: "custom_jql_order" };
}

async function mount(callHook: NonNullable<UiContributionRenderContext["callHook"]>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(JiraPanel, { callHook })));
}

function view() { return container.querySelector<HTMLSelectElement>('[aria-label="Jira filter"]')!; }
function detail() { return container.querySelector(".jira-detail")?.textContent ?? ""; }
function button(name: string) {
  return Array.from(container.querySelectorAll("button")).find((entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === name)!;
}
async function click(name: string) { await act(async () => button(name).click()); }
async function select(id: string) {
  await act(async () => {
    view().value = id;
    view().dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function fill(selector: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    Object.getOwnPropertyDescriptor(input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => container.querySelector(".jira-filter-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
