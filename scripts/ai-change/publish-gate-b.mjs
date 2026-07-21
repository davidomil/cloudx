#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GATE_B_CANDIDATE_REF,
  GATE_B_COMMIT_SUBJECTS,
  GATE_B_EXPECTED_OLD_CANDIDATE_SHA,
  GATE_B_EXPECTED_TARGET_BASE_SHA,
  GATE_B_LOCAL_CHANGE_BASE_SHA,
  GATE_B_POLICY_SHA256,
  GATE_B_PULL_REQUEST,
  GATE_B_REPOSITORY,
  GATE_B_TARGET_BASE_REF,
  validateGateBArtifactBundle,
} from "./validate-process.mjs";
import { validateSchema } from "./schema-validator.mjs";

const candidateBranch = GATE_B_CANDIDATE_REF.slice("refs/heads/".length);
const targetBaseBranch = GATE_B_TARGET_BASE_REF.slice("refs/heads/".length);
const pullRequestFields = [
  "number",
  "state",
  "baseRefName",
  "baseRefOid",
  "headRefName",
  "headRefOid",
  "isCrossRepository",
  "url",
].join(",");
const gitSha = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const publicationAuthorizationMaxBytes = 32 * 1024;
const publicationGrantLifetimeMs = 15 * 60 * 1000;
const prePushDiagnostic = "Gate B publication rejected before push.\n";
const publishedResult = Object.freeze({
  outcome: "published",
  pushAttempts: 1,
  retry: false,
  reviewPrHandoff: true,
});
const manualReconciliationResult = Object.freeze({
  outcome: "manual-reconciliation-required",
  pushAttempts: 1,
  retry: false,
  reviewPrHandoff: false,
});

const productionTransport = deepFreeze({
  url: "https://github.com/davidomil/cloudx",
  protocol: "https",
  credentialScope: {
    host: "github.com",
    path: "davidomil/cloudx",
  },
});

