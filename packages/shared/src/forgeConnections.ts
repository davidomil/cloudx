import type { ForgeCredentialRole, ForgeRepository } from "./forge.js";

export interface ForgeConnectionStatus {
  role: ForgeCredentialRole;
  state: "disconnected" | "registering" | "installing" | "connected" | "expired" | "failed";
  name?: string;
  message?: string;
  expiresAt?: string;
}

export interface ForgeConnections {
  repository?: ForgeRepository;
  configurationError?: string;
  roles: ForgeConnectionStatus[];
}

export interface ForgeConnectionAction {
  method: "GET" | "POST";
  url: string;
  fields?: Record<string, string>;
}
