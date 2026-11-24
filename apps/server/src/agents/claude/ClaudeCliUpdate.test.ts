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

async function updaterFixture(channel: "stable" | "latest" | null, resultVersion = "2.1.331", currentVersion = "2.1.325") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-updater-")); roots.push(root);
  const command = path.join(root, "claude"), calls = path.join(root, "updater.json");
  const inspection = path.join(root, "inspection.json"), doctorReport = path.join(root, "doctor.txt");
  const providerHome = path.join(root, "provider"); await fs.mkdir(providerHome);
  const managedSettings = path.join(root, "managed", "managed-settings.json");
  await fs.mkdir(path.dirname(managedSettings));
  const saved = JSON.stringify({ ...(channel ? { autoUpdatesChannel: channel } : {}), model: "sonnet", theme: "dark" });
  await fs.writeFile(path.join(providerHome, "settings.json"), saved);
  await fs.writeFile(command, `#!${process.execPath}
import fs from "node:fs";
if (process.argv[2] === "--version") console.log((fs.existsSync(${JSON.stringify(calls)}) ? ${JSON.stringify(resultVersion)} : ${JSON.stringify(currentVersion)}) + " (Claude Code)");
else if (process.argv.at(-1) === "doctor") {
  fs.writeFileSync(${JSON.stringify(inspection)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR, updatesDisabled: process.env.DISABLE_AUTOUPDATER }));
  const inline = JSON.parse(process.argv[process.argv.indexOf("--settings") + 1]);
  const policy = fs.existsSync(${JSON.stringify(managedSettings)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(managedSettings)}, "utf8")) : {};
  console.log(fs.existsSync(${JSON.stringify(doctorReport)}) ? fs.readFileSync(${JSON.stringify(doctorReport)}, "utf8") : "Claude Code doctor\\nAuto-update channel: " + (policy.autoUpdatesChannel ?? inline.autoUpdatesChannel) + "\\nManaged settings (remote): not fetched — no usable credentials for the settings fetch");
}
else { fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2), updatesDisabled:process.env.DISABLE_AUTOUPDATER})); fs.appendFileSync(${JSON.stringify(command)}, "\\n// Updated executable\\n"); console.log("Updated reviewed fixture"); }
`, { mode: 0o700 });
  const service = new ClaudeSettingsService(path.join(root, "data"), () => providerHome, { PATH: process.env.PATH, HOME: root, CLOUDX_CLAUDE_BIN: command });
  return { service, calls, command, executable: await fs.readFile(command), managedSettings, inspection, doctorReport, providerHome, settings: path.join(providerHome, "settings.json"), saved };
}

it.each(["2.1.331", "2.1.332"])("refuses managed latest over saved stable before effective target %s can replace the executable", async effectiveTarget => {
  const fixture = await updaterFixture("stable", effectiveTarget);
  await fs.writeFile(fixture.managedSettings, JSON.stringify({ autoUpdatesChannel: "latest" }));
  const fetcher = vi.fn(async (url: string) => new Response(url.endsWith("/stable") ? "2.1.325" : effectiveTarget));
  vi.stubGlobal("fetch", fetcher);
  let failure: unknown;
  try { await fixture.service.updateCli(); } catch (error) { failure = error; }
  await expect(fs.stat(fixture.calls)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(fixture.command)).toEqual(fixture.executable);
  expect(await fs.readFile(fixture.settings, "utf8")).toBe(fixture.saved);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/managed.*channel.*no updater has started/i);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([["stable", "2.1.325", false], ["latest", "2.1.331", false], [null, "2.1.331", false], ["stable", "2.1.325", true], ["latest", "2.1.331", true]] as const)("checks %s target %s before invoking the updater and preserves saved choices (managed: %s)", async (channel, target, managed) => {
  const fixture = await updaterFixture(channel, target);
  if (managed) await fs.writeFile(fixture.managedSettings, JSON.stringify({ autoUpdatesChannel: channel }));
  const fetcher = vi.fn().mockResolvedValue(new Response(target)); vi.stubGlobal("fetch", fetcher);
  const result = await fixture.service.updateCli();
  expect(JSON.parse(await fs.readFile(fixture.inspection, "utf8"))).toEqual({ args: ["--settings", JSON.stringify({ autoUpdatesChannel: channel ?? "latest" }), "doctor"], cwd: process.cwd(), configDir: fixture.providerHome, updatesDisabled: "1" });
  expect(fetcher).toHaveBeenCalledWith(`https://downloads.claude.ai/claude-code-releases/${channel ?? "latest"}`, expect.objectContaining({ redirect: "error" }));
  expect(JSON.parse(await fs.readFile(fixture.calls, "utf8"))).toEqual({ args: ["--settings", JSON.stringify({ autoUpdatesChannel: channel ?? "latest" }), "update"], updatesDisabled: "1" });
  expect(result).toMatchObject({ installed: true, version: `${target} (Claude Code)` });
  expect(result.output).toContain(`Reviewed ${channel ?? "latest"} target: ${target}`);
  expect(await fs.readFile(fixture.settings, "utf8")).toBe(fixture.saved);
});

it.each([
  "no usable credentials for the settings fetch", "requires an Enterprise or Team subscription",
  "not available with a custom ANTHROPIC_BASE_URL", "not available on Bedrock/Vertex/third-party providers"
])("accepts the native channel when remote policy is explicitly ineligible: %s", async reason => {
  const fixture = await updaterFixture("stable", "2.1.325");
  await fs.writeFile(fixture.doctorReport, `Auto-update channel: stable\nManaged settings (remote): not fetched — ${reason}\n`);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("2.1.325")));
  await expect(fixture.service.updateCli()).resolves.toMatchObject({ installed: true });
});

