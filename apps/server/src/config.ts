import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { DEFAULT_VOICE_MODEL } from "@cloudx/shared";

export interface AppConfig {
  host: string;
  port: number;
  allowedRoots: string[];
  asrUrl: string;
  voiceModel: string;
  dataDir: string;
  webDistDir: string;
  appServerEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.CLOUDX_HOST ?? "0.0.0.0";
  const port = Number.parseInt(env.CLOUDX_PORT ?? "3001", 10);
  const home = os.homedir();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const allowedRoots = (env.CLOUDX_ALLOWED_ROOTS ?? home)
    .split(path.delimiter)
    .map((root) => path.resolve(root.trim()))
    .filter(Boolean);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("CLOUDX_PORT must be a positive integer.");
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
    dataDir: path.resolve(env.CLOUDX_DATA_DIR ?? path.join(repoRoot, ".cloudx")),
    webDistDir: path.resolve(env.CLOUDX_WEB_DIST_DIR ?? path.join(repoRoot, "apps/web/dist")),
    appServerEnabled: env.CLOUDX_APP_SERVER_ENABLED !== "false"
  };
}
