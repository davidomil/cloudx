import { afterEach, describe, expect, it, vi } from "vitest";
import { connectForgeGitLab, getForgeConnections, startForgeGitHubConnection } from "./api.js";

const repository = { provider: "github" as const, apiUrl: "https://api.github.com", projectPath: "cloudx/example" };
const connections = { repository, roles: [{ role: "worker", state: "disconnected" }, { role: "reviewer", state: "connected", name: "Reviewer app" }] };
const response = (body: unknown) => new Response(JSON.stringify(body));

afterEach(() => vi.unstubAllGlobals());

describe("Forge connection transport", () => {
  it("loads public status with cancellation and strips unrelated response data", async () => {
    const fetch = vi.fn(async () => response({ ...connections, privateKey: "must-not-enter-UI-state" }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await expect(getForgeConnections(signal)).resolves.toEqual(connections);
    expect(fetch).toHaveBeenCalledWith("/api/forge/connections", { signal, headers: undefined });
  });

  it.each([
    { roles: [] },
    { ...connections, roles: [{ role: "worker", state: "connected" }, { role: "worker", state: "failed" }] },
    { ...connections, roles: [{ role: "worker", state: "unknown" }, connections.roles[1]] },
    { ...connections, repository: { ...repository, apiUrl: "javascript:alert(1)" } },
    { ...connections, roles: [{ role: "worker", state: "registering", expiresAt: "invalid" }, connections.roles[1]] }
  ])("rejects malformed connection state", async value => {
    vi.stubGlobal("fetch", vi.fn(async () => response(value)));
    await expect(getForgeConnections()).rejects.toThrow("Invalid Forge connection response");
  });

  it("starts the exact GitHub role and validates its consent action", async () => {
    const action = { method: "POST", url: "https://github.com/settings/apps/new", fields: { manifest: "{}" } };
    const fetch = vi.fn(async () => response(action));
    vi.stubGlobal("fetch", fetch);
    await expect(startForgeGitHubConnection(repository, "reviewer")).resolves.toEqual(action);
    expect(fetch).toHaveBeenCalledWith("/api/forge/connections/github/start", { method: "POST", body: JSON.stringify({ repository, role: "reviewer" }), headers: { "content-type": "application/json" } });
  });

  it.each([
    { method: "DELETE", url: "https://github.com/apps/new" },
    { method: "GET", url: "javascript:alert(1)" },
    { method: "POST", url: "https://github.com/apps/new", fields: { manifest: 3 } }
  ])("rejects unsafe or malformed consent actions", async action => {
    vi.stubGlobal("fetch", vi.fn(async () => response(action)));
    await expect(startForgeGitHubConnection(repository, "worker")).rejects.toThrow("Invalid Forge connection action");
  });

  it("sends the temporary GitLab setup token only in the request body", async () => {
    const fetch = vi.fn(async () => response(connections));
    vi.stubGlobal("fetch", fetch);
    await connectForgeGitLab(repository, "temporary-setup-token");
    expect(fetch).toHaveBeenCalledWith("/api/forge/connections/gitlab", { method: "POST", body: JSON.stringify({ repository, setupToken: "temporary-setup-token" }), headers: { "content-type": "application/json" } });
  });
});
