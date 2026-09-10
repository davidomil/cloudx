// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxConfigResponse, CloudxConfigValues, RulesSkillsStore } from "@cloudx/shared";

import { SettingsDialog } from "./SettingsDialog.js";

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
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
const modelOptions = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"].map(value => ({ label: value, value }));
const reasoningOptions = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "X-high", value: "xhigh" },
  { label: "Max", value: "max" },
  { label: "Ultra", value: "ultra" }
];

function config(): CloudxConfigResponse {
  return { globalFields: [], plugins: [{ pluginId: "forge", displayName: "Forge Workers", fields: [
    { key: "provider", label: "Provider", type: "select", defaultValue: "github", options: [{ label: "GitHub", value: "github" }, { label: "GitLab", value: "gitlab" }] },
    { key: "apiUrl", label: "API URL", type: "string", defaultValue: "https://api.github.com" },
    { key: "projectPath", label: "Repository", type: "string", defaultValue: "" },
    { key: "workerTemplateId", label: "Issue worker template", type: "string", defaultValue: "", optionSource: "rulesSkills.templates" },
    { key: "workerModel", label: "Coding model", type: "select", defaultValue: "gpt-6-astra", options: modelOptions },
    { key: "workerReasoningEffort", label: "Coding reasoning effort", type: "select", defaultValue: "xhigh", options: reasoningOptions },
    { key: "reviewTemplateId", label: "Review template", type: "string", defaultValue: "", optionSource: "rulesSkills.templates" },
    { key: "reviewModel", label: "Review model", type: "select", defaultValue: "gpt-6-astra", options: modelOptions },
    { key: "reviewReasoningEffort", label: "Review reasoning effort", type: "select", defaultValue: "max", options: reasoningOptions }
  ] }], values: { global: {}, plugins: { forge: { provider: "github", apiUrl: "https://api.github.com", projectPath: "cloudx/example" } } } };
}

async function mount(store = templates, response = config()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const save = vi.fn(async (_values: CloudxConfigValues) => {});
  await act(async () => root!.render(createElement(SettingsDialog, { config: response, rulesSkillsStore: store, onSave: save, onCancel: vi.fn() })));
  await act(async () => container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Forge Workers"]')!.click());
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

  it("shows model defaults and saves independent coding and review dropdown choices", async () => {
    const { container, save } = await mount();
    const codingModel = field(container, "Coding model");
    const reviewModel = field(container, "Review model");
    const codingEffort = field(container, "Coding reasoning effort") as HTMLSelectElement;
    const reviewEffort = field(container, "Review reasoning effort") as HTMLSelectElement;
    expect(codingModel.value).toBe("gpt-6-astra");
    expect(reviewModel.value).toBe("gpt-6-astra");
    expect(codingEffort.value).toBe("xhigh");
    expect(reviewEffort.value).toBe("max");
    for (const model of [codingModel, reviewModel]) {
      expect(model).toBeInstanceOf(HTMLSelectElement);
      expect([...(model as HTMLSelectElement).options].map(option => option.value)).toEqual(modelOptions.map(option => option.value));
    }
    for (const effort of [codingEffort, reviewEffort]) {
      expect([...effort.options].map(option => ({ label: option.textContent, value: option.value }))).toEqual(reasoningOptions);
    }

    await select(codingModel, "gpt-5.6-sol");
    await select(codingEffort, "high");
    expect(reviewModel.value).toBe("gpt-6-astra");
    expect(reviewEffort.value).toBe("max");
    await select(reviewModel, "gpt-5.6-terra");
    await select(reviewEffort, "ultra");
    expect(codingModel.value).toBe("gpt-5.6-sol");
    expect(codingEffort.value).toBe("high");
    await act(async () => [...container.querySelectorAll("button")].find(item => item.textContent === "Save")!.click());
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].plugins.forge).toMatchObject({
      workerModel: "gpt-5.6-sol",
      workerReasoningEffort: "high",
      reviewModel: "gpt-5.6-terra",
      reviewReasoningEffort: "ultra"
    });
  });

  it("explains the missing template prerequisite", async () => {
    const { container } = await mount({ ...templates, templates: [] });
    expect(field(container, "Review template").disabled).toBe(true);
    expect(container.textContent).toContain("Create a template in Rules / Skills first");
  });
});
