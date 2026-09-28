import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import type { ForgeChangeRequest, ForgeWorker } from "@cloudx/shared";
import { ForgeMergeQueue } from "./ForgeMergeQueue.js";
import { parseWorkers } from "./ForgeWorkflowValidation.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Queue fixture", "-c", "user.email=queue@example.test", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

it.each(["github", "gitlab"] as const)("serializes three %s candidates against the actual new Git target without repeated waiting updates", async provider => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-merge-queue-git-"));
  try {
    const queued = await scenario(path.join(root, "queued"), provider, true);
    const eager = await scenario(path.join(root, "eager"), provider, false);
    expect(queued).toMatchObject({ merged: [1, 2, 3], preparations: 3, ciRestarts: 0, ciRounds: 6 });
    expect(eager).toMatchObject({ merged: [1, 2, 3], preparations: 6, ciRestarts: 3, ciRounds: 6 });
    console.info("Forge merge queue Git fixture", { provider, queued, eager });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 20_000);

async function scenario(root: string, provider: "github" | "gitlab", queued: boolean) {
  const started = performance.now();
  await fs.mkdir(root, { recursive: true });
  const origin = path.join(root, "origin");
  await fs.mkdir(origin);
  git(origin, "init", "-b", "main");
  await fs.writeFile(path.join(origin, "README.md"), "Shared target\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "TEST: shared target");
  let workers: ForgeWorker[] = [];
  const checkouts = new Map<number, string>();
  for (const number of [1, 2, 3]) {
    const checkout = path.join(root, `worker-${number}`);
    git(root, "clone", origin, checkout);
    git(checkout, "switch", "-c", `issue-${number}`);
    await fs.writeFile(path.join(checkout, `issue-${number}.txt`), `Issue ${number}\n`);
    git(checkout, "add", ".");
    git(checkout, "commit", "-m", `TEST: issue ${number}`);
    git(checkout, "push", "origin", `issue-${number}`);
    checkouts.set(number, checkout);
    workers.push({ id: randomUUID(), kind: "issue", number, title: `Issue ${number}`, repository: {
      provider, apiUrl: provider === "github" ? "https://api.github.com" : "https://gitlab.example.test/api/v4", projectPath: "fixture/project",
    }, baseBranch: "main", templateId: "worker", status: "awaiting_review", autoPost: false,
    branch: `issue-${number}`, headSha: git(checkout, "rev-parse", "HEAD"), changeNumber: number,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  const metrics = { merged: [] as number[], preparations: 0, ciRestarts: 0, ciRounds: 0, elapsedMs: 0 };
  let queue = new ForgeMergeQueue(() => workers);
  const candidates = new Map<number, { headSha: string; targetHeadSha: string }>();
  const remote = (worker: ForgeWorker) => ({ number: worker.number, headSha: worker.headSha!,
    targetHeadSha: git(origin, "rev-parse", "main") }) as ForgeChangeRequest;
  const prepare = (worker: ForgeWorker) => {
    const checkout = checkouts.get(worker.number)!;
    git(checkout, "fetch", "origin", "main");
    git(checkout, "merge", "--no-edit", "origin/main");
    worker.headSha = git(checkout, "rev-parse", "HEAD");
    git(checkout, "push", "origin", worker.branch!);
    if (candidates.has(worker.number)) metrics.ciRestarts++;
    candidates.set(worker.number, { headSha: worker.headSha, targetHeadSha: git(origin, "rev-parse", "main") });
    metrics.preparations++;
  };
  if (!queued) for (const worker of workers) prepare(worker);
  for (const number of [1, 2, 3]) {
    let active = workers.find(worker => worker.number === number)!;
    if (queued) {
      for (const worker of workers.filter(worker => !metrics.merged.includes(worker.number))) queue.reserve(worker, remote(worker));
      expect(queue.reserve(active, remote(active))).toBe(true);
      prepare(active);
      expect(queue.reserve(active, remote(active))).toBe(true);
      queue.phase(active, "waiting_ci");
    }
    for (let round = 0; round < 2; round++) {
      metrics.ciRounds++;
      if (!queued) continue;
      for (const waiting of workers.filter(worker => worker.number > number)) {
        expect(queue.reserve(waiting, remote(waiting))).toBe(false);
        expect(candidates.has(waiting.number)).toBe(false);
      }
      // Reload the validated persisted queue while CI is pending.
      workers = parseWorkers(JSON.parse(JSON.stringify(workers)));
      queue = new ForgeMergeQueue(() => workers);
      active = workers.find(worker => worker.number === number)!;
      expect(queue.reserve(active, remote(active))).toBe(true);
    }
    const candidate = candidates.get(number)!;
    expect(git(origin, "rev-parse", active.branch!)).toBe(candidate.headSha);
    expect(git(origin, "rev-parse", "main")).toBe(candidate.targetHeadSha);
    expect(git(origin, "merge-base", candidate.headSha, candidate.targetHeadSha)).toBe(candidate.targetHeadSha);
    git(origin, "update-ref", "refs/heads/main", candidate.headSha, candidate.targetHeadSha);
    metrics.merged.push(number);
    if (queued) queue.complete(active);
    else for (const waiting of workers.filter(worker => worker.number > number)) prepare(waiting);
  }
  for (const number of [1, 2, 3]) expect(git(origin, "show", `main:issue-${number}.txt`)).toBe(`Issue ${number}`);
  expect(git(origin, "show", "main:README.md")).toBe("Shared target");
  metrics.elapsedMs = Math.round(performance.now() - started);
  return metrics;
}
