#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 3002;
const host = process.env.CLOUDX_TEST_HOST?.trim() || "127.0.0.1";
const envRoot = path.join(repoRoot, ".cloudx-test-3002");
const dataDir = path.join(envRoot, "data");
const workspaceRoot = path.join(envRoot, "workspaces");
const webDistDir = path.join(repoRoot, "apps/web/dist");
const pidPath = path.join(envRoot, "server.pid");
const logPath = path.join(envRoot, "server.log");
const startedAt = "2026-06-19T00:00:00.000Z";

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(helpText());
  process.exit(0);
}

if (args.has("--stop")) {
  await stopServer();
  process.exit(0);
}

seedEnvironment();

if (args.has("--start")) {
  await startServer();
}

printSummary(args.has("--start"));

function helpText() {
  return [
    "Seed and run the CloudX local test environment on port 3002.",
    "",
    "Usage:",
    "  node scripts/setup-test-environment.mjs          Seed data only",
    "  node scripts/setup-test-environment.mjs --start  Seed data and start the server",
    "  node scripts/setup-test-environment.mjs --stop   Stop the managed server",
    "",
    "Environment:",
    "  CLOUDX_TEST_HOST=0.0.0.0 binds the test server to all IPv4 interfaces.",
    "",
    "Generated files live under .cloudx-test-3002/."
  ].join("\n");
}

function seedEnvironment() {
  assertManagedServerStopped();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "plugin-data"), { recursive: true });

  const sampleApp = path.join(workspaceRoot, "sample-app");
  const pythonFixtures = path.join(workspaceRoot, "python-fixtures");
  const codexTarget = path.join(workspaceRoot, "codex-target");
  const jiraFixtures = path.join(workspaceRoot, "jira-fixtures");
  const createDirectoryTarget = path.join(workspaceRoot, "workspace-created-by-automation");

  writeFile(path.join(sampleApp, "package.json"), `${JSON.stringify({ name: "cloudx-seeded-sample-app", private: true, scripts: { test: "node src/smoke.js" } }, null, 2)}\n`);
  writeFile(path.join(sampleApp, "src", "smoke.js"), "console.log(JSON.stringify({ ok: true, fixture: 'sample-app' }));\n");
  writeFile(path.join(sampleApp, "README.md"), "# CloudX seeded sample app\n\nThis fixture is intentionally small and safe to use from terminal, file, and automation panels.\n");
  writeFile(path.join(pythonFixtures, "payload.json"), `${JSON.stringify({ fixture: "python-fixtures", ok: true }, null, 2)}\n`);
  writeFile(path.join(codexTarget, "README.md"), "# Codex automation target\n\nUse this directory for manual `primitive:codex.exec` smoke tests from the seeded automation group.\n");
  writeFile(path.join(jiraFixtures, "transition-payload.json"), `${JSON.stringify(jiraManualPayload(), null, 2)}\n`);

  writeJson(path.join(dataDir, "config.json"), configDocument());
  writeJson(path.join(dataDir, "workspace.json"), workspaceDocument({ sampleApp, jiraFixtures }));
  writeJson(path.join(dataDir, "automation.json"), automationDocument({ sampleApp, pythonFixtures, codexTarget, createDirectoryTarget }));
  writeJson(path.join(dataDir, "plugin-data", `${pluginDataStem("jira")}.json`), jiraPluginDataDocument());
  writeFile(path.join(envRoot, "env.sh"), envScript());
  writeFile(path.join(envRoot, "README.md"), readme());
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function configDocument() {
  return {
    global: {
      aiControlEnabled: true,
      voiceCommandsEnabled: true,
      microphoneEnabled: false,
      voiceModel: "gpt-5.3-codex-spark",
      themeId: "cloudx-neon",
      uiScale: 100
    },
    plugins: {
      jira: {
        siteUrl: "https://jira.test.invalid",
        accountEmail: "cloudx-test@example.com",
        dashboardFilterJql: "project = TEST AND resolution = EMPTY",
        dashboardSort: "updated_desc",
        dashboardGroup: "status",
        dashboardRefreshSeconds: 60,
        pollingEnabled: false,
        pollIntervalSeconds: 120,
        pollOverlapSeconds: 120,
        pollProjectKeys: "TEST",
        pollJqlFilter: "resolution = EMPTY",
        commentPollingEnabled: true,
        assignmentDetectionEnabled: true,
        maxIssuesPerPoll: 25
      }
    }
  };
}

