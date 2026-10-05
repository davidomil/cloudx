#!/usr/bin/env node
// Runs CI's verification jobs on this machine with the exact steps from
// .github/workflows/ci.yml: the repository policy job, every isolated lane in
// the CI container with its no-network sandbox, the coverage merge and the
// final aggregate. Steps are read from the workflow, so local and CI runs use
// the same commands, flags and lanes.
//
// Usage: node scripts/ci/local.mjs [--lanes coverage-1,static] [--jobs policy,isolated-lanes]
// The working tree is tested as it is, including uncommitted changes.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";

export const LOCAL_JOBS = ["policy", "isolated-lanes", "coverage-merge", "isolated-verifier"];
const LANE_JOB = "isolated-lanes";
const MIN_INOTIFY_WATCHES = 524_288;

const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const workRoot = path.join(repo, "test-results", "local-ci");

export function readWorkflow(file = path.join(repo, ".github", "workflows", "ci.yml")) {
  return fs.readFile(file, "utf8").then(text => parseDocument(text).toJS());
}

// Replaces the GitHub expressions these jobs use. Anything else is an error,
// so a new expression in CI is noticed instead of silently left in a command.
export function substitute(text, context) {
  return text.replace(/\$\{\{\s*([^}]+?)\s*\}\}/gu, (_match, expression) => {
    if (expression === "github.sha") return context.sha;
    if (expression === "matrix.lane" && context.lane) return context.lane;
    const need = /^needs\.([\w-]+)\.result$/u.exec(expression);
    if (need) return context.needs[need[1]] ?? "skipped";
    throw new Error(`Unsupported workflow expression: ${expression}`);
  });
}

// Evaluates the step conditions used by the reproduced jobs.
export function stepRuns(condition, context, jobFailed) {
  if (condition === undefined) return !jobFailed;
  const text = String(condition).trim();
  if (text === "always()") return true;
  if (text === "failure()") return jobFailed;
  const prefix = /^startsWith\(matrix\.lane,\s*'([^']+)'\)$/u.exec(text);
  if (prefix) return !jobFailed && Boolean(context.lane?.startsWith(prefix[1]));
  throw new Error(`Unsupported step condition: ${text}`);
}

// Host steps use the Node.js release CI pins. nvm installs it with
// `nvm install <version>`; the runner puts it first on PATH.
let hostPath = process.env.PATH;

