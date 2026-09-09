import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HookRegistry } from "../hooks/HookRegistry.js";
import { RulesSkillsPlugin } from "../plugins/RulesSkillsPlugin.js";
import { RulesSkillsCatalogService } from "./RulesSkillsCatalogService.js";
import { RulesSkillsGitService } from "./RulesSkillsGitService.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Rules & Skills Git checkout", () => {
  it("reports a catalog outside Git and never initializes it when setting origin", async () => {
    const { catalog, call } = await catalogFixture();

    await expect(call("status")).resolves.toMatchObject({
      git: { isRepository: false, rootPath: catalog.catalogRoot(), hasChanges: false, hasCommits: false }
    });
    await expect(call("setOrigin", { originUrl: "/unused/local-remote.git" })).rejects.toThrow(/repository|checkout/i);
    await expect(fs.stat(path.join(catalog.catalogRoot(), ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads an origin configured in Git and adds or updates it through the plugin", async () => {
    const fixture = await repositoryFixture();
    const firstOrigin = path.join(fixture.root, "first.git");
    const secondOrigin = path.join(fixture.root, "second.git");

    await expect(fixture.call("setOrigin", { originUrl: firstOrigin })).resolves.toMatchObject({
      git: { originUrl: firstOrigin, branch: "main", hasCommits: true }
    });
    await expect(git(fixture.checkout, "remote", "get-url", "origin")).resolves.toBe(firstOrigin);
    await expect(fixture.call("setOrigin", { originUrl: secondOrigin })).resolves.toMatchObject({ git: { originUrl: secondOrigin } });
    await expect(git(fixture.checkout, "remote", "get-url", "origin")).resolves.toBe(secondOrigin);

    await git(fixture.checkout, "remote", "set-url", "origin", firstOrigin);
    await expect(fixture.call("status")).resolves.toMatchObject({ git: { originUrl: firstOrigin } });
  });

  it("pushes and pulls a local origin whose path contains spaces", async () => {
    const { catalog, checkout, root, call } = await repositoryFixture();
    const origin = path.join(root, "shared rules.git");
    const peer = path.join(root, "peer checkout");
    await git(root, "init", "--bare", "--initial-branch=main", origin);
    await expect(call("setOrigin", { originUrl: origin })).resolves.toMatchObject({ git: { originUrl: origin } });

    await catalog.pushGit();
    await expect(git(origin, "rev-parse", "refs/heads/main")).resolves.toBe(await git(checkout, "rev-parse", "HEAD"));
    await git(root, "clone", origin, peer);
    await fs.writeFile(path.join(peer, "rules", "shared-rule.md"), "Review the shared catalog.\n");
    await commit(peer, "Add shared rule");
    await git(peer, "push", "origin", "main");

    await expect(catalog.pullGit()).resolves.toMatchObject({
      git: { originUrl: origin, hasChanges: false },
      store: { rules: expect.arrayContaining([expect.objectContaining({ id: "shared-rule" })]) }
    });
  });

  it.each(["push URL", "multiple push URLs", "multiple fetch URLs", "push-only URL rewrite"])(
    "saves a single fetch and push destination despite an existing %s", async configuration => {
      const { catalog, checkout, origin, root, call } = await synchronizedFixture();
      const replacement = path.join(root, "replacement.git");
      const otherOrigin = path.join(root, "other-old.git");
      await git(root, "init", "--bare", "--initial-branch=main", replacement);
      await git(root, "init", "--bare", "--initial-branch=main", otherOrigin);
      const oldHead = await git(origin, "rev-parse", "refs/heads/main");
      if (configuration === "multiple fetch URLs") {
        await git(checkout, "remote", "set-url", "--add", "origin", otherOrigin);
      } else if (configuration === "push-only URL rewrite") {
        await git(checkout, "config", `url.${origin}.pushInsteadOf`, replacement);
      } else {
        await git(checkout, "config", "remote.origin.pushurl", origin);
        if (configuration === "multiple push URLs") {
          await git(checkout, "config", "--add", "remote.origin.pushurl", otherOrigin);
        }
      }
      await catalog.saveRule(rule("selected-origin", "Publish only to the selected repository."));
      await commit(checkout, "Add selected origin rule");
      const head = await git(checkout, "rev-parse", "HEAD");

      await expect(call("setOrigin", { originUrl: replacement })).resolves.toMatchObject({ git: { originUrl: replacement } });
      await call("push");

      await expect(git(replacement, "rev-parse", "refs/heads/main")).resolves.toBe(head);
      await expect(git(origin, "rev-parse", "refs/heads/main")).resolves.toBe(oldHead);
      await expect(git(otherOrigin, "for-each-ref", "--format=%(refname)")).resolves.toBe("");
      await expect(git(checkout, "remote", "get-url", "--all", "origin")).resolves.toBe(replacement);
      await expect(git(checkout, "remote", "get-url", "--push", "--all", "origin")).resolves.toBe(replacement);
    }
  );

  it("rejects pushing to a destination that differs from the displayed origin", async () => {
    const { catalog, checkout, origin, root } = await synchronizedFixture();
    const hiddenOrigin = path.join(root, "hidden.git");
    await git(root, "init", "--bare", "--initial-branch=main", hiddenOrigin);
    await git(checkout, "config", "remote.origin.pushurl", hiddenOrigin);
    const oldHead = await git(origin, "rev-parse", "refs/heads/main");
    await catalog.saveRule(rule("local-rule", "Keep this commit from hidden destinations."));
    await commit(checkout, "Add local rule");

    await expect(catalog.pushGit()).rejects.toThrow(/same single URL/i);

    await expect(git(origin, "rev-parse", "refs/heads/main")).resolves.toBe(oldHead);
    await expect(git(hiddenOrigin, "for-each-ref", "--format=%(refname)")).resolves.toBe("");
  });

  it("rejects saving and pushing an origin with additional inherited push destinations", async () => {
    const { catalog, checkout, origin, root } = await synchronizedFixture();
    const replacement = path.join(root, "replacement.git");
    const includedConfig = path.join(root, "included.gitconfig");
    await git(root, "init", "--bare", "--initial-branch=main", replacement);
    await git(checkout, "config", "--file", includedConfig, "remote.origin.pushurl", origin);
    await git(checkout, "config", "include.path", includedConfig);
    const oldHead = await git(origin, "rev-parse", "refs/heads/main");
    await catalog.saveRule(rule("local-rule", "Keep this commit from inherited destinations."));
    await commit(checkout, "Add local rule");

    await expect(catalog.setGitOrigin(replacement)).rejects.toThrow(/included or global/i);
    await expect(catalog.pushGit()).rejects.toThrow(/same single URL/i);

    await expect(git(origin, "rev-parse", "refs/heads/main")).resolves.toBe(oldHead);
    await expect(git(replacement, "for-each-ref", "--format=%(refname)")).resolves.toBe("");
    await expect(git(checkout, "config", "--file", includedConfig, "remote.origin.pushurl")).resolves.toBe(origin);
  });

  it("stores an IPv6 SSH origin without contacting the remote", async () => {
    const { checkout, call } = await repositoryFixture();
    const originUrl = "ssh://git@[::1]/rules.git";

    await expect(call("setOrigin", { originUrl })).resolves.toMatchObject({ git: { originUrl } });

    await expect(git(checkout, "remote", "get-url", "origin")).resolves.toBe(originUrl);
  });

  it("reports local catalog edits and returns to clean after they are committed", async () => {
    const { catalog, checkout, call } = await repositoryFixture();
    await expect(call("status")).resolves.toMatchObject({ git: { hasChanges: false } });

    await catalog.saveRule(rule("local-rule", "Review local changes."));

    await expect(call("status")).resolves.toMatchObject({ git: { hasChanges: true } });
    await commit(checkout, "Add local rule");
    await expect(call("status")).resolves.toMatchObject({ git: { hasChanges: false } });
  });

  it("pulls the current branch from origin, reloads the catalog, and notifies subscribers", async () => {
    const { catalog, checkout, peer, call } = await synchronizedFixture();
    await fs.writeFile(path.join(peer, "rules", "from-origin.md"), "Use the shared review checklist.\n");
    await commit(peer, "Add shared rule");
    await git(peer, "push", "origin", "main");
    const listener = vi.fn();
    catalog.onChange(listener);

    const result = await call("pull");

    expect(result).toMatchObject({
      git: { branch: "main", hasChanges: false },
      store: { rules: expect.arrayContaining([expect.objectContaining({ id: "from-origin", text: "Use the shared review checklist." })]) }
    });
    expect(listener).toHaveBeenCalledOnce();
    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(await git(peer, "rev-parse", "HEAD"));
    await expect(catalog.list()).resolves.toMatchObject({ rules: expect.arrayContaining([expect.objectContaining({ id: "from-origin" })]) });
  });

  it("pushes committed changes while preserving uncommitted edits without creating a commit", async () => {
    const { catalog, checkout, origin, call } = await synchronizedFixture();
    await catalog.saveRule(rule("published-rule", "Review the committed version."));
    await commit(checkout, "Add publishable rule");
    const head = await git(checkout, "rev-parse", "HEAD");
    await catalog.saveRule(rule("published-rule", "Keep this draft local."));

    await expect(call("push")).resolves.toMatchObject({ git: { hasChanges: true } });

    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(head);
    await expect(git(origin, "rev-parse", "refs/heads/main")).resolves.toBe(head);
    await expect(git(origin, "show", "refs/heads/main:rules/published-rule.md")).resolves.toContain("Review the committed version.");
    await expect(fs.readFile(path.join(checkout, "rules", "published-rule.md"), "utf8")).resolves.toContain("Keep this draft local.");
  });

  it("fast-forwards cleanly even when the branch is configured to squash merges", async () => {
    const { catalog, checkout, peer } = await synchronizedFixture();
    await fs.writeFile(path.join(peer, "rules", "remote-rule.md"), "Advance to this commit.\n");
    await commit(peer, "Add remote rule");
    await git(peer, "push", "origin", "main");
    await git(checkout, "config", "branch.main.mergeOptions", "--squash");

    await expect(catalog.pullGit()).resolves.toMatchObject({ git: { hasChanges: false } });

    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(await git(peer, "rev-parse", "HEAD"));
    await expect(git(checkout, "status", "--porcelain=v1")).resolves.toBe("");
    await expect(catalog.pullGit()).resolves.toMatchObject({ git: { hasChanges: false } });
  });

  it("pushes only the current branch despite repository-wide push configuration", async () => {
    const { catalog, checkout, origin } = await synchronizedFixture();
    await git(checkout, "branch", "unpublished");
    await git(checkout, "-c", "user.name=CloudX Test", "-c", "user.email=cloudx@example.test", "tag", "--annotate", "local-tag", "--message", "Local tag");
    await git(checkout, "config", "remote.origin.mirror", "true");
    await git(checkout, "config", "remote.origin.push", "refs/heads/*:refs/heads/*");
    await git(checkout, "config", "push.followTags", "true");
    await catalog.saveRule(rule("published-rule", "Review the published version."));
    await commit(checkout, "Add publishable rule");

    await catalog.pushGit();

    await expect(git(origin, "for-each-ref", "--format=%(refname)")).resolves.toBe("refs/heads/main");
    await expect(git(origin, "rev-parse", "refs/heads/main")).resolves.toBe(await git(checkout, "rev-parse", "HEAD"));
  });

  it("synchronizes the current branch even when its upstream names a different branch", async () => {
    const { catalog, checkout, origin, peer } = await synchronizedFixture();
    const mainHead = await git(checkout, "rev-parse", "main");
    await git(checkout, "checkout", "-b", "review");
    await git(checkout, "config", "branch.review.remote", "origin");
    await git(checkout, "config", "branch.review.merge", "refs/heads/main");
    await git(peer, "checkout", "-b", "review");
    await fs.writeFile(path.join(peer, "rules", "branch-rule.md"), "Review this branch.\n");
    await commit(peer, "Add branch rule");
    await git(peer, "push", "origin", "review");

    await expect(catalog.pullGit()).resolves.toMatchObject({
      git: { branch: "review" },
      store: { rules: expect.arrayContaining([expect.objectContaining({ id: "branch-rule" })]) }
    });
    await catalog.saveRule(rule("local-branch-rule", "Publish to this branch."));
    await commit(checkout, "Add local branch rule");
    await catalog.pushGit();

    await expect(git(origin, "rev-parse", "refs/heads/review")).resolves.toBe(await git(checkout, "rev-parse", "HEAD"));
    await expect(git(origin, "rev-parse", "refs/heads/main")).resolves.toBe(mainHead);
  });

  it("serializes saves and catalog reads behind a pull across catalog service instances", async () => {
    const { catalog, checkout } = await synchronizedFixture();
    const anotherCatalog = new RulesSkillsCatalogService(path.dirname(checkout));
    const entered = deferred();
    const resume = deferred();
    const originalPull = RulesSkillsGitService.prototype.pull;
    vi.spyOn(RulesSkillsGitService.prototype, "pull").mockImplementation(async function (this: RulesSkillsGitService) {
      entered.resolve();
      await resume.promise;
      await originalPull.call(this);
    });
    const pulling = catalog.pullGit();
    await entered.promise;
    const saving = anotherCatalog.saveRule(rule("queued-rule", "Save this after pulling."));
    const reading = catalog.list();
    const results = Promise.allSettled([pulling, saving, reading]);
    try {
      await new Promise(resolve => setImmediate(resolve));
      await expect(fs.stat(path.join(checkout, "rules", "queued-rule.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resume.resolve();
      await results;
    }

    await expect(pulling).resolves.toMatchObject({ store: { rules: expect.not.arrayContaining([expect.objectContaining({ id: "queued-rule" })]) } });
    await expect(saving).resolves.toMatchObject({ rules: expect.arrayContaining([expect.objectContaining({ id: "queued-rule" })]) });
    await expect(reading).resolves.toMatchObject({ rules: expect.arrayContaining([expect.objectContaining({ id: "queued-rule" })]) });
  });

  it.each(["tracked", "untracked"])("rejects pulling with %s local changes and preserves the checkout", async kind => {
    const { catalog, checkout, peer } = await synchronizedFixture();
    await fs.writeFile(path.join(peer, "rules", "remote-only.md"), "Review remote changes.\n");
    await commit(peer, "Add remote change");
    await git(peer, "push", "origin", "main");
    const ruleId = kind === "tracked" ? "keep-changes-focused" : "draft-rule";
    await catalog.saveRule(rule(ruleId, "Preserve this local draft."));
    const head = await git(checkout, "rev-parse", "HEAD");

    await expect(catalog.pullGit()).rejects.toThrow(/changes|clean|commit/i);

    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(head);
    await expect(fs.readFile(path.join(checkout, "rules", `${ruleId}.md`), "utf8")).resolves.toContain("Preserve this local draft.");
    await expect(fs.stat(path.join(checkout, "rules", "remote-only.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["rules/private.md", "skills/private-notes/SKILL.md"])(
    "rejects incoming changes that overwrite ignored %s, preserving the file and HEAD", async relativePath => {
      const { catalog, checkout, peer } = await synchronizedFixture();
      await fs.appendFile(path.join(checkout, ".git", "info", "exclude"), "\nrules/private.md\nskills/private-notes/\n");
      const localFile = path.join(checkout, relativePath);
      const remoteFile = path.join(peer, relativePath);
      await fs.mkdir(path.dirname(localFile), { recursive: true });
      await fs.mkdir(path.dirname(remoteFile), { recursive: true });
      await fs.writeFile(localFile, "Preserve this ignored local draft.\n");
      await fs.writeFile(remoteFile, "Incoming tracked content.\n");
      await commit(peer, "Track formerly ignored catalog content");
      await git(peer, "push", "origin", "main");
      await git(checkout, "config", "branch.main.mergeOptions", "--overwrite-ignore");
      const head = await git(checkout, "rev-parse", "HEAD");
      const listener = vi.fn();
      catalog.onChange(listener);
      await expect(catalog.gitStatus()).resolves.toMatchObject({ hasChanges: false });

      await expect(catalog.pullGit()).rejects.toThrow(/overwrite|ignored/i);

      await expect(fs.readFile(localFile, "utf8")).resolves.toBe("Preserve this ignored local draft.\n");
      await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(head);
      await expect(git(checkout, "status", "--porcelain=v1")).resolves.toBe("");
      expect(listener).not.toHaveBeenCalled();
    }
  );

  it("preserves unrelated ignored files while pulling a non-colliding change", async () => {
    const { catalog, checkout, peer } = await synchronizedFixture();
    await fs.appendFile(path.join(checkout, ".git", "info", "exclude"), "\nrules/private.md\n");
    const localFile = path.join(checkout, "rules", "private.md");
    await fs.writeFile(localFile, "Preserve this ignored local draft.\n");
    await fs.writeFile(path.join(peer, "rules", "remote-rule.md"), "Review the remote rule.\n");
    await commit(peer, "Add non-colliding rule");
    await git(peer, "push", "origin", "main");

    await expect(catalog.pullGit()).resolves.toMatchObject({ git: { hasChanges: false } });

    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(await git(peer, "rev-parse", "HEAD"));
    await expect(fs.readFile(localFile, "utf8")).resolves.toBe("Preserve this ignored local draft.\n");
  });

  it("does not merge a stale FETCH_HEAD when fetching the selected origin fails", async () => {
    const { catalog, checkout, peer, root } = await synchronizedFixture();
    await fs.writeFile(path.join(peer, "rules", "remote-rule.md"), "Do not merge after a failed fetch.\n");
    await commit(peer, "Add remote rule");
    await git(peer, "push", "origin", "main");
    await git(checkout, "fetch", "origin", "main");
    const head = await git(checkout, "rev-parse", "HEAD");
    await catalog.setGitOrigin(path.join(root, "missing.git"));
    const listener = vi.fn();
    catalog.onChange(listener);

    await expect(catalog.pullGit()).rejects.toThrow(/Git command failed/i);

    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(head);
    await expect(fs.stat(path.join(checkout, "rules", "remote-rule.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(git(checkout, "status", "--porcelain=v1")).resolves.toBe("");
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects divergent history without merging, rebasing, force pushing, or notifying catalog changes", async () => {
    const { catalog, checkout, peer, origin } = await synchronizedFixture();
    await fs.writeFile(path.join(peer, "rules", "remote-only.md"), "Review remote changes.\n");
    await commit(peer, "Add remote change");
    await git(peer, "push", "origin", "main");
    await catalog.saveRule(rule("local-only", "Review local changes."));
    await commit(checkout, "Add local change");
    const head = await git(checkout, "rev-parse", "HEAD");
    const listener = vi.fn();
    catalog.onChange(listener);

    await expect(catalog.pullGit()).rejects.toThrow(/fast.forward|diverg/i);
    await expect(catalog.pushGit()).rejects.toThrow(/rejected/i);

    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(head);
    await expect(git(origin, "rev-parse", "refs/heads/main")).resolves.toBe(await git(peer, "rev-parse", "HEAD"));
    await expect(fs.stat(path.join(checkout, ".git", "MERGE_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(checkout, ".git", "rebase-merge"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(["pull", "push"])("rejects %s without an origin", async operation => {
    const { call } = await repositoryFixture();
    await expect(call(operation)).rejects.toThrow(/origin/i);
  });

  it.each(["pull", "push"])("rejects %s on a detached checkout", async operation => {
    const { checkout, call } = await synchronizedFixture();
    await git(checkout, "checkout", "--detach", "HEAD");

    await expect(call(operation)).rejects.toThrow(/branch|detach/i);
  });

  it.each(["pull", "push"])("rejects %s on an unborn branch", async operation => {
    const { catalog, root, call } = await catalogFixture();
    await git(catalog.catalogRoot(), "init", "--initial-branch=main");
    await catalog.setGitOrigin(path.join(root, "origin.git"));

    await expect(call(operation)).rejects.toThrow(/commit|unborn/i);
  });

  it("rejects an enclosing Git repository before changing its origin or history", async () => {
    const { catalog, root, call } = await catalogFixture();
    await git(root, "init", "--initial-branch=main");
    await git(root, "remote", "add", "origin", "/parent-origin.git");

    for (const operation of ["status", "pull", "push"]) {
      await expect(call(operation)).rejects.toThrow(/root|catalog|enclos|parent/i);
    }
    await expect(catalog.setGitOrigin("/replacement-origin.git")).rejects.toThrow(/root|catalog|enclos|parent/i);
    await expect(git(root, "remote", "get-url", "origin")).resolves.toBe("/parent-origin.git");
    await expect(fs.stat(path.join(catalog.catalogRoot(), ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked catalog root before inspecting or changing the target repository", async () => {
    const { catalog, root, call } = await catalogFixture();
    const outside = path.join(root, "outside");
    await fs.rename(catalog.catalogRoot(), outside);
    await git(outside, "init", "--initial-branch=main");
    await git(outside, "remote", "add", "origin", "/outside-origin.git");
    await fs.symlink(outside, catalog.catalogRoot(), "dir");

    for (const operation of ["status", "pull", "push"]) {
      await expect(call(operation)).rejects.toThrow(/symbolic|symlink/i);
    }
    await expect(catalog.setGitOrigin("/replacement-origin.git")).rejects.toThrow(/symbolic|symlink/i);
    await expect(git(outside, "remote", "get-url", "origin")).resolves.toBe("/outside-origin.git");
  });

  it("rejects symlinked Git metadata before changing another repository", async () => {
    const { catalog, checkout, root } = await repositoryFixture();
    const outside = path.join(root, "outside-git");
    await fs.rename(path.join(checkout, ".git"), outside);
    await fs.symlink(outside, path.join(checkout, ".git"), "dir");

    await expect(catalog.gitStatus()).rejects.toThrow(/symbolic link/i);
    await expect(catalog.setGitOrigin("/replacement.git")).rejects.toThrow(/symbolic link/i);
    expect(await fs.readFile(path.join(outside, "config"), "utf8")).not.toContain("replacement.git");
  });

  it("reports corrupt Git metadata instead of presenting the catalog as uninitialized", async () => {
    const { catalog, checkout } = await catalogFixture();
    await fs.writeFile(path.join(checkout, ".git"), "invalid metadata\n");

    await expect(catalog.gitStatus()).rejects.toThrow(/metadata/i);
  });

  it.each([{}, { originUrl: null }, { originUrl: 42 }, { originUrl: "" }, { originUrl: "   " }])("rejects malformed origin hook input: %j", async input => {
    const { call, checkout } = await repositoryFixture();

    await expect(call("setOrigin", input)).rejects.toThrow();
    await expect(git(checkout, "remote")).resolves.toBe("");
  });

  it("redacts credentials from an origin already configured outside CloudX", async () => {
    const { catalog, checkout } = await repositoryFixture();
    await git(checkout, "remote", "add", "origin", "https://private-user:private-password@example.test/catalog.git?token=private-token#private-fragment");

    const state = await catalog.gitStatus();

    expect(state.originUrl).toBe("https://example.test/catalog.git");
    expect(JSON.stringify(state)).not.toContain("private-");
  });

  it.each([
    "https://private-token@example.test/catalog.git",
    "https://user:private-password@example.test/catalog.git",
    "https://example.test/catalog.git?token=private-token",
    "ext::arbitrary-command",
    "--upload-pack=arbitrary-command",
    "https://example.test/catalog.git\nextra-command"
  ])("rejects unsafe origin values before saving them: %s", async originUrl => {
    const { catalog, checkout } = await repositoryFixture();

    await expect(catalog.setGitOrigin(originUrl)).rejects.toThrow();
    await expect(git(checkout, "remote")).resolves.toBe("");
  });

  it.each(["status", "setOrigin", "pull", "push"])("rejects an arbitrary cwd at the %s hook boundary", async operation => {
    const { call } = await repositoryFixture();
    const input = operation === "setOrigin" ? { originUrl: "/unused.git", cwd: "/elsewhere" } : { cwd: "/elsewhere" };

    await expect(call(operation, input)).rejects.toThrow(/invalid input/i);
  });
});

async function catalogFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-git-"));
  roots.push(root);
  const catalog = new RulesSkillsCatalogService(path.join(root, "data"));
  await catalog.list();
  const hooks = new HookRegistry();
  new RulesSkillsPlugin(catalog).hooks.forEach(hook => hooks.register(hook));
  const call = (operation: string, input: Record<string, unknown> = {}) => hooks.call(`rules-skills.git.${operation}`, input, { caller: { kind: "ui" } });
  return { root, catalog, hooks, call, checkout: catalog.catalogRoot() };
}

async function repositoryFixture() {
  const fixture = await catalogFixture();
  await git(fixture.checkout, "init", "--initial-branch=main");
  await commit(fixture.checkout, "Seed catalog");
  return fixture;
}

async function synchronizedFixture() {
  const fixture = await repositoryFixture();
  const origin = path.join(fixture.root, "origin.git");
  const peer = path.join(fixture.root, "peer");
  await git(fixture.root, "init", "--bare", "--initial-branch=main", origin);
  await git(fixture.checkout, "remote", "add", "origin", origin);
  await git(fixture.checkout, "push", "--set-upstream", "origin", "main");
  await git(fixture.root, "clone", origin, peer);
  return { ...fixture, origin, peer };
}

async function commit(checkout: string, message: string) {
  await git(checkout, "add", "--all");
  await git(checkout, "-c", "user.name=CloudX Test", "-c", "user.email=cloudx@example.test", "commit", "-m", message);
}

async function git(checkout: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", checkout, ...args], {
    timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }
  });
  return stdout.trim();
}

function rule(id: string, text: string) {
  return { id, text, description: text };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
