import { describe, expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { LocalWebPlugin, normalizeLocalWebUrl, redactLocalWebUrlForVoice } from "./LocalWebPlugin.js";

describe("LocalWebPlugin", () => {
  it("declares that it can be created without a directory", () => {
    expect(new LocalWebPlugin().descriptor()).toMatchObject({
      acronym: "WEB",
      requiresDirectory: false
    });
  });

  it("opens a loopback dashboard URL, preserving tokens for UI state while redacting voice context", async () => {
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
    const voiceContext = await Promise.resolve(session.voiceContext());
    expect(voiceContext).toMatchObject({
      kind: "local-web",
      currentPath: "http://127.0.0.1:5173/",
      metadata: { url: "http://127.0.0.1:5173/", urlRedacted: true }
    });
    expect(voiceContext.summary).not.toContain("f5d6");
    expect(voiceContext.visibleText).not.toContain("token=");
  });

  it("updates and clears the local web URL through plugin actions", () => {
    const tab = workspaceTab();
    const session = new LocalWebPlugin().createSession({
      tab,
      cwd: tab.cwd,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined }
    });

    expect(session.handleAction("open_url", { url: "https://100.64.0.20:8443/dashboard?token=abc" })).toMatchObject({
      url: "https://100.64.0.20:8443/dashboard?token=abc"
    });
    expect(session.handleAction("get_state", {})).toMatchObject({
      url: "https://100.64.0.20:8443/dashboard?token=abc"
    });
    expect(session.handleAction("clear_url", {})).toEqual({});
  });

  it("rejects non-local or unsafe web URLs", () => {
    expect(() => normalizeLocalWebUrl("https://example.com")).toThrow(/host must be/);
    expect(() => normalizeLocalWebUrl("file:///tmp/report.html")).toThrow(/http/);
    expect(() => normalizeLocalWebUrl("https://user:pass@127.0.0.1:5173")).toThrow(/credentials/);
    expect(() => normalizeLocalWebUrl("http://100.64.0.20:5173")).toThrow(/Plain HTTP/);
  });

  it("rejects link-local and cloud metadata IP literals", () => {
    expect(() => normalizeLocalWebUrl("https://169.254.169.254/latest/meta-data/")).toThrow(/link-local/);
    expect(() => normalizeLocalWebUrl("https://169.254.10.20/dashboard")).toThrow(/link-local/);
    expect(() => normalizeLocalWebUrl("https://[fe80::1]/dashboard")).toThrow(/link-local/);
    expect(() => normalizeLocalWebUrl("https://[febf::1]/dashboard")).toThrow(/link-local/);
  });

  it("accepts loopback host variants for local HTTP", () => {
    expect(normalizeLocalWebUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeLocalWebUrl("http://dev.localhost:5173/path")).toBe("http://dev.localhost:5173/path");
    expect(normalizeLocalWebUrl("http://[::1]:5173/path")).toBe("http://[::1]:5173/path");
    expect(normalizeLocalWebUrl("http://[::ffff:127.0.0.1]:5173")).toBe("http://[::ffff:7f00:1]:5173/");
  });

  it("accepts local HTTPS hostnames for LAN and tailnet dashboards", () => {
    expect(normalizeLocalWebUrl("https://100.64.0.20:8443/dashboard")).toBe("https://100.64.0.20:8443/dashboard");
    expect(normalizeLocalWebUrl("https://[fd00::1]:8443/dashboard")).toBe("https://[fd00::1]:8443/dashboard");
    expect(normalizeLocalWebUrl("https://[::ffff:100.64.0.20]:8443/dashboard")).toBe("https://[::ffff:6440:14]:8443/dashboard");
    expect(normalizeLocalWebUrl("https://devbox.local:5173/?token=host")).toBe("https://devbox.local:5173/?token=host");
    expect(normalizeLocalWebUrl("https://cloudx.tailnet.ts.net:5173/?token=tailnet")).toBe("https://cloudx.tailnet.ts.net:5173/?token=tailnet");
  });

  it("classifies IPv4-mapped IPv6 link-local addresses as unsafe", () => {
    expect(() => normalizeLocalWebUrl("https://[::ffff:169.254.169.254]/latest/meta-data/")).toThrow(/link-local/);
  });

  it("redacts local web query strings and fragments for voice planner context", () => {
    expect(redactLocalWebUrlForVoice("https://devbox.local:5173/dashboard?token=abc&view=graph#secret")).toBe("https://devbox.local:5173/dashboard");
    expect(redactLocalWebUrlForVoice("not a url")).toBe("[invalid local web URL]");
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
