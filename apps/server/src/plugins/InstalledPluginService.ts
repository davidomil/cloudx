import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { CreatePluginSessionInput, PluginSession, WorkspacePlugin } from "@cloudx/plugin-api";
import { descriptorFromPlugin } from "@cloudx/plugin-api";
import type { PluginDescriptor } from "@cloudx/shared";

import { JsonStateFile } from "../jsonStateFile.js";

const execFileAsync = promisify(execFile);
const PLUGIN_MANIFEST_PATH = ".cloudx-plugin/plugin.json";
const INSTALLED_PLUGIN_CATALOG_SCHEMA_VERSION = 1;
const INSTALLED_PLUGIN_MANIFEST_SCHEMA_VERSION = 1;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const GITHUB_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface InstalledPluginManifest {
  schemaVersion: 1;
  id: string;
  acronym: string;
  displayName: string;
  description: string;
}

export interface InstalledPluginRecord {
  schemaVersion: 1;
  id: string;
  enabled: true;
  installedAt: string;
  updatedAt: string;
  directoryName: string;
  commit: string;
  source: {
    type: "github";
    url: string;
    cloneUrl: string;
    owner: string;
    repo: string;
  };
  manifest: InstalledPluginManifest;
}

export interface PluginGitClient {
  lsRemote(url: string): Promise<void>;
  clone(url: string, directory: string): Promise<void>;
  revParseHead(directory: string): Promise<string>;
}

export class InstalledPluginInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstalledPluginInstallError";
  }
}

interface InstalledPluginCatalog {
  schemaVersion: 1;
  plugins: InstalledPluginRecord[];
}

export class InstalledPluginService {
  private readonly catalog: JsonStateFile;
  private readonly installRoot: string;
  private readonly git: PluginGitClient;

  constructor(dataDir: string, options: { git?: PluginGitClient } = {}) {
    this.catalog = new JsonStateFile(dataDir, "installed-plugins.json", "Installed plugins catalog");
    this.installRoot = path.join(path.resolve(dataDir), "plugins", "github");
    this.git = options.git ?? new DefaultGitClient();
  }

  listRecordsSync(): InstalledPluginRecord[] {
    return this.readCatalogSync().plugins;
  }

  listPublicRecordsSync(): InstalledPluginRecord[] {
    return this.listRecordsSync();
  }

  pluginsFromCatalog(): WorkspacePlugin[] {
    return this.listRecordsSync().filter((record) => record.enabled).map((record) => installedManifestPlugin(record));
  }