function workspaceDocument({ sampleApp, jiraFixtures }) {
  return {
    activeWindowId: "window-test-primary",
    windows: [
      workspaceWindow("window-test-primary", "Seeded Test Workspace", sampleApp, splitEmptyLayout()),
      workspaceWindow("window-test-jira", "Jira Transition Fixture", jiraFixtures, emptyLayout("pane-test-jira"))
    ],
    templates: [
      {
        id: "template-test-development",
        name: "Seeded Development Trio",
        basePath: workspaceRoot,
        layout: {
          root: {
            type: "split",
            id: "split-template-root",
            direction: "row",
            sizes: [55, 45],
            children: [
              { type: "pane", pane: { id: "pane-template-terminal", tabIds: ["template-tab-terminal"], activeTabId: "template-tab-terminal" } },
              { type: "pane", pane: { id: "pane-template-tools", tabIds: ["template-tab-files", "template-tab-jira"], activeTabId: "template-tab-files" } }
            ]
          },
          activePaneId: "pane-template-terminal"
        },
        tabs: [
          { id: "template-tab-terminal", pluginId: "standard-terminal", title: "Seed Shell", relativeCwd: "sample-app" },
          { id: "template-tab-files", pluginId: "file-browser", title: "Seed Files", relativeCwd: "sample-app" },
          { id: "template-tab-jira", pluginId: "jira", title: "Seed Jira", relativeCwd: "jira-fixtures" }
        ],
        createdAt: startedAt,
        updatedAt: startedAt
      }
    ]
  };
}

function workspaceWindow(id, name, defaultCwd, layout) {
  return {
    id,
    name,
    defaultCwd,
    layout,
    pluginMetadata: {
      automation: { fixture: "test-environment-3002" }
    },
    createdAt: startedAt,
    updatedAt: startedAt
  };
}

function emptyLayout(paneId) {
  return {
    root: { type: "pane", pane: { id: paneId, tabIds: [] } },
    activePaneId: paneId
  };
}

function splitEmptyLayout() {
  return {
    root: {
      type: "split",
      id: "split-test-root",
      direction: "row",
      sizes: [60, 40],
      children: [
        { type: "pane", pane: { id: "pane-test-main", tabIds: [] } },
        { type: "pane", pane: { id: "pane-test-side", tabIds: [] } }
      ]
    },
    activePaneId: "pane-test-main"
  };
}

function automationDocument(paths) {
  const payload = worktreePayload(paths.sampleApp);
  return {
    groups: [
      comparisonGroup(),
      pythonSleepGroup(paths.pythonFixtures),
      workspaceCreateDirectoryGroup(paths.createDirectoryTarget),
      codexExecShapeGroup(paths.codexTarget),
      jiraTransitionShapeGroup()
    ],
    runs: [
      seededRun("run-seed-comparison", "seed-comparisons", "succeeded", ["Seeded historical run.", "true", "true", "true"]),
      seededRun("run-seed-jira-missing-token", "seed-jira-transition-shape", "failed", ["Seeded Jira transition dry run."], "Jira site URL, account email, and API token must be configured in CloudX settings.")
    ],
    triggerEvents: [
      {
        id: "event-seed-worktree-created",
        triggerId: "worktree.created",
        source: { kind: "test", automationGroupId: "seed-comparisons" },
        payload,
        emittedAt: startedAt
      },
      {
        id: "event-seed-jira-manual",
        triggerId: "jira.issueManualRun",
        source: { kind: "test", pluginId: "jira", automationGroupId: "seed-jira-transition-shape" },
        payload: jiraManualPayload(),
        emittedAt: startedAt
      }
    ]
  };
}

function comparisonGroup() {
  return group("seed-comparisons", "Seed: comparisons and ranges", {
    schemaVersion: 1,
    nodes: [
      node("trigger", "trigger:worktree.created", 0, 0),
      node("number", "primitive:number.compare", 160, 120, { left: 7, right: 3, operator: "greaterThan" }),
      node("string", "primitive:string.compare", 160, 240, { left: "CloudX automation", right: "cloudx", operator: "startsWith", caseSensitive: false }),
      node("range", "primitive:number.range", 160, 360, { value: 5, min: 5, max: 10, mode: "inclusive" }),
      node("log-number", "primitive:log", 460, 120),
      node("log-string", "primitive:log", 680, 120),
      node("log-range", "primitive:log", 900, 120)
    ],
    edges: [
      exec("exec-trigger-number-log", "trigger", "log-number"),
      exec("exec-number-string-log", "log-number", "log-string"),
      exec("exec-string-range-log", "log-string", "log-range"),
      data("data-number-log", "number", "value", "log-number", "message"),
      data("data-string-log", "string", "value", "log-string", "message"),
      data("data-range-log", "range", "value", "log-range", "message")
    ],
    variables: []
  }, [
    testCase("case-comparisons-green", "All comparison primitives resolve true", worktreePayload(path.join(workspaceRoot, "sample-app")), {
      status: "succeeded",
      traceIncludes: ["Running Worktree Created.", "true"]
    })
  ]);
}

