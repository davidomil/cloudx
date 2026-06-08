import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CloudxConfigResponse, RulesSkillsStore } from "@cloudx/shared";

import { SettingsDialog } from "./SettingsDialog.js";

describe("SettingsDialog", () => {
  it("renders the global default personality template selector", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsDialog, {
        config: configResponse(),
        rulesSkillsStore: rulesSkillsStore(),
        onCancel: vi.fn(),
        onSave: vi.fn(async () => undefined),
        onSaveDefaultTemplate: vi.fn(async () => undefined)
      })
    );

    expect(html).toContain("Default template");
    expect(html).toContain("Focused (default)");
    expect(html).toContain("Review");
    expect(html).not.toContain(">Inherited<");
  });

  it("does not render internal config fields", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsDialog, {
        config: {
          globalFields: [
            {
              key: "visibleGlobal",
              label: "Visible global",
              type: "boolean",
              defaultValue: true
            },
            {
              key: "internalGlobal",
              label: "Internal global",
              type: "string",
              visibility: "internal",
              defaultValue: "hidden-value"
            }
          ],
          plugins: [
            {
              pluginId: "documentation",
              displayName: "Documentation",
              fields: [
                {
                  key: "aiEnrichmentEnabled",
                  label: "AI enrichment",
                  type: "select",
                  defaultValue: "gpt-5.4-mini",
                  options: [
                    {
                      label: "GPT-5.4-Mini",
                      value: "gpt-5.4-mini",
                      description: "Small, fast, and cost-efficient model for simpler coding tasks."
                    }
                  ]
                },
                {
                  key: "aiEnrichmentSkillIds",
                  label: "AI enrichment skills",
                  type: "string",
                  visibility: "internal",
                  defaultValue: "documentation-enrich-metadata"
                }
              ]
            },
            {
              pluginId: "internal-only",
              displayName: "Internal Only",
              fields: [
                {
                  key: "internalPluginValue",
                  label: "Internal plugin value",
                  type: "string",
                  visibility: "internal",
                  defaultValue: "hidden"
                }
              ]
            }
          ],
          values: {
            global: { visibleGlobal: true, internalGlobal: "hidden-value" },
            plugins: {
              documentation: {
                aiEnrichmentEnabled: true,
                aiEnrichmentSkillIds: "documentation-enrich-metadata"
              },
              "internal-only": {
                internalPluginValue: "hidden"
              }
            }
          }
        },
        onCancel: vi.fn(),
        onSave: vi.fn(async () => undefined)
      })
    );

    expect(html).toContain("Visible global");
    expect(html).toContain("Documentation");
    expect(html).toContain("AI enrichment");
    expect(html).toContain("GPT-5.4-Mini - Small, fast, and cost-efficient model for simpler coding tasks.");
    expect(html).not.toContain("Internal global");
    expect(html).not.toContain("AI enrichment skills");
    expect(html).not.toContain("Internal Only");
  });

  it("renders a clear action for configured plugin secrets", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsDialog, {
        config: {
          globalFields: [],
          plugins: [
            {
              pluginId: "jira",
              displayName: "Jira",
              fields: [
                {
                  key: "apiToken",
                  label: "Jira API token",
                  type: "secret",
                  defaultValue: "",
                  secretConfigured: true
                }
              ]
            }
          ],
          values: { global: {}, plugins: { jira: { apiToken: "" } } }
        },
        onCancel: vi.fn(),
        onSave: vi.fn(async () => undefined),
        onClearPluginSecret: vi.fn(async () => undefined)
      })
    );

    expect(html).toContain("Jira API token");
    expect(html).toContain("Configured. Leave blank to keep the current value.");
    expect(html).toContain(">Clear<");
  });
});

function configResponse(): CloudxConfigResponse {
  return {
    globalFields: [],
    plugins: [],
    values: {
      global: {},
      plugins: {}
    }
  };
}

function rulesSkillsStore(): RulesSkillsStore {
  return {
    defaultTemplateId: "focused",
    rules: [],
    systemRules: [],
    skills: [],
    systemSkills: [],
    templates: [
      { id: "focused", name: "Focused", color: "yellow", ruleIds: [], skillIds: [] },
      { id: "review", name: "Review", color: "red", ruleIds: [], skillIds: [] }
    ]
  };
}
