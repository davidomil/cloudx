import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_BASELINE = "3a3de3597402114e5587b5033068cd39b8b3622f";

export function selectLifecycleRevisions({ eventName, event, targetSha }) {
  const target = requireCommitSha(targetSha, "target");
  let source;
  let sourceKind;
  switch (eventName) {
    case "pull_request":
      source = event.pull_request?.base?.sha;
      sourceKind = "pull-request-base";
      break;
    case "push":
      source = event.before;
      sourceKind = "previous-main-tip";
      if (event.after !== target)
        throw new Error("Push target must match the immutable workflow SHA.");
      break;
    case "workflow_dispatch":
      source = event.inputs?.previous_supported_sha;
      sourceKind = "explicit-supported-revision";
      break;
    default:
      throw new Error(`Unsupported lifecycle event: ${eventName}`);
  }
  const sourceSha = requireCommitSha(source, "source");
  if (sourceSha === target)
    throw new Error("Upgrade source and target must differ.");
  return {
    baselineSha: SUPPORTED_BASELINE,
    sourceSha,
    targetSha: target,
    sourceKind,
  };
}

export function verifyLifecycleRevisions(revisions, directory = process.cwd()) {
  const { baselineSha, sourceSha, targetSha } = revisions;
  for (const sha of [baselineSha, sourceSha, targetSha]) {
    requireCommitSha(sha, "revision");
    const resolved = execFileSync(
      "git",
      ["rev-parse", "--verify", `${sha}^{commit}`],
      {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (resolved !== sha)
      throw new Error(`Revision is not an exact commit: ${sha}`);
  }
  for (const [ancestor, descendant, diagnostic] of [
    [
      baselineSha,
      sourceSha,
      "Upgrade source predates or diverges from the supported baseline.",
    ],
    [
      sourceSha,
      targetSha,
      "Upgrade target must descend from the pinned source.",
    ],
  ]) {
    const result = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      {
        cwd: directory,
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(diagnostic);
  }
}

function requireCommitSha(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value) ||
    /^0{40}$/u.test(value)
  )
    throw new Error(`Lifecycle ${label} must be a full nonzero commit SHA.`);
  return value;
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("Usage: lifecycle-revisions.mjs EVIDENCE_FILE");
  await fs.mkdir(path.dirname(output), { recursive: true });
  let revisions;
  try {
    const event = JSON.parse(
      await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    revisions = selectLifecycleRevisions({
      eventName: process.env.GITHUB_EVENT_NAME,
      event,
      targetSha: process.env.GITHUB_SHA,
    });
    verifyLifecycleRevisions(revisions);
    await fs.writeFile(
      output,
      `${JSON.stringify({ ...revisions, result: "selected" }, null, 2)}\n`,
    );
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `source-sha=${revisions.sourceSha}\ntarget-sha=${revisions.targetSha}\n`,
    );
  } catch (error) {
    await fs.writeFile(
      output,
      `${JSON.stringify({ ...revisions, result: "failed", error: error.message }, null, 2)}\n`,
    );
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
