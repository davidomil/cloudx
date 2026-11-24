import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeSettingsService } from "./ClaudeSettingsService.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function updaterFixture(channel: "stable" | "latest" | null, resultVersion = "2.1.331") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-updater-")); roots.push(root);
  const command = path.join(root, "claude"), calls = path.join(root, "updater.json");
  const providerHome = path.join(root, "provider"); await fs.mkdir(providerHome);
  const saved = JSON.stringify({ ...(channel ? { autoUpdatesChannel: channel } : {}), model: "sonnet", theme: "dark" });
  await fs.writeFile(path.join(providerHome, "settings.json"), saved);
  await fs.writeFile(command, `#!${process.execPath}
import fs from "node:fs";
if (process.argv[2] === "--version") console.log(${JSON.stringify(`${resultVersion} (Claude Code)`)});
else { fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2), updatesDisabled:process.env.DISABLE_AUTOUPDATER})); console.log("Updated reviewed fixture"); }
`, { mode: 0o700 });
  const service = new ClaudeSettingsService(path.join(root, "data"), () => providerHome, { PATH: process.env.PATH, HOME: root, CLOUDX_CLAUDE_BIN: command });
  return { service, calls, settings: path.join(providerHome, "settings.json"), saved };
}

it.each([["stable", "2.1.325"], ["latest", "2.1.331"], [null, "2.1.331"]] as const)("checks the exact %s release before invoking the native updater and preserves saved choices", async (channel, target) => {
  const fixture = await updaterFixture(channel, target);
  const fetcher = vi.fn().mockResolvedValue(new Response(target)); vi.stubGlobal("fetch", fetcher);
  const result = await fixture.service.updateCli();
  expect(fetcher).toHaveBeenCalledWith(`https://downloads.claude.ai/claude-code-releases/${channel ?? "latest"}`, expect.objectContaining({ redirect: "error" }));
  expect(JSON.parse(await fs.readFile(fixture.calls, "utf8"))).toEqual({ args: ["--settings", JSON.stringify({ autoUpdatesChannel: channel ?? "latest" }), "update"], updatesDisabled: "1" });
  expect(result).toMatchObject({ installed: true, version: `${target} (Claude Code)` });
  expect(result.output).toContain(`Reviewed ${channel ?? "latest"} target: ${target}`);
  expect(await fs.readFile(fixture.settings, "utf8")).toBe(fixture.saved);
});

it.each([new Response("2.1.332"), new Response("9".repeat(65)), new Response("unexpected channel response"), new Response("denied", { status: 403 })])("leaves the executable and settings intact when the channel is unreviewed or cannot be verified %#", async response => {
  const fixture = await updaterFixture("stable");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(fixture.service.updateCli()).rejects.toThrow(/no updater has started/i);
  await expect(fs.stat(fixture.calls)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(fixture.settings, "utf8")).toBe(fixture.saved);
});

it("rejects a native updater no-op rather than presenting another reviewed version as the selected target", async () => {
  const fixture = await updaterFixture("latest", "2.1.325");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("2.1.331")));
  await expect(fixture.service.updateCli()).rejects.toThrow("did not select the verified latest target 2.1.331");
  expect(await fs.readFile(fixture.settings, "utf8")).toBe(fixture.saved);
});

it("refuses completion when the native updater selected an unreviewed executable", async () => {
  const fixture = await updaterFixture("latest", "2.1.332");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("2.1.331")));
  await expect(fixture.service.updateCli()).rejects.toThrow("unsupported or unrecognized version");
});

it("does not start the native updater when the channel lookup fails", async () => {
  const fixture = await updaterFixture("latest");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unavailable")));
  await expect(fixture.service.updateCli()).rejects.toThrow("Cannot verify the Claude latest channel target");
  await expect(fs.stat(fixture.calls)).rejects.toMatchObject({ code: "ENOENT" });
});
