import { useEffect, useRef, useState, type ReactNode } from "react";

import type { CloudxConfigResponse, CloudxConfigValues, ConfigFieldDescriptor, ConfigValue, RulesSkillsStore } from "@cloudx/shared";

import { ControlButton } from "./Control.js";
import { useOutsidePointerDismiss } from "./outsidePointer.js";
import { TemplateSelect } from "./RulesSkillsPanel.js";
import type { BrowserNotificationPermissionState } from "./notifications.js";

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
  const [pendingSecretImports, setPendingSecretImports] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useOutsidePointerDismiss(true, dialogRef, onCancel);

  useEffect(() => {
    setDefaultTemplateId(rulesSkillsStore?.defaultTemplateId ?? "");
  }, [rulesSkillsStore?.defaultTemplateId]);

  async function save() {
    if (pendingSecretImports) return;
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

  function beginSecretImport(): () => void {
    setPendingSecretImports(count => count + 1);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      setPendingSecretImports(count => count - 1);
    };
  }

  function setGlobalValue(key: string, value: ConfigValue) {
    setValues((current) => ({ ...current, global: { ...current.global, [key]: value } }));
  }

  function setPluginValue(pluginId: string, key: string, value: ConfigValue) {
    setValues((current) => ({
      ...current,
      plugins: {
        ...current.plugins,
        [pluginId]: {
          ...(current.plugins[pluginId] ?? {}),
          [key]: value
        }
      }
    }));
  }

  const globalFields = config.globalFields.filter(isUserVisibleConfigField);
  const pluginSections = config.plugins
    .map((plugin) => ({ ...plugin, fields: plugin.fields.filter(isUserVisibleConfigField) }))
    .filter((plugin) => plugin.fields.length > 0);

  return (
    <div className="dialog-backdrop">
      <div className="dialog settings-dialog" ref={dialogRef}>
        <h2>Settings</h2>
        <section className="settings-section">
          <h3>Global</h3>
          {globalFields.map((field) => (
            <ConfigField key={field.key} field={field} templates={rulesSkillsStore?.templates} beginSecretImport={beginSecretImport} value={values.global[field.key] ?? field.defaultValue} onChange={(value) => setGlobalValue(field.key, value)} />
          ))}
          {rulesSkillsStore ? (
            <TemplateSelect
              value={defaultTemplateId}
              templates={rulesSkillsStore.templates}
              defaultTemplateId={defaultTemplateId}
              onChange={setDefaultTemplateId}
              label="Default template"
            />
          ) : null}
        </section>
        {browserNotificationState ? (
          <BrowserNotificationSettings state={browserNotificationState} onRequest={onRequestBrowserNotifications} />
        ) : null}
        {children}
        <section className="settings-section">
          <h3>Plugins</h3>
          {pluginSections.length ? (
            pluginSections.map((plugin) => (
              <div key={plugin.pluginId} className="settings-plugin-section">
                <h4>{plugin.displayName}</h4>
                {plugin.fields.map((field) => (
                  <ConfigField
                    key={`${plugin.pluginId}:${field.key}`}
                    field={field}
                    templates={rulesSkillsStore?.templates}
                    beginSecretImport={beginSecretImport}
                    value={values.plugins[plugin.pluginId]?.[field.key] ?? field.defaultValue}
                    onChange={(value) => setPluginValue(plugin.pluginId, field.key, value)}
                    onClearSecret={field.type === "secret" && field.secretConfigured && onClearPluginSecret ? () => onClearPluginSecret(plugin.pluginId, field.key) : undefined}
                  />
                ))}
              </div>
            ))
          ) : (
            <p>No plugin settings.</p>
          )}
        </section>
        <div className="dialog-actions">
          <ControlButton onClick={onCancel} disabled={busy}>Cancel</ControlButton>
          <ControlButton className="primary-button" tone="primary" onClick={() => void save()} disabled={busy || pendingSecretImports > 0}>Save</ControlButton>
        </div>
      </div>
    </div>
  );
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

function ConfigField({ field, value, onChange, onClearSecret, templates, beginSecretImport }: { field: ConfigFieldDescriptor; value: ConfigValue; onChange: (value: ConfigValue) => void; onClearSecret?: () => Promise<void>; templates?: RulesSkillsStore["templates"]; beginSecretImport: () => () => void }) {
  const [clearing, setClearing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const activeImport = useRef<(() => void) | undefined>(undefined);

  useEffect(() => () => {
    activeImport.current?.();
    activeImport.current = undefined;
  }, []);

  async function importSecretFile(file: File) {
    setImportMessage("");
    if (file.size > 64 * 1024) {
      setImportMessage("Choose a file no larger than 64 KB.");
      return;
    }
    const finish = beginSecretImport();
    activeImport.current = finish;
    setImporting(true);
    try {
      const text = await file.text();
      if (activeImport.current !== finish) return;
      onChange(text);
      setImportMessage("File imported. Save to apply.");
    } catch {
      if (activeImport.current === finish) setImportMessage("Could not read the selected file.");
    } finally {
      finish();
      if (activeImport.current === finish) {
        activeImport.current = undefined;
        setImporting(false);
      }
    }
  }

  async function clearSecret() {
    if (!onClearSecret) {
      return;
    }
    setClearing(true);
    try {
      await onClearSecret();
      onChange("");
      setImportMessage("");
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
        <select value={String(value)} onChange={(event) => onChange(parseSelectValue(event.target.value, field))}>
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
      <div>
      <label>
        {field.label}
        <span className="settings-secret-control">
          <input
            type="password"
            value={String(value)}
            placeholder={field.secretConfigured ? "Configured" : ""}
            autoComplete="off"
            aria-label={field.label}
            disabled={importing || clearing}
            onChange={(event) => { onChange(event.target.value); setImportMessage(""); }}
          />
          {onClearSecret ? <ControlButton size="compact" onClick={() => void clearSecret()} disabled={clearing || importing}>Clear</ControlButton> : null}
        </span>
        {field.description ? <small>{field.description}</small> : null}
        {field.secretConfigured ? <small>Configured. Leave blank to keep the current value.</small> : null}
      </label>
      {field.acceptFile ? (
        <label>
          Import from file
          <input type="file" accept={field.acceptFile} aria-label={`Import ${field.label} from file`} disabled={importing || clearing} onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void importSecretFile(file);
          }} />
          <small role="status">{importing ? "Reading file…" : importMessage}</small>
        </label>
      ) : null}
      </div>
    );
  }

  return (
    <label>
      {field.label}
      <input
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

function parseSelectValue(raw: string, field: ConfigFieldDescriptor): ConfigValue {
  return field.options?.find((option) => String(option.value) === raw)?.value ?? raw;
}

function selectOptionLabel(option: NonNullable<ConfigFieldDescriptor["options"]>[number]): string {
  return option.description ? `${option.label} - ${option.description}` : option.label;
}

function isUserVisibleConfigField(field: ConfigFieldDescriptor): boolean {
  return field.visibility !== "internal";
}
