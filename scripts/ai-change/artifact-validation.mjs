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
  if (kind === "plan") {
    validateVerificationCommandList(artifact.verification);
    return;
  }
  if (kind !== "verification") {
    return;
  }
  validateVerificationCommandList(
    artifact.commands.map(({ command }) => command),
  );
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

const npmVerificationScripts = new Set([
  "build",
  "documentation:test",
  "format:check",
  "lint",
  "policy:validate",
  "test:coverage",
  "typecheck",
]);

const nodeVerificationScripts = new Set([
  "scripts/ai-change/validate-process.mjs",
]);

function validateVerificationCommandList(commands) {
  for (const command of commands) {
    try {
      validateReadOnlyVerificationCommand(command);
    } catch (error) {
      throw new Error(
        `Verification command must be recognized, local, and read-only: ${command}`,
        { cause: error },
      );
    }
  }
}

function validateReadOnlyVerificationCommand(command) {
  const trimmed = command.trim();
  const tokens = verificationTokens(command);
  if (/\bapi\.github\.com\b/iu.test(trimmed)) {
    throw new Error("GitHub API access is not allowed.");
  }
  if (tokens.some((token) => executableName(token) === "gh")) {
    throw new Error("GitHub CLI access is not allowed.");
  }

  const executableIndex = unwrapCommandPrefix(tokens);
  const executable = executableName(tokens[executableIndex] ?? "");
  const args = tokens.slice(executableIndex + 1);
  if (executable === "git") return validateGit(args);
  if (executable === "npm") return validateNpm(args);
  if (executable === "npx") return validateNpx(args);
  if (executable === "node") return validateNode(args);
  if (executable === "python" || executable === "python3") {
    return validatePython(args);
  }
  if (/\/python(?:3(?:\.\d+)?)?$/u.test(tokens[executableIndex] ?? "")) {
    return validatePython(args);
  }
  throw new Error(`Unsupported verification executable '${executable}'.`);
}

function validateNpm(args) {
  if (args[0] === "test") {
    requireExactTail(args.slice(1), [[], ["--", "--run"]], "npm test");
    return;
  }
  if (args[0] !== "run" || !args[1]) {
    throw new Error("Unsupported npm command.");
  }
  const script = args[1];
  if (
    !npmVerificationScripts.has(script) &&
    !/^test:[A-Za-z0-9:_-]+$/u.test(script)
  ) {
    throw new Error("Unsupported npm verification script.");
  }
  const tail = args.slice(2);
  if (script === "typecheck") {
    requireExactTail(tail, [[], ["--", "--pretty", "false"]], "npm typecheck");
    return;
  }
  requireExactTail(tail, [[]], `npm run ${script}`);
}

function validateNpx(args) {
  const tool = args[0];
  if (!tool || !/^(?:eslint|playwright|prettier|tsc|vitest)$/u.test(tool)) {
    throw new Error("Unsupported npx verification tool.");
  }
  const tail = args.slice(1);
  if (tool === "vitest") {
    requireToolPaths(tail, "run", "Vitest");
    return;
  }
  if (tool === "playwright") {
    requireToolPaths(tail, "test", "Playwright");
    return;
  }
  if (tool === "prettier") {
    requireToolPaths(tail, "--check", "Prettier");
    return;
  }
  if (tool === "tsc") {
    requireExactTail(
      tail,
      [[], ["--noEmit"], ["--noEmit", "--pretty", "false"]],
      "TypeScript",
    );
    return;
  }
  validateEslint(tail);
}

function validateNode(args) {
  const script = args[0];
  if (!script) {
    throw new Error("Node verification requires an admitted script.");
  }
  if (script === "scripts/install-cloudx.mjs") {
    requireExactTail(
      args.slice(1),
      [["--dry-run"], ["--dry-run", "--yes"]],
      "installer verification",
    );
    return;
  }
  if (!nodeVerificationScripts.has(script) || args.length !== 1) {
    throw new Error("Unsupported Node verification script.");
  }
}

function validatePython(args) {
  const moduleIndex = args.indexOf("-m");
  if (moduleIndex !== 0 || args[1] !== "pytest") {
    throw new Error("Python verification must run pytest.");
  }
  const pytestArgs = args.slice(2);
  let index = 0;
  let pathCount = 0;
  while (index < pytestArgs.length) {
    const argument = pytestArgs[index];
    if (
      argument === "-q" ||
      argument === "--quiet" ||
      argument === "-x" ||
      argument === "--disable-warnings"
    ) {
      index += 1;
      continue;
    }
    if (argument === "-k") {
      const expression = pytestArgs[index + 1];
      if (!expression || !/^[A-Za-z0-9_ -]+$/u.test(expression)) {
        throw new Error("Pytest -k requires a literal expression.");
      }
      index += 2;
      continue;
    }
    if (
      !isRepositoryPath(argument) ||
      !/^services\/(?:asr|documentation-indexer)\/tests(?:\/|$)/u.test(argument)
    ) {
      throw new Error(
        "Pytest paths must stay in an admitted service test tree.",
      );
    }
    pathCount += 1;
    index += 1;
  }
  if (pathCount === 0) {
    throw new Error("Pytest verification requires an admitted test path.");
  }
}

