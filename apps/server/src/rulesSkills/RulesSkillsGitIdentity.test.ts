import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { RulesSkillsGitService } from "./RulesSkillsGitService.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("catalog Git branch identity", () => {
  it("pulls refs/heads/main when the checkout also has a main tag", async () => {
    const { checkout, origin, peer, service } = await synchronizedFixture();
    const taggedCommit = await git(checkout, "rev-parse", "refs/tags/main");
    await commit(peer, "Incoming catalog changes");
    await git(peer, "push", "origin", "HEAD:refs/heads/main");

    await service.pull();

    await expect(service.status()).resolves.toMatchObject({ branch: "main", hasChanges: false });
    await expect(git(checkout, "rev-parse", "refs/heads/main")).resolves.toBe(await git(origin, "rev-parse", "refs/heads/main"));
    await expect(git(checkout, "rev-parse", "refs/tags/main")).resolves.toBe(taggedCommit);
    await expect(git(origin, "for-each-ref", "--format=%(refname)")).resolves.toBe("refs/heads/main");
  });

  it("pushes only refs/heads/main when the checkout also has a main tag", async () => {
    const { checkout, origin, service } = await synchronizedFixture();
    const taggedCommit = await git(checkout, "rev-parse", "refs/tags/main");
    await commit(checkout, "Outgoing catalog changes");

    const state = await service.push(origin);

    expect(state.branch).toBe("main");
    await expect(git(origin, "rev-parse", "refs/heads/main")).resolves.toBe(await git(checkout, "rev-parse", "HEAD"));
    await expect(git(origin, "for-each-ref", "--format=%(refname)")).resolves.toBe("refs/heads/main");
    await expect(git(checkout, "rev-parse", "refs/tags/main")).resolves.toBe(taggedCommit);
  });
});

describe("catalog Git origin privacy", () => {
  it.each([
    ["https::https://private-user:private-password@example.test/catalog.git?token=private-token#private-fragment", "https::https://example.test/catalog.git"],
    ["http::http://private-user:private-password@127.0.0.1:12345/catalog.git?token=private-token", "http::http://127.0.0.1:12345/catalog.git"],
    ["custom::https://private-user:private-password@example.test/catalog.git", "custom::https://example.test/catalog.git"],
    ["ssh::ssh://git:private-password@example.test/catalog.git", "ssh::ssh://git@example.test/catalog.git"]
  ])("redacts credentials inside existing helper origin %s", async (origin, publicOrigin) => {
    const { checkout, service } = await repositoryFixture();
    await git(checkout, "remote", "add", "origin", origin);

    const state = await service.status();

    expect(state.originUrl).toBe(publicOrigin);
    expect(JSON.stringify(state)).not.toContain("private-");
    await expect(git(checkout, "remote", "get-url", "origin")).resolves.toBe(origin);
  });

  it.each([
    "https://private-user:private-password@bad host/catalog.git",
    "https://private-user:private-password@[invalid]/catalog.git",
    "https:private-user:private-password@bad host/catalog.git",
    "https::https://private-user:private-password@bad host/catalog.git",
    "custom::private-user:private-password@example.test/catalog.git",
    "custom::custom::https://private-user:private-password@example.test/catalog.git"
  ])("rejects an origin that cannot be safely displayed: %s", async origin => {
    const { checkout, service } = await repositoryFixture();
    await git(checkout, "remote", "add", "origin", origin);

    await expect(service.status()).rejects.toEqual(new Error("The configured origin URL cannot be displayed safely. Update it in Git configuration."));
    await expect(git(checkout, "remote", "get-url", "origin")).resolves.toBe(origin);
  });

  it.each(["git@example.test:rules/catalog.git", "/local rules/catalog.git", "../catalog.git"])("displays a credential-free SSH or local origin: %s", async origin => {
    const { checkout, service } = await repositoryFixture();
    await git(checkout, "remote", "add", "origin", origin);

    await expect(service.status()).resolves.toMatchObject({ originUrl: origin });
  });
});

async function repositoryFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-git-identity-"));
  roots.push(root);
  const checkout = path.join(root, "catalog");
  await git(root, "init", "--initial-branch=main", checkout);
  await commit(checkout, "Seed catalog");
  return { root, checkout, service: new RulesSkillsGitService(checkout) };
}

async function synchronizedFixture() {
  const fixture = await repositoryFixture();
  const origin = path.join(fixture.root, "origin.git");
  const peer = path.join(fixture.root, "peer");
  await git(fixture.root, "init", "--bare", "--initial-branch=main", origin);
  await git(fixture.checkout, "remote", "add", "origin", origin);
  await git(fixture.checkout, "push", "origin", "HEAD:refs/heads/main");
  await git(fixture.root, "clone", origin, peer);
  await git(fixture.checkout, "tag", "main");
  return { ...fixture, origin, peer };
}

async function commit(checkout: string, message: string) {
  await fs.writeFile(path.join(checkout, "rule.md"), `${message}\n`);
  await git(checkout, "add", "rule.md");
  await git(checkout, "-c", "user.name=CloudX Test", "-c", "user.email=cloudx@example.test", "commit", "-m", message);
}

async function git(checkout: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", checkout, ...args], {
    timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }
  });
  return stdout.trim();
}
