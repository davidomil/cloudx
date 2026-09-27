import { expect, it } from "vitest";
import { balancedShards, verificationShards } from "./shards.mjs";
import { historicalTargets } from "../helpers/historical-targets.mjs";
import fs from "node:fs";

it("assigns every file once and distributes measured long fixtures before short tests", () => {
  const files = ["a", "b", "c", "d", "new"];
  const costs = { a: 100, b: 80, c: 20, d: 10 };
  const shards = balancedShards(files, 2, costs);
  expect(shards).toEqual([
    ["a", "d"],
    ["b", "c", "new"],
  ]);
  expect(shards.flat().sort()).toEqual(files.sort());
  expect(balancedShards([...files].reverse(), 2, costs)).toEqual(shards);
});

it("rejects invalid shard inputs instead of losing or duplicating tests", () => {
  expect(() => balancedShards(["a", "a"], 2, {})).toThrow("unique");
  expect(() => balancedShards(["a"], 0, {})).toThrow("positive");
  expect(() => balancedShards(["a"], 2, { a: -1 })).toThrow("duration");
  expect(balancedShards([], 2, {})).toEqual([[], []]);
});

it("keeps expensive integration fixtures on separate runners from unit tests without dropping new files", () => {
  const files = [
    "install-profile.test.mjs",
    "history.integration.test.ts",
    "slow.test.ts",
    "unit.test.ts",
    "new.test.ts",
  ];
  const shards = verificationShards(files, {
    "slow.test.ts": 20_000,
    "unit.test.ts": 40,
  });
  expect(shards.slice(0, 2).flat().sort()).toEqual([
    "history.integration.test.ts",
    "install-profile.test.mjs",
    "slow.test.ts",
  ]);
  expect(shards.slice(2).flat().sort()).toEqual([
    "new.test.ts",
    "unit.test.ts",
  ]);
  expect(shards.flat().sort()).toEqual(files.sort());
});

it("retains every historical target exactly once across the file entry points", () => {
  const entryPoints = fs
    .readdirSync("scripts")
    .filter((name) =>
      /^managed-update-history(?:\.(?!systemd)[^.]+)?\.test\.mjs$/.test(name),
    );
  const indices = entryPoints.map((name) =>
    Number(
      /historicalTargets\[(\d+)\]/.exec(
        fs.readFileSync(`scripts/${name}`, "utf8"),
      )?.[1],
    ),
  );
  expect(indices.sort()).toEqual(historicalTargets.map((_, index) => index));
});
