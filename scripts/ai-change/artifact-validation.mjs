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

const readOnlyGitCommands = new Set([
  "cat-file",
  "diff",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "ls-remote",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "status",
]);

const gitGlobalOptionsWithValues = new Set([
  "-C",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
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
  if (!trimmed || hasUnquotedShellControl(trimmed)) {
    throw new Error("Shell control syntax is not allowed.");
  }
  if (/\bapi\.github\.com\b/iu.test(trimmed)) {
    throw new Error("GitHub API access is not allowed.");
  }
  if (
    /\b(?:ba|c|da|fi|k|z)?sh\s+(?:-[A-Za-z]*c\b|--command\b)/u.test(trimmed)
  ) {
    throw new Error("Shell command indirection is not allowed.");
  }

  const tokens = verificationTokens(trimmed);
  validateEmbeddedGitCommands(tokens);
  if (tokens.some((token) => executableName(token) === "gh")) {
    throw new Error("GitHub CLI access is not allowed.");
  }

  const executableIndex = unwrapCommandPrefix(tokens);
  const executable = executableName(tokens[executableIndex] ?? "");
  const args = tokens.slice(executableIndex + 1);
  if (args.includes("-m") && args[args.indexOf("-m") + 1] === "pytest") {
    return validatePython(args);
  }
  if (executable === "git") return;
  if (executable === "test" || executable === "[") return;
  if (executable === "npm") return validateNpm(args);
  if (executable === "npx") return validateNpx(args);
  if (executable === "node") return validateNode(args, trimmed);
  if (executable === "python" || executable === "python3") {
    return validatePython(args);
  }
  if (/\/python(?:3(?:\.\d+)?)?$/u.test(tokens[executableIndex] ?? "")) {
    return validatePython(args);
  }
  throw new Error(`Unsupported verification executable '${executable}'.`);
}

function validateNpm(args) {
  const commandIndex = args.findIndex((argument) => !argument.startsWith("-"));
  const command = args[commandIndex];
  if (command === "test") return;
  if (command !== "run") throw new Error("Unsupported npm command.");
  const script = args
    .slice(commandIndex + 1)
    .find((argument) => !argument.startsWith("-"));
  if (
    !script ||
    !/^(?:build|lint|policy:validate|test(?::[A-Za-z0-9:_-]+)?|typecheck|verify(?::[A-Za-z0-9:_-]+)?|format:check|documentation:test)$/u.test(
      script,
    )
  ) {
    throw new Error("Unsupported npm verification script.");
  }
}

function validateNpx(args) {
  const tool = args.find((argument) => !argument.startsWith("-"));
  if (!tool || !/^(?:eslint|playwright|prettier|tsc|vitest)$/u.test(tool)) {
    throw new Error("Unsupported npx verification tool.");
  }
  if (tool === "prettier" && !args.includes("--check")) {
    throw new Error("Prettier verification must use --check.");
  }
}

function validateNode(args, command) {
  if (args.some((argument) => argument === "-e" || argument === "--eval")) {
    return validateNodeEval(command);
  }
  const script = args.find((argument) => !argument.startsWith("-"));
  if (!script) {
    throw new Error("Node verification requires a script or eval payload.");
  }
  if (script === "scripts/install-cloudx.mjs") {
    if (!args.includes("--dry-run")) {
      throw new Error("Installer verification must use --dry-run.");
    }
    return;
  }
  if (
    !/^scripts\/(?:ai-change\/(?!publish-gate-b\.mjs)[A-Za-z0-9._/-]+|[A-Za-z0-9._-]+\.test\.mjs)$/u.test(
      script,
    )
  ) {
    throw new Error("Unsupported Node verification script.");
  }
}

function validateNodeEval(command) {
  const match = /(?:^|\s)(?:-e|--eval)\s+(["'])([\s\S]*)\1\s*$/u.exec(command);
  if (!match) throw new Error("Node eval payload must use one quoted literal.");
  const payload = match[2];
  if (
    /["'`]\s*\+|\+\s*["'`]|\b(?:Buffer\.from|String\.fromCharCode|eval|Function|fetch|process|require|Deno|Bun)\b|\bimport\s*\(|\b(?:appendFile|chmod|chown|copyFile|createWriteStream|link|mkdir|mkdtemp|open|rename|rm|rmdir|symlink|truncate|unlink|writeFile)(?:Sync)?\b|\b(?:exec|execSync|fork|spawn|spawnSync)\b|\.concat\s*\(/u.test(
      payload,
    )
  ) {
    throw new Error("Node eval payload contains dynamic or mutating behavior.");
  }
  const childProcessCalls = [...payload.matchAll(/\bexecFileSync\s*\(/gu)];
  const literalGitCalls = [
    ...payload.matchAll(/\bexecFileSync\(\s*(["'])git\1\s*,\s*\[([^\]]*)\]/gu),
  ];
  if (
    childProcessCalls.length === 0 ||
    childProcessCalls.length !== literalGitCalls.length
  ) {
    throw new Error(
      "Node eval may execute only literal read-only Git commands.",
    );
  }
  for (const call of literalGitCalls) {
    const args = literalStringList(call[2]);
    if (!args || !readOnlyGitCommands.has(args[0])) {
      throw new Error("Node eval Git command is not read-only.");
    }
  }
}

function literalStringList(source) {
  const values = [];
  let remainder = source;
  const stringPattern = /^\s*(["'])((?:\\.|(?!\1).)*)\1\s*/u;
  while (remainder.trim()) {
    const match = stringPattern.exec(remainder);
    if (!match) return null;
    values.push(match[2].replace(/\\([\\"'])/gu, "$1"));
    remainder = remainder.slice(match[0].length);
    if (!remainder.trim()) break;
    if (!/^\s*,/u.test(remainder)) return null;
    remainder = remainder.replace(/^\s*,/u, "");
  }
  return values;
}

function validatePython(args) {
  const moduleIndex = args.indexOf("-m");
  if (moduleIndex === -1 || args[moduleIndex + 1] !== "pytest") {
    throw new Error("Python verification must run pytest.");
  }
}

function validateEmbeddedGitCommands(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (executableName(tokens[index]) !== "git") continue;
    const options = tokens.slice(index + 1);
    if (
      options.some(
        (token) =>
          token === "-c" ||
          token.startsWith("-c=") ||
          token === "--config-env" ||
          token.startsWith("--config-env=") ||
          token === "--exec-path" ||
          token.startsWith("--exec-path="),
      )
    ) {
      throw new Error(
        "Git executable and configuration injection is not allowed.",
      );
    }
    const command = gitSubcommand(tokens, index + 1);
    if (!readOnlyGitCommands.has(command)) {
      throw new Error(
        `Git command '${command || "unknown"}' is not read-only.`,
      );
    }
  }
}

function gitSubcommand(tokens, start) {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    const option = token.split("=", 1)[0];
    if (gitGlobalOptionsWithValues.has(option)) {
      index += token.includes("=") ? 1 : 2;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return executableName(token);
  }
  return "";
}

function unwrapCommandPrefix(tokens) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) {
    index += 1;
  }
  if (executableName(tokens[index] ?? "") === "command") {
    index += 1;
    while (tokens[index]?.startsWith("-")) index += 1;
  }
  if (executableName(tokens[index] ?? "") === "env") {
    index += 1;
    while (
      tokens[index] &&
      (tokens[index].startsWith("-") ||
        /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]))
    ) {
      index += 1;
    }
  }
  return index;
}

function verificationTokens(command) {
  return command.match(/[A-Za-z0-9_./:=@+-]+/gu) ?? [];
}

function executableName(token) {
  return token.slice(token.lastIndexOf("/") + 1);
}

function hasUnquotedShellControl(command) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (
      character === "`" ||
      character === ";" ||
      character === "|" ||
      character === ">" ||
      character === "<"
    ) {
      return true;
    }
    if (character === "&" && command[index + 1] === "&") return true;
  }
  return Boolean(quote || escaped);
}
