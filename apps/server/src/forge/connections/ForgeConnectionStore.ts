import { createHash } from "node:crypto";
import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import { ConfigSecretStore } from "../../configSecretStore.js";
import { validateRepository } from "../providers/ForgeCredentials.js";

export interface GitHubApplication {
  appId: string;
  privateKey: string;
  slug: string;
  name: string;
}

export interface StoredForgeConnection {
  repository: ForgeRepository;
  role: ForgeCredentialRole;
  phase:
    | "registering"
    | "converting"
    | "installing"
    | "verifying"
    | "creating_account"
    | "granting_access"
    | "creating_token"
    | "connected"
    | "failed";
  name?: string;
  message?: string;
  app?: GitHubApplication;
  installationId?: string;
  account?: { id: string; name: string; username: string };
  token?: string;
  tokenId?: string;
  expiresAt?: string;
  attempt?: {
    state: string;
    cookieHash: string;
    origin: string;
    expiresAt: string;
  };
}

export type ForgeConnectionRecords = Record<string, StoredForgeConnection>;

/** Registration state and issued credentials share one private, atomic record. */
export class ForgeConnectionStore {
  private readonly secrets: ConfigSecretStore;
  constructor(dataDir: string) {
    this.secrets = new ConfigSecretStore(dataDir);
  }

  read(): ForgeConnectionRecords {
    try {
      const json = this.secrets.getPluginSecret("forge", "applications");
      if (!json) return {};
      if (Buffer.byteLength(json) > 1_000_000) invalid();
      return parseConnections(JSON.parse(json));
    } catch {
      return invalid();
    }
  }

  async write(connections: ForgeConnectionRecords): Promise<void> {
    let json: string;
    try {
      parseConnections(connections);
      json = JSON.stringify(connections);
      if (Buffer.byteLength(json) > 1_000_000) invalid();
    } catch {
      return invalid();
    }
    try {
      await this.secrets.update({
        global: {},
        plugins: { forge: { applications: json } },
      });
    } catch {
      throw new Error("Could not save Forge application state.");
    }
  }
}

export function connectionKey(
  repository: ForgeRepository,
  role: ForgeCredentialRole,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        repository.provider,
        repository.apiUrl,
        repository.projectPath,
        role,
      ]),
    )
    .digest("hex");
}

function parseConnections(value: unknown): ForgeConnectionRecords {
  const records = object(value);
  for (const [key, raw] of Object.entries(records)) {
    const entry = object(raw, [
      "repository",
      "role",
      "phase",
      "name",
      "message",
      "app",
      "installationId",
      "account",
      "token",
      "tokenId",
      "expiresAt",
      "attempt",
    ]);
    const rawRepository = object(entry.repository, [
      "provider",
      "apiUrl",
      "projectPath",
    ]);
    if (
      rawRepository.provider !== "github" &&
      rawRepository.provider !== "gitlab"
    )
      invalid();
    const repository: ForgeRepository = {
      provider: rawRepository.provider,
      apiUrl: text(rawRepository.apiUrl),
      projectPath: text(rawRepository.projectPath),
    };
    validateRepository(repository);
    if (entry.role !== "worker" && entry.role !== "reviewer") invalid();
    if (key !== connectionKey(repository, entry.role)) invalid();
    const phases =
      repository.provider === "github"
        ? [
            "registering",
            "converting",
            "installing",
            "verifying",
            "connected",
            "failed",
          ]
        : [
            "creating_account",
            "granting_access",
            "creating_token",
            "connected",
            "failed",
          ];
    if (!phases.includes(text(entry.phase))) invalid();
    for (const name of ["name", "message", "token"]) optionalText(entry[name]);
    for (const name of ["installationId", "tokenId"])
      if (entry[name] !== undefined) id(entry[name]);
    if (entry.expiresAt !== undefined) date(entry.expiresAt);
    if (entry.app !== undefined) {
      if (repository.provider !== "github") invalid();
      const app = object(entry.app, ["appId", "privateKey", "slug", "name"]);
      id(app.appId);
      for (const name of ["privateKey", "name"]) text(app[name]);
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(text(app.slug))) invalid();
    }
    if (entry.account !== undefined) {
      if (repository.provider !== "gitlab") invalid();
      const account = object(entry.account, ["id", "username", "name"]);
      id(account.id);
      for (const name of ["username", "name"]) text(account[name]);
    }
    if (entry.attempt !== undefined) {
      if (repository.provider !== "github") invalid();
      const attempt = object(entry.attempt, [
        "state",
        "cookieHash",
        "origin",
        "expiresAt",
      ]);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(text(attempt.state)) ||
        !/^[a-f0-9]{64}$/.test(text(attempt.cookieHash))
      )
        invalid();
      const origin = new URL(text(attempt.origin));
      if (
        !["https:", "http:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.origin !== attempt.origin
      )
        invalid();
      date(attempt.expiresAt);
    }
    if (repository.provider === "github") {
      if (
        entry.account !== undefined ||
        entry.token !== undefined ||
        entry.tokenId !== undefined ||
        entry.expiresAt !== undefined
      )
        invalid();
      if (
        ["registering", "converting", "installing", "verifying"].includes(
          text(entry.phase),
        ) &&
        !entry.attempt
      )
        invalid();
      if (
        ["installing", "verifying", "connected"].includes(text(entry.phase)) &&
        !entry.app
      )
        invalid();
      if (entry.phase === "connected" && !entry.installationId) invalid();
    } else {
      if (entry.installationId !== undefined) invalid();
      if (
        ["granting_access", "creating_token", "connected"].includes(
          text(entry.phase),
        ) &&
        !entry.account
      )
        invalid();
      if (entry.phase === "connected" && (!entry.token || !entry.tokenId))
        invalid();
    }
  }
  return records as unknown as ForgeConnectionRecords;
}

function object(value: unknown, fields?: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid();
  if (fields && Object.keys(value).some((key) => !fields.includes(key)))
    invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 65_536) invalid();
  return value;
}
function optionalText(value: unknown): void {
  if (value !== undefined) text(value);
}
function id(value: unknown): void {
  if (!/^[1-9]\d*$/.test(text(value)) || !Number.isSafeInteger(Number(value)))
    invalid();
}
function date(value: unknown): void {
  const valueText = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(valueText)
  )
    invalid();
  const timestamp = Date.parse(valueText);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== valueText.slice(0, 10)
  )
    invalid();
}
function invalid(): never {
  throw new Error("Invalid saved Forge application state.");
}
