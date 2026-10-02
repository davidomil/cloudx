import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { expect, it } from "vitest";
import { historicalTargets } from "../helpers/historical-targets.mjs";
import { historicalDependencyPackages } from "./cache-historical-dependencies.mjs";

it("seeds the verifier image with the shared historical dependency cache", () => {
  const dockerfile = fs
    .readFileSync("containers/ci/Dockerfile", "utf8")
    .replace(/\\\r?\n/g, " ");
  const helper = "scripts/ci/cache-historical-dependencies.mjs";

  expect(dockerfile).toContain(`COPY ${helper} ${helper}`);
  expect(dockerfile).toMatch(
    /RUN npm ci --ignore-scripts\s+&& node scripts\/ci\/cache-historical-dependencies\.mjs\s+&& npm cache verify/,
  );
});

it.each(historicalTargets)(
  "provisions the offline verifier cache for %s",
  (_name, commit) => {
    const currentLock = JSON.parse(
      fs.readFileSync("package-lock.json", "utf8"),
    );
    const historicalLock = JSON.parse(
      execFileSync("git", ["show", `${commit}:package-lock.json`], {
        encoding: "utf8",
      }),
    );
    const currentPackages = new Set(
      Object.values(currentLock.packages).map((entry) => entry.resolved),
    );
    const historicalPackages = new Set(historicalDependencyPackages);
    const missing = Object.entries(historicalLock.packages)
      .filter(([, entry]) => entry.resolved && !entry.link)
      .filter(([location, entry]) => {
        const name = entry.name ?? location.split("node_modules/").at(-1);
        return (
          !currentPackages.has(entry.resolved) &&
          !historicalPackages.has(`${name}@${entry.version}`)
        );
      })
      .map(([, entry]) => entry.resolved);

    expect(missing).toEqual([]);
  },
);