export function readGateBArtifactSnapshot(artifactDir) {
  const directory = path.resolve(artifactDir);
  const names = fs.readdirSync(directory).sort();
  const files = Object.fromEntries(
    names.map((name) => {
      const filePath = path.join(directory, name);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Gate B artifact must be a regular file: ${name}`);
      }
      return [name, fs.readFileSync(filePath)];
    }),
  );
  const manifest = artifactManifest(files);
  return {
    directory,
    files,
    manifest,
    manifestSha256: sha256(manifest),
  };
}

export function canonicalPublicationAuthorization(value) {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

export function readPublicationAuthorizationSnapshot({
  authorizationFile,
  artifactDir,
  authorizedPublicationSha256,
}) {
  if (!sha256Pattern.test(authorizedPublicationSha256)) {
    throw new Error(
      "Gate B authorized publication digest must be a SHA-256 digest.",
    );
  }
  if (typeof authorizationFile !== "string" || authorizationFile.length === 0) {
    throw new Error("Gate B publication authorization file is required.");
  }

  const artifactDirectory = fs.realpathSync(path.resolve(artifactDir));
  const authorizationPath = path.resolve(authorizationFile);
  const initialStat = fs.lstatSync(authorizationPath);
  if (
    initialStat.isSymbolicLink() ||
    !initialStat.isFile() ||
    initialStat.size > publicationAuthorizationMaxBytes
  ) {
    throw new Error(
      "Gate B publication authorization must be a regular nonsymlink file no larger than 32 KiB.",
    );
  }

  const realAuthorizationPath = fs.realpathSync(authorizationPath);
  if (isPathInside(artifactDirectory, realAuthorizationPath)) {
    throw new Error(
      "Gate B publication authorization must be outside the artifact directory.",
    );
  }

  const handle = fs.openSync(
    authorizationPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  let bytes;
  try {
    const openedStat = fs.fstatSync(handle);
    if (
      !openedStat.isFile() ||
      openedStat.size > publicationAuthorizationMaxBytes ||
      openedStat.dev !== initialStat.dev ||
      openedStat.ino !== initialStat.ino
    ) {
      throw new Error(
        "Gate B publication authorization identity changed while opening.",
      );
    }
    bytes = fs.readFileSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  if (bytes.length > publicationAuthorizationMaxBytes) {
    throw new Error(
      "Gate B publication authorization must be no larger than 32 KiB.",
    );
  }

  const publicationSha256 = sha256(bytes);
  if (publicationSha256 !== authorizedPublicationSha256) {
    throw new Error(
      "Gate B authorized publication digest does not match the authorization file.",
    );
  }
  const authorization = parseJsonObject(
    bytes.toString("utf8"),
    "publication authorization",
  );
  const canonicalBytes = Buffer.from(
    canonicalPublicationAuthorization(authorization),
  );
  if (!bytes.equals(canonicalBytes)) {
    throw new Error(
      "Gate B publication authorization must use exact canonical JSON bytes.",
    );
  }
  validateSchema("publication-authorization", authorization);
  return {
    path: realAuthorizationPath,
    bytes,
    publicationSha256,
    authorization,
  };
}

export function publishGateBCandidate(options) {
  requireClosedOptions(options);
  return publishCandidateWithTransport(options, productionTransport);
}

export function publishGateBCandidateForLoopbackTest(options, transport) {
  requireClosedOptions(options);
  requireLoopbackTestTransport(transport);
  return publishCandidateWithTransport(options, transport);
}

async function publishCandidateWithTransport(options, transport) {
  const {
    artifactDir,
    authorizedManifestSha256,
    authorizationFile,
    authorizedPublicationSha256,
    credentialMode,
    expectedOldHead,
    now = Date.now,
    readToken = defaultTokenReader,
    runCommand = defaultCommandRunner,
    removeDirectory = defaultDirectoryRemover,
  } = options;

  requirePublicationInputs({
    authorizedManifestSha256,
    credentialMode,
    expectedOldHead,
  });

  const snapshot = readGateBArtifactSnapshot(artifactDir);
  const bundle = validateGateBArtifactBundle({ snapshot });
  if (snapshot.manifestSha256 !== authorizedManifestSha256) {
    throw new Error(
      "Gate B authorized manifest digest does not match the validated bundle.",
    );
  }

  const authorizationSnapshot = readPublicationAuthorizationSnapshot({
    authorizationFile,
    artifactDir: snapshot.directory,
    authorizedPublicationSha256,
  });
  requirePublicationAuthorization({
    authorization: authorizationSnapshot.authorization,
    authorizedManifestSha256,
    bundle,
    credentialMode,
    expectedOldHead,
    nowMs: currentTime(now),
  });

  const token = requireGateBToken(readToken());
  requireAuthorizedTokenFingerprint(
    token,
    authorizationSnapshot.authorization.credential_token_sha256,
  );

  let context;
  let pushStarted = false;
  let terminalResult;
  let prePushFailure;
  try {
    context = await createAuthenticatedCommandContext({
      removeDirectory,
      runCommand,
      token,
      transport,
    });
    terminalResult = await publishAuthorizedCandidate({
      artifactDir: snapshot.directory,
      authorizedManifestSha256,
      authorizationSnapshot,
      bundle,
      credentialMode,
      expectedOldHead,
      markPushStarted() {
        pushStarted = true;
      },
      now,
      runAuthenticated: context.runAuthenticated,
      runLocal: context.runLocal,
      snapshot,
      transport,
    });
  } catch (error) {
    if (pushStarted) terminalResult = manualReconciliationResult;
    else prePushFailure = error;
  } finally {
    if (context) {
      try {
        context.dispose();
      } catch {
        if (pushStarted) terminalResult = manualReconciliationResult;
        else prePushFailure = new Error("Gate B pre-push cleanup failed.");
      }
    }
  }

  if (terminalResult) return requireTerminalResult(terminalResult);
  throw prePushFailure;
}

async function publishAuthorizedCandidate({
  artifactDir,
  authorizedManifestSha256,
  authorizationSnapshot,
  bundle,
  credentialMode,
  expectedOldHead,
  markPushStarted,
  now,
  runAuthenticated,
  runLocal,
  snapshot,
  transport,
}) {
  const localHead = output(
    await checked(runLocal, "git", ["rev-parse", "HEAD"]),
  );
  requireEqual(localHead, bundle.headSha, "Gate B local head");
  requireEqual(
    bundle.localChangeBaseSha,
    GATE_B_LOCAL_CHANGE_BASE_SHA,
    "Gate B local change base",
  );
  const localBranch = output(
    await checked(runLocal, "git", ["symbolic-ref", "--short", "HEAD"]),
  );
  requireEqual(localBranch, candidateBranch, "Gate B local branch");
  const subjects = lines(
    (
      await checked(runLocal, "git", [
        "log",
        "--reverse",
        "--format=%s",
        `${GATE_B_LOCAL_CHANGE_BASE_SHA}..${localHead}`,
      ])
    ).stdout,
  );
  requireExactList(subjects, GATE_B_COMMIT_SUBJECTS, "Gate B commit subjects");
  await requireQuiet(runLocal, ["diff", "--cached", "--quiet"], "Git index");
  await requireQuiet(runLocal, ["diff", "--quiet"], "tracked worktree");
  const sourceGitDirectory = output(
    await checked(runLocal, "git", ["rev-parse", "--absolute-git-dir"]),
  );

  await runAuthenticated.importCandidate(sourceGitDirectory, localHead);
  await checked(runAuthenticated.git, "git", [
    "merge-base",
    "--is-ancestor",
    expectedOldHead,
    localHead,
  ]);

  const ghVersion = output(
    await checked(runAuthenticated.gh, "gh", ["--version"]),
  );
  if (!/^gh version \d+\.\d+\.\d+/u.test(ghVersion)) {
    throw new Error("Gate B GitHub CLI version output is malformed.");
  }
  await requireCredentialPrincipal(
    runAuthenticated.gh,
    credentialMode,
    authorizationSnapshot.authorization.principal,
  );
  const repositoryIdentity = parseJsonObject(
    (
      await checked(runAuthenticated.gh, "gh", [
        "repo",
        "view",
        GATE_B_REPOSITORY,
        "--json",
        "nameWithOwner",
      ])
    ).stdout,
    "repository",
  );
  requireEqual(
    repositoryIdentity.nameWithOwner,
    GATE_B_REPOSITORY,
    "Gate B repository identity",
  );

  const remoteTargetBase = await readRemoteHead(
    runAuthenticated.git,
    transport,
    GATE_B_TARGET_BASE_REF,
  );
  requireEqual(
    remoteTargetBase,
    GATE_B_EXPECTED_TARGET_BASE_SHA,
    "Gate B expected target base",
  );
  const remoteCandidate = await readRemoteHead(
    runAuthenticated.git,
    transport,
    GATE_B_CANDIDATE_REF,
  );
  requireEqual(
    remoteCandidate,
    expectedOldHead,
    "Gate B expected old candidate head",
  );

  const beforePushPr = parsePullRequest(
    (
      await checked(runAuthenticated.gh, "gh", [
        "pr",
        "view",
        String(GATE_B_PULL_REQUEST),
        "--repo",
        GATE_B_REPOSITORY,
        "--json",
        pullRequestFields,
      ])
    ).stdout,
  );
  requirePullRequest(beforePushPr, expectedOldHead, "pre-push");
  await requireUnprotectedCandidateBranch(runAuthenticated.gh, expectedOldHead);
  const rules = parseJson(
    (
      await checked(runAuthenticated.gh, "gh", [
        "api",
        `repos/${GATE_B_REPOSITORY}/rules/branches/${candidateBranch}`,
      ])
    ).stdout,
    "candidate rules",
  );
  if (!Array.isArray(rules) || rules.length !== 0) {
    throw new Error("Gate B candidate branch must have no applicable rules.");
  }

  requireUnchangedPublicationInputs({
    artifactDir,
    authorizationSnapshot,
    authorizedManifestSha256,
    bundle,
    credentialMode,
    expectedOldHead,
    now,
    snapshot,
  });

  markPushStarted();
  let pushResult;
  try {
    pushResult = await runAuthenticated.git(
      "git",
      [
        "push",
        "--no-verify",
        "--porcelain",
        `--force-with-lease=${GATE_B_CANDIDATE_REF}:${expectedOldHead}`,
        transport.url,
        `HEAD:${GATE_B_CANDIDATE_REF}`,
      ],
      { timeoutMs: 300_000 },
    );
  } catch {
    return manualReconciliationResult;
  }
  if (!pushResult || pushResult.exitCode !== 0) {
    return manualReconciliationResult;
  }

  try {
    requireFastForwardPorcelain(
      pushResult.stdout,
      expectedOldHead,
      localHead,
      transport.url,
    );
    const postPushTargetBase = await readRemoteHead(
      runAuthenticated.git,
      transport,
      GATE_B_TARGET_BASE_REF,
    );
    const postPushCandidate = await readRemoteHead(
      runAuthenticated.git,
      transport,
      GATE_B_CANDIDATE_REF,
    );
    const afterPushPr = parsePullRequest(
      (
        await checked(runAuthenticated.gh, "gh", [
          "pr",
          "view",
          String(GATE_B_PULL_REQUEST),
          "--repo",
          GATE_B_REPOSITORY,
          "--json",
          pullRequestFields,
        ])
      ).stdout,
    );
    requireEqual(
      postPushTargetBase,
      GATE_B_EXPECTED_TARGET_BASE_SHA,
      "Gate B post-push target base",
    );
    requireEqual(postPushCandidate, localHead, "Gate B post-push candidate");
    requirePullRequest(afterPushPr, localHead, "post-push");
  } catch {
    return manualReconciliationResult;
  }

  return publishedResult;
}

function requirePublicationInputs({
  authorizedManifestSha256,
  credentialMode,
  expectedOldHead,
}) {
  if (!sha256Pattern.test(authorizedManifestSha256)) {
    throw new Error(
      "Gate B authorized manifest digest must be a SHA-256 digest.",
    );
  }
  if (!gitSha.test(expectedOldHead)) {
    throw new Error(
      "Gate B expected old candidate head must be a full Git SHA.",
    );
  }
  requireEqual(
    expectedOldHead,
    GATE_B_EXPECTED_OLD_CANDIDATE_SHA,
    "Gate B expected old candidate head",
  );
  if (!new Set(["automated-app", "attended-user"]).has(credentialMode)) {
    throw new Error(
      "Gate B publication authorization requires one explicit credential mode.",
    );
  }
}

function requirePublicationAuthorization({
  authorization,
  authorizedManifestSha256,
  bundle,
  credentialMode,
  expectedOldHead,
  nowMs,
}) {
  const expected = {
    artifact_manifest_sha256: authorizedManifestSha256,
    policy_sha256: GATE_B_POLICY_SHA256,
    credential_mode: credentialMode,
    local_change_base_sha: bundle.localChangeBaseSha,
    planning_head_sha: bundle.planningHeadSha,
    candidate_head_sha: bundle.headSha,
    expected_old_candidate_sha: expectedOldHead,
    candidate_ref: GATE_B_CANDIDATE_REF,
    target_base_ref: GATE_B_TARGET_BASE_REF,
    expected_target_base_sha: GATE_B_EXPECTED_TARGET_BASE_SHA,
    repository: GATE_B_REPOSITORY,
    pull_request: GATE_B_PULL_REQUEST,
    pr_state: "OPEN",
    pr_base_ref_name: targetBaseBranch,
    pr_base_ref_oid: GATE_B_EXPECTED_TARGET_BASE_SHA,
    pr_head_ref_name: candidateBranch,
    pr_head_ref_oid: expectedOldHead,
    same_repository: true,
  };
  for (const [name, value] of Object.entries(expected)) {
    requireEqual(
      authorization[name],
      value,
      `Gate B publication authorization ${name}`,
    );
  }

  const issuedAt = Date.parse(authorization.issued_at);
  const expiresAt = Date.parse(authorization.expires_at);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > nowMs ||
    expiresAt <= nowMs ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > publicationGrantLifetimeMs
  ) {
    throw new Error(
      "Gate B publication authorization grant must be current and no longer than 15 minutes.",
    );
  }
}

function requireAuthorizedTokenFingerprint(token, authorizedDigest) {
  const actual = createHash("sha256").update(token).digest();
  const expected = Buffer.from(authorizedDigest, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Gate B publication credential is not authorized.");
  }
}

function requireGateBToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 4096 ||
    /[^\x21-\x7e]/u.test(value)
  ) {
    throw new Error(
      "Gate B requires one high-entropy CLOUDX_GATE_B_TOKEN value.",
    );
  }
  return value;
}

async function createAuthenticatedCommandContext({
  removeDirectory,
  runCommand,
  token,
  transport,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-gate-b-"));
  let disposed = false;
  const dispose = () => {
    if (disposed) throw new Error("Gate B command context disposed twice.");
    disposed = true;
    removeDirectory(root);
  };

  try {
    fs.chmodSync(root, 0o700);
    const templateDirectory = path.join(root, "empty-template");
    const transportGitDirectory = path.join(root, "transport.git");
    const ghConfigDirectory = path.join(root, "gh-config");
    fs.mkdirSync(templateDirectory, { mode: 0o700 });
    fs.mkdirSync(transportGitDirectory, { mode: 0o700 });
    fs.mkdirSync(ghConfigDirectory, { mode: 0o700 });
    requirePrivateEmptyDirectory(templateDirectory, "template");
    requirePrivateEmptyDirectory(transportGitDirectory, "bare transport");

    const baseEnvironment = commandEnvironment(root);
    const localGitEnvironment = {
      ...baseEnvironment,
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: "/bin/false",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_TEMPLATE_DIR: templateDirectory,
      SSH_ASKPASS: "/bin/false",
    };
    const authenticatedGitEnvironment = {
      ...localGitEnvironment,
      GH_TOKEN: token,
    };
    const ghEnvironment = {
      ...baseEnvironment,
      GH_CONFIG_DIR: ghConfigDirectory,
      GH_HOST: "github.com",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_PROMPT_DISABLED: "1",
      GH_REPO: GATE_B_REPOSITORY,
      GH_TOKEN: token,
    };
    const sourceEnvironment = { ...localGitEnvironment };
    delete sourceEnvironment.GIT_TEMPLATE_DIR;

    await checked(
      (command, args, options = {}) =>
        runCommand(command, args, {
          ...options,
          cwd: root,
          env: localGitEnvironment,
        }),
      "git",
      [
        "init",
        "--bare",
        `--template=${templateDirectory}`,
        transportGitDirectory,
      ],
    );
    fs.chmodSync(transportGitDirectory, 0o700);
    requirePrivateEmptyDirectory(templateDirectory, "template");
    requirePrivateDirectory(transportGitDirectory, "bare transport");

    const localGit = (command, args, options = {}) =>
      runCommand(command, args, {
        ...options,
        cwd: process.cwd(),
        env: sourceEnvironment,
      });
    const bareGit = (command, args, options = {}) =>
      runCommand(
        command,
        command === "git"
          ? [`--git-dir=${transportGitDirectory}`, ...args]
          : args,
        {
          ...options,
          cwd: root,
          env: localGitEnvironment,
        },
      );
    const authenticatedGit = (command, args, options = {}) =>
      runCommand(
        command,
        command === "git"
          ? [
              `--git-dir=${transportGitDirectory}`,
              ...gitCredentialArguments(transport),
              ...args,
            ]
          : args,
        {
          ...options,
          cwd: root,
          env: authenticatedGitEnvironment,
        },
      );
    const gh = (command, args, options = {}) =>
      runCommand(command, args, {
        ...options,
        cwd: root,
        env: ghEnvironment,
      });

    await auditBareGitConfiguration(bareGit, transportGitDirectory);
    return {
      runLocal: localGit,
      runAuthenticated: {
        git: authenticatedGit,
        gh,
        async importCandidate(sourceGitDirectory, localHead) {
          await checked(bareGit, "git", [
            "fetch",
            "--no-tags",
            sourceGitDirectory,
            `${localHead}:${GATE_B_CANDIDATE_REF}`,
          ]);
          await checked(bareGit, "git", [
            "symbolic-ref",
            "HEAD",
            GATE_B_CANDIDATE_REF,
          ]);
          const imported = output(
            await checked(bareGit, "git", ["rev-parse", GATE_B_CANDIDATE_REF]),
          );
          requireEqual(imported, localHead, "Gate B imported candidate");
          await auditBareGitConfiguration(bareGit, transportGitDirectory);
        },
      },
      dispose,
    };
  } catch (error) {
    try {
      dispose();
    } catch {
      throw new Error("Gate B isolated context creation and cleanup failed.");
    }
    throw error;
  }
}

async function auditBareGitConfiguration(runGit, gitDirectory) {
  const config = (
    await checked(runGit, "git", ["config", "--local", "--null", "--list"])
  ).stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.split("\n"));
  if (
    config.length !== 3 ||
    config[0]?.[0] !== "core.repositoryformatversion" ||
    config[0]?.[1] !== "0" ||
    config[1]?.[0] !== "core.filemode" ||
    !new Set(["true", "false"]).has(config[1]?.[1]) ||
    config[2]?.[0] !== "core.bare" ||
    config[2]?.[1] !== "true"
  ) {
    throw new Error("Gate B isolated bare Git config must have three keys.");
  }
  const hooks = path.join(gitDirectory, "hooks");
  if (fs.existsSync(hooks) && fs.readdirSync(hooks).length !== 0) {
    throw new Error("Gate B isolated bare Git repository must have no hooks.");
  }
}

function commandEnvironment(root) {
  return {
    HOME: root,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    XDG_CONFIG_HOME: path.join(root, "config"),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

function gitCredentialArguments(transport) {
  const hostUrl = `${transport.protocol}://${transport.credentialScope.host}`;
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.${hostUrl}.helper=`,
    "-c",
    `credential.${transport.url}.helper=`,
    "-c",
    `credential.${transport.url}.helper=${oneShotGitCredentialHelper(transport)}`,
    "-c",
    "credential.useHttpPath=true",
    "-c",
    "credential.interactive=false",
    "-c",
    "http.extraHeader=",
    "-c",
    `http.${hostUrl}.extraHeader=`,
    "-c",
    `http.${transport.url}.extraHeader=`,
    "-c",
    "core.askPass=/bin/false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "push.pushOption=",
    "-c",
    "push.gpgSign=false",
  ];
}

function oneShotGitCredentialHelper(transport) {
  const { protocol } = transport;
  const { host, path: credentialPath } = transport.credentialScope;
  return `!f() { test "$1" = get || exit 0; protocol=; host=; path=; while IFS='=' read -r key value; do case "$key" in protocol) protocol=$value ;; host) host=$value ;; path) path=$value ;; esac; done; test "$protocol" = ${shellWord(protocol)} && test "$host" = ${shellWord(host)} && { test "$path" = ${shellWord(credentialPath)} || test "$path" = ${shellWord(`${credentialPath}.git`)}; } || { printf 'quit=true\\n'; exit 0; }; printf 'username=x-access-token\\npassword=%s\\nquit=true\\n' "$GH_TOKEN"; }; f`;
}

function shellWord(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function requireLoopbackTestTransport(transport) {
  requireFrozenClosedObject(
    transport,
    ["credentialScope", "protocol", "url"],
    "transport",
  );
  requireFrozenClosedObject(
    transport.credentialScope,
    ["host", "path"],
    "credential scope",
  );
  if (transport.protocol !== "http") {
    throw new Error("Gate B loopback test transport protocol must be http.");
  }
  let url;
  try {
    url = new URL(transport.url);
  } catch {
    throw new Error("Gate B loopback test transport URL is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/cloudx.git" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    transport.credentialScope.host !== `127.0.0.1:${url.port}` ||
    transport.credentialScope.path !== "cloudx.git"
  ) {
    throw new Error(
      "Gate B loopback test transport must be exact and coherent.",
    );
  }
}

function requireFrozenClosedObject(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.isFrozen(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
  ) {
    throw new Error(`Gate B ${label} must be a frozen closed object.`);
  }
}

function requireClosedOptions(options) {
  const allowed = [
    "artifactDir",
    "authorizationFile",
    "authorizedManifestSha256",
    "authorizedPublicationSha256",
    "credentialMode",
    "expectedOldHead",
    "now",
    "readToken",
    "removeDirectory",
    "runCommand",
  ];
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowed.includes(key))
  ) {
    throw new Error("Gate B publisher options must use the closed contract.");
  }
}

function requireUnchangedPublicationInputs({
  artifactDir,
  authorizationSnapshot,
  authorizedManifestSha256,
  bundle,
  credentialMode,
  expectedOldHead,
  now,
  snapshot,
}) {
  const freshSnapshot = readGateBArtifactSnapshot(snapshot.directory);
  if (
    freshSnapshot.manifestSha256 !== snapshot.manifestSha256 ||
    freshSnapshot.manifest !== snapshot.manifest ||
    freshSnapshot.manifestSha256 !== authorizedManifestSha256
  ) {
    throw new Error("Gate B artifact bundle changed before publication.");
  }
  const freshAuthorization = readPublicationAuthorizationSnapshot({
    authorizationFile: authorizationSnapshot.path,
    artifactDir,
    authorizedPublicationSha256: authorizationSnapshot.publicationSha256,
  });
  if (
    freshAuthorization.path !== authorizationSnapshot.path ||
    !freshAuthorization.bytes.equals(authorizationSnapshot.bytes)
  ) {
    throw new Error(
      "Gate B publication authorization changed before publication.",
    );
  }
  requirePublicationAuthorization({
    authorization: freshAuthorization.authorization,
    authorizedManifestSha256,
    bundle,
    credentialMode,
    expectedOldHead,
    nowMs: currentTime(now),
  });
}

async function requireCredentialPrincipal(
  runCommand,
  credentialMode,
  principal,
) {
  if (credentialMode === "automated-app") {
    const installation = parseJsonObject(
      (
        await checked(runCommand, "gh", [
          "api",
          "--method",
          "GET",
          "/installation/repositories",
        ])
      ).stdout,
      "installation repositories",
    );
    if (
      installation.total_count !== 1 ||
      !Array.isArray(installation.repositories) ||
      installation.repositories.length !== 1
    ) {
      throw new Error(
        "Gate B automated-app token must access exactly one repository.",
      );
    }
    requireEqual(
      installation.repositories[0]?.full_name,
      GATE_B_REPOSITORY,
      "Gate B automated-app repository",
    );
    requireEqual(
      principal.kind,
      "github-app-installation",
      "Gate B automated-app principal",
    );
    return;
  }

  const user = parseJsonObject(
    (await checked(runCommand, "gh", ["api", "--method", "GET", "/user"]))
      .stdout,
    "attended user",
  );
  requireEqual(user.id, principal.user_id, "Gate B attended user ID");
  requireEqual(user.login, principal.login, "Gate B attended user login");
}

async function readRemoteHead(runCommand, transport, ref) {
  return parseRemoteHead(
    (await checked(runCommand, "git", ["ls-remote", transport.url, ref]))
      .stdout,
    ref,
  );
}

async function requireQuiet(runCommand, args, label) {
  const result = requireCommandResult(
    await runCommand("git", args, { allowFailure: true }),
    `git ${args.join(" ")}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Gate B ${label} must be clean.`);
  }
}

async function requireUnprotectedCandidateBranch(runCommand, expectedHead) {
  const branch = parseJsonObject(
    (
      await checked(runCommand, "gh", [
        "api",
        "--method",
        "GET",
        `repos/${GATE_B_REPOSITORY}/branches/${candidateBranch}`,
      ])
    ).stdout,
    "candidate branch",
  );
  requireEqual(branch.name, candidateBranch, "Gate B candidate branch name");
  requireEqual(branch.commit?.sha, expectedHead, "Gate B candidate branch OID");
  requireEqual(
    branch.protected,
    false,
    "Gate B candidate branch protected state",
  );
}

async function checked(runCommand, command, args, options = {}) {
  const result = requireCommandResult(
    await runCommand(command, args, options),
    `${command} ${args.join(" ")}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Gate B command failed: ${command}.`);
  }
  return result;
}

function requireCommandResult(result, command) {
  if (
    !result ||
    !Number.isInteger(result.exitCode) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw new Error(`Gate B command result is malformed: ${command}`);
  }
  return result;
}

function parsePullRequest(stdout) {
  return parseJsonObject(stdout, "pull-request readback");
}

function requirePullRequest(value, expectedHead, phase) {
  requireEqual(value.number, GATE_B_PULL_REQUEST, `Gate B ${phase} PR number`);
  requireEqual(value.state, "OPEN", `Gate B ${phase} PR state`);
  requireEqual(
    value.baseRefName,
    targetBaseBranch,
    `Gate B ${phase} PR base name`,
  );
  requireEqual(
    value.baseRefOid,
    GATE_B_EXPECTED_TARGET_BASE_SHA,
    `Gate B ${phase} PR base OID`,
  );
  requireEqual(
    value.headRefName,
    candidateBranch,
    `Gate B ${phase} PR head name`,
  );
  requireEqual(value.headRefOid, expectedHead, `Gate B ${phase} PR head OID`);
  requireEqual(
    value.isCrossRepository,
    false,
    `Gate B ${phase} same-repository identity`,
  );
  requireEqual(
    value.url,
    `https://github.com/${GATE_B_REPOSITORY}/pull/${GATE_B_PULL_REQUEST}`,
    `Gate B ${phase} PR repository URL`,
  );
}