function pythonSleepGroup(pythonFixtures) {
  return group("seed-python-sleep", "Seed: sleep and Python JSON", {
    schemaVersion: 1,
    allowedSafety: ["read", "write", "external"],
    nodes: [
      node("trigger", "trigger:worktree.created", 0, 0),
      node("sleep", "primitive:sleep", 180, 0, { durationMs: 25 }),
      node("python", "primitive:python.exec", 390, 0, {
        code: "import json, os, sys\nprint(json.dumps({'stdin': sys.stdin.read(), 'cwd': os.path.basename(os.getcwd())}))",
        stdin: "from seeded automation",
        cwd: pythonFixtures,
        timeoutMs: 5000,
        parseJson: true
      }),
      node("log-json", "primitive:log", 690, 0)
    ],
    edges: [
      exec("exec-trigger-sleep", "trigger", "sleep"),
      exec("exec-sleep-python", "sleep", "python"),
      exec("exec-python-log", "python", "log-json"),
      data("data-python-json-log", "python", "json", "log-json", "message")
    ],
    variables: []
  }, [
    testCase("case-python-json", "Sleep then parse Python JSON", worktreePayload(path.join(workspaceRoot, "sample-app")), {
      status: "succeeded",
      traceIncludes: ["Sleeping for 25 ms.", "Python process completed.", "from seeded automation"]
    })
  ]);
}

function workspaceCreateDirectoryGroup(createDirectoryTarget) {
  return group("seed-workspace-create-directory", "Seed: workspace createDirectory", {
    schemaVersion: 1,
    allowedSafety: ["read", "write"],
    nodes: [
      node("trigger", "trigger:worktree.created", 0, 0),
      node("create-window", "hook:workspace.windows.create", 220, 0, {
        name: "Created Directory Smoke",
        defaultCwd: createDirectoryTarget,
        createDirectory: true
      }),
      node("log-window-cwd", "primitive:log", 540, 0)
    ],
    edges: [
      exec("exec-trigger-create-window", "trigger", "create-window"),
      exec("exec-create-window-log", "create-window", "log-window-cwd"),
      data("data-window-cwd-log", "create-window", "window.defaultCwd", "log-window-cwd", "message")
    ],
    variables: []
  }, [
    testCase("case-create-directory", "Create a workspace window and missing directory", worktreePayload(path.join(workspaceRoot, "sample-app")), {
      status: "succeeded",
      traceIncludes: ["Create Window completed.", "workspace-created-by-automation"]
    })
  ]);
}

function codexExecShapeGroup(codexTarget) {
  return group("seed-codex-exec-shape", "Seed: Codex exec shape", {
    schemaVersion: 1,
    allowedSafety: ["read", "write", "external"],
    nodes: [
      node("trigger", "trigger:worktree.created", 0, 0),
      node("codex", "primitive:codex.exec", 220, 0, {
        prompt: "Return a one-line confirmation that the seeded CloudX test environment is reachable.",
        stdin: "This is a manual smoke-test fixture. Do not edit files.",
        cwd: codexTarget,
        timeoutMs: 60000,
        sandbox: "read-only",
        approvalPolicy: "never",
        ephemeral: true,
        json: false,
        skipGitRepoCheck: true
      }),
      node("log-codex", "primitive:log", 560, 0)
    ],
    edges: [
      exec("exec-trigger-codex", "trigger", "codex"),
      exec("exec-codex-log", "codex", "log-codex"),
      data("data-codex-final-log", "codex", "finalMessage", "log-codex", "message")
    ],
    variables: []
  }, [
    testCase("case-codex-manual", "Manual Codex exec smoke", worktreePayload(path.join(workspaceRoot, "sample-app")), {
      status: "succeeded",
      traceIncludes: ["Codex exec process completed."]
    })
  ]);
}

