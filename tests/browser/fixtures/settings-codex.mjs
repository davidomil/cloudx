#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { parse } from "smol-toml";

// Protocol fixture only; native configuration acceptance has separate executable tests.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("codex-cli 0.160.0");
  process.exit(0);
}
if (args[0] !== "app-server" || args[1] !== "--stdio") {
  throw new Error(
    "Settings fixture supports --version and app-server --stdio only.",
  );
}
for (let index = 2; index < args.length; index += 2) {
  if (
    args[index] !== "-c" ||
    !/^(sqlite_home|log_dir|features\.remote_control)=/.test(
      args[index + 1] ?? "",
    )
  ) {
    throw new Error("Unexpected Settings validation launch argument.");
  }
}
if (!process.env.CODEX_HOME)
  throw new Error("Settings validation requires an isolated CODEX_HOME.");
const config = parse(
  await fs.readFile(path.join(process.env.CODEX_HOME, "config.toml"), "utf8"),
);
const models = [
  "gpt-6.1-sol",
  "browser-fixture-model",
  "initial-model",
  "unsaved-draft-model",
  "external-model",
];
let initialized = false;
let ready = false;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result;
  if (request.method === "initialize" && !initialized) {
    if (request.params?.clientInfo?.name !== "cloudx_settings_validation")
      throw new Error("Unexpected Settings validation client.");
    initialized = true;
    result = { userAgent: "cloudx-browser-settings-protocol-fixture" };
  } else if (
    request.method === "initialized" &&
    initialized &&
    !ready &&
    request.id === undefined
  ) {
    ready = true;
    continue;
  } else if (
    request.method === "config/read" &&
    ready &&
    request.params?.includeLayers === false
  ) {
    result = { config, origins: {}, layers: null };
  } else if (
    request.method === "model/list" &&
    ready &&
    request.params?.includeHidden === true
  ) {
    result = {
      data: models.map((model) => ({
        model,
        supportedReasoningEfforts: ["low", "medium", "high"].map(
          (reasoningEffort) => ({ reasoningEffort }),
        ),
        supportsPersonality: false,
      })),
      nextCursor: null,
    };
  } else {
    throw new Error(
      `Unexpected Settings validation request: ${request.method}`,
    );
  }
  console.log(JSON.stringify({ id: request.id, result }));
}
