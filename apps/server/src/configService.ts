import { CLOUDX_THEME_OPTIONS, DEFAULT_CLOUDX_THEME_ID } from "@cloudx/shared";
import type { CloudxConfigResponse, CloudxConfigValues, ConfigFieldDescriptor, ConfigValue, PluginDescriptor, PluginId } from "@cloudx/shared";

import { ConfigSecretStore, type ConfigSecretPatch } from "./configSecretStore.js";
import { JsonStateFile } from "./jsonStateFile.js";

export const GLOBAL_CONFIG_FIELDS: ConfigFieldDescriptor[] = [
  {
    key: "aiControlEnabled",
    label: "AI control",
    type: "boolean",
    description: "Enable voice and typed AI control surfaces.",
    defaultValue: true
  },
  {
    key: "voiceCommandsEnabled",
    label: "Voice commands",
    type: "boolean",
    description: "Enable Codex-backed voice command planning.",
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
  },
  {
    key: "uiScale",
    label: "UI scale",
    type: "number",
    description: "Scale CloudX controls, text, and terminal typography as a percentage.",
    defaultValue: 100,
    min: 75,
    max: 150,
    step: 5
  }
];

interface StoredConfig {
  global?: unknown;
  plugins?: unknown;
}

export class ConfigValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export class ConfigService {
  private static readonly writeQueues = new Map<string, Promise<void>>();

  readonly configPath: string;
  private readonly configFile: JsonStateFile;
  private readonly secrets: ConfigSecretStore;
  private values: CloudxConfigValues;

  constructor(
    dataDir: string,
    private readonly listPlugins: () => PluginDescriptor[] = () => []
  ) {
    this.configFile = new JsonStateFile(dataDir, "config.json", "CloudX config");
    this.secrets = new ConfigSecretStore(dataDir);
    this.configPath = this.configFile.filePath;
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

  getPluginSecret(pluginId: PluginId, key: string): string | undefined {
    return this.secrets.getPluginSecret(pluginId, key);
  }

  isAiControlEnabled(): boolean {
    return this.getValues().global.aiControlEnabled !== false;
  }

  isVoiceCommandsEnabled(): boolean {
    const global = this.getValues().global;
    return global.aiControlEnabled !== false && global.voiceCommandsEnabled !== false;
  }

  isMicrophoneEnabled(): boolean {
    const global = this.getValues().global;
    return global.aiControlEnabled !== false && global.voiceCommandsEnabled !== false && global.microphoneEnabled !== false;
  }

  async update(patch: Partial<CloudxConfigValues> = {}): Promise<CloudxConfigResponse> {
    const queueKey = this.configPath;
    const operation = this.writeQueue().then(async () => {
      const plugins = this.pluginSections();
      const latestValues = this.loadStoredConfig();
      const validated = validatePatch(patch, GLOBAL_CONFIG_FIELDS, plugins);
      await this.secrets.update(validated.secrets);
      const nextValues = mergeConfigValues(latestValues, validated.values);
      await this.persist(nextValues);
      this.values = nextValues;
      return this.getResponse();
    });
    ConfigService.writeQueues.set(queueKey, operation.then(() => undefined, () => undefined));
    return operation;
  }

  async clearPluginSecret(pluginId: PluginId, key: string): Promise<CloudxConfigResponse> {
    const fields = this.pluginSections().find((plugin) => plugin.pluginId === pluginId)?.fields;
    if (!fields) {
      throwConfigValidationError(`Unknown plugin config section: ${pluginId}`);
    }
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) {
      throwConfigValidationError(`Unknown config key: plugins.${pluginId}.${key}`);
    }
    if (field.type !== "secret") {
      throwConfigValidationError(`plugins.${pluginId}.${key} is not a secret field.`);
    }
    await this.secrets.deletePluginSecret(pluginId, key);
    return this.getResponse();
  }

  private writeQueue(): Promise<void> {
    return ConfigService.writeQueues.get(this.configPath) ?? Promise.resolve();
  }

