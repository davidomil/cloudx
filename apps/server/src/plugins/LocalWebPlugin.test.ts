import { describe, expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { LocalWebPlugin, normalizeLocalWebUrl } from "./LocalWebPlugin.js";

describe("LocalWebPlugin", () => {
  it("declares that it can be created without a directory", () => {
    expect(new LocalWebPlugin().descriptor()).toMatchObject({
      acronym: "WEB",
      requiresDirectory: false
    });
  });

  it("opens a loopback dashboard URL and preserves token query strings", () => {
    const tab = workspaceTab();
    const session = new LocalWebPlugin().createSession({
      tab,
      cwd: tab.cwd,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined },
      initialInput: { url: "http://127.0.0.1:5173?token=f5d6#graph" }
    });

    expect(session.snapshot()).toMatchObject({
      tabId: "tab-1",
      pluginId: "local-web",
      state: { url: "http://127.0.0.1:5173/?token=f5d6#graph" }
    });
    expect(session.voiceContext()).toMatchObject({
      kind: "local-web",
      currentPath: "http://127.0.0.1:5173/?token=f5d6#graph",
      metadata: { url: "http://127.0.0.1:5173/?token=f5d6#graph" }
    });
  });

  it("updates and clears the local web URL through plugin actions", () => {
    const tab = workspaceTab();
    const session = new LocalWebPlugin().createSession({
      tab,
      cwd: tab.cwd,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    expect(session.handleAction("open_url", { url: "https://192.168.1.20:8443/dashboard?token=abc" })).toMatchObject({
      url: "https://192.168.1.20:8443/dashboard?token=abc"
    });
    expect(session.handleAction("get_state", {})).toMatchObject({
      url: "https://192.168.1.20:8443/dashboard?token=abc"
    });
    expect(session.handleAction("clear_url", {})).toMatchObject({
      url: undefined
    });
  });

  it("rejects non-local or unsafe web URLs", () => {
    expect(() => normalizeLocalWebUrl("https://example.com")).toThrow(/host must be/);
    expect(() => normalizeLocalWebUrl("file:///tmp/report.html")).toThrow(/http/);
    expect(() => normalizeLocalWebUrl("https://user:pass@127.0.0.1:5173")).toThrow(/credentials/);
    expect(() => normalizeLocalWebUrl("http://192.168.1.20:5173")).toThrow(/Plain HTTP/);
  });

  it("accepts loopback host variants for local HTTP", () => {
    expect(normalizeLocalWebUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeLocalWebUrl("http://dev.localhost:5173/path")).toBe("http://dev.localhost:5173/path");
    expect(normalizeLocalWebUrl("http://[::1]:5173/path")).toBe("http://[::1]:5173/path");
  });

  it("accepts local HTTPS hostnames for LAN and tailnet dashboards", () => {
    expect(normalizeLocalWebUrl("https://devbox.local:5173/?token=host")).toBe("https://devbox.local:5173/?token=host");
    expect(normalizeLocalWebUrl("https://cloudx.tailnet.ts.net:5173/?token=tailnet")).toBe("https://cloudx.tailnet.ts.net:5173/?token=tailnet");
  });
});

function workspaceTab(): WorkspaceTab {
  return {
    id: "tab-1",
    pluginId: "local-web",
    title: "Local Web",
    cwd: "/workspace",
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
