// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProviderStatus, CloudxConfigResponse, CloudxConfigValues, ConfigFieldOption } from "@cloudx/shared";

import { SettingsDialog } from "./SettingsDialog.js";
import { modelNativeWarning } from "./modelNativeWarning.js";

const option: ConfigFieldOption = { label: "GPT-6.2 Sol", value: "gpt-6.2-sol", nativeRequirement: { providerId: "codex", minimumVersion: "0.166.0" } };
const provider = (version: string, installed = true): AgentProviderStatus => ({ providerId: "codex", label: "Codex", command: "/selected/codex", version, installed });
let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("selected native executable requirements", () => {
  it("requires the model's selected provider to report an installed, parseable, suitable version", () => {
    expect(modelNativeWarning(option)).toContain("Verify the selected Codex");
    expect(modelNativeWarning(option, [{ providerId: "claude", label: "Claude", installed: true, version: "2.1.331" }])).toContain("Verify the selected Codex");
    expect(modelNativeWarning(option, [provider("0.172.0", false)])).toContain("unavailable");
    for (const version of ["unknown", "codex-cli 0.166.0-beta.1", "codex-cli 0.172.0 malformed", "unrelated 0.172.0", "0.0166.0"])
      expect(modelNativeWarning(option, [provider(version)])).toContain("unknown");
    expect(modelNativeWarning(option, [provider("codex-cli 0.160.0")])).toContain("Selected /selected/codex reports codex-cli 0.160.0");
    for (const version of ["0.166.0", "codex-cli 0.172.0", "1.0.0"]) expect(modelNativeWarning(option, [provider(version)])).toBeUndefined();
    expect(modelNativeWarning({ label: "Existing choice", value: "existing" })).toBeUndefined();
  });

  it("rechecks upgrades and downgrades when returning to model settings without replacing saved choices", async () => {
    const options = [option, { label: "Existing model", value: "existing-model" }];
    const config: CloudxConfigResponse = {
      globalFields: [{ key: "voiceModel", label: "Voice model", type: "select", defaultValue: "existing-model", options }],
      plugins: [{ pluginId: "documentation", displayName: "Documentation", fields: [
        { key: "aiAnswerModel", label: "Answer model", type: "select", defaultValue: "existing-model", options }
      ] }], values: { global: { voiceModel: "gpt-6.2-sol" }, plugins: { documentation: { aiAnswerModel: "existing-model" } } }
    };
    const pending: Array<(value: unknown) => void> = [];
    const callHook = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(SettingsDialog, { config, onCancel: vi.fn(), onSave: vi.fn(), callHook: callHook as never })));
    const dropdown = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    const refresh = async (version: string) => act(async () => pending.shift()!({ state: { accounts: [], providers: [provider(version)] } }));
    const visit = async (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${label}"]`)!.click());
    await refresh("0.172.0");
    expect(dropdown("Voice model").options[0].disabled).toBe(false);
    await visit("Documentation");
    expect(dropdown("Answer model").options[0].disabled).toBe(true);
    await refresh("0.160.0");
    expect(dropdown("Answer model").options[0].disabled).toBe(true);
    expect(dropdown("Answer model").value).toBe("existing-model");
    expect(container.textContent).not.toContain("Native version verified");
    await visit("General");
    expect(dropdown("Voice model").options[0].disabled).toBe(true);
    await refresh("0.172.0");
    expect(dropdown("Voice model").options[0].disabled).toBe(false);
    expect(dropdown("Voice model").value).toBe("gpt-6.2-sol");
    expect(callHook).toHaveBeenCalledTimes(3);
  });

  it.each(["0.160.0", "0.172.0"])("checks native status before offering the new model and retains a saved choice on %s", async version => {
    const config: CloudxConfigResponse = {
      globalFields: [{ key: "voiceModel", label: "Voice model", type: "select", defaultValue: "existing-model", options: [option, { label: "Existing model", value: "existing-model" }] }],
      plugins: [], values: { global: { voiceModel: "gpt-6.2-sol" }, plugins: {} }
    };
    let finishRead!: (value: unknown) => void;
    const callHook = vi.fn(() => new Promise(resolve => { finishRead = resolve; }));
    const save = vi.fn(async (_values: CloudxConfigValues) => {});
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(SettingsDialog, { config, onCancel: vi.fn(), onSave: save, callHook: callHook as never })));
    const selected = container.querySelector<HTMLSelectElement>('select[aria-label="Voice model"]')!;
    expect(selected.value).toBe("gpt-6.2-sol");
    expect(selected.options[0].disabled).toBe(true);
    expect(selected.options[0].textContent).toContain("Verify the selected Codex executable");
    expect(callHook).toHaveBeenCalledWith("agent-accounts.read", {});
    await act(async () => finishRead({ state: { accounts: [], providers: [provider(version)] } }));
    expect(selected.options[0].disabled).toBe(version === "0.160.0");
    expect(selected.value).toBe("gpt-6.2-sol");
    if (version === "0.160.0") expect(container.textContent).toContain("requires Codex 0.166.0 or later");
    else expect(container.textContent).toContain("selected account and provider determine model access");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Save")!.click());
    expect(save.mock.calls[0][0].global.voiceModel).toBe("gpt-6.2-sol");
  });
});
