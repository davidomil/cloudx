import { BaseSequencer } from "vitest/node";
import fs from "node:fs";
import path from "node:path";

export function balancedShards(files, count, durations) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    new Set(files).size !== files.length
  )
    throw new Error(
      "Shard inputs must be unique files and a positive shard count.",
    );
  const shards = Array.from({ length: count }, () => ({
    files: [],
    milliseconds: 0,
  }));
  const cost = (file) => durations[file] ?? 1;
  if (files.some((file) => !Number.isFinite(cost(file)) || cost(file) < 0))
    throw new Error("Invalid measured file duration.");
  for (const file of [...files].sort(
    (a, b) => cost(b) - cost(a) || a.localeCompare(b),
  )) {
    const shard = shards.reduce((least, next) =>
      next.milliseconds < least.milliseconds ? next : least,
    );
    shard.files.push(file);
    shard.milliseconds += Math.max(1, cost(file));
  }
  return shards.map((shard) => shard.files);
}

export function verificationShards(files, durations) {
  const integration = files.filter(
    (file) =>
      /(?:\.integration|managed-update|install-|managed-runtime)/.test(file) ||
      (durations[file] ?? 0) >= 10_000,
  );
  const expensive = new Set(integration);
  return [
    ...balancedShards(integration, 2, durations),
    ...balancedShards(
      files.filter((file) => !expensive.has(file)),
      2,
      durations,
    ),
  ];
}

export default class MeasuredSequencer extends BaseSequencer {
  async shard(specifications) {
    const { root, shard } = this.ctx.config;
    if (shard.count !== 4)
      throw new Error(
        "CloudX CI requires four coverage shards (two integration, two unit).",
      );
    const durations = JSON.parse(
      fs.readFileSync(
        path.join(root, "scripts/ci/test-durations.json"),
        "utf8",
      ),
    ).files;
    const files = specifications.map((spec) =>
      path.relative(root, spec.moduleId),
    );
    const selected = new Set(
      verificationShards(files, durations)[shard.index - 1],
    );
    return specifications.filter((spec) =>
      selected.has(path.relative(root, spec.moduleId)),
    );
  }
}
