import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateArtifact } from "./artifact-validation.mjs";
import { classifyChange, loadPolicy } from "./policy.mjs";
import { displayCommand, verificationPlan } from "./verify.mjs";
import { GATE_B_LOCAL_CHANGE_BASE_SHA } from "./validate-process.mjs";
import {
  reviewLocal,
  parseLocalReviewArgs,
  discoverLocalPaths,
} from "./review-local.mjs";
import * as localReader from "./review-local.mjs";
import {
  AREA_REVIEW_ROLES,
  validateAreaReviewFanout,
  validateAggregateReview,
} from "./review-fanout.mjs";

const repository = path.resolve(import.meta.dirname, "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const localSubject = (implementation, verification) =>
  sha(`cloudx-local-review-v1\n${sha(implementation)}\n${sha(verification)}\n`);
const directories = [];
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const finding = {
  id: "LOCAL-001",
  severity: "high",
  category: "security",
  path: "README.md",
  line: 1,
  evidence: "Unresolved production finding",
  required_fix: "Resolve before aggregation",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(paths = ["README.md"], extraRoles = []) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-local-review-test-")),
  );
  directories.push(directory);
  const root = path.join(directory, "repo");
  const evidence = path.join(directory, "evidence");
  await fs.mkdir(path.join(root, ".agents"), { recursive: true });
  await fs.mkdir(evidence);
  await fs.copyFile(
    path.join(repository, ".agents/pr-review-policy.toml"),
    path.join(root, ".agents/pr-review-policy.toml"),
  );
  const policy = await loadPolicy(
    path.join(root, ".agents/pr-review-policy.toml"),
  );
  const classification = classifyChange(policy, { type: "refactor", paths });
  const roles = [...new Set([...classification.skills, ...extraRoles])].sort();
  const skillVersions = {};
  for (const role of ["plan-change", ...roles]) {
    const filename = path.join(root, ".agents/skills", role, "SKILL.md");
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, `Trusted fixture skill ${role}\n`);
    skillVersions[role] = sha(await fs.readFile(filename));
  }
  const state = {
    head: "a".repeat(40),
    tree: "b".repeat(64),
    committed: [],
    staged: [],
    unstaged: [...paths],
    untracked: [],
    tracked: ["README.md"],
    config: Buffer.alloc(0),
    attributeValues: {},
    index: "H 100644 " + "c".repeat(40) + " 0\tREADME.md\0",
  };
  const plan = {
    schema_version: 1,
    kind: "change-plan",
    run_id: "independent-plan-producer",
    base_sha: "d".repeat(40),
    head_sha: "e".repeat(40),
    policy_sha256: policy.policySha256,
    skill_versions: skillVersions,
    task: "Improve local review",
    classification: {
      type: "refactor",
      areas: classification.areas,
      risk: classification.risk,
      skills: roles,
      human_review_required: classification.humanReviewRequired,
      automerge_eligible: classification.automergeEligible,
    },
    anchors: [
      { path: "README.md", line: 1, reason: "Production seam" },
      { path: "README.md", line: 2, reason: "Evidence seam" },
    ],
    claims: [
      {
        id: "CLAIM-LOCAL",
        behavior: "Document verified behavior",
        production_seam: "README.md",
        test: "README review",
        negative_cases: ["Wrong behavior"],
      },
    ],
    allowed_paths: paths,
    forbidden_paths: ["forbidden/**"],
    verification: verificationPlan("full").map(displayCommand),
  };
  const implementation = {
    schema_version: 1,
    kind: "change-implementation",
    run_id: "independent-implementation-producer",
    base_sha: plan.base_sha,
    head_sha: state.head,
    policy_sha256: policy.policySha256,
    plan_sha256: sha(json(plan)),
    changed_files: paths,
    claim_evidence: [
      {
        claim_id: "CLAIM-LOCAL",
        production_path: "README.md",
        test_path: "README.md",
        revert_failing_assertion: "Changed behavior fails",
        negative_cases: ["Wrong behavior"],
      },
    ],
    deviations: [],
  };
  const planReview = {
    schema_version: 1,
    kind: "change-review",
    run_id: "independent-plan-review-producer",
    subject: "plan",
    subject_sha256: sha(json(plan)),
    base_sha: plan.base_sha,
    head_sha: plan.head_sha,
    policy_sha256: policy.policySha256,
    reviewer_role: "review-plan",
    verdict: "clean",
    tags: [],
    findings: [],
  };
  const verification = {
    schema_version: 1,
    kind: "change-verification",
    run_id: "verification-execution",
    base_sha: plan.base_sha,
    head_sha: state.head,
    policy_sha256: policy.policySha256,
    tree_sha256_before: state.tree,
    tree_sha256_after: state.tree,
    verdict: "passed",
    commands: plan.verification.map((command) => ({
      command,
      exit_code: 0,
      stdout_sha256: sha("ok"),
      stderr_sha256: sha(""),
      tree_sha256_before: state.tree,
      tree_sha256_after: state.tree,
    })),
  };
  const options = {
    mode: "local",
    plan: path.join(evidence, "plan.json"),
    planReview: path.join(evidence, "plan-review.json"),
    implementation: path.join(evidence, "implementation.json"),
    verification: path.join(evidence, "verification.json"),
    reviews: [],
  };
  const write = async (name, value) => fs.writeFile(options[name], json(value));
  for (const [name, value, kind] of [
    ["plan", plan, "plan"],
    ["planReview", planReview, "review"],
    ["implementation", implementation, "implementation"],
    ["verification", verification, "verification"],
  ]) {
    validateArtifact(kind, value);
    await write(name, value);
  }
  const refreshReviews = async () => {
    const digest = localSubject(
      await fs.readFile(options.implementation),
      await fs.readFile(options.verification),
    );
    options.subjectSha256 = digest;
    options.reviews = [];
    for (const role of roles) {
      const filename = path.join(evidence, `${role}.json`);
      await fs.writeFile(
        filename,
        json({
          ...planReview,
          run_id: verification.run_id,
          subject: "implementation",
          subject_sha256: digest,
          head_sha: state.head,
          reviewer_role: role,
        }),
      );
      options.reviews.push(filename);
    }
  };
  await refreshReviews();
  const nul = (values) =>
    Buffer.from(values.length ? `${values.join("\0")}\0` : "");
  const gitRunner = vi.fn(async (planned) => {
    const args = planned.args;
    let stdout;
    if (args.includes("config")) stdout = state.config;
    else if (args[0] === "check-attr") {
      const separator = args.indexOf("--");
      stdout = nul(
        args
          .slice(separator + 1)
          .flatMap((filename) =>
            args
              .slice(2, separator)
              .flatMap((attribute) => [
                filename,
                attribute,
                state.attributeValues[attribute] ?? "unspecified",
              ]),
          ),
      );
    } else if (args.includes("--show-toplevel"))
      stdout = Buffer.from(`${root}\n`);
    else if (args.includes("cat-file")) stdout = Buffer.from("commit\n");
    else if (args.includes("--stage")) stdout = Buffer.from(state.index);
    else if (args.includes("--others")) stdout = nul(state.untracked);
    else if (args[0] === "ls-files") stdout = nul(state.tracked);
    else if (args.includes("--cached")) stdout = nul(state.staged);
    else if (args.some((arg) => arg.includes("..")))
      stdout = nul(state.committed);
    else stdout = nul(state.unstaged);
    return { exitCode: 0, stdout, stderr: Buffer.alloc(0) };
  });
  const dependencies = {
    repositoryRoot: root,
    gitRunner,
    readHead: async () => state.head,
    worktreeDigest: async () => state.tree,
  };
  const reverify = async () => {
    verification.tree_sha256_before = state.tree;
    verification.tree_sha256_after = state.tree;
    for (const command of verification.commands)
      command.tree_sha256_before = command.tree_sha256_after = state.tree;
    await write("verification", verification);
  };
  return {
    directory,
    root,
    evidence,
    state,
    plan,
    planReview,
    implementation,
    verification,
    options,
    dependencies,
    roles,
    write,
    refreshReviews,
    reverify,
  };
}

// A private launcher selects private system configuration for both audit and
// execution. Neither fixture setup nor production probes touch user Git config.
async function privateGitFixture(f) {
  const home = path.join(f.directory, "home");
  const bin = path.join(f.directory, "bin");
  const system = path.join(f.directory, "system.gitconfig");
  const convertingMarker = path.join(f.directory, "converting-read");
  await fs.mkdir(path.join(home, ".config/git"), { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(system, "");
  const executable = spawnSync("/bin/sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).stdout.trim();
  await fs.writeFile(
    path.join(bin, "git"),
    `#!/bin/sh\nexport GIT_CONFIG_SYSTEM=${shellQuote(system)}\nfor argument do\n if [ "$argument" = diff ]; then printf 'diff\\n' >> ${shellQuote(convertingMarker)}; fi\ndone\nexec ${shellQuote(executable)} "$@"\n`,
    { mode: 0o700 },
  );
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args) => {
    const result = spawnSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...args],
      { cwd: f.root, env, encoding: "utf8", timeout: 10000 },
    );
    if (result.status !== 0)
      throw new Error("Private fixture Git setup failed.");
    return result.stdout.trim();
  };
  const gitRunner = vi.fn(async (planned) => {
    const args = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.ignoreSubmodules=none",
      ...planned.args,
    ];
    if (planned.args[0] === "diff")
      args.splice(
        5,
        0,
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=none",
      );
    const result = spawnSync("git", args, {
      cwd: f.root,
      env,
      timeout: planned.timeoutMs,
      maxBuffer: planned.maxStdoutBytes,
    });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: result.stderr ?? Buffer.alloc(0),
    };
  });
  return { home, system, convertingMarker, env, git, gitRunner };
}

