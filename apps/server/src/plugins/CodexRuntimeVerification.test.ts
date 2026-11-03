import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexRuntimeVerificationError } from "../../../../scripts/codex-runtime-errors.mjs";
import { assertNativeLaunchEvidence, verifyCodexRuntime } from "./CodexRuntimeVerification.js";
import { completedVerificationTurn, readVerificationTranscript, type VerificationTranscriptEvent } from "./CodexVerificationTranscript.js";

const launchFailure = {
  name: "CodexRuntimeVerificationError",
  diagnostic: { stage: "launch", code: "failed" },
  message: expect.stringContaining("failed at native tab launch and conversation selection"),
  cause: expect.objectContaining({ message: expect.stringMatching(/did not save a selected conversation/i) }),
};

it("rejects a CLI that exits before saving any native conversation", async () => {
  await expect(verifyCodexRuntime({ assistantBin: "/bin/false" })).rejects.toMatchObject(launchFailure);
}, 10_000);

it("cancels native verification and reaps the launched candidate", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-verification-cancel-"));
  const binary = path.join(fixture, "codex");
  const pidPath = path.join(fixture, "pid");
  try {
    await fs.writeFile(binary, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const controller = new AbortController();
    const verification = verifyCodexRuntime({ assistantBin: binary, signal: controller.signal });
    const rejected = expect(verification).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(async () => fs.readFile(pidPath, "utf8").catch(() => ""), { timeout: 5_000 }).toMatch(/^\d+$/u);
    const pid = Number(await fs.readFile(pidPath, "utf8"));
    controller.abort();
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}, 10_000);

it("requires an explicitly selected absolute CLI path", async () => {
  await expect(verifyCodexRuntime({ assistantBin: "codex" })).rejects.toThrow("absolute executable path");
});

it("probes the requested executable without consulting its prefix's active selection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-verification-executable-"));
  try {
    const assistantBin = path.join(root, "bin/codex");
    const launched = path.join(root, "launched");
    await fs.mkdir(path.dirname(assistantBin));
    await fs.writeFile(path.join(root, ".cloudx-codex-selection.json"), "invalid active selection");
    await fs.writeFile(assistantBin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(launched)}, 'requested executable');\nprocess.exit(86);\n`, { mode: 0o700 });

    await expect(verifyCodexRuntime({ assistantBin })).rejects.toMatchObject(launchFailure);

    expect(await fs.readFile(launched, "utf8")).toBe("requested executable");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 10_000);

it("retains private bounded phase evidence after a rejected launch without inheriting credentials", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-verification-diagnostics-"));
  const output: string[] = [];
  try {
    await expect(verifyCodexRuntime({
      assistantBin: "/bin/false",
      env: { PATH: process.env.PATH, CLOUDX_CODEX_VERIFICATION_DIAGNOSTICS_DIR: directory, OPENAI_API_KEY: "must-not-be-retained" },
      onOutput: text => output.push(text)
    })).rejects.toMatchObject(launchFailure);
    const files = await fs.readdir(directory);
    expect(files).toHaveLength(1);
    const file = path.join(directory, files[0]!);
    const content = await fs.readFile(file, "utf8");
    const diagnostic = JSON.parse(content);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(content)).toBeLessThan(16_384);
    expect(content).not.toContain("must-not-be-retained");
    expect(diagnostic).toMatchObject({
      version: 1, phase: "launch", elapsedMs: expect.any(Number),
      phases: [{ phase: "launch", elapsedMs: expect.any(Number) }],
      providerRequests: { count: 0, purposes: [] }, transcriptEvents: [],
      process: { exited: true }, error: { name: "Error" }, evidenceErrors: []
    });
    expect(output).toContain(`Private native verification diagnostics: ${file}\n`);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}, 10_000);

it("refuses to put private launch evidence in a public directory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-public-verification-diagnostics-"));
  const output: string[] = [];
  try {
    await fs.chmod(directory, 0o755);
    await expect(verifyCodexRuntime({
      assistantBin: "/bin/false", env: { PATH: process.env.PATH, CLOUDX_CODEX_VERIFICATION_DIAGNOSTICS_DIR: directory }, onOutput: text => output.push(text)
    })).rejects.toMatchObject(launchFailure);
    expect(await fs.readdir(directory)).toEqual([]);
    expect(output).toContain("Private native verification diagnostics could not be saved.\n");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}, 10_000);

const workspace = "/workspace";
const skillsRoot = "/workspace/data/rules-skills";
type EvidenceStage = "interactive-evidence" | "forge-evidence";

async function nativeLaunchTurn(stage: EvidenceStage, change?: (events: VerificationTranscriptEvent[]) => void) {
  const events = await readVerificationTranscript(new URL("./fixtures/codex-0.166.0-verification.jsonl", import.meta.url).pathname);
  const previous = stage === "forge-evidence" ? structuredClone(events) : [];
  change?.(events);
  const fresh = previous.length ? events.slice(1).map(event => event.payload?.turn_id
    ? { ...event, payload: { ...event.payload, turn_id: "resumed" } } : event) : events;
  const turn = completedVerificationTurn([...previous, ...fresh], previous.length, "selected-thread", "answer");
  if (!turn) throw new Error("The native launch fixture did not complete its turn.");
  return turn;
}

function removeNativeRoot(events: VerificationTranscriptEvent[], root: string) {
  const state = events.find(event => event.type === "world_state")!.payload!.state as { environments: { filesystem: string } };
  state.environments.filesystem = state.environments.filesystem.replace(`<root>${root}</root>`, "");
}

function changeNativeContext(events: VerificationTranscriptEvent[], values: Record<string, unknown>) {
  Object.assign(events.find(event => event.type === "turn_context")!.payload!, values);
}

for (const stage of ["interactive-evidence", "forge-evidence"] as const) {
  it(`accepts sanitized 0.166.0 world-state launch evidence at ${stage}`, async () => {
    const turn = await nativeLaunchTurn(stage);
    expect(turn.context).not.toHaveProperty("workspace_roots");
    expect(turn.workspaceRoots).toEqual([workspace, skillsRoot]);
    expect(() => assertNativeLaunchEvidence(turn, workspace, skillsRoot, stage)).not.toThrow();
  });

  it.each([
    { failure: "missing skills root", code: "workspace-roots", change: (events: VerificationTranscriptEvent[]) => removeNativeRoot(events, skillsRoot) },
    { failure: "missing workspace root", code: "workspace-roots", change: (events: VerificationTranscriptEvent[]) => removeNativeRoot(events, workspace) },
    { failure: "wrong working directory", code: "cwd", change: (events: VerificationTranscriptEvent[]) => changeNativeContext(events, { cwd: "/private/changed-workspace" }) },
    { failure: "wrong approval policy", code: "approval-policy", change: (events: VerificationTranscriptEvent[]) => changeNativeContext(events, { approval_policy: "on-request" }) },
    { failure: "wrong sandbox policy", code: "sandbox-policy", change: (events: VerificationTranscriptEvent[]) => changeNativeContext(events, { sandbox_policy: { type: "read-only", privateDetail: "/private/sandbox" } }) },
  ])(`rejects $failure at ${stage} with a safe cause and no private launch details`, async ({ code, change }) => {
    const turn = await nativeLaunchTurn(stage, change);
    let failure;
    try { assertNativeLaunchEvidence(turn, workspace, skillsRoot, stage); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CodexRuntimeVerificationError);
    const error = failure as CodexRuntimeVerificationError;
    expect(error.diagnostic).toEqual({ stage, code });
    expect(error.cause).toMatchObject({ code: "ERR_ASSERTION" });
    expect(error.message).toContain(stage === "interactive-evidence" ? "interactive turn evidence" : "Forge turn evidence");
    expect(error.message).toContain("The active selection is unchanged");
    expect(`${error.message} ${JSON.stringify(error)}`).not.toMatch(/\/workspace|\/private|privateDetail/);
    if (stage === "interactive-evidence") expect(error.message).not.toMatch(/Forge|shared-state/);
  });
}