function validateGit(args) {
  const command = args[0];
  const commandArgs = args.slice(1);
  const allowedOptions = {
    "cat-file": new Set(["-e", "-p", "-t", "-s"]),
    diff: new Set([
      "--cached",
      "--check",
      "--exit-code",
      "--name-only",
      "--no-renames",
      "--quiet",
      "--stat",
      "-z",
    ]),
    "for-each-ref": new Set(["--count", "--format", "--sort"]),
    grep: new Set([
      "--cached",
      "--files-with-matches",
      "--line-number",
      "--no-color",
      "-n",
    ]),
    log: new Set([
      "--format",
      "--max-count",
      "--no-decorate",
      "--oneline",
      "--reverse",
    ]),
    "ls-files": new Set([
      "--cached",
      "--error-unmatch",
      "--others",
      "--stage",
      "--tracked",
      "-z",
    ]),
    "merge-base": new Set(["--is-ancestor"]),
    "rev-list": new Set(["--count", "--max-count", "--objects"]),
    "rev-parse": new Set([
      "--absolute-git-dir",
      "--is-inside-work-tree",
      "--show-toplevel",
      "--verify",
    ]),
    show: new Set(["--format", "--name-only", "--no-renames", "--stat"]),
    status: new Set(["--porcelain", "--short", "--untracked-files=all", "-z"]),
  }[command];
  if (!allowedOptions) {
    throw new Error(
      `Git command '${command || "unknown"}' is not admitted for verification.`,
    );
  }
  for (let index = 0; index < commandArgs.length; index += 1) {
    const argument = commandArgs[index];
    const [option] = argument.split("=", 1);
    if (!argument.startsWith("-")) {
      if (!isGitRevisionOrPath(argument)) {
        throw new Error(
          "Git verification arguments must be literal revisions or repository paths.",
        );
      }
      continue;
    }
    if (!allowedOptions.has(option)) {
      throw new Error(`Git option '${option}' is not admitted for ${command}.`);
    }
    if (
      ["--count", "--format", "--max-count", "--sort"].includes(option) &&
      !argument.includes("=")
    ) {
      const value = commandArgs[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error(`Git option '${option}' requires a literal value.`);
      index += 1;
    }
  }
}

function unwrapCommandPrefix(tokens) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) {
    if (
      !/^PYTHONPATH=services\/(?:asr|documentation-indexer)\/src$/u.test(
        tokens[index],
      )
    ) {
      throw new Error("Verification environment prefixes are not admitted.");
    }
    index += 1;
  }
  return index;
}

function requireExactTail(actual, allowed, label) {
  if (
    !allowed.some(
      (candidate) =>
        candidate.length === actual.length &&
        candidate.every((value, index) => value === actual[index]),
    )
  ) {
    throw new Error(
      `${label} arguments are not admitted for read-only verification.`,
    );
  }
}

function requireToolPaths(args, verb, label) {
  if (
    args[0] !== verb ||
    args.length < 2 ||
    args.slice(1).some((argument) => !isRepositoryPath(argument))
  ) {
    throw new Error(
      `${label} requires ${verb} and literal repository-relative inputs.`,
    );
  }
}

function validateEslint(args) {
  let pathCount = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--max-warnings") {
      if (!/^\d+$/u.test(args[index + 1] ?? ""))
        throw new Error("ESLint --max-warnings requires an integer.");
      index += 1;
      continue;
    }
    if (!isRepositoryPath(argument))
      throw new Error("ESLint arguments must be repository-relative inputs.");
    pathCount += 1;
  }
  if (pathCount === 0)
    throw new Error(
      "ESLint verification requires a repository-relative input.",
    );
}

function isRepositoryPath(value) {
  return (
    Boolean(value) &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.split("/").includes("..")
  );
}

function isGitRevisionOrPath(value) {
  return (
    isRepositoryPath(value) && !value.includes("://") && !value.startsWith("@")
  );
}

function verificationTokens(command) {
  if (typeof command !== "string" || command !== command.trim() || !command) {
    throw new Error("Verification command must be one nonempty literal line.");
  }
  if (/[\u0000-\u001f\u007f$"`\\;|&<>()*?\[\]{}~]/u.test(command)) {
    throw new Error(
      "Shell expansion, control, glob, and nesting syntax is not allowed.",
    );
  }
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    if (command[index] === " ") {
      index += 1;
      if (command[index] === " " || index === command.length) {
        throw new Error("Verification command spacing must be canonical.");
      }
      continue;
    }
    if (command[index] === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1 || end === index + 1) {
        throw new Error(
          "Single-quoted verification literals must be closed and nonempty.",
        );
      }
      const value = command.slice(index + 1, end);
      if (!/^[A-Za-z0-9_./:=@,+%^ -]+$/u.test(value)) {
        throw new Error("Single-quoted verification literal is not allowed.");
      }
      tokens.push(value);
      index = end + 1;
      if (index < command.length && command[index] !== " ") {
        throw new Error("Verification literal nesting is not allowed.");
      }
      continue;
    }
    const end = command.indexOf(" ", index);
    const token = command.slice(index, end === -1 ? command.length : end);
    if (!/^[A-Za-z0-9_./:=@,+%^-]+$/u.test(token)) {
      throw new Error(
        "Verification command token is outside the literal grammar.",
      );
    }
    tokens.push(token);
    index = end === -1 ? command.length : end;
  }
  return tokens;
}

function executableName(token) {
  return token.slice(token.lastIndexOf("/") + 1);
}
