import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ForgeRepository } from "@cloudx/shared";
import { ConfigSecretStore } from "../../configSecretStore.js";
import {
  connectionKey,
  ForgeConnectionStore,
  type ForgeConnectionRecords,
  type StoredForgeConnection,
} from "./ForgeConnectionStore.js";

const invalidStateMessage = "Invalid saved Forge application state.";
const github: ForgeRepository = {
  provider: "github",
  apiUrl: "https://api.github.com",
  projectPath: "owner/repo",
};
const gitlab: ForgeRepository = {
  provider: "gitlab",
  apiUrl: "https://gitlab.com/api/v4",
  projectPath: "group/project",
};
const app = {
  appId: "123",
  privateKey:
    "-----BEGIN PRIVATE KEY-----\nprivate-app-material\n-----END PRIVATE KEY-----\n",
  slug: "cloudx-worker",
  name: "CloudX worker",
};
const account = {
  id: "71",
  username: "service_account_project_42_random",
  name: "CloudX reviewer",
};
const attempt = {
  state: "s".repeat(43),
  cookieHash: "a".repeat(64),
  origin: "http://127.0.0.1:5173",
  expiresAt: "2099-09-07T00:00:00.000Z",
};
const worker: StoredForgeConnection = {
  repository: github,
  role: "worker",
  phase: "connected",
  app,
  installationId: "42",
};
const reviewer: StoredForgeConnection = {
  repository: gitlab,
  role: "reviewer",
  phase: "connected",
  account,
  token: "private-bot-token",
  tokenId: "6",
  expiresAt: "2099-09-07",
};

function records(
  ...connections: StoredForgeConnection[]
): ForgeConnectionRecords {
  return Object.fromEntries(
    connections.map((connection) => [
      connectionKey(connection.repository, connection.role),
      connection,
    ]),
  );
}

