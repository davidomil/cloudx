import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const oldestSupportedRevision =
  "3a3de3597402114e5587b5033068cd39b8b3622f";

export function selectLifecycleRevisions(eventName, event, candidate) {
  const target = immutableCommit(candidate, "candidate");
  let source;
  let pullRequestHead;
  if (eventName === "pull_request") {
    if (event.pull_request?.base?.ref !== "main") {
      throw new Error("Lifecycle pull requests must target main.");
    }
    source = immutableCommit(event.pull_request.base.sha, "pull request base");
    pullRequestHead = immutableCommit(
      event.pull_request.head?.sha,
      "pull request head",
    );
  } else if (eventName === "push") {
    if (event.ref !== "refs/heads/main") {
      throw new Error("Lifecycle pushes must target main.");
    }
    source = immutableCommit(event.before, "previous main tip");
    if (immutableCommit(event.after, "pushed target") !== target) {
      throw new Error("Pushed target does not match the CI candidate.");
    }
  } else {
    throw new Error(`Unsupported lifecycle event '${eventName}'.`);
  }
  if (source === target) {
    throw new Error("Lifecycle upgrade source and target must differ.");
  }
  return {
    event: eventName,
    baseline: oldestSupportedRevision,
    source,
    target,
    ...(pullRequestHead ? { pullRequestHead } : {}),
  };
}

export function verifyLifecycleHistory(revisions, repository = process.cwd()) {
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", `safe.directory=${repository}`, "-C", repository, ...args],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  for (const [name, sha] of Object.entries({
    baseline: revisions.baseline,
    source: revisions.source,
    target: revisions.target,
  })) {
    immutableCommit(sha, name);
    if (git("cat-file", "-t", sha) !== "commit") {
      throw new Error(`Lifecycle ${name} must identify a commit.`);
    }
  }
  if (revisions.source === revisions.target) {
    throw new Error("Lifecycle upgrade source and target must differ.");
  }
  try {
    git("merge-base", "--is-ancestor", revisions.baseline, revisions.source);
  } catch {
    throw new Error(
      "Lifecycle source predates or diverges from the supported baseline.",
    );
  }
  try {
    git("merge-base", "--is-ancestor", revisions.source, revisions.target);
  } catch {
    throw new Error("Lifecycle target must descend from the pinned source.");
  }
  if (revisions.event === "pull_request") {
    const parents = git("show", "-s", "--format=%P", revisions.target).split(
      " ",
    );
    if (
      parents.length !== 2 ||
      parents[0] !== revisions.source ||
      parents[1] !== revisions.pullRequestHead
    ) {
      throw new Error(
        "CI candidate parents must be the pinned base and pull request head.",
      );
    }
  }
  return revisions;
}

function immutableCommit(value, label) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? "") || /^0+$/u.test(value)) {
    throw new Error(`Lifecycle ${label} requires a full nonzero commit SHA.`);
  }
  return value;
}

async function main() {
  const { values } = parseArgs({ options: { evidence: { type: "string" } } });
  if (!values.evidence || !process.env.GITHUB_OUTPUT) {
    throw new Error(
      "Revision selection requires --evidence and GITHUB_OUTPUT.",
    );
  }
  await fs.mkdir(path.dirname(values.evidence), { recursive: true });
  let report = { result: "failed", event: process.env.GITHUB_EVENT_NAME };
  try {
    const event = JSON.parse(
      await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    const revisions = selectLifecycleRevisions(
      process.env.GITHUB_EVENT_NAME,
      event,
      process.env.GITHUB_SHA,
    );
    report = { ...report, ...revisions };
    verifyLifecycleHistory(revisions);
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `source=${revisions.source}\ntarget=${revisions.target}\n`,
    );
    report.result = "selected";
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    await fs.writeFile(values.evidence, `${JSON.stringify(report, null, 2)}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
