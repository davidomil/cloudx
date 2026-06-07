import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { DEFAULT_VOICE_MODEL } from "@cloudx/shared";
import { DEFAULT_ASR_TIMEOUT_MS, MAX_ASR_TIMEOUT_MS } from "./asrClient.js";
import {
  DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
  DEFAULT_DOCUMENTATION_TIMEOUT_MS,
  DEFAULT_DOCUMENTATION_URL,
  MAX_DOCUMENTATION_RESPONSE_MAX_BYTES,
  MAX_DOCUMENTATION_TIMEOUT_MS
} from "./documentation/DocumentationClient.js";
import { DEFAULT_TERMINAL_REPLAY_BYTES } from "./plugins/CodexTerminalPlugin.js";

export const DEFAULT_CLOUDX_HOST = "127.0.0.1";
export const DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_VOICE_AUDIO_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
export const MAX_DOCUMENTATION_UPLOAD_MAX_BYTES = 25 * 1024 * 1024 * 1024;

export interface AppConfig {
  host: string;
  port: number;
  allowedRoots: string[];
  asrUrl: string;
  asrTimeoutMs: number;
  voiceModel: string;
  dataDir: string;
  webDistDir: string;
  appServerEnabled: boolean;
  automationStartDisabled: boolean;
  terminalReplayBytes: number;
  voiceAudioUploadMaxBytes: number;
  documentationUrl?: string;
  documentationTimeoutMs?: number;
  documentationResponseMaxBytes: number;
  documentationUploadMaxBytes: number;
  voiceDebugTranscripts?: boolean;
  https?: {
    keyPath: string;
    certPath: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.CLOUDX_HOST ?? DEFAULT_CLOUDX_HOST;
  const port = parsePositiveInteger(env.CLOUDX_PORT ?? "3001", "CLOUDX_PORT");
  const terminalReplayBytes = parsePositiveInteger(env.CLOUDX_TERMINAL_REPLAY_BYTES ?? String(DEFAULT_TERMINAL_REPLAY_BYTES), "CLOUDX_TERMINAL_REPLAY_BYTES");
  const asrTimeoutMs = parsePositiveInteger(env.CLOUDX_ASR_TIMEOUT_MS ?? String(DEFAULT_ASR_TIMEOUT_MS), "CLOUDX_ASR_TIMEOUT_MS");
  const documentationTimeoutMs = parsePositiveInteger(env.CLOUDX_DOCUMENTATION_TIMEOUT_MS ?? String(DEFAULT_DOCUMENTATION_TIMEOUT_MS), "CLOUDX_DOCUMENTATION_TIMEOUT_MS");
  const documentationResponseMaxBytes = parsePositiveInteger(env.CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES ?? String(DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES), "CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES");
  const documentationUploadMaxBytes = parsePositiveInteger(env.CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES ?? String(DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES), "CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES");
  const voiceAudioUploadMaxBytes = parsePositiveInteger(env.CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES ?? String(DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES), "CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES");
  const home = os.homedir();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = path.resolve(env.CLOUDX_DATA_DIR ?? path.join(repoRoot, ".cloudx"));
  const https = resolveHttpsConfig(env, dataDir);
  const allowedRoots = (env.CLOUDX_ALLOWED_ROOTS ?? home)
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);

  if (!Number.isSafeInteger(asrTimeoutMs) || asrTimeoutMs <= 0 || asrTimeoutMs > MAX_ASR_TIMEOUT_MS) {
    throw new Error(`CLOUDX_ASR_TIMEOUT_MS must be a positive integer no greater than ${MAX_ASR_TIMEOUT_MS}.`);
  }
  if (!Number.isSafeInteger(voiceAudioUploadMaxBytes) || voiceAudioUploadMaxBytes <= 0 || voiceAudioUploadMaxBytes > MAX_VOICE_AUDIO_UPLOAD_MAX_BYTES) {
    throw new Error(`CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES must be a positive integer no greater than ${MAX_VOICE_AUDIO_UPLOAD_MAX_BYTES}.`);
  }
  if (!Number.isSafeInteger(documentationTimeoutMs) || documentationTimeoutMs <= 0 || documentationTimeoutMs > MAX_DOCUMENTATION_TIMEOUT_MS) {
    throw new Error(`CLOUDX_DOCUMENTATION_TIMEOUT_MS must be a positive integer no greater than ${MAX_DOCUMENTATION_TIMEOUT_MS}.`);
  }
  if (!Number.isSafeInteger(documentationResponseMaxBytes) || documentationResponseMaxBytes <= 0 || documentationResponseMaxBytes > MAX_DOCUMENTATION_RESPONSE_MAX_BYTES) {
    throw new Error(`CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES must be a positive integer no greater than ${MAX_DOCUMENTATION_RESPONSE_MAX_BYTES}.`);
  }
  if (!Number.isSafeInteger(documentationUploadMaxBytes) || documentationUploadMaxBytes <= 0 || documentationUploadMaxBytes > MAX_DOCUMENTATION_UPLOAD_MAX_BYTES) {
    throw new Error(`CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES must be a positive integer no greater than ${MAX_DOCUMENTATION_UPLOAD_MAX_BYTES}.`);
  }
  if (allowedRoots.length === 0) {
    throw new Error("CLOUDX_ALLOWED_ROOTS must include at least one path.");
  }

  return {
    host,
    port,
    allowedRoots,
    asrUrl: env.CLOUDX_ASR_URL ?? "http://127.0.0.1:7810",
    asrTimeoutMs,
    voiceModel: env.CLOUDX_VOICE_MODEL ?? DEFAULT_VOICE_MODEL,
    dataDir,
    webDistDir: path.resolve(env.CLOUDX_WEB_DIST_DIR ?? path.join(repoRoot, "apps/web/dist")),
    appServerEnabled: env.CLOUDX_APP_SERVER_ENABLED !== "false",
    automationStartDisabled: isTruthy(env.CLOUDX_AUTOMATION_START_DISABLED),
    terminalReplayBytes,
    voiceAudioUploadMaxBytes,
    documentationUrl: env.CLOUDX_DOCUMENTATION_URL ?? DEFAULT_DOCUMENTATION_URL,
    documentationTimeoutMs,
    documentationResponseMaxBytes,
    documentationUploadMaxBytes,
    voiceDebugTranscripts: isTruthy(env.CLOUDX_VOICE_DEBUG_TRANSCRIPTS),
    https
  };
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function shouldWarnForNetworkBind(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

export function networkBindWarning(host: string, port: number, protocol: "http" | "https" = "https"): string {
  return [
    "",
    "======================================================================",
    "WARNING: Cloudx is listening on a network interface.",
    `CLOUDX_HOST=${host} exposes this shell-controlling service beyond localhost.`,
    "Cloudx can spawn terminals, edit files, proxy dashboards, and transcribe",
    "browser microphone audio when voice is enabled.",
    "Use only on a trusted LAN or private tailnet. Public internet unsupported.",
    `Local URL: ${protocol}://127.0.0.1:${port}`,
    "======================================================================",
    ""
  ].join("\n");
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
