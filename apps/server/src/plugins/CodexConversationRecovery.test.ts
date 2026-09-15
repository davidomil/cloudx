import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "smol-toml";

import { CodexConversationRecovery } from "./CodexConversationRecovery.js";

const firstId = "01a08470-d118-7b72-b1df-439e72e5c744";
const secondId = "01a08470-d118-7b72-b1df-439e72e5c745";
let home: string;
let recovery: CodexConversationRecovery;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-conversation-"));
  recovery = new CodexConversationRecovery(home);
});
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

describe("Codex conversation identity", () => {
  it("records session hook receipts atomically and observes subsequent hook receipts", async () => {
    const observed = vi.fn();
    const failed = vi.fn();
    const stop = recovery.observe(observed, failed);
    try {
      expect(await runHook(sessionEvent(firstId), recovery.receiptPath)).toBe(0);
      await vi.waitFor(() => expect(observed).toHaveBeenLastCalledWith({ sessionId: firstId, cwd: home, transcriptPath: path.join(home, "first.jsonl") }));
      expect(await runHook(sessionEvent(secondId), recovery.receiptPath)).toBe(0);
      await vi.waitFor(() => expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: secondId })));
      expect(failed).not.toHaveBeenCalled();
      expect(await fs.readdir(home)).toEqual([".cloudx-conversation.json"]);
    } finally { stop(); }
    observed.mockClear();
    await runHook(sessionEvent(firstId), recovery.receiptPath);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(observed).not.toHaveBeenCalled();
  });

  it.each([null, {}, { hook_event_name: "SessionStart", session_id: "--last", cwd: "/tmp" }, { hook_event_name: "SessionStart", session_id: firstId, cwd: "relative" }, "x".repeat(17_000)])("rejects malformed native identity events without writing a receipt", async event => {
    expect(await runHook(event, recovery.receiptPath)).not.toBe(0);
    expect(recovery.read()).toBeUndefined();
  });

  it("does not follow receipt symlinks or read oversized receipts", async () => {
    const other = path.join(home, "other.json");
    await fs.writeFile(other, JSON.stringify({ sessionId: firstId, cwd: home }));
    await fs.symlink(other, recovery.receiptPath);
    expect(() => recovery.read()).toThrow();
    await fs.unlink(recovery.receiptPath);
    await fs.writeFile(recovery.receiptPath, " ".repeat(65_537));
    expect(() => recovery.read()).toThrow("size limit");
  });

  it("reports malformed saved identity and clears the previous launch receipt explicitly", async () => {
    await fs.writeFile(recovery.receiptPath, JSON.stringify({ sessionId: "last", cwd: home }));
    expect(() => recovery.read()).toThrow("identity is invalid");
    const failed = vi.fn();
    const stop = recovery.observe(vi.fn(), failed);
    stop();
    expect(failed).toHaveBeenCalledOnce();
    await recovery.reset();
    expect(recovery.read()).toBeUndefined();
  });

  it("adds a single narrowly trusted session hook without bypassing other hook trust", () => {
    const args = recovery.launchArgs();
    const hook = parse(args[1]!).hooks as { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    expect(hook.SessionStart).toHaveLength(1);
    expect(hook.SessionStart[0]!.hooks[0]!.command).toContain("codex-conversation-hook.mjs");
    expect(hook.SessionStart[0]!.hooks[0]!.command).toContain(recovery.receiptPath);
    expect(args[3]).toMatch(/^hooks\.state=\{"\/<session-flags>\/config.toml:session_start:0:0"=\{trusted_hash="sha256:[a-f0-9]{64}"\}\}$/u);
    expect(args).not.toContain("--dangerously-bypass-hook-trust");
  });
});

describe("exact Codex transcript recovery", () => {
  it("checks the requested conversation even when a newer conversation shares its directory", async () => {
    await transcript(firstId);
    await transcript(secondId);
    await expect(recovery.requireTranscript(firstId, home)).resolves.toBeUndefined();
    await fs.rm(path.join(home, "sessions", `rollout-${firstId}.jsonl`));
    await expect(recovery.requireTranscript(firstId, home)).rejects.toThrow(`transcript for Codex conversation ${firstId} is unavailable`);
    await expect(recovery.requireTranscript(secondId, home)).resolves.toBeUndefined();
  });

  it("rejects a transcript with a different recorded identity and reports corrupt metadata", async () => {
    const file = await transcript(firstId);
    await fs.writeFile(file, JSON.stringify({ type: "session_meta", payload: { id: secondId } }) + "\n");
    await expect(recovery.requireTranscript(firstId, home)).rejects.toThrow("is unavailable");
    await fs.writeFile(file, "truncated record");
    await expect(recovery.requireTranscript(firstId, home)).rejects.toThrow("invalid metadata");
  });

  it("rejects aliases and missing stores instead of selecting last", async () => {
    await expect(recovery.requireTranscript("last", home)).rejects.toThrow("exact Codex conversation ID");
    await expect(recovery.requireTranscript(firstId, home)).rejects.toThrow("Select a saved session");
  });

  it("accepts native metadata with substantial instructions and bounds the header read", async () => {
    const file = await transcript(firstId);
    const metadata = { type: "session_meta", payload: { id: firstId, base_instructions: { text: "x".repeat(80_000) } } };
    await fs.writeFile(file, JSON.stringify(metadata) + "\n" + "x".repeat(2_000_000));
    await expect(recovery.requireTranscript(firstId, home)).resolves.toBeUndefined();
    metadata.payload.base_instructions.text = "x".repeat(1_048_577);
    await fs.writeFile(file, JSON.stringify(metadata) + "\n");
    await expect(recovery.requireTranscript(firstId, home)).rejects.toThrow("header for Codex conversation");
    await expect(recovery.requireTranscript(firstId, home)).rejects.toThrow("1 MiB limit");
  });
});

function sessionEvent(id: string) {
  return { hook_event_name: "SessionStart", session_id: id, cwd: home, transcript_path: path.join(home, "first.jsonl") };
}

async function transcript(id: string) {
  const directory = path.join(home, "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-${id}.jsonl`);
  await fs.writeFile(file, JSON.stringify({ type: "session_meta", payload: { id, cwd: home } }) + "\n");
  return file;
}

function runHook(event: unknown, receipt: string): Promise<number | null> {
  const helper = fileURLToPath(new URL("../../helpers/codex-conversation-hook.mjs", import.meta.url));
  const child = spawn(process.execPath, [helper, receipt], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end(JSON.stringify(event));
  return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
}