function jiraTransitionShapeGroup() {
  const payload = jiraManualPayload();
  return group("seed-jira-transition-shape", "Seed: Jira transition hooks", {
    schemaVersion: 1,
    allowedSafety: ["read", "write", "external"],
    nodes: [
      node("trigger", "trigger:jira.issueManualRun", 0, 0),
      node("list-transitions", "hook:jira.issue.transitions.list", 250, -80, { expandFields: true }),
      node("transition-issue", "hook:jira.issue.transition", 590, -80, {
        targetStatus: "Done",
        comment: "Seeded CloudX transition smoke test."
      }),
      node("log-status", "primitive:log", 930, -80)
    ],
    edges: [
      exec("exec-trigger-list", "trigger", "list-transitions"),
      exec("exec-list-transition", "list-transitions", "transition-issue"),
      exec("exec-transition-log", "transition-issue", "log-status"),
      data("data-trigger-issue-list", "trigger", "issueKey", "list-transitions", "issueIdOrKey"),
      data("data-trigger-issue-transition", "trigger", "issueKey", "transition-issue", "issueIdOrKey"),
      data("data-transition-status-log", "transition-issue", "status", "log-status", "message")
    ],
    variables: []
  }, [
    testCase("case-jira-missing-token", "Transition fixture without a real Jira API token", payload, {
      status: "failed",
      errorIncludes: "Jira site URL, account email, and API token must be configured"
    })
  ]);
}

function group(id, name, graph, testCases = []) {
  return {
    id,
    name,
    enabled: false,
    createdAt: startedAt,
    updatedAt: startedAt,
    graph,
    testCases
  };
}

function node(id, typeId, x, y, config) {
  return {
    id,
    typeId,
    position: { x, y },
    ...(config ? { config } : {})
  };
}

function exec(id, sourceNodeId, targetNodeId, sourcePortId = "exec", targetPortId = "exec") {
  return { id, kind: "exec", sourceNodeId, sourcePortId, targetNodeId, targetPortId };
}

function data(id, sourceNodeId, sourcePortId, targetNodeId, targetPortId) {
  return { id, kind: "data", sourceNodeId, sourcePortId, targetNodeId, targetPortId };
}

function testCase(id, name, payload, expected) {
  return { id, name, payload, expected };
}

function seededRun(id, groupId, status, messages, error) {
  return {
    id,
    groupId,
    status,
    startedAt,
    finishedAt: startedAt,
    ...(error ? { error } : {}),
    trace: messages.map((message, index) => ({
      id: `${id}-trace-${index + 1}`,
      level: status === "failed" && index === messages.length - 1 ? "error" : "info",
      message,
      at: startedAt
    }))
  };
}

function worktreePayload(sampleApp) {
  return {
    folderName: "seeded-feature",
    branchName: "feature/seeded-test-data",
    mode: "new_branch",
    baseRef: "main",
    path: sampleApp,
    projectDir: workspaceRoot
  };
}

function jiraManualPayload() {
  return {
    eventId: "jira-seed-event-1",
    eventType: "jira.issueManualRun",
    transport: "ui",
    siteUrl: "https://jira.test.invalid",
    projectKey: "TEST",
    projectId: "10000",
    issueId: "10001",
    issueKey: "TEST-123",
    issueUrl: "https://jira.test.invalid/browse/TEST-123",
    summary: "Seeded transition smoke test",
    issueType: "Task",
    issueTypeId: "10002",
    status: "In Progress",
    statusId: "3",
    priority: "Medium",
    priorityId: "3",
    assigneeAccountId: "seed-account",
    reporterAccountId: "seed-reporter",
    createdAt: "2026-06-18T12:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
    detectedAt: startedAt
  };
}

function jiraPluginDataDocument() {
  return {
    initialized: true,
    lastRunAt: "2026-06-19T00:00:00.000Z",
    lastSuccessfulPollAt: "2026-06-19T00:00:00.000Z",
    issues: {
      "TEST-123": {
        updated: "2026-06-19T00:00:00.000Z",
        status: "In Progress",
        assigneeAccountId: "seed-account",
        commentIds: ["10001"],
        lastSeenAt: "2026-06-19T00:00:00.000Z"
      }
    }
  };
}

