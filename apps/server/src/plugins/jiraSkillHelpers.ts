import type { PluginSkillContributionFile } from "@cloudx/plugin-api";

export const JIRA_HELPER_SCRIPT_PATH = "scripts/cloudx-jira.mjs";

export const JIRA_HELPER_FILES: PluginSkillContributionFile[] = [
  {
    path: JIRA_HELPER_SCRIPT_PATH,
    executable: true,
    content: String.raw`#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const [command, ...rawArgs] = process.argv.slice(2);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const { args, options } = parseArgs(rawArgs);
  switch (command) {
    case "status":
      return printJson(await callHook("jira.connection.status"));
    case "projects":
      return printJson(await callHook("jira.projects.list"));
    case "types":
      return printJson(await callHook("jira.issueTypes.list"));
    case "fields":
      return printJson(await callHook("jira.fields.list"));
    case "priorities":
      return printJson(await callHook("jira.priorities.list"));
    case "link-types":
      return printJson(await callHook("jira.issueLinkTypes.list"));
    case "meta":
      return printJson(await callHook("jira.metadata.get"));
    case "triage":
      return printJson(await callHook("jira.dashboard.list", dashboardInput(options)));
    case "search":
      return printJson(await callHook("jira.issues.search", searchInput(args, options)));
    case "view":
      return printJson(await viewIssue(args, options));
    case "comments":
      return printJson(await callHook("jira.issue.comments.list", { issueIdOrKey: requiredArg(args, "issueIdOrKey") }));
    case "comment":
      return printJson(await callHook("jira.issue.comment.add", commentInput(args, options)));
    case "create":
      return printJson(await callHook("jira.issue.create", createInput(args, options)));
    case "epic":
      return printJson(await callHook("jira.issue.create", epicInput(args, options)));
    case "update":
      return printJson(await callHook("jira.issue.update", updateInput(args, options)));
    case "transitions":
      return printJson(await callHook("jira.issue.transitions.list", { issueIdOrKey: requiredArg(args, "issueIdOrKey") }));
    case "transition":
      return printJson(await transitionIssue(args, options));
    case "link":
      return printJson(await callHook("jira.issue.link", linkInput(args, options)));
    case "url":
      return printJson(await callHook("jira.issue.url", urlInput(args)));
    case "poll":
      return printJson(await callHook("jira.poll.run"));
    default:
      usage();
  }
}

async function viewIssue(args, options) {
  const issueIdOrKey = requiredArg(args, "issueIdOrKey");
  const result = await callHook("jira.issue.get", { issueIdOrKey });
  if (options.comments !== "false") {
    result.comments = (await callHook("jira.issue.comments.list", { issueIdOrKey })).comments || [];
  }
  if (options.transitions !== "false") {
    result.transitions = (await callHook("jira.issue.transitions.list", { issueIdOrKey })).transitions || [];
  }
  return result;
}

async function transitionIssue(args, options) {
  const issueIdOrKey = requiredArg(args, "issueIdOrKey");
  const transitionId = option(options, "id") || await transitionIdFromName(issueIdOrKey, option(options, "to"));
  return callHook("jira.issue.transition", compactRecord({
    issueIdOrKey,
    transitionId,
    comment: option(options, "comment"),
    fields: fieldsOption(options)
  }));
}

async function transitionIdFromName(issueIdOrKey, name) {
  if (!name) {
    throw new Error("missing transition id; pass --id ID or --to NAME");
  }
  const transitions = (await callHook("jira.issue.transitions.list", { issueIdOrKey })).transitions || [];
  const expected = name.toLowerCase();
  const exact = transitions.filter((transition) => String(transition.name || "").toLowerCase() === expected);
  const matches = exact.length ? exact : transitions.filter((transition) => String(transition.name || "").toLowerCase().includes(expected));
  if (matches.length !== 1) {
    const names = transitions.map((transition) => transition.id + ":" + transition.name).join(", ");
    throw new Error("transition name must match exactly one transition. Available: " + names);
  }
  return String(matches[0].id);
}

function dashboardInput(options) {
  return compactRecord({
    filterJql: option(options, "filter") || option(options, "jql"),
    sortBy: option(options, "sort"),
    groupBy: option(options, "group"),
    maxResults: integerOption(option(options, "limit"))
  });
}

function searchInput(args, options) {
  const jql = option(options, "jql") || args.join(" ").trim();
  return compactRecord({
    jql: jql || undefined,
    maxResults: integerOption(option(options, "limit"))
  });
}

function commentInput(args, options) {
  const issueIdOrKey = requiredArg(args, "issueIdOrKey");
  const body = option(options, "body") || args.slice(1).join(" ").trim();
  if (!body) {
    throw new Error("missing comment body");
  }
  return { issueIdOrKey, body };
}

function createInput(args, options) {
  const projectKey = requiredArg(args, "projectKey");
  const issueType = option(options, "type") || option(options, "issue-type") || args[1];
  const summary = option(options, "summary") || args.slice(2).join(" ").trim();
  if (!issueType) {
    throw new Error("missing issueType");
  }
  if (!summary) {
    throw new Error("missing summary");
  }
  return issueInput(projectKey, issueType, summary, options);
}

function epicInput(args, options) {
  const projectKey = requiredArg(args, "projectKey");
  const summary = option(options, "summary") || args.slice(1).join(" ").trim();
  if (!summary) {
    throw new Error("missing summary");
  }
  return issueInput(projectKey, option(options, "type") || "Epic", summary, options);
}

function issueInput(projectKey, issueType, summary, options) {
  return compactRecord({
    projectKey,
    issueType,
    summary,
    description: option(options, "description"),
    priority: option(options, "priority"),
    parentKey: option(options, "parent"),
    epicKey: option(options, "epic"),
    assigneeAccountId: option(options, "assignee"),
    labels: csvOption(option(options, "labels") || option(options, "label")),
    customFields: fieldsOption(options, "field")
  });
}

function updateInput(args, options) {
  const issueIdOrKey = requiredArg(args, "issueIdOrKey");
  return compactRecord({
    issueIdOrKey,
    summary: option(options, "summary"),
    description: option(options, "description"),
    priority: option(options, "priority"),
    parentKey: option(options, "parent"),
    assigneeAccountId: option(options, "assignee"),
    labels: csvOption(option(options, "labels") || option(options, "label")),
    fields: fieldsOption(options, "field"),
    update: jsonOption(options, "update")
  });
}

function linkInput(args, options) {
  const inwardIssueKey = requiredArg(args, "inwardIssueKey");
  const outwardIssueKey = args[1];
  if (!outwardIssueKey) {
    throw new Error("missing outwardIssueKey");
  }
  return compactRecord({
    inwardIssueKey,
    outwardIssueKey,
    typeName: option(options, "type") || "Relates",
    comment: option(options, "comment")
  });
}

function urlInput(args) {
  return compactRecord({
    issueKey: requiredArg(args, "issueKey"),
    commentId: args[1]
  });
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
    const pair = arg.slice(2);
    const equals = pair.indexOf("=");
    if (equals >= 0) {
      setOption(options, pair.slice(0, equals), pair.slice(equals + 1));
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      setOption(options, pair, "true");
      continue;
    }
    setOption(options, pair, next);
    index += 1;
  }
  return { args: positionals, options };
}

function setOption(options, key, value) {
  const previous = options[key];
  if (previous === undefined) {
    options[key] = value;
    return;
  }
  options[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
}

function requiredArg(args, name) {
  const value = args[0]?.trim();
  if (!value) {
    throw new Error("missing " + name);
  }
  return value;
}

function option(options, key) {
  const value = options[key];
  return Array.isArray(value) ? value.at(-1) : value;
}

function optionValues(options, key) {
  const value = options[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function integerOption(value) {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("invalid positive integer option: " + value);
  }
  return parsed;
}

function csvOption(value) {
  if (!value) return undefined;
  const values = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

function fieldsOption(options, key = "field") {
  const entries = optionValues(options, key);
  if (entries.length === 0) {
    return undefined;
  }
  const fields = {};
  for (const entry of entries) {
    const pair = String(entry);
    const equals = pair.indexOf("=");
    if (equals <= 0) {
      throw new Error("--" + key + " must use name=value");
    }
    fields[pair.slice(0, equals)] = parseFieldValue(pair.slice(equals + 1));
  }
  return fields;
}

function jsonOption(options, key) {
  const value = option(options, key);
  if (value === undefined) return undefined;
  return JSON.parse(value);
}

function parseFieldValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
    return JSON.parse(trimmed);
  }
  return value;
}

async function callHook(hookId, input = {}) {
  return postJson(serverEndpoint("/api/hooks/" + encodeURIComponent(hookId)), { input });
}

function serverEndpoint(path) {
  const base = process.env.CLOUDX_SERVER_URL?.trim();
  if (!base) {
    throw new Error("CLOUDX_SERVER_URL is not set. Start CloudX through the app or server so Jira skills can call local hooks.");
  }
  return joinUrl(base, path);
}

function joinUrl(base, path) {
  return base.replace(/\/+$/u, "") + path;
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

function request(urlString, options) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = transport(url).request(url, requestOptionsFor(url, options), (res) => {
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

function compactRecord(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && (!isRecord(item) || Object.keys(item).length > 0)));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function usage() {
  console.error([
    "Usage:",
    "  cloudx-jira.mjs status|meta|projects|types|fields|priorities|link-types",
    "  cloudx-jira.mjs triage [--limit 25] [--filter JQL] [--group epic|status|priority|project|none]",
    "  cloudx-jira.mjs search \"project = ENG ORDER BY updated DESC\" [--limit 20]",
    "  cloudx-jira.mjs view ENG-123 [--comments false] [--transitions false]",
    "  cloudx-jira.mjs create ENG Task \"Summary\" [--description text] [--priority High] [--label a,b] [--field customfield_123=value]",
    "  cloudx-jira.mjs epic ENG \"Summary\" [--description text]",
    "  cloudx-jira.mjs comment ENG-123 \"Plain text comment\"",
    "  cloudx-jira.mjs update ENG-123 [--summary text] [--description text] [--field customfield_123=value]",
    "  cloudx-jira.mjs transitions ENG-123",
    "  cloudx-jira.mjs transition ENG-123 --to \"Done\" [--comment text]",
    "  cloudx-jira.mjs link ENG-123 ENG-124 [--type Relates] [--comment text]",
    "  cloudx-jira.mjs url ENG-123 [commentId]",
    "  cloudx-jira.mjs poll"
  ].join("\n"));
  process.exit(2);
}
`
  }
];
