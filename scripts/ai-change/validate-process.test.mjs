import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import {
  GATE_B_ALLOWED_PATH_COUNT,
  GATE_B_LOCAL_CHANGE_BASE_SHA,
  GATE_B_PLANNING_HEAD_SHA,
  GATE_B_POLICY_SHA256,
  GATE_B_REVIEW_ROLES,
  validateAttendedCommitContractSources,
  validateGateBArtifactBundle,
  validateGateBRemediationCycleSources,
  validatePolicyReferences,
  validateProcess,
  validatePublicationContractSources,
  validateVerificationCommands,
  validateVerifierConsumerSources,
  validateVerifierBuildContext,
  validateWorkflow,
} from "./validate-process.mjs";
import { displayCommand, verificationPlan, verifyChange } from "./verify.mjs";

describe("public repository AI process validation", () => {
  it("accepts the checked-in public policy, skills, schemas, and workflows", async () => {
    const result = await validateProcess();

    expect(result.workflows).toEqual(["ci.yml", "classify-pr.yml"]);
    expect(result.skills).toContain("review-agent-policy");
    expect(result.schemas).toContain("review.schema.json");
    expect(result.policy_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps every self-hosted model job out of the public workflows", () => {
    for (const name of ["ci.yml", "classify-pr.yml"]) {
      const source = fs.readFileSync(`.github/workflows/${name}`, "utf8");

      expect(source).not.toContain("self-hosted");
      expect(source).not.toContain("cloudx-codex");
      expect(source).not.toContain("codex login");
      expect(source).not.toMatch(/secrets\.[A-Z0-9_]+/u);
    }
  });

  it("rejects mutable external action references", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-public-ai-"));
    const workflow = parseDocument(`
name: Unsafe
on: pull_request
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`).toJS();
    const issues = [];

    validateWorkflow(root, "unsafe.yml", workflow, issues);

    expect(issues).toContainEqual(
      expect.stringMatching(/full-length commit SHA/i),
    );
  });

  it("rejects a write-authority job that executes pull-request head code", () => {
    const workflow = parseDocument(`
name: Unsafe target
on: pull_request_target
permissions: {}
jobs:
  mutate:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/checkout@1111111111111111111111111111111111111111
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm test
`).toJS();
    const issues = [];

    validateWorkflow(process.cwd(), "unsafe-target.yml", workflow, issues);

    expect(issues).toContainEqual(
      expect.stringMatching(/privileged.*pull-request head/i),
    );
  });

  it("rejects a dependency on a removed private-controller job", () => {
    const workflow = parseDocument(`
name: Stale dependency
on: push
permissions: {}
jobs:
  public-check:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  aggregate:
    needs: [public-check, manager-postgres]
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`).toJS();
    const issues = [];

    validateWorkflow(process.cwd(), "ci.yml", workflow, issues);

    expect(issues).toContainEqual(
      expect.stringMatching(/aggregate.*undefined job.*manager-postgres/i),
    );
  });

  it("rejects verifier build-context references to private extracted paths", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "cloudx-verifier-context-"),
    );
    fs.mkdirSync(path.join(root, "containers", "ci"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "containers", "ci", "Dockerfile"),
      "COPY apps/ai-manager/package.json apps/ai-manager/package.json\n",
    );
    const issues = [];

    validateVerifierBuildContext(root, issues);

    expect(issues).toEqual([
      "Verifier Dockerfile copies missing build-context path 'apps/ai-manager/package.json'.",
    ]);
  });

  it("requires enough test-merge history to validate both bound parents", () => {
    const source = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    const workflow = parseDocument(
      source.replaceAll("          fetch-depth: 2\n", ""),
    ).toJS();
    const issues = [];

    validateWorkflow(process.cwd(), "ci.yml", workflow, issues);

    expect(issues).toContainEqual(
      expect.stringMatching(/test-merge identity artifact/i),
    );
  });

  it("fails closed when policy references a skill that is not synchronized", () => {
    const issues = [];
    validatePolicyReferences(
      {
        labels: { areas: ["repository"] },
        defaults: {
          area: "repository",
          skills: ["missing-skill"],
        },
        cross_area: { areas: ["repository"], skills: [] },
        path_rules: [],
      },
      ["review-architecture"],
      issues,
    );

    expect(issues).toEqual([
      "Policy route 'defaults' references missing skill 'missing-skill'.",
    ]);
  });

  it("rejects push and GitHub mutation commands from deterministic verification", () => {
    const issues = [];

    validateVerificationCommands(
      [
        "npm run verify",
        "git push origin HEAD:refs/heads/candidate",
        "gh pr comment 1 --body reviewed",
      ],
      issues,
    );

    expect(issues).toEqual([
      "Verification command must be read-only and local: git push origin HEAD:refs/heads/candidate",
      "Verification command must be read-only and local: gh pr comment 1 --body reviewed",
    ]);
  });

  it("requires every tracked verifier consumer to use the silent plan-aware full entry", () => {
    const sources = rawVerifierConsumerSources();
    expect(validateVerifierConsumerSources(sources, [])).toEqual([]);

    const cases = [
      [
        "package",
        (value) => value.replace("verify.mjs", "verify.mjs --scope full"),
      ],
      [
        "workflow",
        (value) =>
          value.replace(
            "node scripts/ai-change/validate-process.mjs",
            "npm run verify:policy",
          ),
      ],
      [
        "root",
        (value) =>
          value.replaceAll("npm run --silent verify", "npm run verify"),
      ],
      [
        "verifierSkill",
        (value) =>
          value.replace("npm run --silent verify", "npm --silent run verify"),
      ],
      [
        "process",
        (value) =>
          value.replaceAll(
            "npm run --silent verify",
            "npm run --slient verify",
          ),
      ],
      [
        "testingMap",
        (value) => value.replace("npm run --silent verify", "npm run verify"),
      ],
      ["root", (value) => value.replace(" -- --plan", "")],
      ["verifierSkill", (value) => value.replace(" --base-sha", " --base")],
      ["process", (value) => value.replaceAll(" --head-sha", " --head")],
      ["testingMap", (value) => value.replace(" -- --plan", "")],
      [
        "verifier",
        (value) =>
          value.replace(
            'validateArtifact("plan", acceptedPlan)',
            "acceptedPlan",
          ),
      ],
      [
        "verifier",
        (value) => value.replace('scope: "full"', "scope: options.scope"),
      ],
      [
        "verifier",
        (value) =>
          value.replace(
            "process.stdout.write(rendered);",
            "await fs.writeFile(options.output, rendered);",
          ),
      ],
    ];
    for (const [name, mutate] of cases) {
      expect(
        validateVerifierConsumerSources(
          { ...sources, [name]: mutate(sources[name]) },
          [],
        ),
        name,
      ).not.toEqual([]);
    }
  });

  it("requires every attended commit handoff to preserve the exact candidate boundary", () => {
    const sources = rawPublicationContractSources();
    expect(validateAttendedCommitContractSources(sources, [])).toEqual([]);

    const cases = [
      [
        "root",
        (value) =>
          value.replace(
            "216e6d739155aa1dc5bab11829f56869e6f494ff",
            "0000000000000000000000000000000000000000",
          ),
      ],
      ["orchestrator", (value) => value.replace("git add --", "git add -A")],
      [
        "process",
        (value) =>
          value.replace("implementation.changed_files", "implementation.files"),
      ],
      [
        "implement",
        (value) =>
          value.replace(
            "POLICY: harden Gate B publication boundary",
            "POLICY: update Gate B",
          ),
      ],
      ["root", (value) => value.replaceAll("118-path", "113-path")],
      [
        "orchestrator",
        (value) =>
          value.replace("credential-free environment", "ambient environment"),
      ],
      [
        "process",
        (value) => value.replace("fatal UTF-8 decoder", "UTF-8 decoder"),
      ],
      [
        "root",
        (value) =>
          value.replace(
            "`GIT_NO_REPLACE_OBJECTS=1` disables replacement refs",
            "replacement refs may remain enabled",
          ),
      ],
    ];
    for (const [name, mutate] of cases) {
      expect(
        validateAttendedCommitContractSources(
          { ...sources, [name]: mutate(sources[name]) },
          [],
        ),
        name,
      ).not.toEqual([]);
    }
  });

  it("binds the attended candidate-tip-3 amend to exactly nine remediation paths", () => {
    const sources = rawPublicationContractSources();
    const paths = [
      ".agents/skills/change-orchestrator/SKILL.md",
      ".agents/skills/implement-change/SKILL.md",
      ".agents/skills/verify-change/SKILL.md",
      "AGENTS.md",
      "docs/AI_CHANGE_PROCESS.md",
      "docs/architecture/testing-map.md",
      "scripts/ai-change/validate-process.mjs",
      "scripts/ai-change/validate-process.test.mjs",
      "scripts/ai-change/verify.test.mjs",
    ];

    expect(validateGateBRemediationCycleSources(sources, [])).toEqual([]);
    for (const sourceName of ["root", "orchestrator", "process", "implement"]) {
      for (const remediationPath of paths) {
        expect(
          sources[sourceName],
          `${sourceName}: ${remediationPath}`,
        ).toContain(`\`${remediationPath}\``);
      }
      expect(sources[sourceName], sourceName).not.toMatch(
        /\bexact eleven(?:-path)?\b/iu,
      );
    }

    const cases = [
      [
        "root",
        (value) =>
          value.replace("`.agents/skills/verify-change/SKILL.md`, ", ""),
      ],
      [
        "orchestrator",
        (value) =>
          value.replace(
            "`docs/architecture/testing-map.md`",
            "`docs/architecture/unknown-map.md`",
          ),
      ],
      [
        "process",
        (value) =>
          value.replace(
            "`scripts/ai-change/verify.test.mjs`.",
            "`scripts/ai-change/verify.test.mjs`, `package.json`.",
          ),
      ],
      [
        "implement",
        (value) =>
          value.replace(
            "`scripts/ai-change/validate-process.mjs`",
            "`scripts/ai-change/validate-process.mjs`, `scripts/ai-change/validate-process.mjs`",
          ),
      ],
      [
        "root",
        (value) =>
          value.replace(
            "exact nine remediation paths",
            "exact eleven remediation paths",
          ),
      ],
    ];
    for (const [name, mutate] of cases) {
      expect(
        validateGateBRemediationCycleSources(
          { ...sources, [name]: mutate(sources[name]) },
          [],
        ),
        name,
      ).not.toEqual([]);
    }
  });

  it("requires a bounded pre-publication remediation cycle and attended same-parent amend", () => {
    const sources = rawPublicationContractSources();
    expect(validateGateBRemediationCycleSources(sources, [])).toEqual([]);

    const cases = [
      [
        "orchestrator",
        (value) =>
          value.replace(
            "at most three candidate tips",
            "at most four candidate tips",
          ),
      ],
      [
        "root",
        (value) =>
          value.replace(
            "counts as candidate tip 1",
            "does not count toward the ceiling",
          ),
      ],
      ["process", (value) => value.replace(/does not\s+reset/gu, "resets")],
      [
        "orchestrator",
        (value) =>
          value.replace(
            "terminally to `blocked`",
            "to another remediation cycle",
          ),
      ],
      [
        "root",
        (value) =>
          value.replace(
            "Before authorization or publication begins",
            "After authorization begins",
          ),
      ],
      [
        "process",
        (value) =>
          value.replaceAll("git commit --amend --no-edit", "git commit"),
      ],
      [
        "orchestrator",
        (value) =>
          value.replace(
            /clean tracked worktree\s+baseline/gu,
            "tracked worktree",
          ),
      ],
      [
        "root",
        (value) =>
          value.replaceAll("exact nine remediation paths", "remediation paths"),
      ],
      ["process", (value) => value.replace("63-path", "61-path")],
      [
        "orchestrator",
        (value) =>
          value.replace(
            "dd08cb93283abf5c1341ed3db13506da4f912423e11a51cf90ef8358404e0325",
            "00".repeat(32),
          ),
      ],
      [
        "implement",
        (value) =>
          value.replace("git commit --amend --no-edit", "git commit --amend"),
      ],
    ];

    for (const [name, mutate] of cases) {
      expect(
        validateGateBRemediationCycleSources(
          { ...sources, [name]: mutate(sources[name]) },
          [],
        ),
        name,
      ).not.toEqual([]);
    }
  });

  it("requires complete candidate-bound evidence regeneration before authorization", () => {
    const sources = rawPublicationContractSources();
    const invalidatedArtifacts = [
      "plan",
      "plan-review",
      "implementation",
      "verification",
      "selected area-review",
      "aggregate-review",
      "final-bundle",
      "authorization",
    ];

    for (const artifact of invalidatedArtifacts) {
      const mutated = {
        ...sources,
        orchestrator: sources.orchestrator.replace(
          `\`${artifact}\``,
          `\`reusable-${artifact}\``,
        ),
      };
      expect(
        validateGateBRemediationCycleSources(mutated, []),
        artifact,
      ).not.toEqual([]);
    }

    const cases = [
      [
        "root",
        (value) => value.replace("118-path/75-claim", "11-path/8-claim"),
      ],
      [
        "process",
        (value) =>
          value.replace("full canonical verification", "focused verification"),
      ],
      [
        "orchestrator",
        (value) =>
          value.replace(
            "all fresh policy-selected area reviews",
            "some area reviews",
          ),
      ],
      [
        "root",
        (value) => value.replace(/final bounded\s+15-file bundle/gu, "bundle"),
      ],
      [
        "process",
        (value) =>
          value.replace(
            "No remediation cycle exists after",
            "A remediation cycle may continue after",
          ),
      ],
      [
        "orchestrator",
        (value) => value.replace("No token is read", "A token may be read"),
      ],
      [
        "root",
        (value) =>
          value.replace(
            "no publisher is invoked",
            "the publisher may be invoked",
          ),
      ],
      [
        "process",
        (value) =>
          value.replace(
            "no GitHub mutation occurs",
            "a GitHub mutation may occur",
          ),
      ],
    ];
    for (const [name, mutate] of cases) {
      expect(
        validateGateBRemediationCycleSources(
          { ...sources, [name]: mutate(sources[name]) },
          [],
        ),
        name,
      ).not.toEqual([]);
    }

    const safeCommands = verificationPlan("full").map(displayCommand);
    expect(safeCommands).toHaveLength(9);
    expect(validateVerificationCommands(safeCommands, [])).toEqual([]);
    expect(
      validateVerificationCommands(
        [...safeCommands, "git push origin HEAD:candidate"],
        [],
      ),
    ).not.toEqual([]);
  });

  it("binds each complete remediation-order source and its exact closed block", () => {
    const sources = rawPublicationContractSources();
    expect(validatePublicationContractSources(sources, [])).toEqual([]);

    const orderBegin = "<!-- CLOUDX-GATE-B-REMEDIATION-ORDER-V1:BEGIN -->";
    const orderEnd = "<!-- CLOUDX-GATE-B-REMEDIATION-ORDER-V1:END -->";
    const contradictoryInstructions = [
      "$verify-change and $review-change dispatch before attended exact local commit.",
      "Verification and all selected area reviewers run before the attended local commit.",
      "Before the attended local commit, run verification and selected area reviews.",
      "All selected reviewers run before the remediation commit.",
      "Area reviews occur before the local commit.",
      "Before the attended commit, run AI reviews.",
      "All required reviews run before the attended local commit.",
      "Security and architecture reviews occur before the remediation commit.",
      "Dispatch reviewers before the attended exact local commit.",
      "Conduct the mandatory reviews before the remediation commit.",
      "Run the full verifier before the attended local commit.",
      "Despite the closed block, run the full verifier before the attended local commit.",
    ];
    for (const name of ["root", "orchestrator", "process"]) {
      for (const instruction of contradictoryInstructions) {
        const mutated = {
          ...sources,
          [name]: sources[name].replace(
            orderEnd,
            `${instruction}\n${orderEnd}`,
          ),
        };
        expect(
          validatePublicationContractSources(mutated, []),
          `${name}: ${instruction}`,
        ).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/canonical remediation-order block/i),
          ]),
        );
      }

      for (const instruction of contradictoryInstructions) {
        const mutated = {
          ...sources,
          [name]: sources[name].replace(
            orderEnd,
            `${orderEnd}\n${instruction}`,
          ),
        };
        expect(
          validatePublicationContractSources(mutated, []),
          `${name}: outside block: ${instruction}`,
        ).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/source-byte commitment/i),
          ]),
        );
      }

      const outsideBlockMutations = [
        [
          "prohibition",
          (value) =>
            value.replace(
              orderEnd,
              `${orderEnd}\nNo verification runs before the attended local commit.`,
            ),
        ],
        [
          "authority override",
          (value) =>
            value.replace(
              orderEnd,
              `${orderEnd}\nThat declaration is nonbinding; run verification before the attended local commit.`,
            ),
        ],
        [
          "before publication contract",
          (value) =>
            value.replace(
              "<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->",
              "Arbitrary policy byte.\n<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->",
            ),
        ],
        [
          "after publication contract",
          (value) =>
            value.replace(
              "<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->",
              "<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->\nArbitrary policy byte.",
            ),
        ],
      ];
      for (const [description, mutate] of outsideBlockMutations) {
        const mutated = { ...sources, [name]: mutate(sources[name]) };
        expect(
          validatePublicationContractSources(mutated, []),
          `${name}: ${description}`,
        ).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/source-byte commitment/i),
          ]),
        );
      }

      const declaration =
        name === "orchestrator"
          ? "The closed block below is the sole machine transition-order authority."
          : "The closed block\nbelow is the sole machine transition-order mirror of the change-orchestrator\nauthority.";
      const declarationMutations = [
        [
          "negated declaration",
          (value) => value.replace("the sole machine", "not the sole machine"),
        ],
        [
          "duplicate declaration",
          (value) => value.replace(orderBegin, `${declaration}\n${orderBegin}`),
        ],
      ];
      for (const [description, mutate] of declarationMutations) {
        const mutated = { ...sources, [name]: mutate(sources[name]) };
        expect(
          validatePublicationContractSources(mutated, []),
          `${name}: ${description}`,
        ).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/sole machine transition-order/i),
          ]),
        );
      }

      const whitespaceOnly = {
        ...sources,
        [name]: sources[name].replace(orderBegin, `${orderBegin}\n \t`),
      };
      expect(
        validatePublicationContractSources(whitespaceOnly, []),
        `${name}: documented whitespace`,
      ).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/source-byte commitment/i),
        ]),
      );

      const markerMutations = [
        ["missing begin", (value) => value.replace(orderBegin, "")],
        ["missing end", (value) => value.replace(orderEnd, "")],
        [
          "duplicate begin",
          (value) => value.replace(orderBegin, `${orderBegin}\n${orderBegin}`),
        ],
        [
          "duplicate end",
          (value) => value.replace(orderEnd, `${orderEnd}\n${orderEnd}`),
        ],
        [
          "reordered markers",
          (value) =>
            value
              .replace(orderBegin, "CLOUDX_ORDER_MARKER_PLACEHOLDER")
              .replace(orderEnd, orderBegin)
              .replace("CLOUDX_ORDER_MARKER_PLACEHOLDER", orderEnd),
        ],
      ];
      for (const [description, mutate] of markerMutations) {
        const mutated = { ...sources, [name]: mutate(sources[name]) };
        expect(
          validatePublicationContractSources(mutated, []),
          `${name}: ${description}`,
        ).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/remediation-order markers/i),
          ]),
        );
      }
    }
  });

  it("requires exactly one complete versioned authority block per consumer", () => {
    const sources = rawPublicationContractSources();

    expect(validatePublicationContractSources(sources, [])).toEqual([]);
    for (const sourceName of [
      "root",
      "orchestrator",
      "ship",
      "review",
      "verifier",
      "process",
    ]) {
      const mutated = {
        ...sources,
        [sourceName]: sources[sourceName].replace(
          "<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->",
          "",
        ),
      };
      expect(
        validatePublicationContractSources(mutated, []),
        sourceName,
      ).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/exactly one Publication Contract V1 block/i),
        ]),
      );
    }
  });
  it("rejects additive or duplicated publication authority instead of accepting positive substrings", () => {
    const sources = rawPublicationContractSources();
    const begin = "<!-- CLOUDX-PUBLICATION-CONTRACT-V1:BEGIN -->";
    const end = "<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->";
    const rootBlock = sources.root.slice(
      sources.root.indexOf(begin),
      sources.root.indexOf(end) + end.length,
    );
    const cases = [
      [
        "root",
        "\nInitial candidate publication may also run `git push origin HEAD:candidate`.\n",
      ],
      [
        "ship",
        "\nA force push is permitted when the candidate branch diverges.\n",
      ],
      ["ship", "\nThe initial publisher may target a protected branch.\n"],
      ["ship", "\nA second initial exception may publish a later update.\n"],
      ["orchestrator", "\nThe orchestrator may push the candidate directly.\n"],
      ["verifier", "\nVerification may mutate GitHub after tests pass.\n"],
      [
        "ship",
        "\nLater mutation may proceed without a current clean review-pr.\n",
      ],
      [
        "ship",
        "\nMerge may proceed without merge intent or required checks.\n",
      ],
      ["root", `\n${rootBlock}\n`],
    ];
    for (const [sourceName, addition] of cases) {
      const issues = validatePublicationContractSources(
        { ...sources, [sourceName]: `${sources[sourceName]}${addition}` },
        [],
      );
      expect(issues, `${sourceName}: ${addition}`).not.toEqual([]);
    }

    const changedPublisher = {
      ...sources,
      ship: sources.ship.replace(
        "node scripts/ai-change/publish-gate-b.mjs",
        "git push origin architecture-and-new-codex",
      ),
    };
    expect(
      validatePublicationContractSources(changedPublisher, []),
    ).not.toEqual([]);
  });

  it.each([
    [
      "root",
      "The localChangeBaseSha=02d05f798096431f23acd1e5594a6bee21f3149f may stand in for the target base.",
    ],
    ["ship", "An alternate raw push is permitted after the publisher returns."],
    ["ship", "A force push is permitted when the candidate diverges."],
    ["ship", "A protected branch update is authorized for administrators."],
    ["ship", "Retry is permitted after a push transport error."],
    ["ship", "The operator may roll back the push automatically."],
    ["orchestrator", "The orchestrator may push the candidate directly."],
    ["orchestrator", "Review-pr may run after a post-push identity mismatch."],
    ["verifier", "Verification may mutate GitHub after local checks pass."],
    ["process", "expectedTargetBaseSha derives from the remote readback."],
    ["root", "Later mutation may proceed without a current clean review-pr."],
    ["root", "Merge may proceed without current intent or checks."],
  ])(
    "rejects a contradiction inside the %s authority block",
    (name, addition) => {
      const sources = rawPublicationContractSources();
      const end = "<!-- CLOUDX-PUBLICATION-CONTRACT-V1:END -->";
      sources[name] = sources[name].replace(end, `${addition}\n${end}`);

      expect(validatePublicationContractSources(sources, [])).not.toEqual([]);
    },
  );

  it.each([
    [
      "changed origin",
      (source) =>
        source.replace(
          "https://github.com/davidomil/cloudx",
          "https://github.com/other/cloudx",
        ),
    ],
    [
      "missing target identity",
      (source) =>
        source.replaceAll("GATE_B_EXPECTED_TARGET_BASE_SHA", "REMOVED_TARGET"),
    ],
    [
      "force option",
      (source) => source.replace('"--porcelain"', '"--force", "--porcelain"'),
    ],
    [
      "general force-with-lease option",
      (source) =>
        source.replace(
          "`--force-with-lease=${GATE_B_CANDIDATE_REF}:${expectedOldHead}`",
          '"--force-with-lease"',
        ),
    ],
    [
      "force-if-includes option",
      (source) =>
        source.replace('"--porcelain"', '"--force-if-includes", "--porcelain"'),
    ],
    [
      "plus refspec",
      (source) =>
        source.replace(
          "`HEAD:${GATE_B_CANDIDATE_REF}`",
          "`+HEAD:${GATE_B_CANDIDATE_REF}`",
        ),
    ],
    [
      "alternate destination",
      (source) =>
        source.replace(
          "`HEAD:${GATE_B_CANDIDATE_REF}`",
          '"HEAD:refs/heads/other"',
        ),
    ],
    [
      "second push",
      (source) =>
        `${source}\nconst bypass = ["push", "--porcelain", "origin", \`HEAD:\${GATE_B_CANDIDATE_REF}\`];\n`,
    ],
    [
      "missing terminal outcome",
      (source) =>
        source.replaceAll(
          'outcome: "manual-reconciliation-required"',
          'outcome: "published"',
        ),
    ],
    [
      "configurable production URL",
      (source) =>
        source.replace(
          'url: "https://github.com/davidomil/cloudx"',
          "url: process.env.CLOUDX_GATE_B_URL",
        ),
    ],
    [
      "mutable production descriptor",
      (source) =>
        source.replace(
          "const productionTransport = deepFreeze",
          "const productionTransport =",
        ),
    ],
    [
      "separate test core",
      (source) =>
        source.replace(
          "return publishCandidateWithTransport(options, productionTransport, {",
          "return publishProductionCandidate(options, productionTransport, {",
        ),
    ],
    [
      "optional direct-test transport",
      (source) =>
        source.replace(
          "requireLoopbackTestTransport(transport);",
          "if (transport !== undefined) requireLoopbackTestTransport(transport);",
        ),
    ],
    [
      "production transport fallback from injected entry",
      (source) =>
        source.replace(
          "publishCandidateWithTransport(publicationOptions, transport, {",
          "publishCandidateWithTransport(\n    publicationOptions,\n    transport ?? productionTransport,\n    {",
        ),
    ],
    [
      "ambient template",
      (source) =>
        source.replace(
          "`--template=${templateDirectory}`",
          '"--template=/ambient"',
        ),
    ],
    [
      "missing header reset",
      (source) =>
        source.replace('"http.extraHeader="', '"http.extraHeader=hostile"'),
    ],
    [
      "enabled hooks",
      (source) =>
        source.replace(
          '"core.hooksPath=/dev/null"',
          '"core.hooksPath=.git/hooks"',
        ),
    ],
    [
      "result reason field",
      (source) =>
        source.replace(
          "reviewPrHandoff: false,\n});",
          'reviewPrHandoff: false,\n  reason: "failed",\n});',
        ),
    ],
    [
      "lossy committed-diff decoding",
      (source) =>
        source.replace(
          'new TextDecoder("utf-8", {\n      fatal: true,\n      ignoreBOM: true,\n    }).decode(result.stdout)',
          'result.stdout.toString("utf8")',
        ),
    ],
    [
      "BOM-stripping committed-diff decoder",
      (source) => source.replace("ignoreBOM: true", "ignoreBOM: false"),
    ],
    [
      "string committed-diff output",
      (source) =>
        source.replace('{ encoding: "buffer" }', '{ encoding: "utf8" }'),
    ],
    [
      "ambient pre-token credential",
      (source) =>
        source.replace(
          'GIT_ASKPASS: "/bin/false",',
          'GH_TOKEN: process.env.GH_TOKEN,\n  GIT_ASKPASS: "/bin/false",',
        ),
    ],
    [
      "replacement refs in credential-free admission",
      (source) => source.replace('GIT_NO_REPLACE_OBJECTS: "1",', ""),
    ],
    [
      "replacement refs in isolated source reads and import",
      (source) => {
        const clause = 'GIT_NO_REPLACE_OBJECTS: "1",';
        const index = source.lastIndexOf(clause);
        return `${source.slice(0, index)}${source.slice(index + clause.length)}`;
      },
    ],
    [
      "widened normal command result",
      (source) =>
        source.replace(
          'typeof result.stdout !== "string"',
          '!Buffer.isBuffer(result.stdout) && typeof result.stdout !== "string"',
        ),
    ],
    [
      "missing initial committed-diff check",
      (source) =>
        source.replace(
          "await validateCommittedCandidateDiff({",
          "await skipCommittedCandidateDiff({",
        ),
    ],
    [
      "missing freshness committed-diff check",
      (source) => {
        const index = source.lastIndexOf(
          "await validateCommittedCandidateDiff({",
        );
        return `${source.slice(0, index)}await skipCommittedCandidateDiff({${source.slice(index + "await validateCommittedCandidateDiff({".length)}`;
      },
    ],
  ])("rejects publisher contract drift: %s", (_name, mutate) => {
    const sources = rawPublicationContractSources();
    sources.publisher = mutate(sources.publisher);

    expect(validatePublicationContractSources(sources, [])).not.toEqual([]);
  });

  it.each([
    [
      "token-bearing authorization schema",
      (sources) => {
        const schema = JSON.parse(sources.authorizationSchema);
        schema.properties.token = { type: "string" };
        sources.authorizationSchema = JSON.stringify(schema);
      },
    ],
    [
      "missing token commitment",
      (sources) => {
        const schema = JSON.parse(sources.authorizationSchema);
        delete schema.properties.credential_token_sha256;
        schema.required = schema.required.filter(
          (name) => name !== "credential_token_sha256",
        );
        sources.authorizationSchema = JSON.stringify(schema);
      },
    ],
    [
      "missing authorization file channel",
      (sources) => {
        sources.publisher = sources.publisher.replaceAll(
          "authorization-file",
          "removed-authorization-file",
        );
      },
    ],
    [
      "aliased publication and manifest digest",
      (sources) => {
        sources.publisher = sources.publisher.replaceAll(
          "authorizedPublicationSha256",
          "authorizedManifestSha256",
        );
      },
    ],
    [
      "missing attended-user mode",
      (sources) => {
        sources.publisher = sources.publisher.replaceAll(
          "attended-user",
          "automated-app",
        );
      },
    ],
    [
      "ambient credential source",
      (sources) => {
        sources.publisher = sources.publisher.replace(
          "process.env.CLOUDX_GATE_B_TOKEN",
          "process.env.GH_TOKEN",
        );
      },
    ],
    [
      "persistent credential helper",
      (sources) => {
        sources.publisher = sources.publisher.replace(
          '"credential.helper="',
          '"credential.helper=store"',
        );
      },
    ],
    [
      "direct-object-only test",
      (sources) => {
        sources.publisherTests = sources.publisherTests.replaceAll(
          "process.execPath",
          '"node"',
        );
      },
    ],
    [
      "challenge-free smart HTTP test",
      (sources) => {
        sources.publisherTests = sources.publisherTests.replaceAll(
          'Basic realm="cloudx-gate-b-test"',
          "removed-challenge",
        );
      },
    ],
    [
      "fake smart HTTP backend",
      (sources) => {
        sources.publisherTests = sources.publisherTests.replaceAll(
          '"http-backend"',
          '"fake-backend"',
        );
      },
    ],
  ])("rejects publication authorization drift: %s", (_name, mutate) => {
    const sources = rawPublicationContractSources();
    mutate(sources);

    expect(validatePublicationContractSources(sources, [])).not.toEqual([]);
  });

  it("binds a production-verifier Gate B bundle to one reviewed committed head", async () => {
    const fixture = gateBBundleFixture();
    const plan = JSON.parse(
      fs.readFileSync(path.join(fixture.directory, "plan.json"), "utf8"),
    );
    const actualVerification = await verifyChange({
      acceptedPlan: plan,
      localBaseSha: GATE_B_LOCAL_CHANGE_BASE_SHA,
      headSha: gitSha("b"),
      loadCurrentPolicy: async () => ({ policySha256: GATE_B_POLICY_SHA256 }),
      readHead: async () => gitSha("b"),
      runner: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      runId: "gate-b-production-verification",
      worktreeDigest: async () => sha("7"),
    });
    writeJson(fixture.directory, "verification.json", actualVerification);

    const options = fixture.options;
    const result = validateGateBArtifactBundle(options);
    const expectedAllowedPaths = Array.from(
      { length: GATE_B_ALLOWED_PATH_COUNT },
      (_, index) => `apps/server/src/gate-b-${index + 1}.ts`,
    ).sort();

    expect(result).toEqual({
      headSha: gitSha("b"),
      planningHeadSha: GATE_B_PLANNING_HEAD_SHA,
      localChangeBaseSha: GATE_B_LOCAL_CHANGE_BASE_SHA,
      allowedPaths: expectedAllowedPaths,
      planSha256: fileDigest(fixture.directory, "plan.json"),
      implementationSha256: fileDigest(
        fixture.directory,
        "implementation.json",
      ),
    });
    expect(Object.isFrozen(result.allowedPaths)).toBe(true);

    options.snapshot.files["plan.json"].fill(0);
    expect(result.allowedPaths).toEqual(expectedAllowedPaths);
    expect(() =>
      result.allowedPaths.push("apps/server/src/drift.ts"),
    ).toThrow();
  });

  it.each([113, 117, 119])(
    "rejects an otherwise complete %i-path Gate B bundle",
    (allowedPathCount) => {
      const fixture = gateBBundleFixture();
      fixture.mutate("plan.json", (plan) => {
        plan.allowed_paths = Array.from(
          { length: allowedPathCount },
          (_, index) => `apps/server/src/gate-b-${index + 1}.ts`,
        );
      });

      expect(() => validateGateBArtifactBundle(fixture.options)).toThrow(
        `Gate B plan allowed path count must equal ${GATE_B_ALLOWED_PATH_COUNT}.`,
      );
    },
  );

  it("builds the complete bundle fixture from the sole path-count authority", () => {
    const fixture = gateBBundleFixture();
    const plan = JSON.parse(
      fs.readFileSync(path.join(fixture.directory, "plan.json"), "utf8"),
    );

    expect(plan.allowed_paths).toHaveLength(GATE_B_ALLOWED_PATH_COUNT);
    expect(new Set(plan.allowed_paths).size).toBe(GATE_B_ALLOWED_PATH_COUNT);
  });

  it("rejects every Gate B artifact-binding bypass", () => {
    const cases = [
      [
        "plan review bound to candidate head",
        (fixture) =>
          fixture.mutate("plan-review.json", (review) => {
            review.head_sha = gitSha("b");
          }),
      ],
      [
        "implementation bound to planning head",
        (fixture) =>
          fixture.mutate("implementation.json", (implementation) => {
            implementation.head_sha = GATE_B_PLANNING_HEAD_SHA;
          }),
      ],
      [
        "area review bound to planning head",
        (fixture) =>
          fixture.mutate("review-web.json", (review) => {
            review.head_sha = GATE_B_PLANNING_HEAD_SHA;
          }),
      ],
      [
        "malformed schema",
        (fixture) => fixture.mutate("plan.json", (plan) => delete plan.task),
      ],
      [
        "missing role",
        (fixture) => fs.rmSync(path.join(fixture.directory, "review-web.json")),
      ],
      [
        "duplicate role",
        (fixture) =>
          fixture.mutate("review-security.json", (review) => {
            review.reviewer_role = "review-web";
          }),
      ],
      [
        "renamed role",
        (fixture) =>
          fs.renameSync(
            path.join(fixture.directory, "review-web.json"),
            path.join(fixture.directory, "review-renamed.json"),
          ),
      ],
      [
        "wrong subject",
        (fixture) =>
          fixture.mutate("review-web.json", (review) => {
            review.subject = "plan";
          }),
      ],
      [
        "wrong base",
        (fixture) =>
          fixture.mutate("implementation.json", (implementation) => {
            implementation.base_sha = gitSha("c");
          }),
      ],
      [
        "wrong head",
        (fixture) =>
          fixture.mutate("verification.json", (verification) => {
            verification.head_sha = gitSha("c");
          }),
      ],
      [
        "wrong policy",
        (fixture) =>
          fixture.mutate("review-change.json", (review) => {
            review.policy_sha256 = sha("9");
          }),
      ],
      [
        "wrong plan digest",
        (fixture) =>
          fixture.mutate("implementation.json", (implementation) => {
            implementation.plan_sha256 = sha("9");
          }),
      ],
      [
        "wrong implementation digest",
        (fixture) =>
          fixture.mutate("review-web.json", (review) => {
            review.subject_sha256 = sha("9");
          }),
      ],
      [
        "missing manual review",
        (fixture) =>
          fixture.mutate("review-change.json", (review) => {
            review.tags = [];
          }),
      ],
      [
        "duplicate claim",
        (fixture) =>
          fixture.mutate("implementation.json", (implementation) => {
            implementation.claim_evidence.push(
              structuredClone(implementation.claim_evidence[0]),
            );
          }),
      ],
      [
        "missing claim",
        (fixture) =>
          fixture.mutate("implementation.json", (implementation) => {
            implementation.claim_evidence.pop();
          }),
      ],
      [
        "changed path",
        (fixture) =>
          fixture.mutate("implementation.json", (implementation) => {
            implementation.changed_files[0] = "apps/server/src/unreviewed.ts";
          }),
      ],
      [
        "changed command",
        (fixture) =>
          fixture.mutate("verification.json", (verification) => {
            verification.commands[0].command = "npm run unreviewed";
          }),
      ],
      [
        "failed verification",
        (fixture) =>
          fixture.mutate("verification.json", (verification) => {
            verification.verdict = "failed";
          }),
      ],
      [
        "changed tree",
        (fixture) =>
          fixture.mutate("verification.json", (verification) => {
            verification.tree_sha256_after = sha("8");
          }),
      ],
      [
        "post-review implementation replacement",
        (fixture) =>
          fixture.mutate("implementation.json", (implementation) => {
            implementation.deviations = ["replacement"];
          }),
      ],
    ];

    for (const [name, mutate] of cases) {
      const fixture = gateBBundleFixture();
      mutate(fixture);
      expect(
        () => validateGateBArtifactBundle(fixture.options),
        name,
      ).toThrow();
    }
  });
});

