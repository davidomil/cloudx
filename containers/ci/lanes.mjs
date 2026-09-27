export const coverageLanes = [
  "coverage-1",
  "coverage-2",
  "coverage-3",
  "coverage-4",
];
export const verificationLanes = [
  ...coverageLanes,
  "static",
  "asr",
  "documentation",
  "browser-1",
  "browser-2",
];

export function selectCommands(commands, lane) {
  if (lane === "full") return commands;
  const [
    install,
    policy,
    format,
    lint,
    typecheck,
    coverage,
    build,
    asrLock,
    asr,
    documentationLock,
    documentation,
    browser,
  ] = commands;
  if (lane === "static") return [install, typecheck, build];
  if (lane === "asr")
    return [
      asrLock,
      {
        ...asr,
        args: [
          ...asr.args,
          "--junitxml=test-results/timings/asr.xml",
          "--durations=10",
        ],
      },
    ];
  if (lane === "documentation")
    return [
      documentationLock,
      {
        ...documentation,
        args: [
          ...documentation.args,
          "--junitxml=test-results/timings/documentation.xml",
          "--durations=10",
        ],
      },
    ];
  if (coverageLanes.includes(lane)) {
    return [
      install,
      build,
      {
        ...coverage,
        env: {
          ...coverage.env,
          CLOUDX_GATE_B_DIAGNOSTICS_DIR: "/work/repository/test-results/gate-b",
          CLOUDX_TERMINAL_DIAGNOSTICS_DIR:
            "/work/repository/test-results/terminal",
        },
        args: [
          "exec",
          "--",
          "vitest",
          "run",
          "--coverage",
          `--shard=${lane.slice(-1)}/4`,
          "--maxWorkers=2",
          "--reporter=dot",
          "--reporter=blob",
          "--reporter=json",
          "--outputFile.json=test-results/timings/vitest.json",
          "--coverage.thresholds.statements=0",
          "--coverage.thresholds.functions=0",
          "--coverage.thresholds.lines=0",
          "--coverage.thresholds.branches=0",
          "--exclude=**/*.systemd.test.mjs",
          "--exclude=scripts/managed-update-systemd.test.mjs",
        ],
      },
    ];
  }
  if (/^browser-[12]$/.test(lane)) {
    return [
      install,
      build,
      {
        ...browser,
        args: [
          ...browser.args,
          `--shard=${lane.slice(-1)}/2`,
          "--reporter=line,json",
        ],
        env: {
          ...browser.env,
          PLAYWRIGHT_JSON_OUTPUT_NAME: "test-results/timings/browser.json",
        },
      },
    ];
  }
  if (lane === "coverage-merge")
    return [
      install,
      {
        ...coverage,
        args: [
          "exec",
          "--",
          "vitest",
          "--merge-reports=/work/coverage-input",
          "--coverage",
        ],
      },
    ];
  throw new Error(`Unknown verifier lane '${lane}'.`);
}

export function requireCompleteEvidence(
  evidence,
  candidateSha,
  required = verificationLanes,
) {
  if (!/^[0-9a-f]{40}$/.test(candidateSha))
    throw new Error("An exact candidate SHA is required.");
  if (evidence.length !== required.length)
    throw new Error("Required verifier evidence is missing or duplicated.");
  const seen = new Set();
  let tree;
  for (const item of evidence) {
    if (!required.includes(item.lane) || seen.has(item.lane))
      throw new Error("Unknown or duplicate verifier lane.");
    seen.add(item.lane);
    if (
      item.candidate_sha !== candidateSha ||
      item.verdict !== "passed" ||
      item.kind !== "managed-container-verification"
    ) {
      throw new Error(
        `Verifier lane ${item.lane} failed or belongs to another candidate.`,
      );
    }
    if (
      !/^[0-9a-f]{64}$/.test(item.tree_sha256_before) ||
      item.tree_sha256_after !== item.tree_sha256_before ||
      (tree && tree !== item.tree_sha256_before)
    ) {
      throw new Error("Verifier lanes did not test one unchanged source tree.");
    }
    tree = item.tree_sha256_before;
    if (
      !item.commands?.length ||
      item.commands.some(
        (command) =>
          command.exit_code !== 0 ||
          command.tree_sha256_before !== tree ||
          command.tree_sha256_after !== tree,
      )
    ) {
      throw new Error(`Incomplete command evidence in ${item.lane}.`);
    }
  }
  return {
    candidate_sha: candidateSha,
    tree_sha256: tree,
    lanes: [...seen].sort(),
  };
}