function runScript(script, { cwd, env, log, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn("bash", ["-eo", "pipefail", "-c", script], {
      cwd, env: { ...process.env, PATH: hostPath, ...env, PWD: cwd }, stdio: ["ignore", "pipe", "pipe"], detached: true
    });
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } }, timeoutMs);
    child.stdout.on("data", chunk => log(chunk));
    child.stderr.on("data", chunk => log(chunk));
    child.on("close", code => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

const builtImages = new Set();

async function buildImage(step, context, log) {
  const tag = substitute(step.with.tags, context);
  if (builtImages.has(tag)) return 0;
  // CI builds from the controller checkout; locally that is the repository.
  const dockerfile = String(step.with.file).replace(/^controller\//u, "");
  const code = await runScript(`docker build ${step.with.pull ? "--pull " : ""}--file ${dockerfile} --tag ${tag} .`, {
    cwd: repo, env: {}, log, timeoutMs: 60 * 60_000
  });
  if (code === 0) builtImages.add(tag);
  return code;
}

// A shallow CI checkout has no history, so it becomes a copy of the working
// tree's tracked and unignored files. Scripts then resolve to the checkout
// path, as in CI.
let snapshot;
function workingTreeSnapshot() {
  snapshot ??= (async () => {
    const target = path.join(workRoot, "checkout");
    await fs.rm(target, { recursive: true, force: true });
    const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
    for (const file of files)
      await fs.cp(path.join(repo, file), path.join(target, file), { verbatimSymlinks: true }).catch(error => { if (error.code !== "ENOENT") throw error; });
    return target;
  })();
  return snapshot;
}

// Runs one job's steps in its own workspace, as on a CI runner. A full-history
// checkout links to this repository; artifacts are files under the shared
// artifacts directory.
async function runJob(name, job, context) {
  const directory = path.join(workRoot, context.lane ? `${name}-${context.lane}` : name);
  await fs.rm(directory, { recursive: true, force: true });
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const logFile = await fs.open(path.join(directory, "log.txt"), "w");
  const log = chunk => { void logFile.write(chunk); };
  const timeoutMs = (job["timeout-minutes"] ?? 60) * 60_000;
  let failed = false;
  try {
    for (const step of job.steps ?? []) {
      if (!stepRuns(step.if, context, failed)) continue;
      const label = step.name ?? step.run ?? step.uses;
      log(`\n### ${label}\n`);
      let code = 0;
      if (step.uses?.startsWith("actions/checkout@")) {
        const target = path.join(workspace, step.with?.path ?? "");
        if (step.with?.path && step.with["fetch-depth"] === 0) await fs.symlink(repo, target);
        else await fs.cp(await workingTreeSnapshot(), target, { recursive: true, verbatimSymlinks: true });
      } else if (step.uses?.startsWith("actions/upload-artifact@")) {
        const target = path.join(context.artifacts, substitute(step.with.name, context));
        await fs.rm(target, { recursive: true, force: true });
        await fs.mkdir(target, { recursive: true });
        await fs.cp(path.join(workspace, substitute(step.with.path, context)), path.join(target, path.basename(step.with.path)), { recursive: true })
          .catch(error => { if (step.with["if-no-files-found"] === "error") throw error; });
      } else if (step.uses?.startsWith("actions/download-artifact@")) {
        const pattern = new RegExp(`^${substitute(step.with.pattern, context).split("*").map(escapeRegExp).join(".*")}$`, "u");
        const target = path.join(workspace, step.with.path);
        await fs.mkdir(target, { recursive: true });
        for (const artifact of await fs.readdir(context.artifacts))
          if (pattern.test(artifact)) await fs.cp(path.join(context.artifacts, artifact), path.join(target, artifact), { recursive: true });
      } else if (step.uses?.startsWith("docker/build-push-action@")) {
        code = await buildImage(step, context, log);
      } else if (step.uses?.startsWith("actions/setup-node@") || step.uses?.startsWith("docker/setup-buildx-action@")) {
        // The local Node.js and Docker are used; preflight checks their versions.
      } else if (step.run !== undefined) {
        const cwd = path.resolve(workspace, step["working-directory"] ?? "");
        const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, substitute(String(value), context)]));
        const script = substitute(step.run, context);
        const realCwd = await fs.realpath(cwd);
        // Parallel lanes share the linked repository; a step there, such as
        // the fixture fetch, runs once per local run.
        const sharedKey = realCwd === repo && step["working-directory"] ? script : undefined;
        if (sharedKey && context.sharedSteps.has(sharedKey)) code = await context.sharedSteps.get(sharedKey);
        else {
          const running = runScript(script, { cwd: realCwd, env, log, timeoutMs });
          if (sharedKey) context.sharedSteps.set(sharedKey, running);
          code = await running;
        }
      } else {
        throw new Error(`Job ${name} uses a step this runner does not reproduce: ${step.uses}`);
      }
      if (code !== 0) { failed = true; log(`\n### failed with exit code ${code}\n`); }
    }
  } catch (error) {
    failed = true;
    log(`\n### ${error instanceof Error ? error.stack : String(error)}\n`);
  } finally {
    await logFile.close();
  }
  return { result: failed ? "failure" : "success", log: path.join(directory, "log.txt") };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function preflight(workflow) {
  const notes = [];
  execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
  const nodeVersions = [...new Set(JSON.stringify(workflow).match(/"node-version":"([^"]+)"/gu)?.map(match => match.split(":")[1].replaceAll("\"", "")))];
  if (nodeVersions.length !== 1) throw new Error(`CI pins several Node.js versions (${nodeVersions.join(", ")}); this runner expects one.`);
  const nodeBin = path.join(process.env.NVM_DIR ?? path.join(os.homedir(), ".nvm"), "versions", "node", `v${nodeVersions[0]}`, "bin");
  if (await fs.stat(path.join(nodeBin, "node")).then(() => true, () => false)) hostPath = `${nodeBin}${path.delimiter}${process.env.PATH}`;
  else if (process.version !== `v${nodeVersions[0]}`)
    throw new Error(`CI host jobs use Node.js ${nodeVersions[0]}. Install it with \`nvm install ${nodeVersions[0]}\`, then run again.`);
  const watches = Number(await fs.readFile("/proc/sys/fs/inotify/max_user_watches", "utf8").catch(() => "0"));
  if (watches < MIN_INOTIFY_WATCHES)
    notes.push(`fs.inotify.max_user_watches is ${watches}; running the suite directly on this host needs at least ${MIN_INOTIFY_WATCHES}. Isolated lanes are not affected.`);
  if (execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim())
    notes.push("The working tree has uncommitted changes; they are included in this run.");
  return notes;
}