function publicationContractSources() {
  return Object.fromEntries(
    Object.entries(rawPublicationContractSources()).map(([name, source]) => [
      name,
      source.replace(/\s+/gu, " "),
    ]),
  );
}

function rawPublicationContractSources() {
  return {
    root: fs.readFileSync("AGENTS.md", "utf8"),
    orchestrator: fs.readFileSync(
      ".agents/skills/change-orchestrator/SKILL.md",
      "utf8",
    ),
    implement: fs.readFileSync(
      ".agents/skills/implement-change/SKILL.md",
      "utf8",
    ),
    ship: fs.readFileSync(".agents/skills/ship-change/SKILL.md", "utf8"),
    review: fs.readFileSync(".agents/skills/review-pr/SKILL.md", "utf8"),
    verifier: fs.readFileSync(".agents/skills/verify-change/SKILL.md", "utf8"),
    process: fs.readFileSync("docs/AI_CHANGE_PROCESS.md", "utf8"),
    authorizationSchema: fs.readFileSync(
      ".agents/schemas/publication-authorization.schema.json",
      "utf8",
    ),
    publisher: fs.readFileSync("scripts/ai-change/publish-gate-b.mjs", "utf8"),
    publisherTests: fs.readFileSync(
      "scripts/ai-change/publish-gate-b.test.mjs",
      "utf8",
    ),
  };
}

