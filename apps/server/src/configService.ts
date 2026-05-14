import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { CLOUDX_THEME_OPTIONS, DEFAULT_CLOUDX_THEME_ID } from "@cloudx/shared";
import type { CloudxConfigResponse, CloudxConfigValues, ConfigFieldDescriptor, ConfigValue, PluginDescriptor, PluginId } from "@cloudx/shared";

export const GLOBAL_CONFIG_FIELDS: ConfigFieldDescriptor[] = [
  {
    key: "aiControlEnabled",
    label: "AI control",
    type: "boolean",
    description: "Enable voice and typed AI control surfaces.",
    defaultValue: true
  },
  {
    key: "microphoneEnabled",
    label: "Microphone",
    type: "boolean",
    description: "Enable microphone capture for AI control.",
    defaultValue: true
  },
  {
    key: "themeId",
    label: "Theme",
    type: "select",
    description: "Choose the active CloudX visual theme.",
    defaultValue: DEFAULT_CLOUDX_THEME_ID,
    options: CLOUDX_THEME_OPTIONS
  }
];

interface StoredConfig {
  global?: Record<string, unknown>;
  plugins?: Record<string, Record<string, unknown>>;
}

export class ConfigService {
  readonly configPath: string;
  private values: CloudxConfigValues;

  constructor(
    dataDir: string,
    private readonly listPlugins: () => PluginDescriptor[] = () => []
  ) {
    this.configPath = path.join(dataDir, "config.json");
    this.values = this.loadStoredConfig();
  }

  getResponse(): CloudxConfigResponse {
    const plugins = this.pluginSections();
    return {
      globalFields: GLOBAL_CONFIG_FIELDS,
      plugins,
      values: this.resolvedValues(plugins)
    };
  }

  getValues(): CloudxConfigValues {
    return this.getResponse().values;
  }

  getPluginConfig(pluginId: PluginId): Record<string, ConfigValue> {
    return this.getValues().plugins[pluginId] ?? {};
  }

  isAiControlEnabled(): boolean {
    return this.getValues().global.aiControlEnabled !== false;
  }

  isMicrophoneEnabled(): boolean {
    const global = this.getValues().global;
    return global.aiControlEnabled !== false && global.microphoneEnabled !== false;
  }

  async update(patch: Partial<CloudxConfigValues>): Promise<CloudxConfigResponse> {
    const plugins = this.pluginSections();
    this.values = mergeConfigValues(this.values, validatePatch(patch, GLOBAL_CONFIG_FIELDS, plugins));
    await fsp.mkdir(path.dirname(this.configPath), { recursive: true });
    await fsp.writeFile(this.configPath, `${JSON.stringify(this.values, null, 2)}\n`, "utf8");
    return this.getResponse();
  }

  private pluginSections() {
    return this.listPlugins()
      .filter((plugin) => plugin.configFields.length > 0)
      .map((plugin) => ({
        pluginId: plugin.id,
        displayName: plugin.displayName,
        fields: plugin.configFields
      }));
  }

  private resolvedValues(plugins: CloudxConfigResponse["plugins"]): CloudxConfigValues {
    const global = resolveFieldValues(GLOBAL_CONFIG_FIELDS, this.values.global);
    const pluginValues: Record<string, Record<string, ConfigValue>> = {};
    for (const plugin of plugins) {
      pluginValues[plugin.pluginId] = resolveFieldValues(plugin.fields, this.values.plugins[plugin.pluginId]);
    }
    return { global, plugins: pluginValues };
  }

  private loadStoredConfig(): CloudxConfigValues {
    if (!fs.existsSync(this.configPath)) {
      return { global: {}, plugins: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as StoredConfig;
    return {
      global: sanitizeUnknownRecord(parsed.global),
      plugins: Object.fromEntries(Object.entries(parsed.plugins ?? {}).map(([pluginId, values]) => [pluginId, sanitizeUnknownRecord(values)]))
    };
  }
}

function validatePatch(patch: Partial<CloudxConfigValues>, globalFields: ConfigFieldDescriptor[], plugins: CloudxConfigResponse["plugins"]): CloudxConfigValues {
  const global = patch.global === undefined ? {} : validateFieldValues(patch.global, globalFields, "global");
  const pluginFieldMap = new Map(plugins.map((plugin) => [plugin.pluginId, plugin.fields]));
  const pluginValues: Record<string, Record<string, ConfigValue>> = {};
  for (const [pluginId, values] of Object.entries(patch.plugins ?? {})) {
    const fields = pluginFieldMap.get(pluginId);
    if (!fields) {
      throw new Error(`Unknown plugin config section: ${pluginId}`);
    }
    pluginValues[pluginId] = validateFieldValues(values, fields, `plugins.${pluginId}`);
  }
  return { global, plugins: pluginValues };
}

function validateFieldValues(values: Record<string, ConfigValue>, fields: ConfigFieldDescriptor[], label: string): Record<string, ConfigValue> {
  const fieldMap = new Map(fields.map((field) => [field.key, field]));
  const validated: Record<string, ConfigValue> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = fieldMap.get(key);
    if (!field) {
      throw new Error(`Unknown config key: ${label}.${key}`);
    }
    validated[key] = validateFieldValue(value, field, `${label}.${key}`);
  }
  return validated;
}

function validateFieldValue(value: ConfigValue, field: ConfigFieldDescriptor, label: string): ConfigValue {
  if (field.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  if (field.type === "string" && typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${label} must be a finite number.`);
  }
  if (field.type === "number" && typeof value === "number" && field.min !== undefined && value < field.min) {
    throw new Error(`${label} must be greater than or equal to ${field.min}.`);
  }
  if (field.type === "number" && typeof value === "number" && field.max !== undefined && value > field.max) {
    throw new Error(`${label} must be less than or equal to ${field.max}.`);
  }
  if (field.type === "select" && !field.options?.some((option) => option.value === value)) {
    throw new Error(`${label} must be one of the configured options.`);
  }
  return value;
}

function resolveFieldValues(fields: ConfigFieldDescriptor[], stored: Record<string, ConfigValue> = {}): Record<string, ConfigValue> {
  return Object.fromEntries(fields.map((field) => [field.key, stored[field.key] ?? field.defaultValue]));
}

function mergeConfigValues(current: CloudxConfigValues, patch: CloudxConfigValues): CloudxConfigValues {
  return {
    global: { ...current.global, ...patch.global },
    plugins: {
      ...current.plugins,
      ...Object.fromEntries(Object.entries(patch.plugins).map(([pluginId, values]) => [pluginId, { ...(current.plugins[pluginId] ?? {}), ...values }]))
    }
  };
}

function sanitizeUnknownRecord(values: Record<string, unknown> | undefined): Record<string, ConfigValue> {
  const result: Record<string, ConfigValue> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
      result[key] = value;
    }
  }
  return result;
}