async function realFixture({
  paths = ["README.md"],
  extraRoles = [],
  attributes = "worktree",
  ident = false,
} = {}) {
  const f = await fixture(paths, extraRoles);
  const { home, system, convertingMarker, env, git, gitRunner } =
    await privateGitFixture(f);
  await fs.mkdir(path.join(f.root, "scripts/ai-change"), { recursive: true });
  await fs.cp(
    path.join(repository, ".agents/schemas"),
    path.join(f.root, ".agents/schemas"),
    { recursive: true },
  );
  for (const name of [
    "review-local.mjs",
    "review-fanout.mjs",
    "artifact-validation.mjs",
    "schema-validator.mjs",
    "policy.mjs",
    "verify.mjs",
    "validate-process.mjs",
  ])
    await fs.copyFile(
      path.join(repository, "scripts/ai-change", name),
      path.join(f.root, "scripts/ai-change", name),
    );
  await fs.symlink(
    path.join(repository, "node_modules"),
    path.join(f.root, "node_modules"),
  );
  await fs.writeFile(path.join(f.root, ".gitignore"), "node_modules\n");
  for (const filename of new Set([
    ...paths,
    "README.md",
    "AGENTS.md",
    "apps/server/src/pathPolicy.ts",
    "candidate-helper.sh",
  ])) {
    await fs.mkdir(path.dirname(path.join(f.root, filename)), {
      recursive: true,
    });
    await fs.writeFile(path.join(f.root, filename), "baseline\n");
  }
  const attrFile =
    attributes === "nested"
      ? "apps/server/src/.gitattributes"
      : ".gitattributes";
  const rule = "* filter=fixture\n";
  if (["worktree", "nested", "index"].includes(attributes))
    await fs.writeFile(path.join(f.root, attrFile), rule);
  git(["init", "--quiet"]);
  if (ident) {
    await fs.writeFile(
      path.join(f.root, ".git/info/attributes"),
      "AGENTS.md ident\n",
    );
    await fs.writeFile(path.join(f.root, "AGENTS.md"), "$Id: baseline $\n");
  }
  git(["config", "user.name", "Local review fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git([
    "add",
    "--",
    ".agents",
    ".gitignore",
    "scripts",
    "README.md",
    "AGENTS.md",
    "apps",
    "candidate-helper.sh",
    ...paths,
    ...(["worktree", "nested", "index"].includes(attributes) ? [attrFile] : []),
  ]);
  git(["commit", "--quiet", "-m", "Fixture baseline"]);
  const head = git(["rev-parse", "HEAD"]);
  f.state.head = f.plan.base_sha = f.plan.head_sha = head;
  f.planReview.base_sha =
    f.planReview.head_sha =
    f.implementation.base_sha =
    f.implementation.head_sha =
      head;
  f.planReview.subject_sha256 = f.implementation.plan_sha256 = sha(
    json(f.plan),
  );
  for (const [name, value] of [
    ["plan", f.plan],
    ["planReview", f.planReview],
    ["implementation", f.implementation],
  ])
    await f.write(name, value);
  if (attributes === "info")
    await fs.writeFile(path.join(f.root, ".git/info/attributes"), rule);
  if (attributes === "global") {
    const filename = path.join(f.directory, "attributes");
    await fs.writeFile(filename, rule);
    git(["config", "core.attributesFile", filename]);
  }
  if (attributes === "default-global")
    await fs.writeFile(path.join(home, ".config/git/attributes"), rule);
  if (attributes === "index") await fs.unlink(path.join(f.root, attrFile));
  for (const filename of paths)
    await fs.writeFile(path.join(f.root, filename), "candidate worktree\n");
  const verifier = await import(
    pathToFileURL(path.join(f.root, "scripts/ai-change/verify.mjs")).href
  );
  const production = await import(
    pathToFileURL(path.join(f.root, "scripts/ai-change/review-local.mjs")).href
  );
  const dependencies = { repositoryRoot: f.root, gitRunner };
  const refresh = async () => {
    const tree = await verifier.calculateWorktreeDigest({
      processRunner: gitRunner,
    });
    Object.assign(f.verification, {
      base_sha: head,
      head_sha: head,
      tree_sha256_before: tree,
      tree_sha256_after: tree,
    });
    for (const command of f.verification.commands)
      command.tree_sha256_before = command.tree_sha256_after = tree;
    validateArtifact("verification", f.verification);
    await f.write("verification", f.verification);
    await f.refreshReviews();
  };
  // Command outcomes are controlled fixture evidence; digest acquisition is real
  // production Git and filesystem work. This is not canonical verification.
  await refresh();
  await fs.unlink(convertingMarker).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const runCli = (printSubject = true, environmentOverrides = {}) =>
    spawnSync(
      process.execPath,
      [
        path.join(f.root, "scripts/ai-change/review-local.mjs"),
        "--mode",
        "local",
        "--plan",
        f.options.plan,
        "--plan-review",
        f.options.planReview,
        "--implementation",
        f.options.implementation,
        "--verification",
        f.options.verification,
        ...(printSubject
          ? ["--print-subject"]
          : [
              "--subject-sha256",
              f.options.subjectSha256,
              ...f.options.reviews.flatMap((filename) => [
                "--review",
                filename,
              ]),
            ]),
      ],
      {
        cwd: f.root,
        env: { ...env, ...environmentOverrides },
        encoding: "utf8",
        timeout: 10000,
      },
    );
  gitRunner.mockClear();
  return {
    ...f,
    git,
    gitRunner,
    dependencies,
    home,
    system,
    convertingMarker,
    env,
    refresh,
    runCli,
    verifier,
    production,
    head,
  };
}