function rawVerifierConsumerSources() {
  return {
    package: fs.readFileSync("package.json", "utf8"),
    workflow: fs.readFileSync(".github/workflows/ci.yml", "utf8"),
    root: fs.readFileSync("AGENTS.md", "utf8"),
    verifierSkill: fs.readFileSync(
      ".agents/skills/verify-change/SKILL.md",
      "utf8",
    ),
    process: fs.readFileSync("docs/AI_CHANGE_PROCESS.md", "utf8"),
    testingMap: fs.readFileSync("docs/architecture/testing-map.md", "utf8"),
    verifier: fs.readFileSync("scripts/ai-change/verify.mjs", "utf8"),
  };
}

const sha = (character) => character.repeat(64);
const gitSha = (character) => character.repeat(40);

function gateBBundleFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-gate-b-"));
  const planningHead = GATE_B_PLANNING_HEAD_SHA;
  const candidateHead = gitSha("b");
  const plan = {
    schema_version: 1,
    kind: "change-plan",
    run_id: "gate-b",
    base_sha: GATE_B_LOCAL_CHANGE_BASE_SHA,
    head_sha: planningHead,
    policy_sha256: GATE_B_POLICY_SHA256,
    skill_versions: { "plan-change": sha("2") },
    task: "Bind one committed candidate artifact set.",
    classification: {
      type: "feature",
      areas: [
        "agent-policy",
        "architecture",
        "automation",
        "documentation",
        "installer",
        "python-services",
        "security",
        "server",
        "shared",
        "web",
      ],
      risk: "human-required",
      skills: [...GATE_B_REVIEW_ROLES],
      human_review_required: true,
      automerge_eligible: false,
    },
    anchors: [
      {
        path: "apps/server/src/server.ts",
        line: 1,
        reason: "Composition owner.",
      },
      { path: "apps/web/src/ui/App.tsx", line: 1, reason: "Web owner." },
    ],
    claims: Array.from({ length: 75 }, (_, index) => ({
      id: `CLAIM-${index + 1}`,
      behavior: `Behavior ${index + 1}.`,
      production_seam: `production ${index + 1}`,
      test: `test ${index + 1}`,
      negative_cases: [`negative ${index + 1}`],
    })),
    allowed_paths: Array.from(
      { length: GATE_B_ALLOWED_PATH_COUNT },
      (_, index) => `apps/server/src/gate-b-${index + 1}.ts`,
    ),
    forbidden_paths: [".github/**"],
    verification: verificationPlan("full").map(displayCommand),
  };
  writeJson(directory, "plan.json", plan);
  const planDigest = fileDigest(directory, "plan.json");
  const implementation = {
    schema_version: 1,
    kind: "change-implementation",
    run_id: "gate-b-implementation",
    base_sha: plan.base_sha,
    head_sha: candidateHead,
    policy_sha256: plan.policy_sha256,
    plan_sha256: planDigest,
    changed_files: [...plan.allowed_paths],
    claim_evidence: plan.claims.map(({ id }) => ({
      claim_id: id,
      production_path: "production",
      test_path: "test",
      revert_failing_assertion: "fails on revert",
      negative_cases: ["negative"],
    })),
    deviations: [],
  };
  writeJson(directory, "implementation.json", implementation);
  const implementationDigest = fileDigest(directory, "implementation.json");
  writeJson(
    directory,
    "plan-review.json",
    reviewArtifact(plan, "review-plan", "plan", planDigest, planningHead),
  );
  for (const role of plan.classification.skills) {
    writeJson(
      directory,
      `${role}.json`,
      reviewArtifact(
        plan,
        role,
        "implementation",
        implementationDigest,
        candidateHead,
      ),
    );
  }
  writeJson(
    directory,
    "review-change.json",
    reviewArtifact(
      plan,
      "review-change",
      "implementation",
      implementationDigest,
      candidateHead,
    ),
  );
  writeJson(
    directory,
    "verification.json",
    verificationArtifact(plan, candidateHead),
  );

  return {
    directory,
    get options() {
      return { snapshot: artifactSnapshot(directory) };
    },
    mutate(name, mutation) {
      const value = JSON.parse(
        fs.readFileSync(path.join(directory, name), "utf8"),
      );
      mutation(value);
      writeJson(directory, name, value);
    },
  };
}

