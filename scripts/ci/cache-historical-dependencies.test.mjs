import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { expect, it } from "vitest";
import { historicalTargets } from "../helpers/historical-targets.mjs";
import { historicalDependencyPackages } from "./cache-historical-dependencies.mjs";

it("caches the exact historical dependencies missing from the current install", () => {
  const installed = new Set(
    dependencyPackages(
      JSON.parse(fs.readFileSync("package-lock.json", "utf8")),
    ),
  );
  const historical = historicalTargets.flatMap(([, commit]) =>
    dependencyPackages(
      JSON.parse(
        execFileSync("git", ["show", `${commit}:package-lock.json`], {
          encoding: "utf8",
        }),
      ),
    ),
  );
  const missing = new Set(historical.filter((name) => !installed.has(name)));

  expect([...historicalDependencyPackages].sort()).toEqual([...missing].sort());
});

function dependencyPackages(lockfile) {
  return Object.entries(lockfile.packages)
    .filter(
      ([location, entry]) => location.includes("node_modules/") && !entry.link,
    )
    .map(
      ([location, entry]) =>
        `${location.split("node_modules/").at(-1)}@${entry.version}`,
    );
}
