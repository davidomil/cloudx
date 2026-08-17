import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateSchema } from "./schema-validator.mjs";

const classifierPath = fileURLToPath(
  new URL("./classify.mjs", import.meta.url),
);
const gitSha = (character) => character.repeat(40);

describe("AI change classifier CLI", () => {
  it("derives trusted routing from every add, modify, delete, and rename endpoint", () => {
    const root = temporaryDirectory();
    const inputPath = writeJson(root, "change.json", {
      schema_version: 1,
      kind: "change-classification-input",
      base_sha: gitSha("a"),
      head_sha: gitSha("b"),
      type: "chore",
      risk: "low",
      labels: ["trusted-auto-merge", "risk:low"],
      changes: [
        { status: "modified", path: "apps/server/src/server.ts" },
        {
          status: "renamed",
          previous_path: ".github/workflows/old.yml",
          path: "docs/workflows/old.yml",
        },
        { status: "deleted", path: "README.md" },
        { status: "added", path: ".\\apps\\web\\src\\NewPanel.tsx" },
      ],
    });

    const result = runClassifier(["--input", inputPath]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const classification = JSON.parse(result.stdout);
    expect(validateSchema("classification", classification)).toBe(
      classification,
    );
    expect(classification).toMatchObject({
      base_sha: gitSha("a"),
      head_sha: gitSha("b"),
      type: "chore",
      risk: "human-required",
      human_review_required: true,
      automerge_eligible: false,
    });
    expect(classification.paths).toEqual([
      ".github/workflows/old.yml",
      "README.md",
      "apps/server/src/server.ts",
      "apps/web/src/NewPanel.tsx",
      "docs/workflows/old.yml",
    ]);
    expect(classification.changes).toEqual([
      { status: "deleted", path: "README.md" },
      { status: "modified", path: "apps/server/src/server.ts" },
      { status: "added", path: "apps/web/src/NewPanel.tsx" },
      {
        status: "renamed",
        path: "docs/workflows/old.yml",
        previous_path: ".github/workflows/old.yml",
      },
    ]);
    expect(classification.labels).not.toContain("trusted-auto-merge");
    expect(classification.labels).toContain("risk:human-required");
  });

  it("emits byte-for-byte deterministic JSON for equivalent caller input", () => {
    const root = temporaryDirectory();
    const common = {
      schema_version: 1,
      kind: "change-classification-input",
      base_sha: gitSha("a"),
      head_sha: gitSha("b"),
      type: "feature",
    };
    const first = writeJson(root, "first.json", {
      ...common,
      risk: "low",
      labels: ["risk:low"],
      changes: [
        { status: "modified", path: "apps/web/src/api.ts" },
        { status: "modified", path: "apps/server/src/server.ts" },
      ],
    });
    const second = writeJson(root, "second.json", {
      ...common,
      risk: "human-required",
      labels: ["manual review"],
      changes: [
        { status: "modified", path: "./apps/server/src/server.ts" },
        { status: "modified", path: "apps/web/src/api.ts" },
      ],
    });

    expect(runClassifier(["--input", first]).stdout).toBe(
      runClassifier(["--input", second]).stdout,
    );
  });

  it("reads git name-status records and preserves both sides of a rename", () => {
    const root = temporaryGitRepository();
    fs.writeFileSync(path.join(root, "README.md"), "before\n");
    fs.writeFileSync(path.join(root, "renamed.txt"), "same content\n");
    fs.writeFileSync(path.join(root, "deleted.txt"), "remove me\n");
    commitAll(root, "base");
    const base = git(root, "rev-parse", "HEAD").trim();

    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    git(root, "mv", "renamed.txt", ".github/workflows/renamed.yml");
    fs.rmSync(path.join(root, "deleted.txt"));
    fs.appendFileSync(path.join(root, "README.md"), "after\n");
    fs.mkdirSync(path.join(root, "apps", "web", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "apps", "web", "src", "Added.ts"),
      "export {};\n",
    );
    commitAll(root, "head");
    const head = git(root, "rev-parse", "HEAD").trim();

    const result = runClassifier(
      ["--base", base, "--head", head, "--type", "chore"],
      root,
    );

    expect(result.status).toBe(0);
    const classification = JSON.parse(result.stdout);
    expect(classification.changes).toEqual(
      expect.arrayContaining([
        { status: "added", path: "apps/web/src/Added.ts" },
        { status: "modified", path: "README.md" },
        { status: "deleted", path: "deleted.txt" },
        {
          status: "renamed",
          path: ".github/workflows/renamed.yml",
          previous_path: "renamed.txt",
        },
      ]),
    );
    expect(classification.paths).toEqual(
      expect.arrayContaining(["renamed.txt", ".github/workflows/renamed.yml"]),
    );
    expect(classification.risk).toBe("human-required");
  });

  it("fails closed for malformed input, unsafe paths, and ambiguous modes", () => {
    const root = temporaryDirectory();
    const validInput = writeJson(root, "valid.json", {
      schema_version: 1,
      kind: "change-classification-input",
      base_sha: gitSha("a"),
      head_sha: gitSha("b"),
      type: "docs",
      changes: [{ status: "modified", path: "README.md" }],
    });
    const unsafeInput = writeJson(root, "unsafe.json", {
      schema_version: 1,
      kind: "change-classification-input",
      base_sha: gitSha("a"),
      head_sha: gitSha("b"),
      type: "docs",
      changes: [{ status: "modified", path: "../outside.md" }],
    });

    expect(runClassifier(["--input", unsafeInput])).toMatchObject({
      status: 1,
      stdout: "",
    });
    expect(runClassifier(["--input", unsafeInput]).stderr).toMatch(
      /repository-relative/i,
    );
    expect(
      runClassifier(["--input", unsafeInput, "--base", "main"]),
    ).toMatchObject({ status: 1, stdout: "" });
    expect(
      runClassifier(["--input", validInput, "--input", validInput]),
    ).toMatchObject({ status: 1, stdout: "" });
    expect(
      runClassifier(["--input", validInput, "--input", validInput]).stderr,
    ).toMatch(/only once/i);
    expect(runClassifier(["--base", "main", "--head", "HEAD"])).toMatchObject({
      status: 1,
      stdout: "",
    });
    expect(
      runClassifier(["--input", path.join(root, "missing.json")]),
    ).toMatchObject({ status: 1, stdout: "" });
  });
});

function runClassifier(args, cwd) {
  return spawnSync(process.execPath, [classifierPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-classifier-"));
}

function temporaryGitRepository() {
  const root = temporaryDirectory();
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "classifier@example.invalid");
  git(root, "config", "user.name", "Classifier Test");
  return root;
}

function commitAll(root, message) {
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", message);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function writeJson(root, name, value) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}