describe("private Forge connection persistence", () => {
  let directory: string;
  let store: ForgeConnectionStore;
  let secrets: ConfigSecretStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "cloudx-forge-connections-"));
    store = new ForgeConnectionStore(directory);
    secrets = new ConfigSecretStore(directory);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function saveRaw(value: string) {
    await secrets.update({
      global: {},
      plugins: { forge: { applications: value } },
    });
  }

  it("starts empty and roundtrips both bot credentials in a private 0600 file", async () => {
    expect(store.read()).toEqual({});
    const connections = records(worker, reviewer);
    await store.write(connections);
    expect(new ForgeConnectionStore(directory).read()).toEqual(connections);
    expect((await stat(secrets.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(secrets.secretDirectoryPath)).mode & 0o777).toBe(0o700);
    expect(
      JSON.parse(await readFile(secrets.filePath, "utf8")).plugins.forge
        .applications,
    ).toBe(JSON.stringify(connections));
  });

  it("keeps other secrets when independent owners update the private file", async () => {
    await Promise.all([
      store.write(records(worker)),
      secrets.update({
        global: { unrelated: "private-global-value" },
        plugins: { another: { accessToken: "private-other-token" } },
      }),
    ]);
    expect(store.read()).toEqual(records(worker));
    expect(secrets.getPluginSecret("another", "accessToken")).toBe(
      "private-other-token",
    );
    expect(secrets.hasGlobalSecret("unrelated")).toBe(true);
  });

  it("never exposes malformed application JSON through a parsing exception", async () => {
    await saveRaw("secret-credential-that-must-stay-private");
    expect(() => store.read()).toThrow(new Error(invalidStateMessage));
  });

  it("sanitizes failures from the underlying secret file as well", async () => {
    await store.write(records(worker));
    await writeFile(
      secrets.filePath,
      "outer-secret-credential-that-must-stay-private",
    );
    expect(() => store.read()).toThrow(new Error(invalidStateMessage));
    await expect(store.write(records(worker))).rejects.toThrow(
      new Error("Could not save Forge application state."),
    );
    expect(await readFile(secrets.filePath, "utf8")).toBe(
      "outer-secret-credential-that-must-stay-private",
    );
  });

  it.each([
    null,
    [],
    { unrelated: {} },
    records({
      ...worker,
      role: "operator",
    } as unknown as StoredForgeConnection),
    records({ ...worker, phase: "ready" } as unknown as StoredForgeConnection),
    records({ ...worker, installationId: "not-an-id" }),
    records({ ...worker, app: { ...app, appId: "0" } }),
    records({ ...worker, app: { ...app, slug: "../../other-app" } }),
    records({ ...worker, app: undefined }),
    records({
      ...worker,
      setupToken: "one-time-secret",
    } as StoredForgeConnection),
    records({ ...worker, token: "wrong-provider-token" }),
    records({ ...reviewer, token: undefined }),
    records({ ...reviewer, tokenId: "0" }),
    records({ ...reviewer, expiresAt: "not-a-date" }),
    records({ ...reviewer, expiresAt: "2099-02-31" }),
    records({ ...reviewer, account: { ...account, id: "../71" } }),
    records({
      ...worker,
      phase: "installing",
      attempt: { ...attempt, state: "short" },
    }),
    records({
      ...worker,
      phase: "installing",
      attempt: { ...attempt, cookieHash: "not-a-hash" },
    }),
    records({
      ...worker,
      phase: "installing",
      attempt: { ...attempt, origin: "https://user:private@example.com" },
    }),
    records({
      ...worker,
      phase: "installing",
      attempt: { ...attempt, expiresAt: "not-a-date" },
    }),
    records({ ...worker, phase: "installing", attempt: undefined }),
  ])(
    "rejects invalid serialized records with the same secret-safe error",
    async (value) => {
      await saveRaw(JSON.stringify(value));
      expect(() => store.read()).toThrow(new Error(invalidStateMessage));
    },
  );

  it("rejects repository key mismatches and malformed repository fields", async () => {
    await saveRaw(
      JSON.stringify({
        [connectionKey(github, "worker")]: {
          ...worker,
          repository: { ...github, projectPath: "another/repo" },
        },
      }),
    );
    expect(() => store.read()).toThrow(new Error(invalidStateMessage));
    await saveRaw(
      JSON.stringify({
        [connectionKey(github, "worker")]: {
          ...worker,
          repository: { ...github, projectPath: 12 },
        },
      }),
    );
    expect(() => store.read()).toThrow(new Error(invalidStateMessage));
  });

  it("rejects oversized serialized state before it can replace saved credentials", async () => {
    await store.write(records(reviewer));
    const oversized = records(
      ...Array.from({ length: 50 }, (_, index) => ({
        ...worker,
        repository: { ...github, projectPath: `owner/repo-${index}` },
        app: { ...app, privateKey: "private".repeat(4000) },
      })),
    );
    await expect(store.write(oversized)).rejects.toThrow(
      new Error(invalidStateMessage),
    );
    expect(store.read()).toEqual(records(reviewer));
    await saveRaw(JSON.stringify(oversized));
    expect(() => store.read()).toThrow(new Error(invalidStateMessage));
  });

  it("validates writes before modifying the private file", async () => {
    await store.write(records(worker));
    await expect(
      store.write(
        records({
          ...reviewer,
          setupToken: "one-time-secret",
        } as StoredForgeConnection),
      ),
    ).rejects.toThrow(new Error(invalidStateMessage));
    expect(store.read()).toEqual(records(worker));
  });

  it("preserves interrupted phases, valid nonce state, and expired credentials for explicit recovery", async () => {
    const connections = records(
      { repository: github, role: "worker", phase: "converting", attempt },
      { ...reviewer, phase: "creating_token", expiresAt: "2000-01-01" },
    );
    await store.write(connections);
    expect(store.read()).toEqual(connections);
  });
});