function parseArgs(argv) {
  const options = { jobs: LOCAL_JOBS, lanes: undefined };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[++index];
    if (argv[index - 1] === "--jobs") options.jobs = value.split(",");
    else if (argv[index - 1] === "--lanes") options.lanes = value.split(",");
    else throw new Error(`Unknown option ${argv[index - 1]}. Use --jobs and --lanes.`);
  }
  for (const job of options.jobs) if (!LOCAL_JOBS.includes(job)) throw new Error(`Job ${job} is not reproduced locally. Choose from ${LOCAL_JOBS.join(", ")}.`);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workflow = await readWorkflow();
  const jobs = workflow.jobs;
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  for (const note of await preflight(workflow)) console.log(`note: ${note}`);
  await fs.mkdir(workRoot, { recursive: true });
  const artifacts = path.join(workRoot, "artifacts");
  await fs.rm(artifacts, { recursive: true, force: true });
  await fs.mkdir(artifacts, { recursive: true });
  const needs = {};
  const results = [];
  const report = (name, outcome) => { results.push({ name, ...outcome }); console.log(`${outcome.result === "success" ? "pass" : "FAIL"}  ${name}  (${path.relative(repo, outcome.log)})`); };
  const sharedSteps = new Map();
  const context = (extra = {}) => ({ sha, needs, artifacts, sharedSteps, ...extra });

  if (options.jobs.includes("policy")) report("policy", await runJob("policy", jobs.policy, context()));

  if (options.jobs.includes(LANE_JOB)) {
    const lanes = options.lanes ?? jobs[LANE_JOB].strategy.matrix.lane;
    // Each lane gets the two CPUs CI gives it.
    const parallel = Math.max(1, Math.floor(os.availableParallelism() / 2));
    const queue = [...lanes];
    const outcomes = [];
    // Build once before the lanes start so they do not race to build.
    const build = jobs[LANE_JOB].steps.find(step => step.uses?.startsWith("docker/build-push-action@"));
    console.log("building the CI verifier image…");
    if (await buildImage(build, context(), chunk => process.stdout.write(chunk)) !== 0) throw new Error("The CI verifier image did not build.");
    await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
      for (let lane = queue.shift(); lane; lane = queue.shift()) {
        const outcome = await runJob(LANE_JOB, jobs[LANE_JOB], context({ lane }));
        outcomes.push(outcome);
        report(`${LANE_JOB} (${lane})`, outcome);
      }
    }));
    needs[LANE_JOB] = outcomes.every(outcome => outcome.result === "success") && !options.lanes ? "success" : "failure";
  }
  if (options.jobs.includes("coverage-merge") && needs[LANE_JOB] === "success") report("coverage-merge", await runJob("coverage-merge", jobs["coverage-merge"], context()));
  needs["coverage-merge"] = results.find(entry => entry.name === "coverage-merge")?.result ?? "skipped";
  if (options.jobs.includes("isolated-verifier") && needs[LANE_JOB] === "success") report("isolated-verifier", await runJob("isolated-verifier", jobs["isolated-verifier"], context()));

  const reproduced = new Set([...LOCAL_JOBS, "python-services", "browser", "aggregate"]);
  const skipped = Object.keys(jobs).filter(name => !reproduced.has(name));
  console.log(`\nNot reproduced locally (need a disposable host, GitHub identity or specific CLI releases): ${skipped.join(", ")}`);
  if (results.some(entry => entry.result !== "success")) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) await main();
