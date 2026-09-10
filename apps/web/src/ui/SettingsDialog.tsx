import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Bell, Blocks, Search, Settings2, X } from "lucide-react";

import type { CloudxConfigResponse, CloudxConfigValues, ConfigFieldDescriptor, ConfigValue, ForgeRepository, RulesSkillsStore } from "@cloudx/shared";

import { ControlButton } from "./Control.js";
import { ForgeConnections } from "./ForgeConnections.js";
import { useOutsidePointerDismiss } from "./outsidePointer.js";
import { TemplateSelect } from "./RulesSkillsPanel.js";
import type { BrowserNotificationPermissionState } from "./notifications.js";

interface SettingsEntry {
  id: string;
  searchText: string;
  content: ReactNode;
}

interface SettingsCategory {
  id: string;
  label: string;
  description: string;
  entries: SettingsEntry[];
}

export function SettingsDialog({
  config,
  rulesSkillsStore,
  onCancel,
  onSave,
  onClearPluginSecret,
  onSaveDefaultTemplate,
  browserNotificationState,
  onRequestBrowserNotifications,
  children
}: {
  config: CloudxConfigResponse;
  rulesSkillsStore?: RulesSkillsStore;
  onCancel: () => void;
  onSave: (values: CloudxConfigValues) => Promise<void>;
  onClearPluginSecret?: (pluginId: string, key: string) => Promise<void>;
  onSaveDefaultTemplate?: (templateId: string | undefined) => Promise<void>;
  browserNotificationState?: BrowserNotificationPermissionState;
  onRequestBrowserNotifications?: () => Promise<void>;
  children?: ReactNode;
}) {
  const [values, setValues] = useState<CloudxConfigValues>(() => structuredClone(config.values));
  const [defaultTemplateId, setDefaultTemplateId] = useState(rulesSkillsStore?.defaultTemplateId ?? "");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategoryId, setActiveCategoryId] = useState("general");
  const [horizontalTabs, setHorizontalTabs] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const forgeFields = config.plugins.find(plugin => plugin.pluginId === "forge")?.fields ?? [];
  const selectedRepository = forgeRepository(values.plugins.forge, forgeFields);

  useOutsidePointerDismiss(true, dialogRef, onCancel);

  useEffect(() => {
    const previousFocus = document.activeElement;
    searchRef.current?.focus();
    return () => { if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const updateOrientation = () => setHorizontalTabs(media.matches);
    updateOrientation();
    media.addEventListener("change", updateOrientation);
    return () => media.removeEventListener("change", updateOrientation);
  }, []);

  useEffect(() => {
    setDefaultTemplateId(rulesSkillsStore?.defaultTemplateId ?? "");
  }, [rulesSkillsStore?.defaultTemplateId]);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeCategoryId, query]);

  async function save() {
    setBusy(true);
    try {
      if (rulesSkillsStore && onSaveDefaultTemplate && defaultTemplateId !== (rulesSkillsStore.defaultTemplateId ?? "")) {
        await onSaveDefaultTemplate(defaultTemplateId || undefined);
      }
      await onSave(values);
    } finally {
      setBusy(false);
    }
  }

  function setGlobalValue(key: string, value: ConfigValue) {
    setValues((current) => ({ ...current, global: { ...current.global, [key]: value } }));
  }

  function setPluginValue(pluginId: string, key: string, value: ConfigValue) {
    setValues((current) => {
      const previous = current.plugins[pluginId] ?? {};
      const next: Record<string, ConfigValue> = {
        ...previous,
        ...(pluginId === "forge" && key === "provider" ? { apiUrl: value === "gitlab" ? "https://gitlab.com/api/v4" : "https://api.github.com" } : {}),
        [key]: value
      };
      return { ...current, plugins: { ...current.plugins, [pluginId]: next } };
    });
  }

  function fieldEntry(field: ConfigFieldDescriptor, pluginId?: string): SettingsEntry {
    return {
      id: field.key,
      searchText: [field.key, field.label, field.description, ...(field.options ?? []).flatMap(option => [option.label, option.description, String(option.value)]),
        ...(field.optionSource === "rulesSkills.templates" ? rulesSkillsStore?.templates.map(template => template.name) ?? [] : [])].join(" "),
      content: <ConfigField
        field={field}
        templates={rulesSkillsStore?.templates}
        value={(pluginId ? values.plugins[pluginId]?.[field.key] : values.global[field.key]) ?? field.defaultValue}
        onChange={value => pluginId ? setPluginValue(pluginId, field.key, value) : setGlobalValue(field.key, value)}
        onClearSecret={pluginId && field.type === "secret" && field.secretConfigured && onClearPluginSecret ? () => onClearPluginSecret(pluginId, field.key) : undefined}
      />
    };
  }

  const categories: SettingsCategory[] = [{
    id: "general",
    label: "General",
    description: "Appearance, AI controls, and defaults for CloudX.",
    entries: config.globalFields.filter(isUserVisibleConfigField).map(field => fieldEntry(field))
  }];
  if (rulesSkillsStore) categories[0].entries.push({
    id: "default-template",
    searchText: `Default template personality ${rulesSkillsStore.templates.map(template => template.name).join(" ")}`,
    content: <TemplateSelect value={defaultTemplateId} templates={rulesSkillsStore.templates} defaultTemplateId={defaultTemplateId} onChange={setDefaultTemplateId} label="Default template" />
  });
  if (children) categories[0].entries.push({ id: "additional", searchText: "Additional settings", content: children });
  for (const plugin of config.plugins) {
    const entries = plugin.fields.filter(isUserVisibleConfigField).map(field => fieldEntry(field, plugin.pluginId));
    if (plugin.pluginId === "forge") entries.push({
      id: "connections",
      searchText: "Connections Connect issue worker reviewer GitHub GitLab setup token registration",
      content: <ForgeConnections repository={selectedRepository} savedRepository={forgeRepository(config.values.plugins.forge, forgeFields)} />
    });
    if (entries.length) categories.push({
      id: `plugin:${plugin.pluginId}`,
      label: plugin.displayName,
      description: `Configure ${plugin.displayName} for your workspace.`,
      entries
    });
  }
  if (browserNotificationState) categories.push({
    id: "browser",
    label: "Browser",
    description: "Permissions for this browser and CloudX origin.",
    entries: [{
      id: "notifications",
      searchText: `Browser Notifications Request permission ${browserNotificationMessage(browserNotificationState)}`,
      content: <BrowserNotificationSettings state={browserNotificationState} onRequest={onRequestBrowserNotifications} />
    }]
  });

  const searchWords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filteredCategories = categories.map(category => ({
    ...category,
    entries: category.entries.map(entry => ({ ...entry, matches: matchesSettingsSearch(category, entry, query) }))
  }));
  const totalMatches = filteredCategories.reduce((count, category) => count + category.entries.filter(entry => entry.matches).length, 0);
  const activeCategory = filteredCategories.find(category => category.id === activeCategoryId) ?? filteredCategories[0];

  useEffect(() => {
    tabsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeCategory.id, horizontalTabs]);

  function changeQuery(nextQuery: string) {
    setQuery(nextQuery);
    const hasMatches = (category: SettingsCategory) => category.entries.some(entry => matchesSettingsSearch(category, entry, nextQuery));
    if (!hasMatches(activeCategory)) {
      const firstMatch = categories.find(hasMatches);
      if (firstMatch) setActiveCategoryId(firstMatch.id);
    }
  }

  function clearSearch() {
    changeQuery("");
    searchRef.current?.focus();
  }

  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const previousKey = horizontalTabs ? "ArrowLeft" : "ArrowUp";
    const nextKey = horizontalTabs ? "ArrowRight" : "ArrowDown";
    const destinations: Record<string, number> = {
      Home: 0,
      End: tabs.length - 1,
      [nextKey]: (index + 1) % tabs.length,
      [previousKey]: (index - 1 + tabs.length) % tabs.length
    };
    const next = destinations[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActiveCategoryId(categories[next].id);
    tabs[next].focus();
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Tab") {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
        .filter(element => !element.closest("[hidden]") && !element.matches(":disabled") && element.tabIndex >= 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }

  return (
    <div className="dialog-backdrop settings-backdrop">
      <div className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} ref={dialogRef} onKeyDown={handleDialogKeyDown}>
        <div className="settings-body">
          <header className="settings-header">
            <div className="settings-title"><Settings2 size={22} aria-hidden="true" /><div><h2 id={`${id}-title`}>Settings</h2><p>Configure your workspace, tools, and integrations.</p></div></div>
            <ControlButton iconOnly title="Close settings" aria-label="Close settings" onClick={onCancel} disabled={busy}><X size={18} /></ControlButton>
          </header>
          <div className="settings-search-bar">
            <div className="settings-search-control">
              <Search size={18} aria-hidden="true" />
              <input ref={searchRef} type="search" aria-label="Search settings" placeholder="Search all settings…" value={query} onChange={event => changeQuery(event.target.value)} />
              {query ? <ControlButton iconOnly size="compact" aria-label="Clear search" title="Clear search" onClick={clearSearch}><X size={16} /></ControlButton> : null}
            </div>
            <span className="settings-result-count" role="status">{searchWords.length ? `${totalMatches} matching settings` : `${totalMatches} settings`} across all tabs</span>
          </div>
          <div className="settings-workspace">
            <div className="settings-tabs" ref={tabsRef} role="tablist" aria-label="Settings categories" aria-orientation={horizontalTabs ? "horizontal" : "vertical"} onKeyDown={navigateTabs}>
              {filteredCategories.map((category, index) => {
                const Icon = category.id === "general" ? Settings2 : category.id === "browser" ? Bell : Blocks;
                return <button key={category.id} type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-label={category.label} aria-selected={category.id === activeCategory.id} tabIndex={category.id === activeCategory.id ? 0 : -1} onClick={() => setActiveCategoryId(category.id)}>
                  <Icon size={16} aria-hidden="true" /><span>{category.label}</span><small>{category.entries.filter(entry => entry.matches).length}</small>
                </button>;
              })}
            </div>
            <div className="settings-content" ref={contentRef}>
              {filteredCategories.map((category, index) => <section key={category.id} className="settings-category" role="tabpanel" id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`} hidden={category.id !== activeCategory.id} tabIndex={0}>
                <div className="settings-category-heading"><h3>{category.label}</h3><p>{category.description}</p></div>
                {category.entries.map(entry => <div key={entry.id} className="settings-entry" hidden={!entry.matches}>{entry.content}</div>)}
                {!category.entries.some(entry => entry.matches) ? <div className="settings-empty">
                  <Search size={28} aria-hidden="true" />
                  <h4>{searchWords.length ? "No matching settings" : "No settings in this tab"}</h4>
                  <p>{searchWords.length ? totalMatches ? "Try another tab with matches, or clear your search." : "Try a different name, description, or plugin." : "Settings will appear here when available."}</p>
                  {query ? <ControlButton onClick={clearSearch}>Show all settings</ControlButton> : null}
                </div> : null}
              </section>)}
            </div>
          </div>
        </div>
        <footer className="settings-footer">
          <small>Save applies changes across all tabs.</small>
          <div className="dialog-actions">
            <ControlButton onClick={onCancel} disabled={busy}>Cancel</ControlButton>
            <ControlButton className="primary-button" tone="primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</ControlButton>
          </div>
        </footer>
      </div>
    </div>
  );
}

function matchesSettingsSearch(category: SettingsCategory, entry: SettingsEntry, query: string): boolean {
  const text = `${category.id} ${category.label} ${entry.searchText}`.toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(word => text.includes(word));
}

function BrowserNotificationSettings({ state, onRequest }: { state: BrowserNotificationPermissionState; onRequest?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const requestDisabled = busy || !onRequest || state === "granted" || state === "denied" || state === "unsupported" || state === "insecure";

  async function requestPermission() {
    if (!onRequest) {
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      await onRequest();
      setMessage("Browser notification permission was updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section browser-notification-settings">
      <h3>Browser Notifications</h3>
      <p>{browserNotificationMessage(state)}</p>
      <ControlButton type="button" size="compact" onClick={() => void requestPermission()} disabled={requestDisabled}>
        Request permission
      </ControlButton>
      {message ? <small>{message}</small> : null}
    </section>
  );
}

function browserNotificationMessage(state: BrowserNotificationPermissionState): string {
  if (state === "granted") {
    return "Browser notifications are allowed for this Cloudx origin.";
  }
  if (state === "denied") {
    return "Browser notifications are blocked in the browser permission settings for this origin.";
  }
  if (state === "unsupported") {
    return "This browser does not expose desktop notifications.";
  }
  if (state === "insecure") {
    return "Browser notifications require HTTPS or another secure context.";
  }
  return "Allow Cloudx to mirror in-app notifications through the browser notification system.";
}

function ConfigField({ field, value, onChange, onClearSecret, templates }: { field: ConfigFieldDescriptor; value: ConfigValue; onChange: (value: ConfigValue) => void; onClearSecret?: () => Promise<void>; templates?: RulesSkillsStore["templates"] }) {
  const [clearing, setClearing] = useState(false);

  async function clearSecret() {
    if (!onClearSecret) {
      return;
    }
    setClearing(true);
    try {
      await onClearSecret();
      onChange("");
    } finally {
      setClearing(false);
    }
  }

  if (field.type === "string" && field.optionSource === "rulesSkills.templates") {
    return (
      <label>
        {field.label}
        <select aria-label={field.label} value={String(value)} disabled={!templates?.length} onChange={event => onChange(event.target.value)}>
          <option value="">Choose a template</option>
          {value && !templates?.some(template => template.id === value) ? <option value={String(value)}>Saved template is unavailable</option> : null}
          {templates?.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
        {field.description ? <small>{field.description}</small> : null}
        {!templates?.length ? <small>Create a template in Rules / Skills first.</small> : null}
      </label>
    );
  }

  if (field.type === "boolean") {
    return (
      <label className="settings-toggle">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>
          {field.label}
          {field.description ? <small>{field.description}</small> : null}
        </span>
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <label>
        {field.label}
        <select aria-label={field.label} value={String(value)} onChange={(event) => onChange(parseSelectValue(event.target.value, field))}>
          {(field.options ?? []).map((option) => (
            <option key={`${field.key}:${String(option.value)}`} value={String(option.value)}>
              {selectOptionLabel(option)}
            </option>
          ))}
        </select>
        {field.description ? <small>{field.description}</small> : null}
      </label>
    );
  }

  if (field.type === "secret") {
    return (
      <label>
        {field.label}
        <span className="settings-secret-control">
          <input
            type="password"
            value={String(value)}
            placeholder={field.secretConfigured ? "Configured" : ""}
            autoComplete="off"
            aria-label={field.label}
            disabled={clearing}
            onChange={(event) => onChange(event.target.value)}
          />
          {onClearSecret ? <ControlButton size="compact" onClick={() => void clearSecret()} disabled={clearing}>Clear</ControlButton> : null}
        </span>
        {field.description ? <small>{field.description}</small> : null}
        {field.secretConfigured ? <small>Configured. Leave blank to keep the current value.</small> : null}
      </label>
    );
  }

  return (
    <label>
      {field.label}
      <input
        aria-label={field.label}
        type={field.type === "number" ? "number" : "text"}
        value={String(value)}
        min={field.type === "number" ? field.min : undefined}
        max={field.type === "number" ? field.max : undefined}
        step={field.type === "number" ? field.step : undefined}
        onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)}
      />
      {field.description ? <small>{field.description}</small> : null}
    </label>
  );
}

function forgeRepository(values: Record<string, ConfigValue> | undefined, fields: ConfigFieldDescriptor[]): ForgeRepository | undefined {
  const value = (key: string) => values?.[key] ?? fields.find(field => field.key === key)?.defaultValue;
  const provider = value("provider");
  const apiUrl = value("apiUrl");
  const projectPath = value("projectPath");
  if ((provider !== "github" && provider !== "gitlab") || typeof apiUrl !== "string" || typeof projectPath !== "string" || !projectPath.trim()) return undefined;
  return { provider, apiUrl: apiUrl.trim().replace(/\/$/, ""), projectPath: projectPath.trim() };
}

function parseSelectValue(raw: string, field: ConfigFieldDescriptor): ConfigValue {
  return field.options?.find((option) => String(option.value) === raw)?.value ?? raw;
}

function selectOptionLabel(option: NonNullable<ConfigFieldDescriptor["options"]>[number]): string {
  return option.description ? `${option.label} - ${option.description}` : option.label;
}

function isUserVisibleConfigField(field: ConfigFieldDescriptor): boolean {
  return field.visibility !== "internal";
}
