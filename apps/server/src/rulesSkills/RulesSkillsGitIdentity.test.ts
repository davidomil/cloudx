import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RulesSkillsGitService } from "./RulesSkillsGitService.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("catalog Git branch identity", () => {
  it("pulls refs/heads/main when the checkout also has a main tag", async () => {
    const { checkout, origin, peer, service } = await synchronizedFixture();
    const taggedCommit = await git(checkout, "rev-parse", "refs/tags/main");
    await commit(peer, "Incoming catalog changes");
    await git(peer, "push", "origin", "HEAD:refs/heads/main");

    await service.pull(origin);

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

describe.each(["git", "ssh", "http", "https", "file"])("catalog Git origin with SSH host alias %s", alias => {
  it("displays the configured scp-style origin unchanged", async () => {
    const { checkout, origin, originUrl, service } = await sshAliasFixture(alias);

    await expect(git(checkout, "ls-remote", "origin", "refs/heads/main")).resolves.toBe(`${await git(origin, "rev-parse", "HEAD")}\trefs/heads/main`);
    await expect(service.status()).resolves.toMatchObject({ originUrl });
  });

  it("updates an existing scp-style origin without changing the selected destination", async () => {
    const { checkout, origin, replacement, service } = await sshAliasFixture(alias);
    const originalCommit = await git(origin, "rev-parse", "HEAD");
    const replacementUrl = `${alias}:replacement.git`;
    await commit(checkout, "Outgoing replacement catalog");

    await expect(service.setOrigin(replacementUrl)).resolves.toMatchObject({ originUrl: replacementUrl });
    await expect(service.push(replacementUrl)).resolves.toMatchObject({ originUrl: replacementUrl });

    await expect(git(checkout, "remote", "get-url", "origin")).resolves.toBe(replacementUrl);
    await expect(git(checkout, "remote", "get-url", "--push", "origin")).resolves.toBe(replacementUrl);
    await expect(git(replacement, "rev-parse", "HEAD")).resolves.toBe(await git(checkout, "rev-parse", "HEAD"));
    await expect(git(origin, "rev-parse", "HEAD")).resolves.toBe(originalCommit);
  });

  it("pulls the incoming branch through the displayed scp-style origin", async () => {
    const { checkout, origin, originUrl, peer, service } = await sshAliasFixture(alias);
    await commit(peer, "Incoming catalog changes");
    await git(peer, "push", "origin", "HEAD:refs/heads/main");

    await service.pull(originUrl);

    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(await git(origin, "rev-parse", "HEAD"));
    await expect(fs.readFile(path.join(checkout, "rule.md"), "utf8")).resolves.toBe("Incoming catalog changes\n");
    await expect(service.status()).resolves.toMatchObject({ originUrl, hasChanges: false });
  });

  it("pushes the outgoing branch through the displayed scp-style origin", async () => {
    const { checkout, origin, originUrl, service } = await sshAliasFixture(alias);
    await commit(checkout, "Outgoing catalog changes");

    await expect(service.push(originUrl)).resolves.toMatchObject({ originUrl, hasChanges: false });

    await expect(git(origin, "rev-parse", "HEAD")).resolves.toBe(await git(checkout, "rev-parse", "HEAD"));
    await expect(git(origin, "show", "HEAD:rule.md")).resolves.toBe("Outgoing catalog changes");
  });
});

describe("catalog Git file origin identity", () => {
  it.each(["#archive", "?archive"])("rejects a file origin whose %s suffix would be hidden before synchronization", async suffix => {
    const { root, checkout, origin, peer, service } = await synchronizedFixture();
    const hiddenOrigin = `${origin}${suffix}`;
    await git(root, "clone", "--bare", origin, hiddenOrigin);
    await commit(peer, "Incoming hidden catalog");
    await git(peer, "push", hiddenOrigin, "HEAD:refs/heads/main");
    const originUrl = `file://${hiddenOrigin}`;
    const displayedOrigin = `file://${origin}`;
    await git(checkout, "remote", "set-url", "origin", originUrl);
    const initialHead = await git(checkout, "rev-parse", "HEAD");
    const hiddenHead = await git(hiddenOrigin, "rev-parse", "HEAD");
    await expect(git(checkout, "ls-remote", "origin", "refs/heads/main")).resolves.toBe(`${hiddenHead}\trefs/heads/main`);

    await expect(service.status()).rejects.toThrow(/cannot be displayed safely/i);
    await expect(service.pull(displayedOrigin)).rejects.toThrow(/cannot be displayed safely/i);

    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(initialHead);
    await expect(fs.stat(path.join(checkout, ".git", "FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    await commit(checkout, "Outgoing hidden catalog");

    await expect(service.push(displayedOrigin)).rejects.toThrow(/cannot be displayed safely/i);

    await expect(git(origin, "rev-parse", "HEAD")).resolves.toBe(initialHead);
    await expect(git(hiddenOrigin, "rev-parse", "HEAD")).resolves.toBe(hiddenHead);
    await expect(git(checkout, "remote", "get-url", "origin")).resolves.toBe(originUrl);
  });

  it.each(["#archive", "?archive"])("synchronizes only the file origin with the encoded %s pathname suffix", async suffix => {
    const { root, checkout, origin, peer, service } = await synchronizedFixture();
    const encodedOrigin = `${origin}${suffix}`;
    await git(root, "clone", "--bare", origin, encodedOrigin);
    const originalHead = await git(origin, "rev-parse", "HEAD");
    const originUrl = `file://${origin}${encodeURIComponent(suffix)}`;
    await expect(service.setOrigin(originUrl)).resolves.toMatchObject({ originUrl });
    await commit(peer, "Incoming encoded catalog");
    await git(peer, "push", encodedOrigin, "HEAD:refs/heads/main");

    await service.pull(originUrl);

    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(await git(encodedOrigin, "rev-parse", "HEAD"));
    await expect(fs.readFile(path.join(checkout, "rule.md"), "utf8")).resolves.toBe("Incoming encoded catalog\n");
    await commit(checkout, "Outgoing encoded catalog");

    await expect(service.push(originUrl)).resolves.toMatchObject({ originUrl, hasChanges: false });

    await expect(git(encodedOrigin, "rev-parse", "HEAD")).resolves.toBe(await git(checkout, "rev-parse", "HEAD"));
    await expect(git(encodedOrigin, "show", "HEAD:rule.md")).resolves.toBe("Outgoing encoded catalog");
    await expect(git(origin, "rev-parse", "HEAD")).resolves.toBe(originalHead);
  });

  it("preserves symlink parent traversal when saving, displaying, pulling, and pushing a file origin", async () => {
    const { root, checkout, origin, peer, service } = await synchronizedFixture();
    const links = path.join(root, "links");
    const alias = path.join(links, "alias");
    await fs.mkdir(links);
    await fs.symlink(checkout, alias, "dir");
    const normalizedOrigin = path.join(links, "origin.git");
    await git(root, "clone", "--bare", origin, normalizedOrigin);
    const normalizedHead = await git(normalizedOrigin, "rev-parse", "HEAD");
    const originUrl = `file://${alias}/../origin.git`;
    const normalizedUrl = `file://${normalizedOrigin}`;

    await expect(service.setOrigin(originUrl)).resolves.toMatchObject({ originUrl });
    await expect(service.status()).resolves.toMatchObject({ originUrl });
    await expect(git(checkout, "remote", "get-url", "origin")).resolves.toBe(originUrl);
    await expect(git(checkout, "remote", "get-url", "--push", "origin")).resolves.toBe(originUrl);
    await commit(peer, "Incoming symlink catalog");
    await git(peer, "push", "origin", "HEAD:refs/heads/main");
    await expect(service.pull(normalizedUrl)).rejects.toThrow(/Origin changed/i);
    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(normalizedHead);

    await service.pull(originUrl);

    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(await git(origin, "rev-parse", "HEAD"));
    await expect(fs.readFile(path.join(checkout, "rule.md"), "utf8")).resolves.toBe("Incoming symlink catalog\n");
    const originHead = await git(origin, "rev-parse", "HEAD");
    await commit(checkout, "Outgoing symlink catalog");
    await expect(service.push(normalizedUrl)).rejects.toThrow(/Origin changed/i);
    await expect(git(origin, "rev-parse", "HEAD")).resolves.toBe(originHead);

    await expect(service.push(originUrl)).resolves.toMatchObject({ originUrl, hasChanges: false });

    await expect(git(origin, "rev-parse", "HEAD")).resolves.toBe(await git(checkout, "rev-parse", "HEAD"));
    await expect(git(origin, "show", "HEAD:rule.md")).resolves.toBe("Outgoing symlink catalog");
    await expect(git(normalizedOrigin, "rev-parse", "HEAD")).resolves.toBe(normalizedHead);
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
    "https:private-user:private-password@example.test/catalog.git",
    "https:/private-user:private-password@bad host/catalog.git",
    "ssh:private-user:private-password@example.test/catalog.git",
    "https::https://private-user:private-password@bad host/catalog.git",
    "custom::private-user:private-password@example.test/catalog.git",
    "custom::custom::https://private-user:private-password@example.test/catalog.git",
    "file://private-user:private-password@localhost/catalog.git",
    "custom::file://private-user:private-password@localhost/catalog.git",
    "file:///catalog.git?token=private-token",
    "file:///catalog.git#private-fragment",
    "custom::file:///catalog.git?token=private-token#private-fragment"
  ])("rejects an origin that cannot be safely displayed: %s", async origin => {
    const { checkout, service } = await repositoryFixture();
    await git(checkout, "remote", "add", "origin", origin);

    await expect(service.status()).rejects.toEqual(new Error("The configured origin URL cannot be displayed safely. Update it in Git configuration."));
    await expect(git(checkout, "remote", "get-url", "origin")).resolves.toBe(origin);
  });

  it.each([
    "git@example.test:rules/catalog.git", "git:catalog@v1.git", "https:rules/catalog@v1.git",
    "git:rules/archive:2026.git", "git@[::1]:catalog.git", "/local rules/catalog.git", "../catalog.git", "./rules:catalog.git",
    "file:///local rules/catalog.git", "file:///rules/alias/../catalog.git", "file:///rules/catalog.git%23archive",
    "custom::file:///rules/alias/../catalog.git"
  ])("displays a credential-free SSH or local origin: %s", async origin => {
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

async function sshAliasFixture(alias: string) {
  const fixture = await synchronizedFixture();
  const replacement = path.join(fixture.root, "replacement.git");
  await git(fixture.root, "init", "--bare", "--initial-branch=main", replacement);
  const bin = path.join(fixture.root, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "ssh"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const [host, command] = process.argv.slice(-2);
const operation = new Map([
  ["git-upload-pack 'catalog.git'", ["upload-pack", ${JSON.stringify(fixture.origin)}]],
  ["git-receive-pack 'catalog.git'", ["receive-pack", ${JSON.stringify(fixture.origin)}]],
  ["git-receive-pack 'replacement.git'", ["receive-pack", ${JSON.stringify(replacement)}]]
]).get(command);
if (host !== ${JSON.stringify(alias)} || !operation) process.exit(1);
const result = spawnSync("git", operation, { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  const originUrl = `${alias}:catalog.git`;
  await git(fixture.checkout, "remote", "set-url", "origin", originUrl);
  return { ...fixture, originUrl, replacement };
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
