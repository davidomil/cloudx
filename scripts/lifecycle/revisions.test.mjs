import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  oldestSupportedRevision,
  selectLifecycleRevisions,
  verifyLifecycleHistory,
} from "./revisions.mjs";

const source = "a".repeat(40);
const head = "b".repeat(40);
const target = "c".repeat(40);
const pullRequest = {
  pull_request: { base: { ref: "main", sha: source }, head: { sha: head } },
};
const push = { ref: "refs/heads/main", before: source, after: target };
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("one immutable lifecycle revision pair", () => {
  it("uses the event base and exact tested merge for pull requests", () => {
    expect(
      selectLifecycleRevisions("pull_request", pullRequest, target),
    ).toEqual({
      event: "pull_request",
      baseline: oldestSupportedRevision,
      source,
      target,
      pullRequestHead: head,
    });
  });

  it("uses the previous main tip and pushed candidate for pushes", () => {
    expect(selectLifecycleRevisions("push", push, target)).toEqual({
      event: "push",
      baseline: oldestSupportedRevision,
      source,
      target,
    });
  });

  it.each([
    ["moving candidate", "push", push, "main", /full nonzero commit SHA/],
    [
      "missing previous tip",
      "push",
      { ...push, before: undefined },
      target,
      /previous main tip/,
    ],
    [
      "new branch",
      "push",
      { ...push, before: "0".repeat(40) },
      target,
      /previous main tip/,
    ],
    [
      "same revisions",
      "push",
      { ...push, before: target },
      target,
      /must differ/,
    ],
    ["different pushed target", "push", push, head, /does not match/],
    [
      "non-main push",
      "push",
      { ...push, ref: "refs/heads/topic" },
      target,
      /target main/,
    ],
    [
      "non-main pull request",
      "pull_request",
      {
        pull_request: {
          ...pullRequest.pull_request,
          base: { ref: "topic", sha: source },
        },
      },
      target,
      /target main/,
    ],
    [
      "missing pull request head",
      "pull_request",
      { pull_request: { base: pullRequest.pull_request.base } },
      target,
      /pull request head/,
    ],
    ["unsupported event", "release", {}, target, /Unsupported lifecycle event/],
  ])(
    "rejects %s rather than choosing another revision",
    (_name, eventName, event, candidate, error) => {
      expect(() =>
        selectLifecycleRevisions(eventName, event, candidate),
      ).toThrow(error);
    },
  );

  it("requires a supported source and the merge's exact ordered parents", () => {
    const fixture = history();
    expect(
      verifyLifecycleHistory(fixture.revisions, fixture.directory),
    ).toEqual(fixture.revisions);
    expect(() =>
      verifyLifecycleHistory(
        { ...fixture.revisions, pullRequestHead: fixture.revisions.source },
        fixture.directory,
      ),
    ).toThrow(/parents/);
    expect(() =>
      verifyLifecycleHistory(
        { ...fixture.revisions, baseline: fixture.revisions.target },
        fixture.directory,
      ),
    ).toThrow(/supported baseline/);
    expect(() =>
      verifyLifecycleHistory(
        { ...fixture.revisions, target: fixture.diverged },
        fixture.directory,
      ),
    ).toThrow(/descend/);
    expect(() =>
      verifyLifecycleHistory(
        { ...fixture.revisions, target: fixture.revisions.source },
        fixture.directory,
      ),
    ).toThrow(/must differ/);
    expect(() =>
      verifyLifecycleHistory(
        { ...fixture.revisions, source: source },
        fixture.directory,
      ),
    ).toThrow();
    expect(() =>
      verifyLifecycleHistory(
        { ...fixture.revisions, target: fixture.tree },
        fixture.directory,
      ),
    ).toThrow(/must identify a commit/);
  });

  it("writes failure evidence and emits no job output for an unsupported source", () => {
    const fixture = history();
    const eventPath = path.join(fixture.directory, "event.json");
    const outputPath = path.join(fixture.directory, "output");
    const evidence = path.join(fixture.directory, "evidence/revisions.json");
    fs.writeFileSync(
      eventPath,
      JSON.stringify({
        ref: "refs/heads/main",
        before: fixture.revisions.source,
        after: fixture.revisions.target,
      }),
    );
    fs.writeFileSync(outputPath, "");
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/lifecycle/revisions.mjs"), "--evidence", evidence],
      {
        cwd: fixture.directory,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_SHA: fixture.revisions.target,
          GITHUB_OUTPUT: outputPath,
        },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(evidence, "utf8"))).toMatchObject({
      result: "failed",
      source: fixture.revisions.source,
      target: fixture.revisions.target,
    });
    expect(fs.readFileSync(outputPath, "utf8")).toBe("");
  });
});

function history() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx-lifecycle-revisions-"),
  );
  directories.push(directory);
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Lifecycle test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Lifecycle test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
  git("init", "--quiet");
  const tree = git("mktree");
  const commit = (message, ...parents) =>
    git(
      "commit-tree",
      tree,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      message,
    );
  const baseline = commit("baseline");
  const source = commit("previous main", baseline);
  const head = commit("candidate head", baseline);
  const target = commit("merge candidate", source, head);
  return {
    directory,
    tree,
    diverged: commit("diverged history"),
    revisions: {
      event: "pull_request",
      baseline,
      source,
      target,
      pullRequestHead: head,
    },
  };
}