describe("real conversion admission and ordinary handoff", () => {
  it.each([
    ["local", "clean", "worktree"],
    ["include", "clean", "nested"],
    ["includeIf", "process", "info"],
    ["home", "clean", "global"],
    ["xdg", "process", "default-global"],
    ["worktree", "clean", "index"],
    ["system", "process", "worktree"],
    ["overridden", "clean", "info"],
    ["empty", "clean", "worktree"],
  ])(
    "LOCAL-REVIEW-GIT-FILTER-001 rejects %s %s before helper execution (%s attributes)",
    async (source, key, attributes) => {
      const f = await realFixture({ attributes });
      const marker = path.join(f.directory, "helper-executed");
      const secret = "fixture-private-command-value";
      const helper = `printf ${shellQuote(secret)} > ${shellQuote(marker)}; cat`;
      const config = `[filter "fixture"]\n\t${key} = ${JSON.stringify(helper)}\n`;
      if (source === "local")
        f.git(["config", `filter.fixture.${key}`, helper]);
      if (["include", "includeIf"].includes(source)) {
        const included = path.join(f.directory, "included.gitconfig");
        await fs.writeFile(included, config);
        f.git([
          "config",
          source === "include"
            ? "include.path"
            : `includeIf.gitdir:${f.root}/.git.path`,
          included,
        ]);
      }
      if (source === "home")
        await fs.writeFile(path.join(f.home, ".gitconfig"), config);
      if (source === "xdg")
        await fs.writeFile(path.join(f.home, ".config/git/config"), config);
      if (source === "system") await fs.writeFile(f.system, config);
      if (source === "worktree") {
        f.git(["config", "extensions.worktreeConfig", "true"]);
        f.git(["config", "--worktree", `filter.fixture.${key}`, helper]);
      }
      if (source === "overridden") {
        await fs.writeFile(path.join(f.home, ".gitconfig"), config);
        f.git(["config", "filter.fixture.clean", ""]);
      }
      if (source === "empty") f.git(["config", "filter.fixture.clean", ""]);
      if (key === "process") f.git(["config", "filter.fixture.clean", helper]);
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      const bytes = await fs.readFile(path.join(f.root, "README.md"));
      await expect(
        f.production.reviewLocal(f.options, f.dependencies),
      ).rejects.toThrow(/filter.*clean.*process/i);
      expect(
        f.gitRunner.mock.calls.some(([planned]) => planned.args[0] === "diff"),
      ).toBe(false);
      for (const print of [true, false]) {
        const result = f.runCli(print);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/filter.*clean.*process/i);
        expect(result.stderr).not.toContain(secret);
        expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1024);
      }
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
      expect(await fs.readFile(path.join(f.root, "README.md"))).toEqual(bytes);
    },
  );

  it.each(["apps/server/src/pathPolicy.ts", "AGENTS.md"])(
    "rejects a candidate helper that would normalize omitted protected %s to HEAD",
    async (omitted) => {
      const f = await realFixture();
      const marker = path.join(f.directory, "candidate-helper-executed");
      // Evidence was acquired before the hidden edit and helper activation. The
      // helper would hide both its own edit and the protected edit from Git diff.
      await fs.writeFile(
        path.join(f.root, omitted),
        "undeclared protected change\n",
      );
      await fs.writeFile(
        path.join(f.root, "candidate-helper.sh"),
        `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\ncase "$1" in\n ${shellQuote(omitted)}|candidate-helper.sh) git show "HEAD:$1" ;;\n *) cat ;;\nesac\n`,
      );
      f.git(["config", "filter.fixture.clean", "sh candidate-helper.sh %f"]);
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      const original = await fs.readFile(path.join(f.root, omitted));
      const outcome = await f.production
        .reviewLocal(f.options, f.dependencies)
        .then(
          (rendered) => ({ rendered }),
          (error) => ({ error }),
        );
      const invoked = await fs.stat(marker).then(
        () => true,
        () => false,
      );
      expect(
        invoked,
        "Candidate filter helper must never execute during review",
      ).toBe(false);
      expect(outcome.error?.message).toMatch(/filter.*clean.*process/i);
      expect(
        f.gitRunner.mock.calls.some(([planned]) => planned.args[0] === "diff"),
      ).toBe(false);
      const result = f.runCli();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/filter.*clean.*process/i);
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(f.root, omitted))).toEqual(original);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    },
  );

  it.each(["production", "print", "aggregate"])(
    "admits no-helper configuration and nonconversion attributes through %s",
    async (entry) => {
      const f = await realFixture({ attributes: "info" });
      f.git([
        "config",
        "fixture.multiline",
        "first\nfilter.fake.clean=not-a-key\nlast",
      ]);
      await fs.writeFile(
        path.join(f.root, ".git/info/attributes"),
        "*.md linguist-language=Markdown\n",
      );
      await f.refresh();
      if (entry === "production")
        expect(
          await f.production.reviewLocal(f.options, f.dependencies),
        ).toContain('"clean"');
      else {
        const print = entry === "print";
        const result = f.runCli(print);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        if (print) expect(result.stdout).toBe(`${f.options.subjectSha256}\n`);
        else expect(JSON.parse(result.stdout).verdict).toBe("clean");
      }
    },
  );

  it.each([
    ["print", true, false],
    ["aggregate", false, false],
    ["paired-print", true, true],
    ["paired-aggregate", false, true],
  ])(
    "rejects the ordinary staged candidate in shortcut CLI %s",
    async (_entry, print, paired) => {
      const f = await realFixture();
      f.git(["add", "--", "README.md"]);
      await f.refresh();
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      const bytes = await fs.readFile(path.join(f.root, "README.md"));
      if (paired) {
        const observed = await f.production.readLocalReviewScope({
          ...f.dependencies,
          baseSha: f.plan.base_sha,
          headSha: f.head,
        });
        expect(observed.paths).toEqual(["README.md"]);
        expect(observed.staged).toEqual(["README.md"]);
      }
      const result = f.runCli(print);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/index|staged/);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
      expect(await fs.readFile(path.join(f.root, "README.md"))).toEqual(bytes);
    },
  );

  it("ARCH-LOCAL-ADMISSION-001 preserves ordinary staged handoff and requires the verified worktree", async () => {
    const f = await realFixture({
      paths: ["README.md", "apps/server/src/pathPolicy.ts"],
      extraRoles: ["review-architecture"],
    });
    f.git(["add", "--", ...f.plan.allowed_paths]);
    await f.refresh();
    const index = await fs.readFile(path.join(f.root, ".git/index"));
    const bytes = await fs.readFile(path.join(f.root, "README.md"));
    const context = await f.production.createLocalGitReadContext(
      f.dependencies,
    );
    const inputs = {
      repositoryRoot: f.root,
      baseSha: f.plan.base_sha,
      headSha: f.head,
      gitRunner: context.gitRunner,
    };
    const observed = await f.production.readLocalReviewScope(inputs);
    expect(observed.paths).toEqual([...f.implementation.changed_files].sort());
    expect(observed.staged).toEqual(observed.paths);
    expect(observed.unstaged).toEqual([]);
    expect(
      await f.verifier.calculateWorktreeDigest({
        processRunner: context.gitRunner,
      }),
    ).toBe(f.verification.tree_sha256_after);
    const subject = localSubject(
      await fs.readFile(f.options.implementation),
      await fs.readFile(f.options.verification),
    );
    const identity = {
      runId: f.verification.run_id,
      subject: "implementation",
      subjectSha256: subject,
      baseSha: f.plan.base_sha,
      headSha: f.head,
      policySha256: f.plan.policy_sha256,
    };
    const current = classifyChange(
      await loadPolicy(path.join(f.root, ".agents/pr-review-policy.toml")),
      { paths: observed.paths, type: f.plan.classification.type },
    );
    const selectedRoles = [
      ...new Set([...current.skills, ...f.plan.classification.skills]),
    ].sort();
    const outputs = Object.fromEntries(
      AREA_REVIEW_ROLES.map((role) => [role, { result: "skipped" }]),
    );
    for (const filename of f.options.reviews) {
      const review = JSON.parse(await fs.readFile(filename, "utf8"));
      review.tags = ["manual-review"];
      outputs[review.reviewer_role] = { result: "success", raw: json(review) };
    }
    const fanout = validateAreaReviewFanout({
      outputs,
      selectedRoles,
      identity,
    });
    const aggregate = {
      ...JSON.parse(outputs[selectedRoles[0]].raw),
      reviewer_role: "review-change",
    };
    const aggregateInputs = {
      raw: json(aggregate),
      jobResult: "success",
      manifest: fanout.manifest,
      manifestSha256: fanout.sha256,
      selectedRoles,
      identity,
      reviewerRole: "review-change",
    };
    expect(() => validateAggregateReview(aggregateInputs)).not.toThrow();
    expect(() =>
      validateAggregateReview({
        ...aggregateInputs,
        raw: json({ ...aggregate, subject_sha256: sha("old") }),
      }),
    ).toThrow(/subject/);
    expect(() =>
      validateAreaReviewFanout({
        outputs: { ...outputs, "review-architecture": { result: "skipped" } },
        selectedRoles,
        identity,
      }),
    ).toThrow(/review-architecture/);
    const oldSubject = sha(await fs.readFile(f.options.implementation));
    expect(() =>
      validateAreaReviewFanout({
        outputs,
        selectedRoles,
        identity: { ...identity, subjectSha256: oldSubject },
      }),
    ).toThrow(/subject/);
    expect(() => assert.deepEqual(observed.paths, ["README.md"])).toThrow();
    expect(await f.production.readLocalReviewScope(inputs)).toEqual(observed);
    await context.assertCurrent();
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(await fs.readFile(path.join(f.root, "README.md"))).toEqual(bytes);
  });

  it("rejects index drift and never describes different index-only bytes as verified", async () => {
    const f = await realFixture();
    f.git(["add", "--", "README.md"]);
    const bytes = await fs.readFile(path.join(f.root, "README.md"));
    const context = await f.production.createLocalGitReadContext(
      f.dependencies,
    );
    const inputs = {
      repositoryRoot: f.root,
      baseSha: f.plan.base_sha,
      headSha: f.head,
      gitRunner: context.gitRunner,
    };
    const observed = await f.production.readLocalReviewScope(inputs);
    // Stage different bytes in the private fixture, then restore the verified
    // worktree. A worktree digest cannot attest those different index-only bytes.
    await fs.writeFile(
      path.join(f.root, "README.md"),
      "unverified index-only candidate\n",
    );
    f.git(["add", "--", "README.md"]);
    await fs.writeFile(path.join(f.root, "README.md"), bytes);
    const changed = await f.production.readLocalReviewScope(inputs);
    expect(changed.indexSha256).not.toBe(observed.indexSha256);
    expect(() => assert.deepEqual(changed, observed)).toThrow();
    expect(
      await f.verifier.calculateWorktreeDigest({
        processRunner: context.gitRunner,
      }),
    ).toBe(f.verification.tree_sha256_after);
    const stagedBytes = f.git(["show", ":README.md"]);
    expect(stagedBytes).not.toBe(bytes.toString().trim());
    expect(() => assert.equal(stagedBytes, bytes.toString().trim())).toThrow();
  });
});

