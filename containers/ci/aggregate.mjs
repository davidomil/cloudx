import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verificationCommands } from "./run.mjs";
import {
  coverageLanes,
  requireCompleteEvidence,
  verificationLanes,
} from "./lanes.mjs";
import { reportBytes } from "./reports.mjs";

export function validateLanes(
  evidence,
  candidateSha,
  required = verificationLanes,
) {
  const identity = requireCompleteEvidence(evidence, candidateSha, required);
  for (const item of evidence) {
    const planned = verificationCommands(item.lane).map((command) =>
      [command.command, ...command.args]
        .map((part) => (/\s|["']/.test(part) ? JSON.stringify(part) : part))
        .join(" "),
    );
    if (
      JSON.stringify(item.commands.map((command) => command.command)) !==
      JSON.stringify(planned)
    )
      throw new Error(
        `Verifier ${item.lane} did not execute the complete required plan.`,
      );
    if (coverageLanes.includes(item.lane)) {
      if (item.coverage_report?.name !== `blob-${item.lane.slice(-1)}-4.json`)
        throw new Error("Wrong coverage shard report.");
      reportBytes(item.coverage_report);
    }
  }
  return identity;
}

async function main() {
  const [candidateSha, input, output, mode = "all"] = process.argv.slice(2);
  if (!["all", "coverage"].includes(mode))
    throw new Error("Unknown aggregation mode.");
  const required =
    mode === "coverage"
      ? coverageLanes
      : [...verificationLanes, "coverage-merge"];
  const names = await fs.readdir(input);
  const evidence = [];
  for (const name of names) {
    const item = JSON.parse(
      await fs.readFile(path.join(input, name, "results.json"), "utf8"),
    );
    if (mode === "all" || coverageLanes.includes(item.lane))
      evidence.push(item);
  }
  const identity = validateLanes(evidence, candidateSha, required);
  await fs.mkdir(output, { recursive: true });
  if (mode === "coverage") {
    for (const item of evidence)
      await fs.writeFile(
        path.join(output, item.coverage_report.name),
        reportBytes(item.coverage_report),
        { flag: "wx" },
      );
  } else {
    const rows = evidence.map((item) => ({
      lane: item.lane,
      duration_ms: item.duration_ms,
      preparation_ms: item.preparation_ms,
      total_duration_ms: item.total_duration_ms,
      commands: item.commands.map(({ command, duration_ms }) => ({
        command,
        duration_ms,
      })),
    }));
    await fs.writeFile(
      path.join(output, "aggregate.json"),
      JSON.stringify(
        { ...identity, verdict: "passed", timings: rows },
        null,
        2,
      ),
    );
    const summary =
      [
        "| Isolated lane | Setup (s) | Commands (s) | Total (s) |",
        "| --- | ---: | ---: | ---: |",
        ...rows.map(
          (row) =>
            `| ${row.lane} | ${(row.preparation_ms / 1000).toFixed(1)} | ${(row.duration_ms / 1000).toFixed(1)} | ${(row.total_duration_ms / 1000).toFixed(1)} |`,
        ),
      ].join("\n") + "\n";
    process.stdout.write(summary);
    if (process.env.GITHUB_STEP_SUMMARY)
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