  private pluginSections() {
    return this.listPlugins()
      .filter((plugin) => plugin.configFields.length > 0)
      .map((plugin) => ({
        pluginId: plugin.id,
        displayName: plugin.displayName,
        fields: withPluginSecretState(plugin.id, plugin.configFields, this.secrets)
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
    const parsed = this.readStoredConfig() ?? {};
    const pluginValues = isRecord(parsed.plugins)
      ? Object.fromEntries(Object.entries(parsed.plugins).map(([pluginId, values]) => [pluginId, sanitizeUnknownRecord(isRecord(values) ? values : undefined)]))
      : {};
    return {
      global: sanitizeUnknownRecord(isRecord(parsed.global) ? parsed.global : undefined),
      plugins: pluginValues
    };
  }

  private readStoredConfig(): StoredConfig | undefined {
    try {
      return this.configFile.readSync<StoredConfig>();
    } catch (error) {
      if (error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  private async persist(values: CloudxConfigValues): Promise<void> {
    await this.configFile.write(values);
  }
}

interface ValidatedConfigPatch {
  values: CloudxConfigValues;
  secrets: ConfigSecretPatch;
}

function validatePatch(patch: unknown, globalFields: ConfigFieldDescriptor[], plugins: CloudxConfigResponse["plugins"]): ValidatedConfigPatch {
  if (!isRecord(patch)) {
    throwConfigValidationError("Config patch must be an object.");
  }
  const global = patch.global === undefined ? validatedEmptyFields() : validateFieldValues(requireRecord(patch.global, "global"), globalFields, "global");
  const pluginFieldMap = new Map(plugins.map((plugin) => [plugin.pluginId, plugin.fields]));
  const pluginValues: Record<string, Record<string, ConfigValue>> = {};
  const pluginSecrets: Record<string, Record<string, string>> = {};
  const pluginPatch = patch.plugins === undefined ? {} : requireRecord(patch.plugins, "plugins");
  for (const [pluginId, values] of Object.entries(pluginPatch)) {
    const fields = pluginFieldMap.get(pluginId);
    if (!fields) {
      throwConfigValidationError(`Unknown plugin config section: ${pluginId}`);
    }
    const validated = validateFieldValues(requireRecord(values, `plugins.${pluginId}`), fields, `plugins.${pluginId}`);
    pluginValues[pluginId] = validated.values;
    pluginSecrets[pluginId] = validated.secrets;
  }
  return {
    values: { global: global.values, plugins: pluginValues },
    secrets: { global: global.secrets, plugins: pluginSecrets }
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throwConfigValidationError(`${label} must be an object.`);
  }
  return value;
}

interface ValidatedFieldValues {
  values: Record<string, ConfigValue>;
  secrets: Record<string, string>;
}

function validatedEmptyFields(): ValidatedFieldValues {
  return { values: {}, secrets: {} };
}

function validateFieldValues(values: Record<string, unknown>, fields: ConfigFieldDescriptor[], label: string): ValidatedFieldValues {
  const fieldMap = new Map(fields.map((field) => [field.key, field]));
  const validated = validatedEmptyFields();
  for (const [key, value] of Object.entries(values)) {
    const field = fieldMap.get(key);
    if (!field) {
      throwConfigValidationError(`Unknown config key: ${label}.${key}`);
    }
    if (field.type === "secret") {
      const secret = validateSecretFieldValue(value, `${label}.${key}`);
      if (secret) {
        validated.secrets[key] = secret;
      }
      continue;
    }
    validated.values[key] = validateFieldValue(value, field, `${label}.${key}`);
  }
  return validated;
}

function validateFieldValue(value: unknown, field: ConfigFieldDescriptor, label: string): ConfigValue {
  if (field.type === "secret") {
    return "";
  }
  if (field.type === "boolean" && typeof value !== "boolean") {
    throwConfigValidationError(`${label} must be a boolean.`);
  }
  if (field.type === "string" && typeof value !== "string") {
    throwConfigValidationError(`${label} must be a string.`);
  }
  if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throwConfigValidationError(`${label} must be a finite number.`);
  }
  if (field.type === "number" && typeof value === "number" && field.min !== undefined && value < field.min) {
    throwConfigValidationError(`${label} must be greater than or equal to ${field.min}.`);
  }
  if (field.type === "number" && typeof value === "number" && field.max !== undefined && value > field.max) {
    throwConfigValidationError(`${label} must be less than or equal to ${field.max}.`);
  }
  if (field.type === "select" && !field.options?.some((option) => option.value === value)) {
    throwConfigValidationError(`${label} must be one of the configured options.`);
  }
  return value as ConfigValue;
}

function validateSecretFieldValue(value: unknown, label: string): string | undefined {
  if (typeof value !== "string") {
    throwConfigValidationError(`${label} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function throwConfigValidationError(message: string): never {
  throw new ConfigValidationError(message);
}

function resolveFieldValues(fields: ConfigFieldDescriptor[], stored: Record<string, ConfigValue> = {}): Record<string, ConfigValue> {
  return Object.fromEntries(fields.map((field) => [field.key, resolveStoredFieldValue(stored[field.key], field)]));
}

function resolveStoredFieldValue(value: ConfigValue | undefined, field: ConfigFieldDescriptor): ConfigValue {
  if (field.type === "secret") {
    return "";
  }
  if (value === undefined) {
    return field.defaultValue;
  }
  try {
    return validateFieldValue(value, field, field.key);
  } catch {
    return field.defaultValue;
  }
}

function withPluginSecretState(pluginId: PluginId, fields: ConfigFieldDescriptor[], secrets: ConfigSecretStore): ConfigFieldDescriptor[] {
  return fields.map((field) => field.type === "secret"
    ? { ...field, defaultValue: "", secretConfigured: secrets.hasPluginSecret(pluginId, field.key) }
    : field);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