describe("conversion snapshot bounds and persistent freshness", () => {
  it("rejects stable active ident before converting ordinary and both real CLI reads", async () => {
    const f = await realFixture({ ident: true });
    const target = path.join(f.root, "AGENTS.md");
    const bytes = await fs.readFile(target);
    const normalized = f.git(["hash-object", "--path=AGENTS.md", "AGENTS.md"]);
    const evidenceFiles = [
      f.options.plan,
      f.options.planReview,
      f.options.implementation,
      f.options.verification,
      ...f.options.reviews,
    ];
    const snapshot = async () => ({
      head: f.git(["rev-parse", "HEAD"]),
      index: sha(await fs.readFile(path.join(f.root, ".git/index"))),
      config: sha(
        f.git([
          "config",
          "--null",
          "--list",
          "--show-origin",
          "--show-scope",
          "--includes",
        ]),
      ),
      attributes: sha(f.git(["check-attr", "-z", "--all", "--", "AGENTS.md"])),
      evidence: await Promise.all(
        evidenceFiles.map(async (filename) => sha(await fs.readFile(filename))),
      ),
    });
    const before = await snapshot();
    await fs.writeFile(target, "$Id: protected expansion changed $\n");
    const changed = await fs.readFile(target);
    expect(sha(changed)).not.toBe(sha(bytes));
    expect(f.git(["hash-object", "--path=AGENTS.md", "AGENTS.md"])).toBe(
      normalized,
    );
    expect(f.git(["diff", "--", "AGENTS.md"])).toBe("");
    expect(
      await f.verifier.calculateWorktreeDigest({ processRunner: f.gitRunner }),
    ).toBe(f.verification.tree_sha256_after);
    expect(await snapshot()).toEqual(before);
    await fs.unlink(f.convertingMarker);
    f.gitRunner.mockClear();
    await expect(
      (async () => {
        const context = await f.production.createLocalGitReadContext(
          f.dependencies,
        );
        return f.production.readLocalReviewScope({
          repositoryRoot: f.root,
          baseSha: f.plan.base_sha,
          headSha: f.head,
          gitRunner: context.gitRunner,
        });
      })(),
    ).rejects.toThrow(/ident/i);
    expect(
      f.gitRunner.mock.calls.some(([planned]) => planned.args[0] === "diff"),
    ).toBe(false);
    for (const print of [true, false]) {
      const result = f.runCli(print);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/ident/i);
      expect(result.stderr).not.toMatch(/protected expansion|baseline|Id:/);
      await expect(fs.stat(f.convertingMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(await fs.readFile(target)).toEqual(changed);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["worktree", "nested", "index", "info", "global", "default-global"])(
    "captures Git-resolved %s conversion attributes and detects changed values",
    async (attributes) => {
      const f = await realFixture({ attributes });
      const outputs = [];
      const runner = async (planned) => {
        const result = await f.gitRunner(planned);
        if (planned.args[0] === "check-attr") outputs.push(result.stdout);
        return result;
      };
      const context = await f.production.createLocalGitReadContext({
        repositoryRoot: f.root,
        gitRunner: runner,
      });
      const filename =
        attributes === "nested" ? "apps/server/src/pathPolicy.ts" : "README.md";
      expect(Buffer.concat(outputs).toString()).toContain(
        `${filename}\0filter\0fixture\0`,
      );
      const source =
        attributes === "info"
          ? path.join(f.root, ".git/info/attributes")
          : attributes === "global"
            ? path.join(f.directory, "attributes")
            : attributes === "default-global"
              ? path.join(f.home, ".config/git/attributes")
              : path.join(
                  f.root,
                  attributes === "nested"
                    ? "apps/server/src/.gitattributes"
                    : ".gitattributes",
                );
      await fs.writeFile(source, "* text=auto\n");
      await expect(context.assertCurrent()).rejects.toThrow(
        /config.*attributes/i,
      );
      expect(
        f.gitRunner.mock.calls.some(([planned]) => planned.args[0] === "diff"),
      ).toBe(false);
    },
  );

  it("uses Git macro expansion and higher-precedence info attributes", async () => {
    const f = await realFixture({ attributes: "info" });
    await fs.writeFile(
      path.join(f.root, ".git/info/attributes"),
      "[attr]conversion ident -text\n*.md conversion\nREADME.md !ident text=auto\n",
    );
    const outputs = [];
    const inputs = {
      repositoryRoot: f.root,
      gitRunner: async (planned) => {
        const result = await f.gitRunner(planned);
        if (planned.args[0] === "check-attr") outputs.push(result.stdout);
        return result;
      },
    };
    await expect(
      f.production.createLocalGitReadContext(inputs),
    ).rejects.toThrow(/ident/i);
    const records = Buffer.concat(outputs).toString();
    expect(records).toContain("README.md\0ident\0unspecified\0");
    expect(records).toContain("README.md\0text\0auto\0");
    expect(records).toContain("AGENTS.md\0ident\0set\0");
    expect(records).toContain("AGENTS.md\0text\0unset\0");
    await fs.appendFile(
      path.join(f.root, ".git/info/attributes"),
      "*.md -ident\nREADME.md !ident text=auto\n",
    );
    const context = await f.production.createLocalGitReadContext(inputs);
    await context.assertCurrent();
    const result = f.runCli();
    expect(result.status, result.stderr).toBe(0);
  });

  it("excludes ambient config and XDG selectors identically in real CLI audit and reads", async () => {
    const f = await realFixture();
    const ignored = path.join(f.directory, "ignored-config");
    await fs.mkdir(path.join(ignored, "git"), { recursive: true });
    const config = path.join(ignored, "git/config");
    await fs.writeFile(
      config,
      '[filter "ambient"]\n clean = private-command\n',
    );
    const result = f.runCli(true, {
      XDG_CONFIG_HOME: ignored,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "filter.ambient.process",
      GIT_CONFIG_VALUE_0: "private-command",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${f.options.subjectSha256}\n`);
    expect(result.stderr).toBe("");
  });

  it("shares the frozen context, rejects a different root and exposes no config-write runner", async () => {
    const f = await fixture();
    const context = await localReader.createLocalGitReadContext(f.dependencies);
    expect(Object.isFrozen(context)).toBe(true);
    expect(
      await localReader.createLocalGitReadContext({
        repositoryRoot: f.root,
        gitRunner: context.gitRunner,
      }),
    ).toBe(context);
    await expect(
      localReader.createLocalGitReadContext({
        repositoryRoot: f.directory,
        gitRunner: context.gitRunner,
      }),
    ).rejects.toThrow(/root/);
    for (const command of ["config", "status", "add", "commit"])
      await expect(
        context.gitRunner({ command: "git", args: [command] }),
      ).rejects.toThrow(/evidence reads/);
    await expect(
      context.gitRunner({ command: "sh", args: ["diff"] }),
    ).rejects.toThrow(/evidence reads/);
  });

  it("rejects malformed commits, noncommit objects and a non-root reader before diff", async () => {
    const f = await fixture();
    for (const baseSha of [
      "HEAD",
      "a".repeat(39),
      "A".repeat(40),
      null,
      { toString: () => "a".repeat(40) },
    ]) {
      await expect(
        localReader.readLocalReviewScope({
          ...f.dependencies,
          baseSha,
          headSha: f.state.head,
        }),
      ).rejects.toThrow(/exact commit/);
    }
    expect(f.dependencies.gitRunner).not.toHaveBeenCalled();
    const runner = f.dependencies.gitRunner;
    await expect(
      localReader.createLocalGitReadContext({
        repositoryRoot: f.directory,
        gitRunner: runner,
      }),
    ).rejects.toThrow(/root/);
    await expect(
      localReader.readLocalReviewScope({
        ...f.dependencies,
        baseSha: f.plan.base_sha,
        headSha: f.state.head,
        gitRunner: async (planned) =>
          planned.args[0] === "cat-file"
            ? {
                exitCode: 0,
                stdout: Buffer.from("blob\n"),
                stderr: Buffer.alloc(0),
              }
            : runner(planned),
      }),
    ).rejects.toThrow(/object type/);
    expect(
      runner.mock.calls.some(([planned]) => planned.args[0] === "diff"),
    ).toBe(false);
  });

  it("suppresses runner errors and rejects config drift during attribute acquisition", async () => {
    const f = await fixture();
    await expect(
      localReader.createLocalGitReadContext({
        repositoryRoot: f.root,
        gitRunner: async () => {
          throw new Error("private-config-value");
        },
      }),
    ).rejects.toThrow(/^Bounded Git read failed\.$/);
    const runner = f.dependencies.gitRunner;
    await expect(
      localReader.createLocalGitReadContext({
        repositoryRoot: f.root,
        gitRunner: async (planned) => {
          const result = await runner(planned);
          if (planned.args[0] === "check-attr")
            f.state.config = Buffer.from(
              "local\0file:.git/config\0fixture.value\nchanged\0",
            );
          return result;
        },
      }),
    ).rejects.toThrow(/config during attribute acquisition/);
  });

  it.each([
    "local\0file:.git/config\0fixture.good\nvalue",
    "local\0file:.git/config\0",
    "invalid-scope\0file:.git/config\0fixture.good\nvalue\0",
    "local\0invalid-origin\0fixture.good\nvalue\0",
    "local\0file:.git/config\0invalid-key\nvalue\0",
    Buffer.from([0xff, 0]),
    Buffer.alloc(4 * 1024 * 1024 + 1),
  ])(
    "rejects malformed or oversized effective config %# before conversion",
    async (value) => {
      const f = await fixture();
      f.state.config = Buffer.from(value);
      await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow();
      expect(
        f.dependencies.gitRunner.mock.calls.some(
          ([planned]) => planned.args[0] === "diff",
        ),
      ).toBe(false);
    },
  );

  it.each(["clean", "process"])(
    "rejects valueless, empty, overridden and unmatched %s definitions",
    async (key) => {
      for (const value of ["", "\n", "\nprivate\nmultiline"]) {
        const f = await fixture();
        f.state.config = Buffer.from(
          `global\0file:private\0filter.Unmatched.Driver.${key}${value}\0local\0file:.git/config\0filter.Unmatched.Driver.${key}\n\0`,
        );
        await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
          /filter.*clean.*process/i,
        );
        expect(
          f.dependencies.gitRunner.mock.calls.some(
            ([planned]) => planned.args[0] === "diff",
          ),
        ).toBe(false);
      }
    },
  );

  it.each([
    "truncated",
    "missing",
    "duplicate",
    "wrong-path",
    "wrong-attribute",
    "invalid-utf8",
    "oversized",
    "failed",
  ])("rejects %s attribute snapshots before conversion", async (variant) => {
    const f = await fixture();
    const runner = f.dependencies.gitRunner;
    f.dependencies.gitRunner = async (planned) => {
      const result = await runner(planned);
      if (planned.args[0] !== "check-attr") return result;
      if (variant === "failed")
        return {
          ...result,
          exitCode: 1,
          stderr: Buffer.from("private diagnostic"),
        };
      let stdout = result.stdout;
      if (variant === "truncated") stdout = stdout.subarray(0, -1);
      if (variant === "missing") stdout = Buffer.alloc(0);
      if (variant === "duplicate") stdout = Buffer.concat([stdout, stdout]);
      if (variant === "wrong-path")
        stdout = Buffer.from(
          stdout.toString().replace("README.md", "other.txt"),
        );
      if (variant === "wrong-attribute")
        stdout = Buffer.from(stdout.toString().replace("filter", "other"));
      if (variant === "invalid-utf8") stdout = Buffer.from([0xff, 0]);
      if (variant === "oversized") stdout = Buffer.alloc(4 * 1024 * 1024 + 1);
      return { ...result, stdout };
    };
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow();
    expect(
      runner.mock.calls.some(([planned]) => planned.args[0] === "diff"),
    ).toBe(false);
  });

  it("batches complete literal tracked and untracked attribute coverage within 32 KiB", async () => {
    const f = await fixture();
    f.state.tracked = Array.from(
      { length: 300 },
      (_, index) => `docs/${index}-${"a".repeat(180)}.md`,
    );
    f.state.untracked = ["\ufeffnew.md", "-new.md"];
    const context = await localReader.createLocalGitReadContext(f.dependencies);
    const calls = f.dependencies.gitRunner.mock.calls.filter(
      ([planned]) => planned.args[0] === "check-attr",
    );
    expect(calls.length).toBeGreaterThan(1);
    const seen = [];
    for (const [planned] of calls) {
      expect(
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "diff.ignoreSubmodules=none",
          ...planned.args,
        ].reduce((size, arg) => size + Buffer.byteLength(arg) + 1, 0),
      ).toBeLessThanOrEqual(32 * 1024);
      const separator = planned.args.indexOf("--");
      expect(planned.args.slice(2, separator)).toEqual([
        "filter",
        "text",
        "eol",
        "crlf",
        "ident",
        "working-tree-encoding",
      ]);
      seen.push(...planned.args.slice(separator + 1));
    }
    expect(seen).toEqual([...f.state.tracked, ...f.state.untracked].sort());
    await expect(context.assertCurrent()).resolves.toBeUndefined();
  });

  it("caps the total attribute output across individually bounded batches", async () => {
    const f = await fixture();
    f.state.tracked = Array.from(
      { length: 5000 },
      (_, index) => `docs/${index}-${"a".repeat(160)}.md`,
    );
    await expect(
      localReader.createLocalGitReadContext(f.dependencies),
    ).rejects.toThrow(/attribute.*output bound/i);
    expect(
      f.dependencies.gitRunner.mock.calls.filter(
        ([planned]) => planned.args[0] === "check-attr",
      ).length,
    ).toBeGreaterThan(1);
  });

  it.each(["filter", "text", "eol", "crlf", "ident", "working-tree-encoding"])(
    "rechecks effective %s at final output admission",
    async (attribute) => {
      const f = await fixture();
      let reads = 0;
      f.dependencies.readHead = async () => {
        if (++reads === 3) f.state.attributeValues[attribute] = "changed";
        return f.state.head;
      };
      await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
        /config.*attributes/i,
      );
      expect(reads).toBe(3);
    },
  );

  it.each(
    ["config", "include", "source-selection", "attributes"].flatMap(
      (variant) => [
        [variant, "before-read"],
        [variant, "before-output"],
      ],
    ),
  )("rejects persistent %s drift at %s", async (variant, moment) => {
    const f = await realFixture({ attributes: "info" });
    const included = path.join(f.directory, "included.gitconfig");
    const selected = path.join(f.directory, "selected.gitconfig");
    await fs.writeFile(included, "[fixture]\n value = stable\n");
    await fs.writeFile(selected, "[fixture]\n value = stable\n");
    f.git(["config", "include.path", included]);
    const mutate = async () => {
      if (variant === "config") f.git(["config", "fixture.value", "changed"]);
      if (variant === "include")
        await fs.appendFile(included, " value = changed\n");
      if (variant === "source-selection")
        f.git(["config", "include.path", selected]);
      if (variant === "attributes")
        await fs.appendFile(
          path.join(f.root, ".git/info/attributes"),
          "*.md text=auto\n",
        );
    };
    if (moment === "before-read") {
      const context = await f.production.createLocalGitReadContext(
        f.dependencies,
      );
      const planned = {
        command: "git",
        args: ["diff", "--name-only", "-z", "--no-renames", "--"],
      };
      await context.gitRunner(planned);
      const diffCount = f.gitRunner.mock.calls.filter(
        ([read]) => read.args[0] === "diff",
      ).length;
      await mutate();
      await expect(context.gitRunner(planned)).rejects.toThrow(
        /config.*attributes/i,
      );
      expect(
        f.gitRunner.mock.calls.filter(([read]) => read.args[0] === "diff"),
      ).toHaveLength(diffCount);
      await expect(context.assertCurrent()).rejects.toThrow(
        /config.*attributes/i,
      );
      return;
    }

    // A separate admission captures the current state, then changes it after
    // the final HEAD lookup. This reaches reviewLocal's last output guard.
    let headReads = 0;
    const nextValue = "final-change";
    const runner = async (read) => {
      const result = await f.gitRunner(read);
      if (
        read.args[0] === "rev-parse" &&
        read.args[1] === "HEAD" &&
        ++headReads === 3
      ) {
        if (variant === "config") f.git(["config", "fixture.value", nextValue]);
        if (variant === "include")
          await fs.appendFile(included, ` value = ${nextValue}\n`);
        if (variant === "source-selection")
          f.git(["config", "include.path", selected]);
        if (variant === "attributes")
          await fs.appendFile(
            path.join(f.root, ".git/info/attributes"),
            "*.md -ident\n",
          );
      }
      return result;
    };
    await expect(
      f.production.reviewLocal(f.options, {
        ...f.dependencies,
        gitRunner: runner,
      }),
    ).rejects.toThrow(/config.*attributes/i);
    expect(headReads).toBe(3);
  });

  it("rejects drift immediately after a single converting read before returning its bytes", async () => {
    const f = await realFixture({ attributes: "info" });
    let diffs = 0;
    const context = await f.production.createLocalGitReadContext({
      repositoryRoot: f.root,
      gitRunner: async (planned) => {
        const result = await f.gitRunner(planned);
        if (planned.args[0] === "diff" && ++diffs === 1)
          await fs.appendFile(
            path.join(f.root, ".git/info/attributes"),
            "*.md text=auto\n",
          );
        return result;
      },
    });
    await expect(
      context.gitRunner({
        command: "git",
        args: ["diff", "--name-only", "-z", "--no-renames", "--"],
      }),
    ).rejects.toThrow(/config.*attributes/i);
    expect(diffs).toBe(1);
  });

  it("rejects a helper introduced immediately after a converting read without a second diff", async () => {
    const f = await realFixture();
    let diffs = 0;
    const runner = async (planned) => {
      const result = await f.gitRunner(planned);
      if (planned.args[0] === "diff" && ++diffs === 1)
        f.git(["config", "filter.new.process", "private-command"]);
      return result;
    };
    await expect(
      f.production.reviewLocal(f.options, {
        ...f.dependencies,
        gitRunner: runner,
      }),
    ).rejects.toThrow(/filter.*clean.*process/i);
    expect(diffs).toBe(1);
  });
});

describe("local clean review admission", () => {
  it("LOCAL-REVIEW-GIT-FILTER-001 rejects a configured helper before any diff", async () => {
    const f = await fixture();
    const runner = f.dependencies.gitRunner;
    f.dependencies.gitRunner = vi.fn(async (planned) =>
      planned.args.includes("config")
        ? {
            exitCode: 0,
            stdout: Buffer.from(
              "local\0file:.git/config\0filter.fixture.clean\nsecret-helper\0",
            ),
            stderr: Buffer.alloc(0),
          }
        : runner(planned),
    );
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
      /filter.*clean.*process/i,
    );
    expect(
      runner.mock.calls.some(([planned]) => planned.args[0] === "diff"),
    ).toBe(false);
  });

  it("prints a digest then aggregates schema-valid clean reviews with distinct producer IDs", async () => {
    const f = await fixture(
      ["README.md", "apps/server/src/asrClient.ts"],
      ["review-architecture"],
    );
    const { subjectSha256: _subject, reviews: _reviews, ...inputs } = f.options;
    expect(
      await reviewLocal({ ...inputs, printSubject: true }, f.dependencies),
    ).toBe(`${f.options.subjectSha256}\n`);
    const rendered = await reviewLocal(f.options, f.dependencies);
    const result = validateArtifact("review", JSON.parse(rendered));
    expect(result).toMatchObject({
      subject: "implementation",
      subject_sha256: f.options.subjectSha256,
      run_id: f.verification.run_id,
      reviewer_role: "review-change",
      verdict: "clean",
      findings: [],
    });
    expect(rendered).toBe(
      `${JSON.stringify(Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`,
    );
    expect(f.roles).toContain("review-architecture");
    f.options.reviews = f.options.reviews.filter(
      (name) => !name.endsWith("review-architecture.json"),
    );
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
      /review-architecture/,
    );
  });

  it.each([false, true])(
    "LOCAL-REVIEW-FRESHNESS-001 rejects old judgments after same-HEAD fresh verification (reused run ID %s)",
    async (reuseRunId) => {
      const f = await fixture();
      await expect(reviewLocal(f.options, f.dependencies)).resolves.toContain(
        '"clean"',
      );
      const oldImplementation = await fs.readFile(f.options.implementation);
      const oldReview = await fs.readFile(f.options.reviews[0]);
      f.state.tree = "f".repeat(64);
      if (!reuseRunId) f.verification.run_id = "fresh-verification-execution";
      await f.reverify();
      validateArtifact("verification", f.verification);
      f.options.subjectSha256 = localSubject(
        oldImplementation,
        await fs.readFile(f.options.verification),
      );
      await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
        reuseRunId ? /subject digest/ : /run ID|subject digest/,
      );
      expect(await fs.readFile(f.options.implementation)).toEqual(
        oldImplementation,
      );
      expect(await fs.readFile(f.options.reviews[0])).toEqual(oldReview);
    },
  );

  it("invalidates old reviews when only raw verification bytes change at the same tree and execution ID", async () => {
    const f = await fixture();
    await fs.appendFile(f.options.verification, "\n");
    f.options.subjectSha256 = localSubject(
      await fs.readFile(f.options.implementation),
      await fs.readFile(f.options.verification),
    );
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
      /subject digest/,
    );
  });

  it.each(["committed", "unstaged", "untracked", "staged"])(
    "LOCAL-REVIEW-SCOPE-002 rejects omitted protected path from %s with current full verification",
    async (source) => {
      const f = await fixture();
      const omitted = "apps/server/src/pathPolicy.ts";
      f.state[source].push(omitted);
      await fs.mkdir(path.dirname(path.join(f.root, omitted)), {
        recursive: true,
      });
      await fs.writeFile(path.join(f.root, omitted), "pre-existing work\n");
      f.state.tree = "f".repeat(64);
      await f.reverify();
      await f.refreshReviews();
      validateArtifact("verification", f.verification);
      await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
        source === "staged"
          ? /index|staged/
          : /observed.*scope|scope.*observed/i,
      );
      expect(await fs.readFile(path.join(f.root, omitted), "utf8")).toBe(
        "pre-existing work\n",
      );
    },
  );

  it("rejects extra declarations and a caller role override", async () => {
    const f = await fixture(["README.md", "apps/server/src/pathPolicy.ts"]);
    f.state.unstaged = ["README.md"];
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
      /observed.*scope|scope.*observed/i,
    );
    await expect(
      reviewLocal(
        { ...f.options, selectedRoles: ["review-documentation"] },
        f.dependencies,
      ),
    ).rejects.toThrow(/option/i);
  });

  it("unions current required roles even when the accepted plan declares fewer", async () => {
    const f = await fixture(["README.md", "apps/server/src/pathPolicy.ts"]);
    f.plan.classification.skills = ["review-documentation"];
    f.plan.classification.human_review_required = false;
    f.planReview.subject_sha256 = f.implementation.plan_sha256 = sha(
      json(f.plan),
    );
    await f.write("plan", f.plan);
    await f.write("planReview", f.planReview);
    await f.write("implementation", f.implementation);
    await f.refreshReviews();
    f.options.reviews = f.options.reviews.filter((filename) =>
      filename.endsWith("review-documentation.json"),
    );
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
      /review-architecture|review-security|review-server/,
    );
  });

  it.each(["not-allowed", "forbidden", "glob-only"])(
    "requires exact literal accepted scope: %s",
    async (variant) => {
      const f = await fixture();
      if (variant === "not-allowed") f.plan.allowed_paths = ["other.md"];
      if (variant === "forbidden") f.plan.forbidden_paths = ["*.md"];
      if (variant === "glob-only") f.plan.allowed_paths = ["*.md"];
      f.planReview.subject_sha256 = f.implementation.plan_sha256 = sha(
        json(f.plan),
      );
      await f.write("plan", f.plan);
      await f.write("planReview", f.planReview);
      await f.write("implementation", f.implementation);
      await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
        /scope/,
      );
    },
  );

  it("preserves a leading BOM as pathname identity rather than repairing it", async () => {
    const f = await fixture(["\ufeffREADME.md"]);
    expect(
      JSON.parse(await reviewLocal(f.options, f.dependencies)).tags,
    ).toEqual(["manual-review"]);
    f.implementation.changed_files = ["README.md"];
    await f.write("implementation", f.implementation);
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
      /scope/,
    );
  });

  it.each(["plan", "current", "area", "plan-review"])(
    "retains manual-review from %s",
    async (source) => {
      const f = await fixture(
        source === "current" ? ["AGENTS.md"] : ["README.md"],
      );
      if (source === "plan") {
        f.plan.classification.human_review_required = true;
        await f.write("plan", f.plan);
        f.planReview.subject_sha256 = f.implementation.plan_sha256 = sha(
          json(f.plan),
        );
        await f.write("planReview", f.planReview);
        await f.write("implementation", f.implementation);
        await f.refreshReviews();
      }
      if (source === "area") {
        const review = JSON.parse(
          await fs.readFile(f.options.reviews[0], "utf8"),
        );
        review.tags = ["manual-review"];
        await fs.writeFile(f.options.reviews[0], json(review));
      }
      if (source === "plan-review") {
        f.planReview.tags = ["manual-review"];
        await f.write("planReview", f.planReview);
      }
      expect(
        JSON.parse(await reviewLocal(f.options, f.dependencies)).tags,
      ).toEqual(["manual-review"]);
    },
  );

  it.each([
    "missing",
    "duplicate-path",
    "duplicate-role",
    "extra",
    "unknown",
    "malformed",
    "blocked",
    "raw-implementation",
    "wrong-run",
  ])("rejects %s area evidence", async (variant) => {
    const f = await fixture();
    const review = JSON.parse(await fs.readFile(f.options.reviews[0], "utf8"));
    if (variant === "missing") f.options.reviews = [];
    else if (variant === "duplicate-path")
      f.options.reviews.push(f.options.reviews[0]);
    else if (["duplicate-role", "extra"].includes(variant)) {
      const filename = path.join(f.evidence, "extra.json");
      if (variant === "extra") review.reviewer_role = "review-security";
      await fs.writeFile(filename, json(review));
      f.options.reviews.push(filename);
    } else {
      if (variant === "unknown") review.reviewer_role = "invented-reviewer";
      if (variant === "blocked") {
        review.verdict = "blocked";
        review.findings = [finding];
      }
      if (variant === "raw-implementation")
        review.subject_sha256 = sha(
          await fs.readFile(f.options.implementation),
        );
      if (variant === "wrong-run") review.run_id = f.implementation.run_id;
      await fs.writeFile(
        f.options.reviews[0],
        variant === "malformed" ? "{" : json(review),
      );
    }
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow();
  });

  it.each([
    "plan-review-subject",
    "plan-review-role",
    "plan-review-blocked",
    "plan-digest",
    "deviations",
    "duplicate-claim",
    "missing-claim",
    "skill-digest",
    "missing-skill",
    "policy",
    "tree",
    "head",
    "commands-omitted",
    "commands-reordered",
    "commands-duplicate",
    "command-failed",
    "command-tree",
    "managed",
    "gate-b",
  ])("rejects invalid prerequisite %s", async (variant) => {
    const f = await fixture();
    if (variant === "plan-review-subject")
      f.planReview.subject_sha256 = "0".repeat(64);
    if (variant === "plan-review-role")
      f.planReview.reviewer_role = "review-change";
    if (variant === "plan-review-blocked") {
      f.planReview.verdict = "blocked";
      f.planReview.findings = [finding];
    }
    if (variant === "plan-digest")
      f.implementation.plan_sha256 = "0".repeat(64);
    if (variant === "deviations")
      f.implementation.deviations = ["Unplanned behavior"];
    if (variant === "duplicate-claim")
      f.implementation.claim_evidence.push(f.implementation.claim_evidence[0]);
    if (variant === "missing-claim")
      f.implementation.claim_evidence[0].claim_id = "CLAIM-OTHER";
    if (variant === "skill-digest")
      f.plan.skill_versions["review-documentation"] = "0".repeat(64);
    if (variant === "missing-skill")
      delete f.plan.skill_versions["review-documentation"];
    if (variant === "policy") f.verification.policy_sha256 = "0".repeat(64);
    if (variant === "tree") f.state.tree = "0".repeat(64);
    if (variant === "head") f.state.head = "0".repeat(40);
    if (variant === "commands-omitted") f.verification.commands.pop();
    if (variant === "commands-reordered") f.verification.commands.reverse();
    if (variant === "commands-duplicate")
      f.verification.commands[1] = f.verification.commands[0];
    if (variant === "command-failed") f.verification.commands[0].exit_code = 1;
    if (variant === "command-tree")
      f.verification.commands[0].tree_sha256_after = "0".repeat(64);
    if (variant === "managed") f.implementation.kind = "managed-implementation";
    if (variant === "gate-b") f.plan.base_sha = GATE_B_LOCAL_CHANGE_BASE_SHA;
    if (["skill-digest", "missing-skill"].includes(variant))
      f.planReview.subject_sha256 = f.implementation.plan_sha256 = sha(
        json(f.plan),
      );
    await Promise.all(
      [
        ["plan", f.plan],
        ["planReview", f.planReview],
        ["implementation", f.implementation],
        ["verification", f.verification],
      ].map(([name, value]) => f.write(name, value)),
    );
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow();
  });

  it.each([
    "head",
    "tree",
    "scope",
    "index",
    "plan",
    "planReview",
    "implementation",
    "verification",
    "review",
    "policy",
    "skill",
  ])("rechecks %s immediately before returning output", async (variant) => {
    const f = await fixture();
    let calls = 0;
    f.dependencies.worktreeDigest = async () => {
      calls += 1;
      if (calls === 2) {
        if (variant === "head") f.state.head = "0".repeat(40);
        else if (variant === "tree") f.state.tree = "0".repeat(64);
        else if (variant === "scope") f.state.unstaged.push("other.txt");
        else if (variant === "index")
          f.state.index = f.state.index.replace(/^H/, "h");
        else {
          const filename =
            variant === "review"
              ? f.options.reviews[0]
              : variant === "policy"
                ? path.join(f.root, ".agents/pr-review-policy.toml")
                : variant === "skill"
                  ? path.join(
                      f.root,
                      ".agents/skills/review-documentation/SKILL.md",
                    )
                  : f.options[variant];
          await fs.appendFile(filename, "\n");
        }
      }
      return f.state.tree;
    };
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow();
  });
});

describe("local CLI and bounded inputs", () => {
  it.each(
    [
      [],
      ["--mode", "managed"],
      ["--mode", "local", "--mode", "local"],
      ["--unknown", "x"],
      ["--plan"],
    ].map((args) => [args]),
  )("rejects invalid options before I/O: %j", async (args) => {
    expect(() => parseLocalReviewArgs(args)).toThrow();
    const result = spawnSync(
      process.execPath,
      [path.join(repository, "scripts/ai-change/review-local.mjs"), ...args],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1024);
    expect(result.stderr).not.toMatch(/ENOENT|at .*\.mjs/);
  });

  it("parses the sole print/aggregate routes and rejects duplicates and mixed modes", async () => {
    const args = [
      "--mode",
      "local",
      "--plan",
      "/p",
      "--plan-review",
      "/pr",
      "--implementation",
      "/i",
      "--verification",
      "/v",
    ];
    expect(parseLocalReviewArgs([...args, "--print-subject"])).toMatchObject({
      mode: "local",
      printSubject: true,
    });
    expect(
      parseLocalReviewArgs([
        ...args,
        "--subject-sha256",
        "a".repeat(64),
        "--review",
        "/r",
      ]),
    ).toMatchObject({ reviews: ["/r"] });
    for (const tail of [
      ["--print-subject", "--review", "/r"],
      ["--print-subject", "--subject-sha256", "a".repeat(64)],
      ["--print-subject", "--print-subject"],
      ["--subject-sha256", "a".repeat(64), "--review", "/r", "--review", "/r"],
      ["--plan", "/other"],
      ["--output", "/out"],
    ])
      expect(() => parseLocalReviewArgs([...args, ...tail])).toThrow();
    const f = await fixture();
    f.options.mode = "managed";
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
      /local/,
    );
    expect(f.dependencies.gitRunner).not.toHaveBeenCalled();
  });

  it.each(["inside", "symlink", "directory", "oversized", "invalid-utf8"])(
    "rejects %s evidence",
    async (variant) => {
      const f = await fixture();
      if (variant === "inside") {
        f.options.plan = path.join(f.root, "plan.json");
        await fs.writeFile(f.options.plan, json(f.plan));
      }
      if (variant === "symlink") {
        const filename = path.join(f.evidence, "link.json");
        await fs.symlink(f.options.plan, filename);
        f.options.plan = filename;
      }
      if (variant === "directory") f.options.plan = f.evidence;
      if (variant === "oversized")
        await fs.writeFile(f.options.plan, Buffer.alloc(1024 * 1024 + 1));
      if (variant === "invalid-utf8")
        await fs.writeFile(f.options.plan, Buffer.from([0xff]));
      await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow();
    },
  );

  it("caps aggregate evidence bytes even when each declared skill file is bounded", async () => {
    const f = await fixture();
    for (let index = 0; index < 9; index += 1) {
      const name = `extra-${index}`;
      const filename = path.join(f.root, ".agents/skills", name, "SKILL.md");
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const bytes = Buffer.alloc(1024 * 1024, "x");
      await fs.writeFile(filename, bytes);
      f.plan.skill_versions[name] = sha(bytes);
    }
    f.planReview.subject_sha256 = f.implementation.plan_sha256 = sha(
      json(f.plan),
    );
    await f.write("plan", f.plan);
    await f.write("planReview", f.planReview);
    await f.write("implementation", f.implementation);
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
      /bounded|aggregate bounds/,
    );
  });

  it("rejects evidence replaced during descriptor acquisition", async () => {
    const f = await fixture();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filename, ...args) => {
      const handle = await open(filename, ...args);
      if (filename === f.options.plan) await fs.appendFile(filename, "\n");
      return handle;
    });
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
      /identity/,
    );
  });

  it("caps Git queries and supplies no caller pathspec or write commands", async () => {
    const f = await fixture();
    await reviewLocal(f.options, f.dependencies);
    for (const [planned] of f.dependencies.gitRunner.mock.calls) {
      expect(planned.command).toBe("git");
      expect(planned.timeoutMs).toBe(30000);
      expect(planned.maxStdoutBytes).toBe(4 * 1024 * 1024);
      expect(planned.maxStderrBytes).toBe(16384);
      expect([
        "rev-parse",
        "cat-file",
        "diff",
        "ls-files",
        "--no-pager",
        "check-attr",
      ]).toContain(planned.args[0]);
      if (planned.args[0] === "diff") {
        expect(planned.args.at(-1)).toBe("--");
        expect(planned.args).toEqual(
          expect.arrayContaining(["--no-renames", "--name-only", "-z"]),
        );
      }
    }
  });

  it.each([
    Buffer.from("README.md"),
    Buffer.from("README.md\0\0"),
    Buffer.from([0xff, 0]),
    Buffer.from("../secret\0"),
    Buffer.from("/etc/passwd\0"),
    Buffer.from("./README.md\0"),
    Buffer.from("docs//file\0"),
    Buffer.from("docs\\file\0"),
    Buffer.from("README.md\0".repeat(10001)),
    Buffer.alloc(4 * 1024 * 1024 + 1),
  ])("rejects malformed/bounded Git path output %#", async (stdout) => {
    const f = await fixture();
    const runner = f.dependencies.gitRunner;
    f.dependencies.gitRunner = async (planned) =>
      planned.args.includes("--others")
        ? { exitCode: 0, stdout, stderr: Buffer.alloc(0) }
        : runner(planned);
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow();
  });

  it.each(["h 100644", "S 100644", "H 160000", "H 040000", "M 100644"])(
    "rejects unsupported index state %s",
    async (prefix) => {
      const f = await fixture();
      f.state.index = f.state.index.replace("H 100644", prefix);
      await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
        /index/,
      );
    },
  );

  it("rejects Git failures and nonregular untracked entries", async () => {
    const f = await fixture();
    const runner = f.dependencies.gitRunner;
    f.dependencies.gitRunner = async () => ({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("failure"),
    });
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(/Git/);
    f.dependencies.gitRunner = runner;
    f.state.untracked = ["link"];
    await fs.symlink("README.md", path.join(f.root, "link"));
    await expect(reviewLocal(f.options, f.dependencies)).rejects.toThrow(
      /regular/,
    );
  });
});

describe("real read-only Git discovery", () => {
  it("observes committed, unstaged, deleted, renamed and untracked paths without index writes", async () => {
    const f = await fixture();
    const { git, gitRunner } = await privateGitFixture(f);
    git(["init", "--quiet"]);
    git(["config", "user.name", "Local review fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    await fs.writeFile(path.join(f.root, "README.md"), "one\n");
    await fs.writeFile(path.join(f.root, "old.md"), "rename\n");
    await fs.writeFile(path.join(f.root, "deleted.md"), "delete\n");
    git(["add", "--", ".agents", "README.md", "old.md", "deleted.md"]);
    git(["commit", "--quiet", "-m", "Fixture baseline"]);
    const baseSha = git(["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(f.root, "README.md"), "two\n");
    await fs.rename(
      path.join(f.root, "old.md"),
      path.join(f.root, "renamed.md"),
    );
    git(["add", "--", "README.md", "old.md", "renamed.md"]);
    git(["commit", "--quiet", "-m", "Fixture candidate"]);
    const headSha = git(["rev-parse", "HEAD"]);
    await fs.rename(
      path.join(f.root, "renamed.md"),
      path.join(f.root, "new.md"),
    );
    await fs.unlink(path.join(f.root, "deleted.md"));
    await fs.writeFile(path.join(f.root, "untracked.md"), "preserve\n");
    const index = await fs.readFile(path.join(f.root, ".git/index"));
    const result = await discoverLocalPaths({
      repositoryRoot: f.root,
      baseSha,
      headSha,
      gitRunner,
    });
    expect(result.paths).toEqual([
      "README.md",
      "deleted.md",
      "new.md",
      "old.md",
      "renamed.md",
      "untracked.md",
    ]);
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    await fs.writeFile(path.join(f.root, "README.md"), "index-only change\n");
    git(["add", "--", "README.md"]);
    await fs.writeFile(path.join(f.root, "README.md"), "two\n");
    const stagedIndex = await fs.readFile(path.join(f.root, ".git/index"));
    const ordinary = await localReader.readLocalReviewScope({
      repositoryRoot: f.root,
      baseSha,
      headSha,
      gitRunner,
    });
    expect(ordinary.staged).toEqual(["README.md"]);
    expect(ordinary.paths).toEqual(result.paths);
    expect(ordinary.indexSha256).not.toBe(result.indexSha256);
    await expect(
      discoverLocalPaths({
        repositoryRoot: f.root,
        baseSha,
        headSha,
        gitRunner,
      }),
    ).rejects.toThrow(/staged|index/);
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(
      stagedIndex,
    );
    expect(await fs.readFile(path.join(f.root, "untracked.md"), "utf8")).toBe(
      "preserve\n",
    );
  }, 30_000);

  it("runs the real print-subject and aggregate CLI with committed plus unstaged and untracked evidence", async () => {
    const f = await fixture(["README.md", "docs/usage.md", "docs/new.md"]);
    const { git, gitRunner, env } = await privateGitFixture(f);
    await fs.mkdir(path.join(f.root, "scripts/ai-change"), { recursive: true });
    await fs.cp(
      path.join(repository, ".agents/schemas"),
      path.join(f.root, ".agents/schemas"),
      { recursive: true },
    );
    for (const name of [
      "review-local.mjs",
      "review-fanout.mjs",
      "artifact-validation.mjs",
      "schema-validator.mjs",
      "policy.mjs",
      "verify.mjs",
      "validate-process.mjs",
    ])
      await fs.copyFile(
        path.join(repository, "scripts/ai-change", name),
        path.join(f.root, "scripts/ai-change", name),
      );
    await fs.symlink(
      path.join(repository, "node_modules"),
      path.join(f.root, "node_modules"),
    );
    await fs.writeFile(
      path.join(f.root, ".gitignore"),
      "node_modules\nignored/\n",
    );
    await fs.mkdir(path.join(f.root, "docs"));
    await fs.writeFile(path.join(f.root, "README.md"), "base\n");
    await fs.writeFile(path.join(f.root, "docs/usage.md"), "base\n");
    git(["init", "--quiet"]);
    git(["config", "user.name", "Local review fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git([
      "add",
      "--",
      ".agents",
      ".gitignore",
      "scripts",
      "README.md",
      "docs/usage.md",
    ]);
    git(["commit", "--quiet", "-m", "Fixture baseline"]);
    f.plan.base_sha = f.plan.head_sha = git(["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(f.root, "README.md"), "candidate\n");
    git(["add", "--", "README.md"]);
    git(["commit", "--quiet", "-m", "Fixture candidate"]);
    const head = git(["rev-parse", "HEAD"]);
    await fs.writeFile(
      path.join(f.root, "docs/usage.md"),
      "unstaged candidate\n",
    );
    await fs.writeFile(
      path.join(f.root, "docs/new.md"),
      "untracked candidate\n",
    );
    await fs.mkdir(path.join(f.root, "ignored"));
    await fs.writeFile(
      path.join(f.root, "ignored/generated.txt"),
      "ignored dependency output\n",
    );
    f.planReview.base_sha = f.implementation.base_sha = f.plan.base_sha;
    f.planReview.head_sha = f.plan.head_sha;
    f.implementation.head_sha = head;
    f.planReview.subject_sha256 = f.implementation.plan_sha256 = sha(
      json(f.plan),
    );
    await f.write("plan", f.plan);
    await f.write("planReview", f.planReview);
    await f.write("implementation", f.implementation);
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import fs from 'node:fs/promises';
      import { verifyChange } from './scripts/ai-change/verify.mjs';
      const acceptedPlan = JSON.parse(await fs.readFile(process.argv[1], 'utf8'));
      const result = await verifyChange({ acceptedPlan, runId: 'fixture-verification-execution', localBaseSha: acceptedPlan.base_sha, headSha: process.argv[2], runner: async () => ({ exitCode: 0, stdout: 'fixture execution', stderr: '' }) });
      process.stdout.write(JSON.stringify(result));
    `,
        f.options.plan,
        head,
      ],
      { cwd: f.root, env, encoding: "utf8", timeout: 10000 },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const verification = validateArtifact(
      "verification",
      JSON.parse(probe.stdout),
    );
    expect(verification.commands).toHaveLength(9);
    await f.write("verification", verification);
    const args = [
      path.join(f.root, "scripts/ai-change/review-local.mjs"),
      "--mode",
      "local",
      "--plan",
      f.options.plan,
      "--plan-review",
      f.options.planReview,
      "--implementation",
      f.options.implementation,
      "--verification",
      f.options.verification,
    ];
    const run = (tail) =>
      spawnSync(process.execPath, [...args, ...tail], {
        cwd: f.root,
        env,
        encoding: "utf8",
        timeout: 10000,
      });
    const index = await fs.readFile(path.join(f.root, ".git/index"));
    const printed = run(["--print-subject"]);
    expect(printed.status, printed.stderr).toBe(0);
    expect(printed.stderr).toBe("");
    expect(printed.stdout).toMatch(/^[a-f0-9]{64}\n$/);
    const review = {
      ...f.planReview,
      run_id: verification.run_id,
      subject: "implementation",
      subject_sha256: printed.stdout.trim(),
      head_sha: head,
      reviewer_role: "review-documentation",
    };
    await fs.writeFile(f.options.reviews[0], json(review));
    const aggregated = run([
      "--subject-sha256",
      printed.stdout.trim(),
      "--review",
      f.options.reviews[0],
    ]);
    expect(aggregated.status, aggregated.stderr).toBe(0);
    expect(aggregated.stderr).toBe("");
    expect(
      validateArtifact("review", JSON.parse(aggregated.stdout)).verdict,
    ).toBe("clean");
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    review.verdict = "blocked";
    review.findings = [finding];
    await fs.writeFile(f.options.reviews[0], json(review));
    const rejected = run([
      "--subject-sha256",
      printed.stdout.trim(),
      "--review",
      f.options.reviews[0],
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(Buffer.byteLength(rejected.stderr)).toBeLessThanOrEqual(1024);
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    for (const flag of ["assume-unchanged", "skip-worktree"]) {
      git(["update-index", `--${flag}`, "--", "README.md"]);
      const unsupportedIndex = await fs.readFile(
        path.join(f.root, ".git/index"),
      );
      await expect(
        discoverLocalPaths({
          repositoryRoot: f.root,
          baseSha: f.plan.base_sha,
          headSha: head,
          gitRunner,
        }),
      ).rejects.toThrow(/index/);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(
        unsupportedIndex,
      );
      git(["update-index", `--no-${flag}`, "--", "README.md"]);
    }
    git(["add", "--intent-to-add", "--", "docs/new.md"]);
    await expect(
      discoverLocalPaths({
        repositoryRoot: f.root,
        baseSha: f.plan.base_sha,
        headSha: head,
        gitRunner,
      }),
    ).rejects.toThrow(/staged|index/);
  }, 30_000);
});