function artifactSnapshot(directory) {
  return {
    files: Object.fromEntries(
      fs
        .readdirSync(directory)
        .sort()
        .map((name) => [name, fs.readFileSync(path.join(directory, name))]),
    ),
  };
}

function reviewArtifact(plan, reviewerRole, subject, subjectSha256, headSha) {
  return {
    schema_version: 1,
    kind: "change-review",
    run_id: `gate-b-${reviewerRole}`,
    subject,
    subject_sha256: subjectSha256,
    base_sha: plan.base_sha,
    head_sha: headSha,
    policy_sha256: plan.policy_sha256,
    reviewer_role: reviewerRole,
    verdict: "clean",
    tags: ["manual-review"],
    findings: [],
  };
}

function verificationArtifact(plan, candidateHead) {
  return {
    schema_version: 1,
    kind: "change-verification",
    run_id: "gate-b",
    base_sha: plan.base_sha,
    head_sha: candidateHead,
    policy_sha256: plan.policy_sha256,
    tree_sha256_before: sha("3"),
    tree_sha256_after: sha("3"),
    verdict: "passed",
    commands: plan.verification.map((command) => ({
      command,
      exit_code: 0,
      stdout_sha256: sha("4"),
      stderr_sha256: sha("5"),
      tree_sha256_before: sha("3"),
      tree_sha256_after: sha("3"),
    })),
  };
}

function writeJson(directory, name, value) {
  fs.writeFileSync(
    path.join(directory, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function fileDigest(directory, name) {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(directory, name)))
    .digest("hex");
}
