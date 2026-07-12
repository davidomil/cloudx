import { validateSchema } from "./schema-validator.mjs";

const artifactSchemas = new Set([
  "implementation",
  "merge-intent",
  "plan",
  "review",
  "verification",
]);

export function validateArtifact(kind, artifact) {
  if (!artifactSchemas.has(kind)) {
    throw new Error(`Unknown AI change artifact '${kind}'.`);
  }
  validateSchema(kind, artifact);
  validateArtifactSemantics(kind, artifact);
  return artifact;
}

function validateArtifactSemantics(kind, artifact) {
  if (kind !== "verification") {
    return;
  }
  if (
    artifact.verdict === "passed" &&
    artifact.commands.some((command) => command.exit_code !== 0)
  ) {
    throw new Error(
      "A passed verification artifact cannot contain a failed command.",
    );
  }
  if (
    artifact.verdict === "passed" &&
    artifact.tree_sha256_before !== artifact.tree_sha256_after
  ) {
    throw new Error("Deterministic verification changed the worktree.");
  }
  if (artifact.verdict === "passed") {
    let expectedDigest = artifact.tree_sha256_before;
    for (const command of artifact.commands) {
      if (
        command.tree_sha256_before !== expectedDigest ||
        command.tree_sha256_after !== command.tree_sha256_before
      ) {
        throw new Error(
          "A passed verification artifact must bind every command to one unchanged source tree.",
        );
      }
      expectedDigest = command.tree_sha256_after;
    }
    if (expectedDigest !== artifact.tree_sha256_after) {
      throw new Error(
        "A passed verification artifact command chain must end at the attested source tree.",
      );
    }
  }
}
