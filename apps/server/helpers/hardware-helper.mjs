#!/usr/bin/env node
import { constants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LIMIT = 2 * 1024 * 1024;
const COMMANDS = {
  "tags list": "hardware.tags.list", "types list": "hardware.types.list", "statuses list": "hardware.statuses.list",
  "items list": "hardware.items.list", "items get": "hardware.items.get", "reservations list": "hardware.reservations.list",
  "statuses refresh": "hardware.statuses.refresh", reserve: "hardware.reserve", release: "hardware.release",
  "access open": "hardware.access.open", "access invoke": "hardware.access.invoke", "access close": "hardware.access.close",
  receipt: "hardware.receipt.get", context: "hardware.context"
};

export async function runHardwareHelper(args, env = process.env) {
  if (!env.CLOUDX_HARDWARE_CONTEXT) throw new Error("Hardware is unavailable in this execution. Relaunch the AI tab to load its Hardware context.");
  const locator = await readJson(env.CLOUDX_HARDWARE_CONTEXT, 16_384, true);
  if (locator.version !== 1 || locator.owner?.kind !== "agent" || typeof locator.owner.tabId !== "string" ||
    typeof locator.owner.executionId !== "string" || typeof locator.capability !== "string" || !/^[a-f0-9]{64}$/.test(locator.capability)) throw new Error("The Hardware execution context is invalid.");
  const endpoint = new URL(locator.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("The Hardware endpoint must be local.");
  if (locator.caPath !== undefined && (typeof locator.caPath !== "string" || !path.isAbsolute(locator.caPath))) throw new Error("Hardware TLS trust requires an absolute certificate path.");
  const command = await parseCommand(args);
  const body = JSON.stringify({ tabId: locator.owner.tabId, executionId: locator.owner.executionId, ...command });
  const ca = endpoint.protocol === "https:" && locator.caPath ? await readFile(locator.caPath, 256 * 1024) : undefined;
  const result = await post(endpoint, locator.capability, body, ca);
  return `${JSON.stringify(result, null, 2)}\n`;
}

async function parseCommand(args) {
  const split = args.findIndex(value => value.startsWith("--"));
  const words = split === -1 ? args : args.slice(0, split);
  const options = split === -1 ? [] : args.slice(split);
  const action = COMMANDS[words.join(" ")];
  if (!action) throw new Error("Use context; tags/types/statuses/items/reservations list; items get; statuses refresh; reserve; access open/invoke/close; release; or receipt.");
  const flags = new Map();
  for (let i = 0; i < options.length; i += 2) {
    if (!["--input", "--id", "--request"].includes(options[i]) || !options[i + 1] || options[i + 1].startsWith("--") || flags.has(options[i])) throw new Error("Use each supported option once, with a value.");
    flags.set(options[i], options[i + 1]);
  }
  if (flags.size > 1) throw new Error("Use one structured --input file, --id, or --request option.");
  let input = flags.has("--input") ? await readJson(flags.get("--input"), LIMIT) : {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Hardware input must be a JSON object.");
  if (flags.has("--id")) {
    if (action !== "hardware.items.get") throw new Error("--id is only valid for items get.");
    input = { hardwareId: flags.get("--id") };
  }
  if (flags.has("--request")) {
    if (action !== "hardware.receipt.get") throw new Error("--request is only valid for receipt.");
    input = { requestId: flags.get("--request") };
  }
  if (action === "hardware.context" && flags.size) throw new Error("context takes no options.");
  return { action, input };
}

function post(endpoint, capability, body, ca) {
  return new Promise((resolve, reject) => {
    const transport = endpoint.protocol === "https:" ? https : http;
    const request = transport.request(endpoint, { method: "POST", agent: false, signal: AbortSignal.timeout(15000), ...(ca ? { ca } : {}),
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${capability}` } }, response => {
      void (async () => {
        if (response.statusCode >= 300 && response.statusCode < 400) throw new Error("The Hardware endpoint must not redirect.");
        let bytes = 0;
        const chunks = [];
        for await (const chunk of response) {
          bytes += chunk.byteLength;
          if (bytes > 10 * LIMIT) throw new Error("The Hardware response exceeds its size bound.");
          chunks.push(chunk);
        }
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`${result.code ?? "REQUEST_FAILED"}: ${result.message ?? "The Hardware request failed."}`);
        resolve(result);
      })().catch(error => { response.destroy(); reject(error); });
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function readJson(file, maximum, privateFile = false) { return JSON.parse((await readFile(file, maximum, privateFile)).toString("utf8")); }
async function readFile(file, maximum, privateFile = false) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || privateFile && (stat.mode & 0o077)) throw new Error("Hardware input must be a bounded regular file with the required permissions.");
    return await handle.readFile();
  } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHardwareHelper(process.argv.slice(2)).then(result => process.stdout.write(result)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