function parseRemoteHead(stdout, expectedRef) {
  const entries = lines(stdout);
  if (entries.length !== 1) {
    throw new Error(`Gate B ${expectedRef} must resolve exactly once.`);
  }
  const [head, ref, ...extra] = entries[0].split(/\s+/u);
  if (!gitSha.test(head) || ref !== expectedRef || extra.length) {
    throw new Error(`Gate B ${expectedRef} remote ref is malformed.`);
  }
  return head;
}

function requireFastForwardPorcelain(
  stdout,
  expectedOldHead,
  expectedNewHead,
  transportUrl,
) {
  const entries = lines(stdout);
  if (
    entries.length !== 3 ||
    entries[0] !== `To ${transportUrl}` ||
    entries[2] !== "Done"
  ) {
    throw new Error("Gate B push must report exactly one porcelain update.");
  }
  const match =
    /^ \tHEAD:refs\/heads\/architecture-and-new-codex\t([a-f0-9]{7,40})\.\.([a-f0-9]{7,40})$/u.exec(
      entries[1],
    );
  if (
    !match ||
    !expectedOldHead.startsWith(match[1]) ||
    !expectedNewHead.startsWith(match[2])
  ) {
    throw new Error(
      "Gate B push porcelain must be one exact non-force fast-forward update.",
    );
  }
}