  async installFromGithub(url: string, existingPluginIds: Set<string>): Promise<{ record: InstalledPluginRecord; plugin: WorkspacePlugin }> {
    const source = installInput(() => normalizeGithubRepositoryUrl(url));
    const current = this.readCatalogSync();
    if (current.plugins.some((plugin) => plugin.source.cloneUrl === source.cloneUrl)) {
      throw new InstalledPluginInstallError(`GitHub plugin repository is already installed: ${source.cloneUrl}`);
    }
    try {
      await this.git.lsRemote(source.cloneUrl);
    } catch {
      throw new InstalledPluginInstallError(`GitHub plugin repository is not reachable: ${source.cloneUrl}`);
    }
    const directoryName = installedPluginDirectoryName(source.owner, source.repo, source.cloneUrl);
    const finalDirectory = path.join(this.installRoot, directoryName);
    const tempDirectory = path.join(this.installRoot, `.tmp-${process.pid}-${Date.now()}-${randomUUID()}`);
    await fs.mkdir(this.installRoot, { recursive: true });
    await fs.rm(tempDirectory, { recursive: true, force: true });
    try {
      await this.git.clone(source.cloneUrl, tempDirectory);
      const manifest = await readInstalledPluginManifest(tempDirectory);
      if (existingPluginIds.has(manifest.id) || current.plugins.some((plugin) => plugin.id === manifest.id)) {
        throw new InstalledPluginInstallError(`Plugin already registered: ${manifest.id}`);
      }
      await fs.rm(finalDirectory, { recursive: true, force: true });
      await fs.rename(tempDirectory, finalDirectory);
      const now = new Date().toISOString();
      const record: InstalledPluginRecord = {
        schemaVersion: INSTALLED_PLUGIN_CATALOG_SCHEMA_VERSION,
        id: manifest.id,
        enabled: true,
        installedAt: now,
        updatedAt: now,
        directoryName,
        commit: await this.git.revParseHead(finalDirectory),
        source,
        manifest
      };
      await this.writeCatalog({ schemaVersion: INSTALLED_PLUGIN_CATALOG_SCHEMA_VERSION, plugins: [...current.plugins, record] });
      return { record, plugin: installedManifestPlugin(record) };
    } catch (error) {
      await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private readCatalogSync(): InstalledPluginCatalog {
    const value = this.catalog.readSync<unknown>();
    if (value === undefined) {
      return { schemaVersion: INSTALLED_PLUGIN_CATALOG_SCHEMA_VERSION, plugins: [] };
    }
    return validateInstalledPluginCatalog(value);
  }

  private async writeCatalog(catalog: InstalledPluginCatalog): Promise<void> {
    await this.catalog.write(catalog);
  }
}

export function installedManifestPlugin(record: InstalledPluginRecord): WorkspacePlugin {
  return new InstalledManifestPlugin(record);
}

export function normalizeGithubRepositoryUrl(rawUrl: string): InstalledPluginRecord["source"] {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("GitHub plugin URL must be a valid https://github.com/<owner>/<repo> URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error("GitHub plugin URL must use https://github.com.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("GitHub plugin URL must not include embedded credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("GitHub plugin URL must not include query strings or fragments.");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("GitHub plugin URL must identify one repository: https://github.com/<owner>/<repo>.");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  if (!GITHUB_SEGMENT_PATTERN.test(owner) || !GITHUB_SEGMENT_PATTERN.test(repo) || repo.length === 0) {
    throw new Error("GitHub plugin URL contains an invalid owner or repository name.");
  }
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  return {
    type: "github",
    url: `https://github.com/${owner}/${repo}`,
    cloneUrl,
    owner,
    repo
  };
}

async function readInstalledPluginManifest(repoDirectory: string): Promise<InstalledPluginManifest> {
  const manifestPath = path.join(repoDirectory, PLUGIN_MANIFEST_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      throw new InstalledPluginInstallError(`Installed plugin metadata is required at ${PLUGIN_MANIFEST_PATH}.`);
    }
    throw error;
  }
  return installInput(() => validateInstalledPluginManifest(JSON.parse(raw)));
}

function validateInstalledPluginCatalog(value: unknown): InstalledPluginCatalog {
  const catalog = requireRecord(value, "Installed plugins catalog");
  if (catalog.schemaVersion !== INSTALLED_PLUGIN_CATALOG_SCHEMA_VERSION) {
    throw new Error(`Installed plugins catalog schemaVersion must be ${INSTALLED_PLUGIN_CATALOG_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(catalog.plugins)) {
    throw new Error("Installed plugins catalog plugins must be an array.");
  }
  const seen = new Set<string>();
  return {
    schemaVersion: INSTALLED_PLUGIN_CATALOG_SCHEMA_VERSION,
    plugins: catalog.plugins.map((plugin, index) => {
      const record = validateInstalledPluginRecord(plugin, `Installed plugins catalog plugins[${index}]`);
      if (seen.has(record.id)) {
        throw new Error(`Installed plugins catalog contains duplicate plugin id: ${record.id}`);
      }
      seen.add(record.id);
      return record;
    })
  };
}

function validateInstalledPluginRecord(value: unknown, label: string): InstalledPluginRecord {
  const record = requireRecord(value, label);
  const manifest = validateInstalledPluginManifest(record.manifest);
  const source = validateGithubSource(record.source, `${label}.source`);
  if (requiredLiteral(record.schemaVersion, INSTALLED_PLUGIN_CATALOG_SCHEMA_VERSION, `${label}.schemaVersion`) !== INSTALLED_PLUGIN_CATALOG_SCHEMA_VERSION) {
    throw new Error("unreachable");
  }
  if (record.enabled !== true) {
    throw new Error(`${label}.enabled must be true.`);
  }
  const id = requiredString(record.id, `${label}.id`);
  if (id !== manifest.id) {
    throw new Error(`${label}.id must match manifest.id.`);
  }
  return {
    schemaVersion: INSTALLED_PLUGIN_CATALOG_SCHEMA_VERSION,
    id,
    enabled: true,
    installedAt: requiredString(record.installedAt, `${label}.installedAt`),
    updatedAt: requiredString(record.updatedAt, `${label}.updatedAt`),
    directoryName: requiredString(record.directoryName, `${label}.directoryName`),
    commit: requiredString(record.commit, `${label}.commit`),
    source,
    manifest
  };
}

function validateGithubSource(value: unknown, label: string): InstalledPluginRecord["source"] {
  const source = requireRecord(value, label);
  if (source.type !== "github") {
    throw new Error(`${label}.type must be github.`);
  }
  const normalized = normalizeGithubRepositoryUrl(requiredString(source.url, `${label}.url`));
  const cloneUrl = requiredString(source.cloneUrl, `${label}.cloneUrl`);
  if (cloneUrl !== normalized.cloneUrl) {
    throw new Error(`${label}.cloneUrl must match the canonical GitHub clone URL.`);
  }
  return normalized;
}

function validateInstalledPluginManifest(value: unknown): InstalledPluginManifest {
  const manifest = requireRecord(value, "Installed plugin metadata");
  if (requiredLiteral(manifest.schemaVersion, INSTALLED_PLUGIN_MANIFEST_SCHEMA_VERSION, "Installed plugin metadata.schemaVersion") !== INSTALLED_PLUGIN_MANIFEST_SCHEMA_VERSION) {
    throw new Error("unreachable");
  }
  const id = requiredString(manifest.id, "Installed plugin metadata.id");
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error("Installed plugin metadata.id must start with a lowercase letter and contain only lowercase letters, numbers, dots, underscores, and hyphens.");
  }
  const acronym = requiredBoundedString(manifest.acronym, "Installed plugin metadata.acronym", 1, 6);
  if (!/^[A-Z0-9]+$/.test(acronym)) {
    throw new Error("Installed plugin metadata.acronym must contain 1-6 uppercase letters or numbers.");
  }
  return {
    schemaVersion: INSTALLED_PLUGIN_MANIFEST_SCHEMA_VERSION,
    id,
    acronym,
    displayName: requiredBoundedString(manifest.displayName, "Installed plugin metadata.displayName", 1, 80),
    description: requiredBoundedString(manifest.description, "Installed plugin metadata.description", 1, 500)
  };
}

function installedPluginDirectoryName(owner: string, repo: string, cloneUrl: string): string {
  const slug = `${owner}-${repo}`.replace(/[^a-z0-9._-]/gi, "-").toLowerCase().slice(0, 80);
  const digest = createHash("sha256").update(cloneUrl).digest("hex").slice(0, 16);
  return `${slug}-${digest}`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredBoundedString(value: unknown, label: string, minLength: number, maxLength: number): string {
  const text = requiredString(value, label);
  if (text.length < minLength || text.length > maxLength) {
    throw new Error(`${label} must be ${minLength}-${maxLength} characters long.`);
  }
  return text;
}

function requiredLiteral<T>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new Error(`${label} must be ${String(expected)}.`);
  }
  return expected;
}

function installInput<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw error instanceof InstalledPluginInstallError ? error : new InstalledPluginInstallError(errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

class InstalledManifestPlugin implements WorkspacePlugin {
  readonly id: string;
  readonly acronym: string;
  readonly displayName: string;
  readonly description: string;
  readonly panelKind = "placeholder" as const;
  readonly creatable = false;
  readonly requiresDirectory = false;
  readonly actions: WorkspacePlugin["actions"] = [];

  constructor(record: InstalledPluginRecord) {
    this.id = record.manifest.id;
    this.acronym = record.manifest.acronym;
    this.displayName = record.manifest.displayName;
    this.description = record.manifest.description;
  }

  createSession(_input: CreatePluginSessionInput): PluginSession {
    throw new Error(`Installed plugin ${this.id} does not provide a runtime panel in this CloudX version.`);
  }

  descriptor(): PluginDescriptor {
    return descriptorFromPlugin(this);
  }
}

class DefaultGitClient implements PluginGitClient {
  async lsRemote(url: string): Promise<void> {
    await execFileAsync("git", ["ls-remote", "--exit-code", url, "HEAD"]);
  }

  async clone(url: string, directory: string): Promise<void> {
    await execFileAsync("git", ["clone", "--depth", "1", "--single-branch", "--", url, directory]);
  }

  async revParseHead(directory: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: directory });
    return stdout.trim();
  }
}
