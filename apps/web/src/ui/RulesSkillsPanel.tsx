import { useEffect, useRef, useState } from "react";
import { Palette, Pencil, Plus, RefreshCw, Save, Square, SquareCheck, Trash2, X, Zap } from "lucide-react";

import {
  RULES_SKILLS_PLUGIN_ID,
  isRecord,
  type CloudxRule,
  type CreateTabRequest,
  type PersonalityTemplate,
  type RulesSkillsStore,
  type WorkspaceTab,
  type WorkspaceWindow
} from "@cloudx/shared";

import { ControlButton } from "./Control.js";
import { createBrowserId } from "./browserId.js";
import { PluginPanelDock } from "./PluginPanelDock.js";
import { RulesSkillsGitPanel, type RulesSkillsGitActions } from "./RulesSkillsGitPanel.js";

export function TemplateSelect({
  value,
  templates,
  defaultTemplateId,
  onChange,
  label,
  includeInherited = false,
  inheritedLabel = "Inherited"
}: {
  value: string;
  templates: PersonalityTemplate[];
  defaultTemplateId?: string;
  onChange: (value: string) => void;
  label: string;
  includeInherited?: boolean;
  inheritedLabel?: string;
}) {
  return (
    <label className="template-select-row">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {includeInherited ? <option value="">{inheritedLabel}</option> : null}
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}{template.id === defaultTemplateId ? " (default)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RulesSkillsPanel({
  store,
  onSaveTemplate,
  onDeleteTemplate,
  onSetDefault,
  onSaveRule,
  onDeleteRule,
  onInjectRuntime,
  onRefreshStore,
  gitActions
}: {
  store?: RulesSkillsStore;
  onSaveTemplate: (template: PersonalityTemplate) => Promise<void>;
  onDeleteTemplate: (templateId: string) => Promise<void>;
  onSetDefault: (templateId: string | undefined) => Promise<void>;
  onSaveRule: (rule: CloudxRule) => Promise<void>;
  onDeleteRule: (ruleId: string) => Promise<void>;
  onInjectRuntime?: () => Promise<number>;
  onRefreshStore?: () => Promise<void>;
  gitActions?: RulesSkillsGitActions;
}) {
  const templates = store?.templates ?? [];
  const [selectedId, setSelectedId] = useState(templates[0]?.id ?? "");
  const selected = templates.find((template) => template.id === selectedId) ?? templates[0];
  const [draft, setDraft] = useState(() => templateDraft(selected));
  const loadedDraft = useRef(templateDraft(selected));
  const [draftMode, setDraftMode] = useState<"existing" | "new">("existing");
  const [newRuleText, setNewRuleText] = useState("");
  const [editingRule, setEditingRule] = useState<CloudxRule | undefined>();
  const [editingRuleText, setEditingRuleText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState("Templates loaded.");
  const savedDraft = templateDraft(selected);
  const hasUnsavedTemplateChanges = draftMode === "new" || !templateDraftsEqual(draft, savedDraft);
  const hasUnsavedChanges = hasUnsavedTemplateChanges || Boolean(newRuleText.trim()) || editingRule !== undefined;
  const missingRuleIds = draft.ruleIds.filter(id => !store?.rules.some(rule => rule.id === id));
  const missingSkillIds = draft.skillIds.filter(id => !store?.skills.some(skill => skill.id === id));
  const hasMissingTemplateReferences = missingRuleIds.length > 0 || missingSkillIds.length > 0;

  useEffect(() => {
    if (!onRefreshStore) {
      return;
    }
    let active = true;
    onRefreshStore().catch((err) => {
      if (active) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      active = false;
    };
  }, [onRefreshStore]);

  useEffect(() => {
    const nextSelected = templates.find((template) => template.id === selectedId) ?? templates[0];
    const previousSavedDraft = loadedDraft.current;
    loadedDraft.current = templateDraft(nextSelected);
    if (draftMode === "new" || !templateDraftsEqual(draft, previousSavedDraft)) {
      return;
    }
    setSelectedId(nextSelected?.id ?? "");
    setDraft(loadedDraft.current);
  }, [draftMode, selectedId, templates]);

  function updateDraft(patch: Partial<TemplateDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function toggleRule(ruleId: string, enabled: boolean) {
    updateDraft({ ruleIds: enabled ? [...new Set([...draft.ruleIds, ruleId])] : draft.ruleIds.filter((id) => id !== ruleId) });
  }

  function toggleSkill(skillId: string, enabled: boolean) {
    updateDraft({ skillIds: enabled ? [...new Set([...draft.skillIds, skillId])] : draft.skillIds.filter((id) => id !== skillId) });
  }

  function createTemplate() {
    if (hasUnsavedTemplateChanges && !confirmDiscardUnsavedChanges(draft.name)) {
      setStatus("Create cancelled. Save or discard the current changes first.");
      return;
    }
    const id = createBrowserId("template");
    setSelectedId(id);
    setDraftMode("new");
    setDraft({ id, name: "New Template", color: "green", ruleIds: [], skillIds: [] });
    setStatus("New template has unsaved changes.");
  }

  function selectTemplate(template: PersonalityTemplate) {
    if (template.id === draft.id) {
      return;
    }
    if (hasUnsavedTemplateChanges && !confirmDiscardUnsavedChanges(draft.name)) {
      setStatus("Switch cancelled. Save or discard the current changes first.");
      return;
    }
    setSelectedId(template.id);
    setDraftMode("existing");
    setDraft(templateDraft(template));
    setStatus("Template loaded.");
  }

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const template = templateFromDraft(draft);
      await onSaveTemplate(template);
      setSelectedId(template.id);
      setDraft(templateDraft(template));
      setDraftMode("existing");
      setStatus("Template saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft.id) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onDeleteTemplate(draft.id);
      setSelectedId("");
      setDraftMode("existing");
      setStatus("Template deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault() {
    setBusy(true);
    setError(undefined);
    try {
      await onSetDefault(draft.id || undefined);
      setStatus("Default template saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addRule() {
    const rule = cloudxRuleFromText(newRuleText);
    if (!rule) {
      return;
    }
    const nextDraft = draftWithRuleEnabled(draft, rule.id);
    setBusy(true);
    setError(undefined);
    try {
      await onSaveRule(rule);
      await onSaveTemplate(templateFromDraft(nextDraft));
      setDraft(nextDraft);
      setDraftMode("existing");
      setNewRuleText("");
      setStatus("Rule added and template saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function startEditingRule(rule: CloudxRule) {
    setEditingRule(rule);
    setEditingRuleText(rule.text);
    setError(undefined);
  }

  function cancelEditingRule() {
    setEditingRule(undefined);
    setEditingRuleText("");
  }

  async function saveEditedRule(rule: CloudxRule) {
    const edited = cloudxRuleFromEdit(rule, editingRuleText);
    if (!edited) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onSaveRule(edited);
      cancelEditingRule();
      setStatus("Rule saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshStore() {
    if (!onRefreshStore) {
      return;
    }
    if (hasUnsavedTemplateChanges && !confirmDiscardUnsavedChanges(draft.name)) {
      setStatus("Refresh cancelled. Save or discard the current changes first.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onRefreshStore();
      setSelectedId(loadedDraft.current.id);
      setDraft(loadedDraft.current);
      setDraftMode("existing");
      setStatus("Rules and skills refreshed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pullGit(expectedOriginUrl: string) {
    if (!gitActions || hasUnsavedChanges || busy) {
      throw new Error("Save or discard template and rule edits before pulling.");
    }
    setBusy(true);
    try {
      return await gitActions.onPullGit(expectedOriginUrl);
    } finally {
      setBusy(false);
    }
  }

  async function injectRuntime() {
    if (!onInjectRuntime) {
      return;
    }
    if (hasUnsavedTemplateChanges) {
      setStatus("Save template changes before injecting.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const count = await onInjectRuntime();
      setStatus(count === 1 ? "Injected into 1 Codex tab." : `Injected into ${count} Codex tabs.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!store) {
    return <div className="rules-skills-panel empty-pane">Templates are not available.</div>;
  }

  const visibleRules = uniqueById([...store.rules, ...(editingRule ? [editingRule] : [])]);

  return (
    <div className="rules-skills-panel">
      <PluginPanelDock items={[{
        id: "templates",
        label: "Templates",
        icon: <Palette size={15} />,
        children: (
          <div className="rules-skills-sidebar">
            {templates.map((template) => (
              <button key={template.id} type="button" className={`${template.id === draft.id ? "selected" : ""} ${template.id === draft.id && hasUnsavedTemplateChanges ? "dirty" : ""}`} onClick={() => selectTemplate(template)} disabled={busy}>
                <span className={`template-color ${template.color}`} />
                <span>{template.name}</span>
              </button>
            ))}
            <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={createTemplate} disabled={busy} title="Create template" aria-label="Create template">
              <Plus size={15} />
            </ControlButton>
          </div>
        )
      }]} />
      <div className="rules-skills-editor">
        <fieldset className="rules-skills-template-fields" disabled={busy}>
        <label>
          Name
          <input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} />
        </label>
        <label>
          Color
          <select value={draft.color} onChange={(event) => updateDraft({ color: event.target.value as PersonalityTemplate["color"] })}>
            <option value="green">Green</option>
            <option value="yellow">Yellow</option>
            <option value="red">Red</option>
          </select>
        </label>

        <section className="rules-skills-picker">
          <h3>Rules</h3>
          {visibleRules.map((rule) =>
            editingRule?.id === rule.id ? (
              <div key={rule.id} className="rule-option rule-option-editing" title={rule.description}>
                <ControlButton
                  type="button"
                  className="compact-icon-button rule-enable-toggle"
                  size="compact"
                  iconOnly
                  selected={draft.ruleIds.includes(rule.id)}
                  onClick={() => toggleRule(rule.id, !draft.ruleIds.includes(rule.id))}
                  title={draft.ruleIds.includes(rule.id) ? `Disable rule ${rule.id}` : `Enable rule ${rule.id}`}
                  aria-label={draft.ruleIds.includes(rule.id) ? `Disable rule ${rule.id}` : `Enable rule ${rule.id}`}
                >
                  {draft.ruleIds.includes(rule.id) ? <SquareCheck size={13} /> : <Square size={13} />}
                </ControlButton>
                <div className="rule-edit-fields">
                  {!store.rules.some(saved => saved.id === rule.id) ? <small>Removed from catalog. Save to restore this rule or cancel to discard the draft.</small> : null}
                  <div
                    className="rule-edit-text"
                    role="textbox"
                    aria-label={`Rule text for ${rule.id}`}
                    contentEditable={!busy}
                    suppressContentEditableWarning
                    spellCheck={false}
                    data-placeholder="Rule text"
                    onInput={(event) => setEditingRuleText(event.currentTarget.textContent ?? "")}
                  >
                    {editingRuleText}
                  </div>
                </div>
                <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => void saveEditedRule(editingRule)} disabled={busy || !editingRuleText.trim()} title={`Save rule ${rule.id}`} aria-label={`Save rule ${rule.id}`}>
                  <Save size={13} />
                </ControlButton>
                <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={cancelEditingRule} disabled={busy} title={`Cancel editing ${rule.id}`} aria-label={`Cancel editing ${rule.id}`}>
                  <X size={13} />
                </ControlButton>
              </div>
            ) : (
              <label key={rule.id} className="checkbox-row rule-option" title={rule.description}>
                <input type="checkbox" checked={draft.ruleIds.includes(rule.id)} onChange={(event) => toggleRule(rule.id, event.target.checked)} />
                <span>{rule.text}</span>
                <span className="rule-option-actions">
                  <ControlButton
                    type="button"
                    className="compact-icon-button"
                    size="compact"
                    iconOnly
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      startEditingRule(rule);
                    }}
                    title={`Edit rule ${rule.id}`}
                    aria-label={`Edit rule ${rule.id}`}
                  >
                    <Pencil size={13} />
                  </ControlButton>
                  <ControlButton
                    type="button"
                    className="compact-icon-button danger"
                    tone="danger"
                    size="compact"
                    iconOnly
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void onDeleteRule(rule.id);
                    }}
                    title={`Delete rule ${rule.id}`}
                    aria-label={`Delete rule ${rule.id}`}
                  >
                    <Trash2 size={13} />
                  </ControlButton>
                </span>
              </label>
            )
          )}
          {missingRuleIds.filter(id => id !== editingRule?.id).map(id => (
            <label key={id} className="checkbox-row rule-option">
              <input type="checkbox" checked aria-label={`Missing rule ${id}`} onChange={() => toggleRule(id, false)} />
              <span>Missing rule: {id}</span>
            </label>
          ))}
          <div className="rules-skills-inline-create">
            <input value={newRuleText} onChange={(event) => setNewRuleText(event.target.value)} placeholder="Add short rule sentence" />
            <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => void addRule()} disabled={busy || !newRuleText.trim() || hasMissingTemplateReferences} title="Add rule" aria-label="Add rule">
              <Plus size={15} />
            </ControlButton>
          </div>
        </section>

        <section className="rules-skills-picker">
          <h3>Skills</h3>
          {store.skills.length > 0 ? store.skills.map((skill) => (
            <label key={skill.id} className="checkbox-row skill-option" title={skill.description}>
              <input type="checkbox" checked={draft.skillIds.includes(skill.id)} onChange={(event) => toggleSkill(skill.id, event.target.checked)} />
              <span>{skill.name}</span>
              <small>{skill.description}</small>
            </label>
          )) : <p>No CloudX skills yet.</p>}
          {missingSkillIds.map(id => (
            <label key={id} className="checkbox-row skill-option">
              <input type="checkbox" checked aria-label={`Missing skill ${id}`} onChange={() => toggleSkill(id, false)} />
              <span>Missing skill: {id}</span>
            </label>
          ))}
        </section>

        {hasMissingTemplateReferences ? <p role="status">Deselect missing rules and skills or restore them before saving this template.</p> : null}
        <div className="rules-skills-footer">
          <span className="rules-skills-status" aria-live="polite">{status}</span>
          {draft.id ? <span className={`rules-skills-save-state automation-save-state ${hasUnsavedTemplateChanges ? "dirty" : "saved"}`}>{hasUnsavedTemplateChanges ? "Unsaved" : "Saved"}</span> : null}
          <div className="rules-skills-actions">
            <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => void refreshStore()} disabled={busy || !onRefreshStore} title="Refresh rules and skills" aria-label="Refresh rules and skills">
              <RefreshCw size={15} />
            </ControlButton>
            <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => void submit()} disabled={busy || !draft.id.trim() || !draft.name.trim() || !hasUnsavedTemplateChanges || hasMissingTemplateReferences} title={hasUnsavedTemplateChanges ? "Save template changes" : "Template is saved"} aria-label="Save template">
              <Save size={15} />
            </ControlButton>
            <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => void injectRuntime()} disabled={busy || !onInjectRuntime || draftMode === "new" || hasUnsavedTemplateChanges} title={hasUnsavedTemplateChanges ? "Save template changes before injecting" : "Inject saved rules and skills into running Codex tabs"} aria-label="Inject saved rules and skills">
              <Zap size={15} />
            </ControlButton>
            <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => void makeDefault()} disabled={busy || draftMode === "new" || hasUnsavedTemplateChanges || draft.id === store.defaultTemplateId} title="Set default" aria-label="Set default">
              <Palette size={15} />
            </ControlButton>
            <ControlButton type="button" className="compact-icon-button danger" tone="danger" size="compact" iconOnly onClick={() => void remove()} disabled={busy || draftMode === "new" || hasUnsavedTemplateChanges || templates.length <= 1} title="Delete template" aria-label="Delete template">
              <Trash2 size={15} />
            </ControlButton>
          </div>
        </div>
        {error ? <div className="window-menu-error">{error}</div> : null}
        </fieldset>
        {gitActions ? <RulesSkillsGitPanel {...gitActions} onPullGit={pullGit} disabled={busy} hasUnsavedChanges={hasUnsavedChanges} /> : null}
      </div>
    </div>
  );
}

export function pluginMetadataForTemplate(templateId: string | undefined): CreateTabRequest["pluginMetadata"] {
  return templateId ? { [RULES_SKILLS_PLUGIN_ID]: { selectedTemplateId: templateId } } : undefined;
}

export function selectedTemplateId(source: WorkspaceWindow | WorkspaceTab | undefined): string {
  const metadata = source?.pluginMetadata?.[RULES_SKILLS_PLUGIN_ID];
  return isRecord(metadata) && typeof metadata.selectedTemplateId === "string" ? metadata.selectedTemplateId : "";
}

export interface TemplateDraft {
  id: string;
  name: string;
  color: PersonalityTemplate["color"];
  ruleIds: string[];
  skillIds: string[];
}

export function templateDraft(template: PersonalityTemplate | undefined): TemplateDraft {
  return {
    id: template?.id ?? "",
    name: template?.name ?? "",
    color: template?.color ?? "green",
    ruleIds: template?.ruleIds ?? [],
    skillIds: template?.skillIds ?? []
  };
}

export function templateFromDraft(draft: TemplateDraft): PersonalityTemplate {
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    color: draft.color,
    ruleIds: [...new Set(draft.ruleIds)],
    skillIds: [...new Set(draft.skillIds)]
  };
}

export function templateDraftsEqual(first: TemplateDraft, second: TemplateDraft): boolean {
  return personalityTemplatesEqual(templateFromDraft(first), templateFromDraft(second));
}

export function personalityTemplatesEqual(first: PersonalityTemplate, second: PersonalityTemplate): boolean {
  return first.id === second.id && first.name === second.name && first.color === second.color && stringArraysEqual(first.ruleIds, second.ruleIds) && stringArraysEqual(first.skillIds, second.skillIds);
}

export function draftWithRuleEnabled(draft: TemplateDraft, ruleId: string): TemplateDraft {
  return { ...draft, ruleIds: [...new Set([...draft.ruleIds, ruleId])] };
}

export function cloudxRuleFromText(value: string): CloudxRule | undefined {
  const text = value.trim();
  const id = text ? slugFromText(text) : undefined;
  return id ? { id, description: text, text } : undefined;
}

export function cloudxRuleFromEdit(rule: CloudxRule, textValue: string): CloudxRule | undefined {
  const text = textValue.trim();
  if (!text) {
    return undefined;
  }
  const existingDescription = rule.description.trim();
  const existingText = rule.text.trim();
  const description = existingDescription && existingDescription !== existingText ? existingDescription : text;
  return { id: rule.id, description, text };
}

function slugFromText(text: string): string | undefined {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || undefined;
}

function stringArraysEqual(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function confirmDiscardUnsavedChanges(templateName: string | undefined): boolean {
  const subject = templateName?.trim() || "the current template";
  return window.confirm(`Discard unsaved changes to ${subject}?`);
}
