import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import { ForgeCredentials, githubAppJwt } from "./ForgeCredentials.js";

describe("private credentials for worker-owned HTTPS checkouts", () => {
  it.each([
    {
      provider: "github",
      apiUrl: "https://api.github.com",
      projectPath: "owner/repo",
      cloneUrl: "https://github.com/owner/repo.git",
      username: "x-access-token",
    },
    {
      provider: "github",
      apiUrl: "https://github.example/api/v3",
      projectPath: "owner/repo",
      cloneUrl: "https://github.example/owner/repo.git",
      username: "x-access-token",
    },
    {
      provider: "gitlab",
      apiUrl: "https://gitlab.example:8443/api/v4",
      projectPath: "group/subgroup/repo",
      cloneUrl: "https://gitlab.example:8443/group/subgroup/repo.git",
      username: "oauth2",
    },
  ] as const)(
    "keeps $provider checkout URLs free of credentials on $apiUrl",
    async ({ cloneUrl, username, ...repository }) => {
      const read = vi.fn(async () => ({
        kind: "token" as const,
        token: "private-reviewer-token",
      }));
      const access = await new ForgeCredentials(repository, read).gitAccess(
        "reviewer",
      );
      expect(access).toEqual({
        cloneUrl,
        authorization: `Basic ${Buffer.from(`${username}:private-reviewer-token`).toString("base64")}`,
      });
      expect(read).toHaveBeenCalledExactlyOnceWith("reviewer");
      expect(new URL(access.cloneUrl).username).toBe("");
      expect(new URL(access.cloneUrl).password).toBe("");
    },
  );

  it("uses the GitLab OAuth token as the HTTPS password", async () => {
    const repository: ForgeRepository = {
      provider: "gitlab",
      apiUrl: "https://gitlab.com/api/v4",
      projectPath: "group/repo",
    };
    const credentials = new ForgeCredentials(repository, async () => ({
      kind: "gitlab-oauth",
      token: "oauth-secret",
    }));
    const access = await credentials.gitAccess("worker");
    expect(
      Buffer.from(access.authorization.slice(6), "base64").toString(),
    ).toBe("oauth2:oauth-secret");
  });

  it("mints and reuses the selected app installation token for Git HTTPS", async () => {
    const repository: ForgeRepository = {
      provider: "github",
      apiUrl: "https://api.github.com",
      projectPath: "owner/repo",
    };
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        token: "installation-secret",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    const read = vi.fn(async (_role: ForgeCredentialRole) => ({
      kind: "github-app" as const,
      appId: "123",
      installationId: "42",
      privateKey: keys.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    }));
    const credentials = new ForgeCredentials(repository, read, fetcher);
    const access = await credentials.gitAccess("worker");
    expect(
      Buffer.from(access.authorization.slice(6), "base64").toString(),
    ).toBe("x-access-token:installation-secret");
    await credentials.gitAccess("worker");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      repositories: ["repo"],
    });
    expect(read.mock.calls.every(([role]) => role === "worker")).toBe(true);
  });

  it("does not read credentials for an already-canceled checkout", async () => {
    const repository: ForgeRepository = {
      provider: "gitlab",
      apiUrl: "https://gitlab.com/api/v4",
      projectPath: "group/repo",
    };
    const read = vi.fn();
    await expect(
      new ForgeCredentials(repository, read).gitAccess(
        "worker",
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects non-RSA keys without disclosing their content", () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const privateKey = keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => githubAppJwt({ appId: "123", privateKey })).toThrow(
      "not a valid RSA signing key",
    );
  });
});
