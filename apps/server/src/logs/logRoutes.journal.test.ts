import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";
import { LOG_MAX_BYTES, readServiceJournal } from "./CloudxLogService.js";

interface JournalStart {
  pid: number;
  units: string[];
  overlapping: number[];
}

let app: FastifyInstance;
let root: string;
let url: string;
const agents: http.Agent[] = [];

async function journalStarts(): Promise<JournalStart[]> {
  return (await fs.readFile(path.join(root, "starts.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function journalIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function readLogs(source: string, agent: http.Agent) {
  const request = http.get(`${url}/api/logs?source=${source}`, { agent, headers: { host: "localhost" } });
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request.on("response", reply => {
      let body = "";
      reply.setEncoding("utf8");
      reply.on("data", chunk => { body += chunk; });
      reply.on("end", () => resolve({ status: reply.statusCode!, body }));
      reply.on("error", reject);
    });
    request.on("error", reject);
  });
  return { request, response };
}

async function warmConnection(): Promise<http.Agent> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  agents.push(agent);
  expect((await readLogs("current", agent).response).status).toBe(200);
  return agent;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-journal-http-"));
  await fs.writeFile(path.join(root, "starts.jsonl"), "");
  await fs.writeFile(path.join(root, "journalctl"), `#!${process.execPath}
const fs = require("node:fs");
const file = ${JSON.stringify(path.join(root, "starts.jsonl"))};
const previous = fs.readFileSync(file, "utf8").trim().split("\\n").filter(Boolean).map(line => JSON.parse(line));
const overlapping = previous.filter(({ pid }) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}).map(({ pid }) => pid);
const units = process.argv.slice(2).filter(arg => arg.startsWith("--unit="));
fs.appendFileSync(file, JSON.stringify({ pid: process.pid, units, overlapping }) + "\\n");
if (units.length > 1 || units[0] === "--unit=cloudx.service") setInterval(() => {}, 1000);
else if (units[0] === "--unit=cloudx-asr.service") process.stdout.write("x".repeat(${LOG_MAX_BYTES + 1}));
else process.stdout.write("terminal journal fixture\\n");
`, { mode: 0o755 });
  vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH}`);
  const config = loadConfig({
    CLOUDX_ALLOWED_ROOTS: root, CLOUDX_DATA_DIR: path.join(root, "data"),
    CLOUDX_TRUSTED_ORIGINS: "http://localhost", CLOUDX_APP_SERVER_ENABLED: "false",
    CLOUDX_AUTOMATION_START_DISABLED: "true", CLOUDX_LOG_LEVEL: "silent",
    CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9", CLOUDX_ASR_URL: "http://127.0.0.1:9"
  });
  const services = buildServices(config);
  vi.spyOn(services.documentation!, "pendingEnrichments").mockResolvedValue([]);
  app = await buildServer(config, services);
  url = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  await app?.close();
  vi.unstubAllEnvs();
  if (root) {
    for (const { pid } of await journalStarts()) if (journalIsRunning(pid)) process.kill(pid, "SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("journal subprocesses through real HTTP connections", () => {
  it.each(["missing", "not executable"])("releases admission when journalctl is %s", async failure => {
    vi.stubEnv("PATH", root);
    const executable = path.join(root, "journalctl");
    if (failure === "missing") await fs.rename(executable, `${executable}.disabled`);
    else await fs.chmod(executable, 0o644);
    const agent = await warmConnection();
    const failed = await readLogs("terminals", agent).response;
    expect(failed.status).toBe(503);
    expect(failed.body).toContain("Could not read the service journal");
    expect(await journalStarts()).toEqual([]);
    if (failure === "missing") await fs.rename(`${executable}.disabled`, executable);
    else await fs.chmod(executable, 0o755);
    expect((await readLogs("terminals", agent).response).status).toBe(200);
  });

  it("closes a real child when its signal was already aborted before execution", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readServiceJournal(["cloudx.service"], controller.signal)).rejects.toMatchObject({ statusCode: 503 });
    expect((await journalStarts()).every(start => !journalIsRunning(start.pid))).toBe(true);
  });

  it("loads a newly selected source immediately after cancellation on a separate warm connection", async () => {
    const firstAgent = await warmConnection();
    const replacementAgent = await warmConnection();
    const first = readLogs("services", firstAgent);
    const cancellation = first.response.catch(error => error);
    await vi.waitFor(async () => expect(await journalStarts()).toHaveLength(1));
    expect(first.request.reusedSocket).toBe(true);
    const originalPort = first.request.socket!.localPort;
    first.request.destroy(new Error("Source changed"));
    const replacement = readLogs("terminals", replacementAgent);
    const result = await replacement.response;
    expect(replacement.request.reusedSocket).toBe(true);
    expect(replacement.request.socket!.localPort).not.toBe(originalPort);
    expect(await cancellation).toMatchObject({ message: "Source changed" });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ source: "terminals", content: "terminal journal fixture" });
    const starts = await journalStarts();
    expect(starts).toHaveLength(2);
    expect(starts.map(start => start.overlapping)).toEqual([[], []]);
    expect(starts.every(start => !journalIsRunning(start.pid))).toBe(true);
  });

  it("terminates oversized output and admits the next source", async () => {
    const agent = await warmConnection();
    const oversized = await readLogs("asr", agent).response;
    expect(oversized.status).toBe(503);
    expect(oversized.body).toContain("1 MiB");
    expect(oversized.body).not.toContain("x".repeat(100));
    expect((await readLogs("terminals", agent).response).status).toBe(200);
    const starts = await journalStarts();
    expect(starts).toHaveLength(2);
    expect(starts.map(start => start.overlapping)).toEqual([[], []]);
    expect(starts.every(start => !journalIsRunning(start.pid))).toBe(true);
  });

  it("terminates a journal at the five-second deadline and starts its waiting replacement", async () => {
    const firstAgent = await warmConnection();
    const replacementAgent = await warmConnection();
    const first = readLogs("server", firstAgent);
    await vi.waitFor(async () => expect(await journalStarts()).toHaveLength(1));
    const replacement = readLogs("terminals", replacementAgent);
    const result = await first.response;
    expect(result.status).toBe(503);
    expect(result.body).toContain("5 seconds");
    expect((await replacement.response).status).toBe(200);
    const starts = await journalStarts();
    expect(starts).toHaveLength(2);
    expect(starts.map(start => start.overlapping)).toEqual([[], []]);
    expect(starts.every(start => !journalIsRunning(start.pid))).toBe(true);
  }, 10_000);
});