function requireTerminalResult(result) {
  const expected =
    result?.outcome === "published"
      ? publishedResult
      : result?.outcome === "manual-reconciliation-required"
        ? manualReconciliationResult
        : undefined;
  if (!expected || JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new Error("Gate B terminal result must match the closed contract.");
  }
  return { ...expected };
}

function requirePrivateDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error(`Gate B ${label} directory must be private.`);
  }
}

function requirePrivateEmptyDirectory(directory, label) {
  requirePrivateDirectory(directory, label);
  if (fs.readdirSync(directory).length !== 0) {
    throw new Error(`Gate B ${label} directory must be empty.`);
  }
}

function defaultDirectoryRemover(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function defaultTokenReader() {
  return process.env.CLOUDX_GATE_B_TOKEN;
}

function currentTime(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Gate B publication clock must return a finite time.");
  }
  return milliseconds;
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObjectKeys(value[key])]),
  );
}

function isPathInside(directory, filePath) {
  const relative = path.relative(directory, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Gate B ${label} must be valid JSON.`, { cause: error });
  }
}

function parseJsonObject(value, label) {
  const parsed = parseJson(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Gate B ${label} must be an object.`);
  }
  return parsed;
}

function artifactManifest(files) {
  return `${Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bytes]) => `${name}:${sha256(bytes)}`)
    .join("\n")}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function output(result) {
  return result.stdout.trim();
}

function lines(value) {
  return value.split(/\r?\n/u).filter(Boolean);
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} must equal ${String(expected)}.`);
  }
}

