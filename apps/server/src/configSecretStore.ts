import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  readTextFileNoFollowSync,
  requireRegularFile,
  requireRegularFileSync,
  requireSafeDirectory,
  requireSafeDirectorySync,
  stringifyJsonDocument
} from "./jsonStateFile.js";

interface StoredConfigSecrets {
  global?: Record<string, string>;
  plugins?: Record<string, Record<string, string>>;
}

export interface ConfigSecretPatch {
  global: Record<string, string>;
  plugins: Record<string, Record<string, string>>;
}

export class ConfigSecretStore {
  private static readonly writeQueues = new Map<string, Promise<void>>();

  readonly rootPath: string;
  readonly secretDirectoryPath: string;
  readonly filePath: string;

  constructor(dataDir: string) {
    this.rootPath = path.resolve(dataDir);
    this.secretDirectoryPath = path.join(this.rootPath, "secrets");
    this.filePath = path.join(this.secretDirectoryPath, "config-secrets.json");
  }

  hasGlobalSecret(key: string): boolean {
    return Boolean(this.readStoredSecretsSync()?.global?.[key]);
  }

  hasPluginSecret(pluginId: string, key: string): boolean {
    return Boolean(this.readStoredSecretsSync()?.plugins?.[pluginId]?.[key]);
  }

  getPluginSecret(pluginId: string, key: string): string | undefined {
    return this.readStoredSecretsSync()?.plugins?.[pluginId]?.[key];
  }

  async update(patch: ConfigSecretPatch): Promise<void> {
    if (!hasSecrets(patch)) {
      return;
    }
    const operation = this.writeQueue().then(async () => {
      const current = this.readStoredSecretsSync() ?? {};
      await this.write({
        global: { ...(current.global ?? {}), ...patch.global },
        plugins: mergePluginSecrets(current.plugins, patch.plugins)
      });
    });
    ConfigSecretStore.writeQueues.set(this.filePath, operation.then(() => undefined, () => undefined));
    return operation;
  }

  async deletePluginSecret(pluginId: string, key: string): Promise<void> {
    const operation = this.writeQueue().then(async () => {
      const current = this.readStoredSecretsSync() ?? {};
      const plugins = { ...(current.plugins ?? {}) };
      const pluginSecrets = { ...(plugins[pluginId] ?? {}) };
      delete pluginSecrets[key];
      if (Object.keys(pluginSecrets).length === 0) {
        delete plugins[pluginId];
      } else {
        plugins[pluginId] = pluginSecrets;
      }
      await this.write({ global: current.global ?? {}, plugins });
    });
    ConfigSecretStore.writeQueues.set(this.filePath, operation.then(() => undefined, () => undefined));
    return operation;
  }

  private writeQueue(): Promise<void> {
    return ConfigSecretStore.writeQueues.get(this.filePath) ?? Promise.resolve();
  }

  private readStoredSecretsSync(): StoredConfigSecrets | undefined {
    if (!requireSafeDirectorySync(this.rootPath, this.secretDirectoryPath, { create: false, label: "CloudX config secret directory" })) {
      return undefined;
    }
    if (!requireRegularFileSync(this.filePath, "CloudX config secret file")) {
      return undefined;
    }
    return sanitizeStoredSecrets(JSON.parse(readTextFileNoFollowSync(this.filePath, "CloudX config secret file")));
  }

  private async write(value: StoredConfigSecrets): Promise<void> {
    await fsp.mkdir(this.secretDirectoryPath, { recursive: true, mode: 0o700 });
    await requireSafeDirectory(this.rootPath, this.secretDirectoryPath, { create: false, label: "CloudX config secret directory" });
    await requireRegularFile(this.filePath, "CloudX config secret file");
    const tempPath = path.join(this.secretDirectoryPath, `config-secrets.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(stringifyJsonDocument(value, "CloudX config secret file"), "utf8");
      await handle.close();
      handle = undefined;
      await fsp.chmod(tempPath, 0o600);
      await fsp.rename(tempPath, this.filePath);
      await fsp.chmod(this.filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
      if (isSymbolicLinkOpenError(error)) {
        throw new Error(`CloudX config secret file must not be a symbolic link: ${this.filePath}`);
      }
      throw error;
    }
  }
}

function hasSecrets(patch: ConfigSecretPatch): boolean {
  return Object.keys(patch.global).length > 0 || Object.values(patch.plugins).some((values) => Object.keys(values).length > 0);
}

function mergePluginSecrets(
  current: Record<string, Record<string, string>> | undefined,
  patch: Record<string, Record<string, string>>
): Record<string, Record<string, string>> {
  return {
    ...(current ?? {}),
    ...Object.fromEntries(Object.entries(patch).map(([pluginId, values]) => [pluginId, { ...(current?.[pluginId] ?? {}), ...values }]))
  };
}

function sanitizeStoredSecrets(value: unknown): StoredConfigSecrets {
  if (!isRecord(value)) {
    return {};
  }
  const global = stringRecord(value.global);
  const plugins = isRecord(value.plugins)
    ? Object.fromEntries(Object.entries(value.plugins).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])).map(([pluginId, values]) => [pluginId, stringRecord(values)]))
    : {};
  return { global, plugins };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSymbolicLinkOpenError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP";
}
