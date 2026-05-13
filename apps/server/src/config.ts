import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { DEFAULT_VOICE_MODEL } from "@cloudx/shared";
import { DEFAULT_TERMINAL_REPLAY_BYTES } from "./plugins/CodexTerminalPlugin.js";

export interface AppConfig {
  host: string;
  port: number;
  allowedRoots: string[];
  asrUrl: string;
  voiceModel: string;
  dataDir: string;
  webDistDir: string;
  appServerEnabled: boolean;
  terminalReplayBytes: number;
  voiceDebugTranscripts?: boolean;
  https?: {
    keyPath: string;
    certPath: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.CLOUDX_HOST ?? "0.0.0.0";
  const port = Number.parseInt(env.CLOUDX_PORT ?? "3001", 10);
  const terminalReplayBytes = Number.parseInt(env.CLOUDX_TERMINAL_REPLAY_BYTES ?? String(DEFAULT_TERMINAL_REPLAY_BYTES), 10);
  const home = os.homedir();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = path.resolve(env.CLOUDX_DATA_DIR ?? path.join(repoRoot, ".cloudx"));
  const https = resolveHttpsConfig(env, dataDir);
  const allowedRoots = (env.CLOUDX_ALLOWED_ROOTS ?? home)
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("CLOUDX_PORT must be a positive integer.");
  }
  if (!Number.isInteger(terminalReplayBytes) || terminalReplayBytes <= 0) {
    throw new Error("CLOUDX_TERMINAL_REPLAY_BYTES must be a positive integer.");
  }
  if (allowedRoots.length === 0) {
    throw new Error("CLOUDX_ALLOWED_ROOTS must include at least one path.");
  }

  return {
    host,
    port,
    allowedRoots,
    asrUrl: env.CLOUDX_ASR_URL ?? "http://127.0.0.1:7810",
    voiceModel: env.CLOUDX_VOICE_MODEL ?? DEFAULT_VOICE_MODEL,
    dataDir,
    webDistDir: path.resolve(env.CLOUDX_WEB_DIST_DIR ?? path.join(repoRoot, "apps/web/dist")),
    appServerEnabled: env.CLOUDX_APP_SERVER_ENABLED !== "false",
    terminalReplayBytes,
    voiceDebugTranscripts: isTruthy(env.CLOUDX_VOICE_DEBUG_TRANSCRIPTS),
    https
  };
}

function isTruthy(value: string | undefined): boolean {
  return value?.toLowerCase() === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes" || value?.toLowerCase() === "on";
}

function resolveHttpsConfig(env: NodeJS.ProcessEnv, dataDir: string): AppConfig["https"] {
  const httpsKeyPath = env.CLOUDX_HTTPS_KEY_PATH?.trim();
  const httpsCertPath = env.CLOUDX_HTTPS_CERT_PATH?.trim();
  if ((httpsKeyPath && !httpsCertPath) || (!httpsKeyPath && httpsCertPath)) {
    throw new Error("CLOUDX_HTTPS_KEY_PATH and CLOUDX_HTTPS_CERT_PATH must be configured together.");
  }
  if (httpsKeyPath && httpsCertPath) {
    return { keyPath: path.resolve(httpsKeyPath), certPath: path.resolve(httpsCertPath) };
  }

  const localCert = defaultLocalHttpsPaths(dataDir);
  if (existsSync(localCert.keyPath) && existsSync(localCert.certPath)) {
    return localCert;
  }
  return undefined;
}

export function defaultLocalHttpsPaths(dataDir: string): { keyPath: string; certPath: string } {
  const certDir = path.join(dataDir, "certs");
  return {
    keyPath: path.join(certDir, "cloudx-local.key"),
    certPath: path.join(certDir, "cloudx-local.crt")
  };
}