function requireExactList(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must match exactly.`);
  }
}

function defaultCommandRunner(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env,
        maxBuffer: 2 * 1024 * 1024,
        timeout: options.timeoutMs ?? 60_000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode:
            typeof error?.code === "number" ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}

function parseCliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Gate B publisher arguments must be --name value pairs.");
    }
    const name = key.slice(2);
    if (Object.hasOwn(values, name)) {
      throw new Error(`Gate B publisher received duplicate --${name}.`);
    }
    values[name] = value;
  }
  const allowed = new Set([
    "artifact-dir",
    "authorized-manifest-sha256",
    "authorization-file",
    "authorized-publication-sha256",
    "credential-mode",
    "expected-old-head",
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key))) {
    throw new Error("Gate B publisher received an unsupported argument.");
  }
  for (const key of allowed) {
    if (!values[key]) throw new Error(`Gate B publisher requires --${key}.`);
  }
  return values;
}

async function runMain(argv) {
  try {
    const args = parseCliArguments(argv);
    const result = await publishGateBCandidate({
      artifactDir: args["artifact-dir"],
      authorizedManifestSha256: args["authorized-manifest-sha256"],
      authorizationFile: args["authorization-file"],
      authorizedPublicationSha256: args["authorized-publication-sha256"],
      credentialMode: args["credential-mode"],
      expectedOldHead: args["expected-old-head"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.outcome === "manual-reconciliation-required") {
      process.exitCode = 2;
    }
  } catch {
    process.stderr.write(prePushDiagnostic.slice(0, 1024));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) void runMain(process.argv.slice(2));
