#!/usr/bin/env node
import { constants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_TRANSACTION_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

export async function runCooperationHelper(args, env = process.env) {
  const contextPath = env.CLOUDX_COOPERATION_CONTEXT;
  if (!contextPath) throw new Error("CLOUDX_COOPERATION_CONTEXT is unavailable in this tab.");
  const locator = await readJson(contextPath, 16384);
  if (locator.version !== 1 || typeof locator.endpoint !== "string" || typeof locator.capability !== "string" ||
    typeof locator.tabId !== "string" || !Number.isSafeInteger(locator.assignmentGeneration)) throw new Error("The cooperation context is invalid.");
  const endpoint = new URL(locator.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username || endpoint.password) throw new Error("The cooperation endpoint must be local.");
  const command = await parseCommand(args);
  if (locator.caPath !== undefined && (typeof locator.caPath !== "string" || !path.isAbsolute(locator.caPath)))
    throw new Error("Cooperation TLS trust requires an absolute certificate path.");
  const ca = endpoint.protocol === "https:" && locator.caPath ? await readFile(locator.caPath, 256 * 1024) : undefined;
  const { action, ...parameters } = command;
  if (action === "upload") endpoint.pathname += "/assets";
  const body = JSON.stringify({ tabId: locator.tabId, assignmentGeneration: locator.assignmentGeneration, boardId: locator.boardId,
    ...(action === "upload" ? parameters : command) });
  const { statusCode, result } = await post(endpoint, locator.capability, body, ca);
  if (statusCode < 200 || statusCode >= 300) throw new Error(`${result.code ?? "REQUEST_FAILED"}: ${result.message ?? "The cooperation request failed."}`);
  if (command.action === "read" && command.format === "markdown" && typeof result.markdown === "string") return result.markdown;
  return `${JSON.stringify(result, null, 2)}\n`;
}

function post(endpoint, capability, body, ca) {
  return new Promise((resolve, reject) => {
    const transport = endpoint.protocol === "https:" ? https : http;
    const request = transport.request(endpoint, {
      method: "POST", agent: false, signal: AbortSignal.timeout(15000),
      ...(ca ? { ca } : {}),
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${capability}` }
    }, response => { void readResponse(response).then(resolve, reject); });
    request.on("error", reject);
    request.end(body);
  });
}

async function readResponse(response) {
  if (response.statusCode >= 300 && response.statusCode < 400) {
    response.destroy();
    throw new Error("The cooperation endpoint must not redirect.");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("The cooperation response exceeds its size limit.");
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return { statusCode: response.statusCode, result };
}

async function parseCommand(args) {
  const [action, ...rest] = args;
  const option = (name, required = true) => {
    const index = rest.indexOf(name);
    if (index < 0 && !required) return undefined;
    if (index < 0 || !rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${name} requires a value.`);
    return rest[index + 1];
  };
  if (action === "context") return { action };
  if (action === "read") {
    const format = option("--format", false) ?? "json";
    if (!["markdown", "json"].includes(format)) throw new Error("--format must be markdown or json.");
    return { action, format, ...(option("--item", false) ? { itemId: option("--item") } : {}) };
  }
  if (action === "asset") return { action, assetId: option("--id") };
  if (action === "upload") {
    const file = option("--file");
    return { action, mime: option("--mime"), name: option("--name", false) ?? path.basename(file),
      base64: (await readFile(file, MAX_ASSET_BYTES)).toString("base64") };
  }
  if (action === "discard") return { action: "discardAsset", stagedToken: option("--token") };
  if (action === "inbox" && rest[0] === "list") return { action: "inbox" };
  if (action === "inbox" && rest[0] === "claim") return { action: "claim", eventId: option("--event") };
  if (action === "apply") return { action, transaction: await readJson(option("--file"), MAX_TRANSACTION_BYTES) };
  if (action === "receipt") return { action, operationId: option("--operation") };
  if (action === "complete") return { action, completion: await readJson(option("--file"), MAX_TRANSACTION_BYTES) };
  throw new Error("Use context, read, asset, upload, discard, inbox list, inbox claim, apply, receipt, or complete. See the cooperation-board skill protocol.");
}

async function readJson(filePath, maxBytes) {
  return JSON.parse((await readFile(filePath, maxBytes)).toString("utf8"));
}

async function readFile(filePath, maxBytes) {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Cooperation input must be a bounded regular file.");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error("Cooperation input changed while it was read.");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCooperationHelper(process.argv.slice(2)).then(result => process.stdout.write(result)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
