import { generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ForgeRepository } from "@cloudx/shared";
import { ForgeRegistrationClient } from "./ForgeRegistrationClient.js";

const repository: ForgeRepository = {
  provider: "github",
  apiUrl: "https://api.github.com",
  projectPath: "owner/repo",
};
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const app = {
  appId: "123",
  privateKey: keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
};
const state = "registration-state-1234567890";
const origin = "http://127.0.0.1:3000";
const installation = {
  id: 42,
  app_id: 123,
  suspended_at: null,
  permissions: { contents: "write", issues: "write", pull_requests: "write" },
};

describe("GitHub application registration", () => {
  it("prepares distinct worker and reviewer applications with browser consent and minimum repository permissions", () => {
    const client = new ForgeRegistrationClient();
    const worker = client.githubManifest(repository, "worker", {
      origin,
      state,
    });
    const reviewer = client.githubManifest(repository, "reviewer", {
      origin,
      state,
    });
    expect(worker.action).toBe(
      `https://github.com/settings/apps/new?state=${state}`,
    );
    expect(worker.manifest).toMatchObject({
      public: true,
      url: origin,
      redirect_url: `${origin}/api/forge/connections/github/manifest`,
      setup_url: `${origin}/api/forge/connections/github/installation`,
      default_permissions: {
        contents: "write",
        issues: "write",
        pull_requests: "write",
      },
    });
    expect(reviewer.manifest.default_permissions).toEqual({
      contents: "read",
      issues: "read",
      pull_requests: "write",
    });
    expect(worker.manifest.name).not.toBe(reviewer.manifest.name);
    expect(worker.manifest).not.toHaveProperty("hook_attributes");
    expect(worker.manifest).not.toHaveProperty("callback_urls");
  });

  it("uses the configured GitHub Enterprise host for registration", () => {
    const client = new ForgeRegistrationClient();
    const enterprise = {
      ...repository,
      apiUrl: "https://github.example/api/v3",
    };
    expect(
      client.githubManifest(enterprise, "worker", { origin, state }).action,
    ).toBe(`https://github.example/settings/apps/new?state=${state}`);
  });

  it.each([
    "http://remote.example",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?secret=1",
  ])("rejects an unsafe callback origin %s", (origin) => {
    expect(() =>
      new ForgeRegistrationClient().githubManifest(repository, "worker", {
        origin,
        state,
      }),
    ).toThrow("origin");
  });

  it("exchanges a manifest code once and returns only required private app configuration", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          id: 123,
          pem: app.privateKey,
          slug: "cloudx-worker",
          name: "CloudX worker",
          client_secret: "unused-secret",
        },
        { status: 201 },
      ),
    );
    expect(
      await new ForgeRegistrationClient(fetcher).githubConvert(
        repository,
        "one-use-code",
      ),
    ).toEqual({ ...app, slug: "cloudx-worker", name: "CloudX worker" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://api.github.com/app-manifests/one-use-code/conversions",
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    { id: "123", pem: app.privateKey, slug: "app", name: "App" },
    { id: 123, pem: "private-invalid-key", slug: "app", name: "App" },
    { id: 123, pem: app.privateKey, slug: "../../other", name: "App" },
  ])(
    "treats invalid conversion credentials as an unknown result without retrying",
    async (body) => {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(body));
      const result = new ForgeRegistrationClient(fetcher).githubConvert(
        repository,
        "one-use-code",
      );
      await expect(result).rejects.toThrow("remote result is unknown");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("verifies the requested repository installation with the app JWT", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(installation),
    );
    const result = await new ForgeRegistrationClient(
      fetcher,
    ).githubInstallation(repository, app, "42", "worker");
    expect(result).toEqual({ installationId: "42" });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/owner/repo/installation");
    const jwt = new Headers(options?.headers).get("Authorization")!.slice(7);
    const [header, payload, signature] = jwt.split(".");
    expect(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    ).toMatchObject({ iss: "123" });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        keys.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it.each([
    { ...installation, id: 43 },
    { ...installation, app_id: 456 },
    { ...installation, suspended_at: "2026-09-07T00:00:00Z" },
    {
      ...installation,
      permissions: { ...installation.permissions, contents: "read" },
    },
    { ...installation, permissions: {} },
  ])(
    "rejects another app, spoofed installation, suspension, or insufficient permissions",
    async (body) => {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(body));
      await expect(
        new ForgeRegistrationClient(fetcher).githubInstallation(
          repository,
          app,
          "42",
          "worker",
        ),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts read-only repository content for the reviewer", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        ...installation,
        permissions: {
          contents: "read",
          issues: "read",
          pull_requests: "write",
        },
      }),
    );
    await expect(
      new ForgeRegistrationClient(fetcher).githubInstallation(
        repository,
        app,
        "42",
        "reviewer",
      ),
    ).resolves.toEqual({ installationId: "42" });
  });

  it("rejects invalid inputs and already canceled requests before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new ForgeRegistrationClient(fetcher);
    await expect(
      client.githubConvert(repository, "../secret"),
    ).rejects.toThrow();
    await expect(
      client.githubConvert(repository, "code", AbortSignal.abort()),
    ).rejects.toThrow();
    await expect(
      client.githubInstallation(repository, app, "../42", "worker"),
    ).rejects.toThrow();
    await expect(
      client.githubInstallation(
        repository,
        app,
        "42",
        "worker",
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("redacts remote failures and reports ambiguous conversion without retry", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("private response with token and one-use-code");
    });
    const client = new ForgeRegistrationClient(fetcher);
    await expect(
      client.githubConvert(repository, "one-use-code"),
    ).rejects.toThrow("remote result is unknown");
    await expect(
      client.githubInstallation(repository, app, "42", "worker"),
    ).rejects.toThrow("could not verify");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds successful response bodies and ignores rejected response text", async () => {
    const cancel = vi.fn();
    const rejected = new Response(new ReadableStream({ cancel }), {
      status: 403,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(new Response("x".repeat(150_000)));
    const client = new ForgeRegistrationClient(fetcher);
    await expect(client.githubConvert(repository, "code")).rejects.toThrow(
      "HTTP 403",
    );
    expect(cancel).toHaveBeenCalledOnce();
    await expect(client.githubConvert(repository, "code")).rejects.toThrow(
      "remote result is unknown",
    );
  });

  it.each([408, 500, 502])(
    "treats HTTP %s during conversion as an uncertain remote result",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response("private detail", { status }),
      );
      await expect(
        new ForgeRegistrationClient(fetcher).githubConvert(repository, "code"),
      ).rejects.toThrow("remote result is unknown");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(["conversion", "installation"] as const)(
    "cancels the production fetch during %s without another request",
    async (operation) => {
      const server = createServer();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Loopback address required");
      const localOrigin = `http://127.0.0.1:${address.port}`;
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>((url, options) =>
        fetch(`${localOrigin}${new URL(String(url)).pathname}`, options),
      );
      const client = new ForgeRegistrationClient(fetcher);
      const requested = once(server, "request");
      const result =
        operation === "conversion"
          ? client.githubConvert(repository, "code", controller.signal)
          : client.githubInstallation(
              repository,
              app,
              "42",
              "worker",
              controller.signal,
            );
      const rejected = expect(result).rejects.toThrow(
        operation === "conversion"
          ? "remote result is unknown"
          : "could not verify",
      );
      try {
        await requested;
        controller.abort();
        await rejected;
        expect(fetcher).toHaveBeenCalledOnce();
      } finally {
        controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe("GitLab project service account registration", () => {
  const repository: ForgeRepository = {
    provider: "gitlab",
    apiUrl: "https://gitlab.example/api/v4",
    projectPath: "group/subgroup/repo",
  };
  const setupToken = "private-setup-token";
  const setupTokenDetails = {
    id: 4,
    user_id: 3,
    name: "CloudX setup",
    active: true,
    revoked: false,
    scopes: ["api"],
    expires_at: null,
  };
  const account = {
    id: 71,
    username: "service_account_project_123_random",
    name: "CloudX worker",
    email: "generated@noreply.gitlab.example",
  };

  it.each([{ accounts: [] }, { accounts: [account] }])(
    "checks the setup token scope and project service-account access without writes or additional pages",
    async ({ accounts }) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(setupTokenDetails))
        .mockResolvedValueOnce(
          Response.json(accounts, { headers: { "x-next-page": "2" } }),
        );
      await expect(
        new ForgeRegistrationClient(fetcher).gitlabCheckSetup(
          repository,
          setupToken,
        ),
      ).resolves.toBeUndefined();
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        "https://gitlab.example/api/v4/personal_access_tokens/self",
        "https://gitlab.example/api/v4/projects/group%2Fsubgroup%2Frepo/service_accounts?per_page=1",
      ]);
      for (const [, options] of fetcher.mock.calls) {
        expect(options).toMatchObject({
          method: "GET",
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
        expect(options).not.toHaveProperty("body");
        expect(new Headers(options?.headers).get("PRIVATE-TOKEN")).toBe(
          setupToken,
        );
      }
    },
  );

  it.each(
    [
      { ...setupTokenDetails, scopes: ["read_api"] },
      { ...setupTokenDetails, scopes: ["write_repository"] },
      { ...setupTokenDetails, active: false },
      { ...setupTokenDetails, revoked: true },
      { ...setupTokenDetails, scopes: "api" },
      [],
    ].map((body) => ({ body })),
  )(
    "rejects insufficient or invalid token evidence before checking project access",
    async ({ body }) => {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(body));
      await expect(
        new ForgeRegistrationClient(fetcher).gitlabCheckSetup(
          repository,
          setupToken,
        ),
      ).rejects.toThrow("api scope");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("rejects an invalid setup token before listing accounts", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(setupToken, { status: 401 }),
    );
    const result = new ForgeRegistrationClient(fetcher).gitlabCheckSetup(
      repository,
      setupToken,
    );
    await expect(result).rejects.toThrow("HTTP 401");
    await expect(result).rejects.not.toThrow(setupToken);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404, 500])(
    "rejects setup access after HTTP %s without exposing the response or retrying",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(setupTokenDetails))
        .mockResolvedValueOnce(
          new Response(`private response ${setupToken}`, { status }),
        );
      const result = new ForgeRegistrationClient(fetcher).gitlabCheckSetup(
        repository,
        setupToken,
      );
      await expect(result).rejects.toThrow(`HTTP ${status}`);
      await expect(result).rejects.not.toThrow(setupToken);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it.each(
    [
      { accounts: [] },
      [null],
      [{ ...account, id: "71" }],
      [{ ...account, username: "" }],
      [{ ...account, name: null }],
      [account, account],
    ].map((body) => ({ body })),
  )("rejects invalid service-account listings", async ({ body }) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(setupTokenDetails))
      .mockResolvedValueOnce(Response.json(body));
    await expect(
      new ForgeRegistrationClient(fetcher).gitlabCheckSetup(
        repository,
        setupToken,
      ),
    ).rejects.toThrow("could not verify GitLab setup access");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds setup response bodies and redacts read failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("x".repeat(150_000)))
      .mockRejectedValueOnce(new Error(setupToken));
    const client = new ForgeRegistrationClient(fetcher);
    await expect(
      client.gitlabCheckSetup(repository, setupToken),
    ).rejects.toThrow("could not verify GitLab setup access");
    const failedRead = client.gitlabCheckSetup(repository, setupToken);
    await expect(failedRead).rejects.toThrow(
      "could not verify GitLab setup access",
    );
    await expect(failedRead).rejects.not.toThrow(setupToken);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid or canceled setup checks before contacting GitLab", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new ForgeRegistrationClient(fetcher);
    await expect(
      client.gitlabCheckSetup(repository, "\r\nsecret"),
    ).rejects.toThrow("setup token");
    await expect(
      client.gitlabCheckSetup(repository, setupToken, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stops preflight before project access if canceled while checking the token", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      controller.abort();
      return Response.json(setupTokenDetails);
    });
    await expect(
      new ForgeRegistrationClient(fetcher).gitlabCheckSetup(
        repository,
        setupToken,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("creates one project-owned service account per role without changing membership or creating tokens", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(account, { status: 201 }),
    );
    const client = new ForgeRegistrationClient(fetcher);
    await expect(
      client.gitlabCreateAccount(repository, "worker", setupToken),
    ).resolves.toEqual({
      id: "71",
      username: account.username,
      name: account.name,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://gitlab.example/api/v4/projects/group%2Fsubgroup%2Frepo/service_accounts",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      name: "CloudX worker",
    });
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).get("PRIVATE-TOKEN"),
    ).toBe(setupToken);
  });

  it.each([
    ["worker", 40],
    ["reviewer", 30],
  ] as const)(
    "grants the %s only its required project membership",
    async (role, accessLevel) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({
          ...account,
          access_level: accessLevel,
          state: "active",
        }),
      );
      await expect(
        new ForgeRegistrationClient(fetcher).gitlabGrantAccess(
          repository,
          role,
          "71",
          setupToken,
        ),
      ).resolves.toBeUndefined();
      expect(fetcher.mock.calls[0][0]).toBe(
        "https://gitlab.example/api/v4/projects/group%2Fsubgroup%2Frepo/members",
      );
      expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
        user_id: 71,
        access_level: accessLevel,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { ...account, access_level: 30, state: "active" },
    { ...account, id: 72, access_level: 40, state: "active" },
    { ...account, access_level: 40, state: "blocked" },
    {
      message: {
        service_account: "Request queued for administrator approval.",
      },
    },
  ])(
    "does not report an ungranted or pending membership as ready",
    async (body) => {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(body));
      await expect(
        new ForgeRegistrationClient(fetcher).gitlabGrantAccess(
          repository,
          "worker",
          "71",
          setupToken,
        ),
      ).rejects.toThrow("remote result is unknown");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(["worker", "reviewer"] as const)(
    "creates a private token for the %s account with explicit API and Git scopes",
    async (role) => {
      const scopes = [
        "api",
        role === "worker" ? "write_repository" : "read_repository",
      ];
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({
          id: 6,
          user_id: 71,
          name: `CloudX ${role}`,
          token: "private-bot-token",
          active: true,
          revoked: false,
          scopes,
          expires_at: "2099-09-07",
        }),
      );
      const result = await new ForgeRegistrationClient(
        fetcher,
      ).gitlabCreateToken(repository, role, "71", setupToken);
      expect(result).toEqual({
        id: "6",
        userId: "71",
        token: "private-bot-token",
        expiresAt: "2099-09-07",
      });
      expect(fetcher.mock.calls[0][0]).toBe(
        "https://gitlab.example/api/v4/projects/group%2Fsubgroup%2Frepo/service_accounts/71/personal_access_tokens",
      );
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
        name: `CloudX ${role}`,
        scopes,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { user_id: 72 },
    { revoked: true },
    { active: false },
    { token: "" },
    { expires_at: "2000-01-01" },
    { scopes: ["read_api"] },
  ])(
    "rejects token evidence for another user, expired tokens, or insufficient scopes",
    async (overrides) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({
          id: 6,
          user_id: 71,
          token: "private-bot-token",
          active: true,
          revoked: false,
          scopes: ["api", "write_repository"],
          expires_at: "2099-09-07",
          ...overrides,
        }),
      );
      await expect(
        new ForgeRegistrationClient(fetcher).gitlabCreateToken(
          repository,
          "worker",
          "71",
          setupToken,
        ),
      ).rejects.toThrow("remote result is unknown");
    },
  );

  it.each([null, undefined])(
    "preserves instance policy when a service token has no expiration",
    async (expires_at) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({
          id: 6,
          user_id: 71,
          token: "private-bot-token",
          active: true,
          revoked: false,
          scopes: ["api", "read_repository"],
          expires_at,
        }),
      );
      const token = await new ForgeRegistrationClient(
        fetcher,
      ).gitlabCreateToken(repository, "reviewer", "71", setupToken);
      expect(token).not.toHaveProperty("expiresAt");
    },
  );

  it("does not contact GitLab for malformed or canceled setup requests", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new ForgeRegistrationClient(fetcher);
    await expect(
      client.gitlabCreateAccount(repository, "worker", "\r\nsecret"),
    ).rejects.toThrow("setup token");
    await expect(
      client.gitlabCreateAccount(
        repository,
        "worker",
        setupToken,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    await expect(
      client.gitlabGrantAccess(repository, "worker", "../71", setupToken),
    ).rejects.toThrow();
    await expect(
      client.gitlabCreateToken(repository, "worker", "71", ""),
    ).rejects.toThrow("setup token");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never retries or exposes the setup token after an ambiguous account creation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(setupToken);
    });
    const result = new ForgeRegistrationClient(fetcher).gitlabCreateAccount(
      repository,
      "worker",
      setupToken,
    );
    await expect(result).rejects.toThrow("remote result is unknown");
    await expect(result).rejects.not.toThrow(setupToken);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
