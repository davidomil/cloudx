import type { PluginSkillContributionFile } from "@cloudx/plugin-api";

export const DOCUMENTATION_HELPER_SCRIPT_PATH = "scripts/cloudx-doc.mjs";

export const DOCUMENTATION_HELPER_FILES: PluginSkillContributionFile[] = [
  {
    path: DOCUMENTATION_HELPER_SCRIPT_PATH,
    executable: true,
    content: String.raw`#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";

const [command, ...rawArgs] = process.argv.slice(2);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const { args, options } = parseArgs(rawArgs);
  switch (command) {
    case "search":
      return search(args, options);
    case "open":
      return openDocument(args, options);
    case "list":
      return listDocuments(options);
    case "ingest-url":
      return ingest("url", { url: requiredArg(args, "url"), ...metadata(options) });
    case "ingest-path":
      return ingestPath(args, options);
    case "ingest-text":
      return ingestText(args, options);
    case "health":
      return printJson(await getJson(documentationEndpoint("/health")));
    case "stats":
      return printJson(await getJson(documentationEndpoint("/stats")));
    case "manifest":
      return printJson(await getJson(documentationEndpoint("/portable-manifest")));
    case "invalidate":
      return invalidateDocument(args, options);
    case "remove":
      return removeDocument(args);
    case "rebuild":
      return printJson(await postJson(documentationEndpoint("/rebuild-index"), {}));
    default:
      usage();
  }
}

async function search(args, options) {
  const query = args.join(" ").trim();
  if (!query) {
    usage();
  }
  const result = await postJson(documentationEndpoint("/search"), {
    query,
    mode: options.mode || "hybrid",
    limit: integerOption(options.limit, 8),
    collection: options.collection,
    sourceTypes: csvOption(options.sourceType || options.sourceTypes)
  });
  printSearch(result);
}

async function openDocument(args, options) {
  const documentId = requiredArg(args, "documentId");
  const params = new URLSearchParams({
    chunkLimit: String(integerOption(options.chunks, 8)),
    chunkTextMaxChars: String(integerOption(options.chars, 1200)),
    artifactLimit: String(integerOption(options.artifacts, 8))
  });
  const result = await getJson(documentationEndpoint("/documents/" + encodeURIComponent(documentId) + "?" + params.toString()));
  printDocument(result.document || result);
}

async function listDocuments(options) {
  const states = options.states || options.state || "active";
  const result = await getJson(documentationEndpoint("/documents?states=" + encodeURIComponent(states)));
  printDocuments(result.documents);
}

async function ingest(kind, input) {
  const serverUrl = process.env.CLOUDX_SERVER_URL?.trim();
  if (serverUrl) {
    const hook = "documentation.ingest." + kind;
    return printJson(await postNdjson(joinUrl(serverUrl, "/api/hooks/" + hook + "?stream=1"), { input }));
  }
  if (kind === "url") {
    return printJson(await postNdjson(documentationEndpoint("/ingest/url?stream=1"), input));
  }
  return printJson(await postJson(documentationEndpoint("/ingest/" + kind), input));
}

async function ingestPath(args, options) {
  const sourcePath = requiredArg(args, "path");
  const input = { path: sourcePath, ...metadata(options) };
  const serverUrl = process.env.CLOUDX_SERVER_URL?.trim();
  if (serverUrl) {
    return ingest("path", { ...input, cwd: process.cwd() });
  }
  if (!path.isAbsolute(sourcePath)) {
    throw new Error("Relative ingest paths require CLOUDX_SERVER_URL so CloudX can resolve them from the current workspace. Pass an absolute path when using CLOUDX_DOCUMENTATION_URL directly.");
  }
  return ingest("path", input);
}

async function ingestText(args, options) {
  const text = args.length > 0 ? args.join(" ") : await stdin();
  const input = { text, ...metadata(options) };
  input.title ||= firstTextLine(text) || "Text source";
  return ingest("text", input);
}

async function invalidateDocument(args, options) {
  const documentId = requiredArg(args, "documentId");
  const state = options.state || args[1];
  const reason = options.reason || args.slice(2).join(" ").trim();
  if (!state) {
    throw new Error("missing state");
  }
  if (!reason) {
    throw new Error("missing reason");
  }
  return printJson(await postJson(documentationEndpoint("/invalidate"), { documentId, state, reason }));
}

async function removeDocument(args) {
  const documentId = requiredArg(args, "documentId");
  return printJson(await requestJson(documentationEndpoint("/documents/" + encodeURIComponent(documentId)), { method: "DELETE" }));
}

function metadata(options) {
  const result = {};
  if (options.title) result.title = options.title;
  if (options.collection) result.collection = options.collection;
  if (options.sourceType) result.sourceType = options.sourceType;
  if (options.tags) result.tags = csvOption(options.tags);
  if (options.uri) result.uri = options.uri;
  return result;
}

function parseArgs(args) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { args: positionals, options };
}

function requiredArg(args, name) {
  const value = args[0]?.trim();
  if (!value) {
    throw new Error("missing " + name);
  }
  return value;
}

function integerOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("invalid integer option: " + value);
  }
  return parsed;
}

function csvOption(value) {
  if (!value) return undefined;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function firstTextLine(text) {
  return String(text).split(/\r?\n/u).map((line) => line.trim()).find(Boolean)?.slice(0, 120);
}

function documentationEndpoint(path) {
  const base = process.env.CLOUDX_DOCUMENTATION_URL?.trim();
  if (!base) {
    throw new Error("CLOUDX_DOCUMENTATION_URL is not set.");
  }
  return joinUrl(base, path);
}

function joinUrl(base, path) {
  return base.replace(/\/+$/u, "") + path;
}

async function getJson(url) {
  return requestJson(url, { method: "GET" });
}

async function postJson(url, payload) {
  return requestJson(url, { method: "POST", payload });
}

async function requestJson(url, { method, payload }) {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const response = await request(url, {
    method,
    headers: body ? { "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(body) } : { accept: "application/json" },
    body
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(method + " " + url + " failed with " + response.statusCode + ": " + response.body);
  }
  return response.body.trim() ? JSON.parse(response.body) : {};
}

async function postNdjson(url, payload) {
  const body = JSON.stringify(payload);
  return requestNdjson(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/x-ndjson",
      "content-length": Buffer.byteLength(body)
    },
    body
  });
}

function request(urlString, options) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const requestOptions = requestOptionsFor(url, options);
    const req = transport(url).request(url, requestOptions, (res) => {
      const chunks = [];
      res.setEncoding("utf8");
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: chunks.join("") }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function requestNdjson(urlString, options) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = transport(url).request(url, requestOptionsFor(url, options), (res) => {
      let failed = false;
      const fail = (error) => {
        failed = true;
        req.destroy();
        reject(error);
      };
      if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
        const chunks = [];
        res.setEncoding("utf8");
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => reject(new Error(options.method + " " + urlString + " failed with " + res.statusCode + ": " + chunks.join(""))));
        return;
      }
      let buffer = "";
      let finalResult;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) {
            try {
              finalResult = handleNdjsonEvent(line, finalResult);
            } catch (error) {
              fail(error);
              return;
            }
          }
        }
      });
      res.on("end", () => {
        if (failed) {
          return;
        }
        if (buffer.trim()) {
          try {
            finalResult = handleNdjsonEvent(buffer, finalResult);
          } catch (error) {
            reject(error);
            return;
          }
        }
        resolve(finalResult || {});
      });
    });
    req.on("error", reject);
    req.write(options.body);
    req.end();
  });
}

function handleNdjsonEvent(line, finalResult) {
  const event = JSON.parse(line);
  if (event.type === "progress") {
    const progress = typeof event.progress === "number" ? " " + Math.round(event.progress) + "%" : "";
    const eta = typeof event.etaSeconds === "number" ? " eta " + event.etaSeconds + "s" : "";
    console.error("[progress]" + progress + eta + " " + (event.stage || ""));
    return finalResult;
  }
  if (event.type === "error") {
    throw new Error(String(event.error || "documentation ingest failed"));
  }
  if (event.type === "result") {
    return event.result || {};
  }
  return finalResult;
}

function requestOptionsFor(url, options) {
  return {
    method: options.method,
    headers: options.headers,
    rejectUnauthorized: shouldVerifyTls(url)
  };
}

function shouldVerifyTls(url) {
  if (url.protocol !== "https:") return undefined;
  return !(url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
}

function transport(url) {
  return url.protocol === "https:" ? https : http;
}

function printSearch(result) {
  const results = Array.isArray(result.results) ? result.results : [];
  for (const [index, item] of results.entries()) {
    console.log(String(index + 1) + ". " + (item.title || item.documentId || "document") + " [" + (item.sourceType || "source") + "]");
    console.log("   doc=" + (item.documentId || "") + " chunk=" + (item.chunkId || "") + " loc=" + (item.locator || ""));
    if (item.uri) console.log("   " + item.uri);
    if (item.snippet) console.log("   " + String(item.snippet).replace(/\s+/gu, " ").trim());
  }
  if (results.length === 0) {
    console.log("No documentation results.");
  }
}

function printDocument(document) {
  console.log((document.title || document.document_id || document.documentId || "document") + " [" + (document.source_type || document.sourceType || "source") + "]");
  console.log("doc=" + (document.document_id || document.documentId || "") + " uri=" + (document.uri || ""));
  for (const chunk of Array.isArray(document.chunks) ? document.chunks : []) {
    console.log("\n# " + (chunk.locator || "chunk " + chunk.chunk_id));
    console.log(String(chunk.text || "").trim());
  }
  const artifacts = Array.isArray(document.artifacts) ? document.artifacts : [];
  if (artifacts.length > 0) {
    console.log("\nArtifacts:");
    for (const artifact of artifacts) {
      console.log("- " + (artifact.kind || "artifact") + " " + (artifact.path || "") + " " + (artifact.label || artifact.title || ""));
    }
  }
}

function printDocuments(documents) {
  const items = Array.isArray(documents) ? documents : [];
  for (const [index, document] of items.entries()) {
    console.log(String(index + 1) + ". " + (document.title || document.document_id || document.documentId || "document") + " [" + (document.source_type || document.sourceType || "source") + "]");
    console.log("   doc=" + (document.document_id || document.documentId || "") + " state=" + (document.state || "") + " chunks=" + (document.chunk_count || document.chunkCount || ""));
    if (document.uri) console.log("   " + document.uri);
  }
  if (items.length === 0) {
    console.log("No documentation documents.");
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function stdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(chunks.join("")));
  });
}

function usage() {
  console.error([
    "Usage:",
    "  cloudx-doc.mjs search <query> [--limit 8] [--collection name] [--sourceType datasheet,media]",
    "  cloudx-doc.mjs open <documentId> [--chunks 8] [--chars 1200] [--artifacts 8]",
    "  cloudx-doc.mjs list [--states active,stale]",
    "  cloudx-doc.mjs ingest-url <url> [--sourceType media] [--collection name]",
    "  cloudx-doc.mjs ingest-path <path> [--sourceType datasheet] [--collection name]",
    "  cloudx-doc.mjs ingest-text <text> [--title title] [--uri uri]",
    "  cloudx-doc.mjs invalidate <documentId> <state> --reason reason",
    "  cloudx-doc.mjs remove <documentId>",
    "  cloudx-doc.mjs health|stats|manifest|rebuild"
  ].join("\n"));
  process.exit(2);
}
`
  }
];
