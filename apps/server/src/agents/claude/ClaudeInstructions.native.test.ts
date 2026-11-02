import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";

const claude = process.env.CLOUDX_NATIVE_CLAUDE;
const native = it.skipIf(!claude);
const run = promisify(execFile);

type NativeRequest = { messages: unknown[]; system?: unknown; stream?: boolean };

async function instructionFixture() {
  expect((await run(claude!, ["--version"], { timeout: 10_000 })).stdout.trim()).toBe("2.1.316 (Claude Code)");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-claude-instructions-"));
  const providerHome = path.join(root, "personal home", ".claude");
  const cwd = path.join(root, "project");
  const accountHome = path.join(root, "account");
  await Promise.all([providerHome, cwd, accountHome].map(directory => fs.mkdir(directory, { recursive: true })));
  const statePath = path.join(providerHome, ".claude.json");
  await fs.writeFile(statePath, JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  const requests: NativeRequest[] = [];
  let readFile: string | undefined;
  const server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (request.url?.includes("count_tokens")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    if (!request.url?.includes("messages")) { response.writeHead(404); response.end(); return; }
    const body = JSON.parse(text) as NativeRequest;
    requests.push(body);
    const read = readFile && requests.length === 1;
    const block = read ? { type: "tool_use", id: "tool_read_fixture", name: "Read", input: { file_path: readFile } } : { type: "text", text: "Local fixture complete." };
    const message = {
      id: `msg_fixture_${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [block],
      stop_reason: read ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }
    };
    if (!body.stream) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(message));
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    const content = read ? { ...block, input: {} } : { type: "text", text: "" };
    const delta = read ? { type: "input_json_delta", partial_json: JSON.stringify({ file_path: readFile }) } : { type: "text_delta", text: "Local fixture complete." };
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: content },
      { type: "content_block_delta", index: 0, delta },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" }
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The local Claude fixture requires a TCP address.");
  const env = {
    PATH: process.env.PATH, HOME: path.join(root, "home"), ANTHROPIC_API_KEY: "fake-local-fixture-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_CONFIG_DIR: path.join(root, "auth"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1"
  };
  await fs.mkdir(env.HOME);
  return {
    root, cwd, providerHome, accountHome, env, statePath,
    requestCount: () => requests.length,
    write: async (relative: string, content: string) => {
      const target = path.join(providerHome, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      return target;
    },
    probe: async (overlay: boolean, target?: string, workingDirectory = cwd) => {
      requests.length = 0;
      readFile = target;
      let configDir = providerHome;
      const args = ["--print", "--no-session-persistence", "--output-format", "json", "--model", "claude-sonnet-4-6", "--tools", target ? "Read" : "", "--allowedTools", "Read", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
      if (overlay) {
        const materialized = await materializeClaudeHomeOverlay({
          dataDir: path.join(root, "data"), tabId: "native", accountHome, providerHome, userStatePath: statePath,
          executionId: "11111111-1111-4111-8111-111111111111", cwd: workingDirectory, trustProject: true, launchEnv: env,
          resolved: {
            source: "default", template: { id: "fixture", name: "Fixture", color: "green", ruleIds: [], skillIds: [] },
            rules: [{ id: "fixture", description: "Fixture", text: "CLOUDX_ADDITION_MARKER", scope: "user" }], skills: []
          }
        });
        configDir = materialized.configDir;
        args.push("--settings", materialized.settingsPath, "--append-system-prompt-file", materialized.instructionsPath);
      }
      const child = execFile(claude!, [...args, "--", "Run the local instruction fixture."], { cwd: workingDirectory, env: { ...env, CLAUDE_CONFIG_DIR: configDir }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      child.stdin?.end();
      await new Promise<void>((resolve, reject) => child.once("error", reject).once("exit", code => code === 0 ? resolve() : reject(new Error(`Native Claude fixture exited ${code}.`))));
      expect(requests.length).toBe(target ? 2 : 1);
      return structuredClone(requests);
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

native("preserves original relative imports, escaping, missing imports and the native four-hop boundary", async () => {
  const fixture = await instructionFixture();
  try {
    await fixture.write("CLAUDE.md", "PERSONAL_ROOT_MARKER\n@docs/first.md\n@Design\\ Docs/preference.md\n@rules/preferences.md\n@../outside.md\n@missing.md\n");
    await fixture.write("rules/preferences.md", "RULE_IMPORT_MARKER\n");
    await fixture.write("../outside.md", "PERSONAL_EXTERNAL_IMPORT_MARKER\n");
    await fixture.write("Design Docs/preference.md", "ESCAPED_IMPORT_MARKER\n");
    for (const [file, next, marker] of [
      ["first", "second", "FIRST_IMPORT_MARKER"], ["second", "third", "SECOND_IMPORT_MARKER"],
      ["third", "fourth", "THIRD_IMPORT_MARKER"], ["fourth", "fifth", "FOURTH_IMPORT_MARKER"], ["fifth", "", "FIFTH_IMPORT_MARKER"]
    ]) await fixture.write(`docs/${file}.md`, `${marker}\n${next ? `@${next}.md\n` : ""}`);
    const original = await fs.readFile(path.join(fixture.providerHome, "CLAUDE.md"), "utf8");
    const plain = JSON.stringify(await fixture.probe(false));
    const overlayRequests = await fixture.probe(true);
    const overlay = JSON.stringify(overlayRequests);
    for (const marker of ["PERSONAL_ROOT_MARKER", "ESCAPED_IMPORT_MARKER", "FIRST_IMPORT_MARKER", "SECOND_IMPORT_MARKER", "THIRD_IMPORT_MARKER", "FOURTH_IMPORT_MARKER"]) {
      expect(plain, marker).toContain(marker);
      expect(overlay, marker).toContain(marker);
      if (marker !== "PERSONAL_ROOT_MARKER")
        expect(overlay, marker).toContain(path.join(fixture.providerHome, marker === "ESCAPED_IMPORT_MARKER" ? "Design Docs/preference.md" : `docs/${marker.split("_")[0]!.toLowerCase()}.md`));
    }
    expect(plain).not.toContain("FIFTH_IMPORT_MARKER");
    expect(overlay).not.toContain("FIFTH_IMPORT_MARKER");
    for (const marker of ["RULE_IMPORT_MARKER", "PERSONAL_EXTERNAL_IMPORT_MARKER"]) {
      expect(plain).toContain(marker);
      expect(overlay).toContain(marker);
    }
    expect(JSON.stringify(overlayRequests[0]?.system).match(/CLOUDX_ADDITION_MARKER/gu)).toHaveLength(1);
    expect(JSON.stringify(overlayRequests[0]?.messages)).not.toContain("CLOUDX_ADDITION_MARKER");
    expect(await fs.realpath(path.join(fixture.root, "data", "claude-launches", "native", "CLAUDE.md"))).toBe(path.join(fixture.providerHome, "CLAUDE.md"));
    expect(await fs.readFile(path.join(fixture.providerHome, "CLAUDE.md"), "utf8")).toBe(original);
  } finally { await fixture.close(); }
}, 90_000);

native("keeps unconditional, nested and path-scoped personal rules at native user scope", async () => {
  const fixture = await instructionFixture();
  try {
    await fixture.write("rules/general.md", "UNCONDITIONAL_RULE_MARKER\n");
    await fixture.write("rules/nested/other.md", "NESTED_RULE_MARKER\n");
    await fixture.write("rules/typescript.md", "---\npaths:\n  - '**/*.ts'\n---\nPATH_SCOPED_RULE_MARKER\n");
    const target = path.join(fixture.cwd, "example.ts");
    await fs.writeFile(target, "export const fixture = true;\n");
    for (const overlay of [false, true]) {
      const requests = await fixture.probe(overlay, target);
      const first = JSON.stringify(requests[0]);
      expect(first).toContain("UNCONDITIONAL_RULE_MARKER");
      expect(first).toContain("NESTED_RULE_MARKER");
      expect(first).not.toContain("PATH_SCOPED_RULE_MARKER");
      expect(JSON.stringify(requests[1])).toContain("PATH_SCOPED_RULE_MARKER");
    }
  } finally { await fixture.close(); }
}, 90_000);

native.each(["user", "project", "local", "worktree-local"])("rejects the original-root %s exclusion combination before starting the overlay native client", async layer => {
  const fixture = await instructionFixture();
  try {
    const personal = await fixture.write("CLAUDE.md", "EXCLUDED_PERSONAL_MARKER\n@docs/import.md\n");
    await fixture.write("docs/import.md", "EXCLUDED_IMPORT_MARKER\n");
    let cwd = fixture.cwd;
    if (layer === "worktree-local") {
      cwd = path.join(fixture.root, "linked-project");
      await run("git", ["init", "-q", fixture.cwd]);
      await run("git", ["-C", fixture.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Fixture"]);
      await run("git", ["-C", fixture.cwd, "worktree", "add", "-qb", "linked", cwd]);
    }
    const settings = layer === "user" ? path.join(fixture.providerHome, "settings.json") : path.join(fixture.cwd, ".claude", layer === "project" ? "settings.json" : "settings.local.json");
    await fs.mkdir(path.dirname(settings), { recursive: true });
    const content = JSON.stringify({ claudeMdExcludes: [personal] });
    await fs.writeFile(settings, content);
    const plain = JSON.stringify(await fixture.probe(false, undefined, cwd));
    expect(plain).not.toContain("EXCLUDED_PERSONAL_MARKER");
    expect(plain).not.toContain("EXCLUDED_IMPORT_MARKER");
    await expect(fixture.probe(true, undefined, cwd)).rejects.toThrow(`claudeMdExcludes in ${settings}`);
    expect(fixture.requestCount()).toBe(0);
    await expect(fs.stat(path.join(fixture.root, "data"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(settings, "utf8")).toBe(content);
  } finally { await fixture.close(); }
}, 90_000);

native.each([false, true])("retains the native project external-import decision (%s) instead of treating project content as personal", async approved => {
  const fixture = await instructionFixture();
  try {
    const external = path.join(fixture.root, "external.md");
    await fs.writeFile(external, "EXTERNAL_PROJECT_IMPORT_MARKER\n");
    await fs.writeFile(path.join(fixture.cwd, "CLAUDE.md"), `PROJECT_ROOT_MARKER\n@${external}\n`);
    const project = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: approved, hasClaudeMdExternalIncludesWarningShown: true };
    await fs.writeFile(fixture.statePath, JSON.stringify({ hasCompletedOnboarding: true, projects: { [fixture.cwd]: project } }));
    const plain = JSON.stringify(await fixture.probe(false));
    const overlay = JSON.stringify(await fixture.probe(true));
    expect(plain).toContain("PROJECT_ROOT_MARKER");
    expect(overlay).toContain("PROJECT_ROOT_MARKER");
    expect(overlay.includes("EXTERNAL_PROJECT_IMPORT_MARKER")).toBe(plain.includes("EXTERNAL_PROJECT_IMPORT_MARKER"));
    expect(JSON.parse(await fs.readFile(fixture.statePath, "utf8")).projects[fixture.cwd]).toEqual(project);
  } finally { await fixture.close(); }
}, 90_000);
