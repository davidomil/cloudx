import { useEffect, useRef, useState, type ReactNode } from "react";

import type { CloudxConfigResponse, CloudxConfigValues, ConfigFieldDescriptor, ConfigValue, RulesSkillsStore } from "@cloudx/shared";

import { ControlButton } from "./Control.js";
import { useOutsidePointerDismiss } from "./outsidePointer.js";
import { TemplateSelect } from "./RulesSkillsPanel.js";

export function SettingsDialog({
  config,
  rulesSkillsStore,
  onCancel,
  onSave,
  onSaveDefaultTemplate,
  children
}: {
  config: CloudxConfigResponse;
  rulesSkillsStore?: RulesSkillsStore;
  onCancel: () => void;
  onSave: (values: CloudxConfigValues) => Promise<void>;
  onSaveDefaultTemplate?: (templateId: string | undefined) => Promise<void>;
  children?: ReactNode;
}) {
  const [values, setValues] = useState<CloudxConfigValues>(() => structuredClone(config.values));
  const [defaultTemplateId, setDefaultTemplateId] = useState(rulesSkillsStore?.defaultTemplateId ?? "");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useOutsidePointerDismiss(true, dialogRef, onCancel);

  useEffect(() => {
    setDefaultTemplateId(rulesSkillsStore?.defaultTemplateId ?? "");
  }, [rulesSkillsStore?.defaultTemplateId]);

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

  return (
    <div className="dialog-backdrop">
      <div className="dialog settings-dialog" ref={dialogRef}>
        <h2>Settings</h2>
        <section className="settings-section">
          <h3>Global</h3>
          {config.globalFields.map((field) => (
            <ConfigField key={field.key} field={field} value={values.global[field.key] ?? field.defaultValue} onChange={(value) => setGlobalValue(field.key, value)} />
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
        {children}
        <section className="settings-section">
          <h3>Plugins</h3>
          {config.plugins.length ? (
            config.plugins.map((plugin) => (
              <div key={plugin.pluginId} className="settings-plugin-section">
                <h4>{plugin.displayName}</h4>
                {plugin.fields.map((field) => (
                  <ConfigField key={`${plugin.pluginId}:${field.key}`} field={field} value={values.plugins[plugin.pluginId]?.[field.key] ?? field.defaultValue} onChange={(value) => setPluginValue(plugin.pluginId, field.key, value)} />
                ))}
              </div>
            ))
          ) : (
            <p>No plugin settings.</p>
          )}
        </section>
        <div className="dialog-actions">
          <ControlButton onClick={onCancel} disabled={busy}>Cancel</ControlButton>
          <ControlButton className="primary-button" tone="primary" onClick={() => void save()} disabled={busy}>Save</ControlButton>
        </div>
      </div>
    </div>
  );
}

function ConfigField({ field, value, onChange }: { field: ConfigFieldDescriptor; value: ConfigValue; onChange: (value: ConfigValue) => void }) {
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
              {option.label}
            </option>
          ))}
        </select>
        {field.description ? <small>{field.description}</small> : null}
      </label>
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
