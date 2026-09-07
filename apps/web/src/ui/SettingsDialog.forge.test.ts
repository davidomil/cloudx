// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxConfigResponse, CloudxConfigValues, RulesSkillsStore } from "@cloudx/shared";

import { SettingsDialog } from "./SettingsDialog.js";

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "cloudx/example" }, roles: [{ role: "worker", state: "disconnected" }, { role: "reviewer", state: "disconnected" }] }))));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const templates: RulesSkillsStore = { rules: [], skills: [], systemRules: [], systemSkills: [], templates: [
  { id: "worker-template", name: "Implement carefully", color: "green", ruleIds: [], skillIds: [] },
  { id: "review-template", name: "Review changes", color: "yellow", ruleIds: [], skillIds: [] }
] };

function config(): CloudxConfigResponse {
  return { globalFields: [], plugins: [{ pluginId: "forge", displayName: "Forge Workers", fields: [
    { key: "provider", label: "Provider", type: "select", defaultValue: "github", options: [{ label: "GitHub", value: "github" }, { label: "GitLab", value: "gitlab" }] },
    { key: "apiUrl", label: "API URL", type: "string", defaultValue: "https://api.github.com" },
    { key: "projectPath", label: "Repository", type: "string", defaultValue: "" },
    { key: "workerTemplateId", label: "Issue worker template", type: "string", defaultValue: "", optionSource: "rulesSkills.templates" },
    { key: "reviewTemplateId", label: "Review template", type: "string", defaultValue: "", optionSource: "rulesSkills.templates" }
  ] }], values: { global: {}, plugins: { forge: { provider: "github", apiUrl: "https://api.github.com", projectPath: "cloudx/example" } } } };
}

async function mount(store = templates, response = config()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const save = vi.fn(async (_values: CloudxConfigValues) => {});
  await act(async () => root!.render(createElement(SettingsDialog, { config: response, rulesSkillsStore: store, onSave: save, onCancel: vi.fn() })));
  return { container, save };
}

function field(container: Element, label: string) {
  return [...container.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))!.querySelector<HTMLInputElement | HTMLSelectElement>("input,select")!;
}

async function select(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

describe("Forge setup in ordinary Settings", () => {
  it("exposes connection actions without requiring a Forge tab or manual keys", async () => {
    const { container } = await mount();
    expect(container.querySelector('[aria-label="Forge connections"]')).not.toBeNull();
    expect(container.textContent).toContain("Connect issue worker");
    expect(container.textContent).toContain("Connect reviewer");
    expect(container.textContent).not.toMatch(/Local repository path|credential type|private key|installation ID/i);
    expect(container.querySelector('input[type="file"], input[type="password"]')).toBeNull();
  });

  it("changes the default API URL with provider selection and requires saving that destination", async () => {
    const { container } = await mount();
    await select(field(container, "Provider"), "gitlab");
    expect(field(container, "API URL").value).toBe("https://gitlab.com/api/v4");
    expect(container.textContent).toContain("Save repository settings first");
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.disabled).toBe(true);
    await select(field(container, "Provider"), "github");
    expect(field(container, "API URL").value).toBe("https://api.github.com");
  });

  it("blocks connection when a repository name is edited without saving", async () => {
    const { container } = await mount();
    await select(field(container, "Repository"), "cloudx/other");
    const connect = [...container.querySelectorAll("button")].find(item => item.textContent === "Connect issue worker")!;
    expect(connect.disabled).toBe(true);
    expect(container.textContent).toContain("Save repository settings first");
  });

  it("matches the server's saved API URL when the entered endpoint ends with a slash", async () => {
    const response = config();
    response.values.plugins.forge.apiUrl = "https://api.github.com/";
    const { container } = await mount(templates, response);
    const connect = [...container.querySelectorAll("button")].find(item => item.textContent === "Connect issue worker")!;
    expect(connect.disabled).toBe(false);
    expect(container.textContent).not.toContain("Save repository settings first");
  });

  it("selects named templates and persists their identifiers", async () => {
    const { container, save } = await mount();
    expect(field(container, "Issue worker template").textContent).toContain("Implement carefully");
    await select(field(container, "Issue worker template"), "worker-template");
    await select(field(container, "Review template"), "review-template");
    await act(async () => [...container.querySelectorAll("button")].find(item => item.textContent === "Save")!.click());
    expect(save.mock.calls[0][0].plugins.forge).toMatchObject({ workerTemplateId: "worker-template", reviewTemplateId: "review-template" });
  });

  it("explains the missing template prerequisite", async () => {
    const { container } = await mount({ ...templates, templates: [] });
    expect(field(container, "Review template").disabled).toBe(true);
    expect(container.textContent).toContain("Create a template in Rules / Skills first");
  });
});