function pluginDataStem(pluginId) {
  const slug = pluginId.replace(/[^a-z0-9._-]/gi, "_").slice(0, 64) || "plugin";
  const digest = createHash("sha256").update(pluginId).digest("hex");
  return `${slug}-${digest}`;
}

function envScript() {
  const env = serverEnv();
  return `${Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n")}\n`;
}

function readme() {
  return [
    "# CloudX test environment for port 3002",
    "",
    "This directory is generated by `node scripts/setup-test-environment.mjs`.",
    "",
    "Seeded state:",
    "- `data/config.json` with local voice settings and non-secret Jira config.",
    "- `data/workspace.json` with two windows and one reusable layout template.",
    "- `data/automation.json` with comparison, Python, workspace, Codex, and Jira transition smoke workflows.",
    "- `data/plugin-data/` with Jira polling state.",
    "- `workspaces/` with sample app, Python, Codex, and Jira fixture directories.",
    "",
    "Commands:",
    "- `npm run testenv:setup` refreshes seed data.",
    "- `npm run testenv:start` builds the web app, refreshes seed data, and starts the server.",
    "- `npm run testenv:stop` stops the managed server.",
    "",
    `Bind host: ${host}`,
    `Local URL: http://${healthHost()}:${port}`
  ].join("\n");
}

async function startServer() {
  assertWebDistBuilt();
  assertManagedServerStopped();
  await assertPortFree(port);

  const out = fs.openSync(logPath, "a");
  const err = fs.openSync(logPath, "a");
  const command = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const child = spawn(command, ["apps/server/src/index.ts"], {
    cwd: repoRoot,
    detached: true,
    env: { ...process.env, ...serverEnv() },
    stdio: ["ignore", out, err]
  });

  fs.writeFileSync(pidPath, `${child.pid}\n`, "utf8");
  child.unref();
  await waitForHealth();
}

async function stopServer() {
  if (!fs.existsSync(pidPath)) {
    console.log("No managed CloudX test server pid file exists.");
    return;
  }
  const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(pidPath, { force: true });
    throw new Error(`Invalid pid file: ${pidPath}`);
  }
  if (!processGroupIsAlive(pid)) {
    fs.rmSync(pidPath, { force: true });
    console.log(`Removed stale pid file for ${pid}.`);
    return;
  }
  process.kill(-pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (processGroupIsAlive(pid) && Date.now() < deadline) {
    await delay(100);
  }
  if (processGroupIsAlive(pid)) {
    throw new Error(`Managed server process group ${pid} did not stop after SIGTERM.`);
  }
  fs.rmSync(pidPath, { force: true });
  console.log(`Stopped managed CloudX test server process group ${pid}.`);
}

function assertManagedServerStopped() {
  if (!fs.existsSync(pidPath)) {
    return;
  }
  const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0 && processGroupIsAlive(pid)) {
    throw new Error(`Managed test server is already running with pid ${pid}. Run npm run testenv:stop first.`);
  }
  fs.rmSync(pidPath, { force: true });
}

function processGroupIsAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertWebDistBuilt() {
  const indexPath = path.join(webDistDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Web build is missing at ${indexPath}. Run npm run build -w @cloudx/web first.`);
  }
}

function assertPortFree(targetPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(targetPort, host);
  }).catch((error) => {
    throw new Error(`Port ${targetPort} is not available on ${host}: ${error.message}`);
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${healthHost()}:${port}/api/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`CloudX test server did not become healthy on ${host}:${port}.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

function healthHost() {
  return host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serverEnv() {
  return {
    CLOUDX_HOST: host,
    CLOUDX_PORT: String(port),
    CLOUDX_DATA_DIR: dataDir,
    CLOUDX_ALLOWED_ROOTS: workspaceRoot,
    CLOUDX_WEB_DIST_DIR: webDistDir,
    CLOUDX_APP_SERVER_ENABLED: "false",
    CLOUDX_LOG_LEVEL: "info",
    CLOUDX_AUTOMATION_START_DISABLED: "false",
    CLOUDX_VOICE_MODEL: "gpt-5.3-codex-spark"
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function printSummary(started) {
  console.log(`Seeded CloudX test environment at ${envRoot}`);
  console.log(`Data dir: ${dataDir}`);
  console.log(`Allowed root: ${workspaceRoot}`);
  console.log(`Bind host: ${host}`);
  console.log(`Local URL: http://${healthHost()}:${port}`);
  console.log(started ? `Server log: ${logPath}` : "Run npm run testenv:start to build and start the server.");
}