it.each([
  "loaded", "none configured for this organization", "checking… (fetch in progress; re-run in a moment)",
  "fetch failed — using stale cache", "fetch failed — no policy applied", "not fetched — the organization sign-in is due for renewal",
  "not fetched — unknown policy reason"
])("refuses an unestablished remote channel snapshot before mutation: %s", async state => {
  const fixture = await updaterFixture("stable");
  await fs.writeFile(fixture.doctorReport, `Auto-update channel: stable\nManaged settings (remote): ${state}\n`);
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(fixture.service.updateCli()).rejects.toThrow(/effective Claude update policy.*no updater has started/);
  await expect(fs.stat(fixture.calls)).rejects.toMatchObject({ code: "ENOENT" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await fs.readFile(fixture.command)).toEqual(fixture.executable);
  expect(await fs.readFile(fixture.settings, "utf8")).toBe(fixture.saved);
});

it.each([
  "private-native-output", "Auto-update channel: rc", "Auto-update channel: stable\nAuto-update channel: latest",
  "Auto-update channel: stable\nAuto-update channel: rc\nManaged settings (remote): not fetched — no usable credentials for the settings fetch",
  "Auto-update channel: stable\nManaged settings (remote): not fetched — no usable credentials for the settings fetch\nManaged settings (remote): loaded",
  ...["fetched", "cached"].map(source => `Auto-update channel: stable\nManaged settings (remote): not fetched — no usable credentials for the settings fetch\nManaged settings (${source}): private-native-output`)
])("refuses missing, ambiguous or cached native policy without exposing its output %#", async diagnostic => {
  const fixture = await updaterFixture("stable");
  await fs.writeFile(fixture.doctorReport, diagnostic);
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const update = fixture.service.updateCli();
  await expect(update).rejects.toThrow(/effective Claude update policy.*no updater has started/);
  await expect(update).rejects.not.toThrow("private-native-output");
  await expect(fs.stat(fixture.calls)).rejects.toMatchObject({ code: "ENOENT" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await fs.readFile(fixture.command)).toEqual(fixture.executable);
  expect(await fs.readFile(fixture.settings, "utf8")).toBe(fixture.saved);
});

it("refuses a failed native inspection without exposing private diagnostic errors", async () => {
  const fixture = await updaterFixture("stable");
  await fs.writeFile(fixture.managedSettings, "invalid-private-policy-json");
  const update = fixture.service.updateCli();
  await expect(update).rejects.toThrow(/effective Claude update policy.*no updater has started/);
  await expect(update).rejects.not.toThrow("invalid-private-policy-json");
  await expect(fs.stat(fixture.calls)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(fixture.command)).toEqual(fixture.executable);
  expect(await fs.readFile(fixture.settings, "utf8")).toBe(fixture.saved);
});

it("does not inspect an unreviewed native version or start its updater", async () => {
  const fixture = await updaterFixture("stable", "2.1.325", "2.1.332");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(fixture.service.updateCli()).rejects.toThrow(/no updater has started/);
  await expect(fs.stat(fixture.inspection)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(fixture.calls)).rejects.toMatchObject({ code: "ENOENT" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await fs.readFile(fixture.command)).toEqual(fixture.executable);
  expect(await fs.readFile(fixture.settings, "utf8")).toBe(fixture.saved);
});

it("reads the native channel from ANSI-colored CRLF diagnostics", async () => {
  const fixture = await updaterFixture("stable", "2.1.325");
  await fs.writeFile(fixture.doctorReport, "\u001b[32mAuto-update channel: stable\u001b[0m\r\nManaged settings (remote): not fetched — no usable credentials for the settings fetch\r\n");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("2.1.325")));
  await expect(fixture.service.updateCli()).resolves.toMatchObject({ installed: true });
});

it("does not inspect or update a native executable after cancellation", async () => {
  const fixture = await updaterFixture("stable");
  const controller = new AbortController(); controller.abort();
  await expect(fixture.service.updateCli(controller.signal)).rejects.toThrow(/no updater has started/);
  await expect(fs.stat(fixture.inspection)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(fixture.calls)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(fixture.command)).toEqual(fixture.executable);
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
