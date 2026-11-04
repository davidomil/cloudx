import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { AgentOwner } from "@cloudx/shared";
import { AgentHardwareContext, HARDWARE_HELPER_PATH } from "./AgentHardwareContext.js";

const run = promisify(execFile);

it("uses explicit local TLS trust, verifies hostnames, and never follows a Hardware redirect", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-helper-tls-"));
  const servers: https.Server[] = [];
  let requests = 0;
  let redirect = false;
  try {
    await run(process.execPath, ["scripts/create-local-cert.mjs"], { env: { ...process.env, CLOUDX_DATA_DIR: root } });
    const cert = path.join(root, "certs", "cloudx-local.crt");
    const wrongCert = path.join(root, "wrong.crt"), wrongKey = path.join(root, "wrong.key");
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-noenc", "-keyout", wrongKey, "-out", wrongCert, "-subj", "/CN=wrong.invalid", "-addext", "subjectAltName=DNS:wrong.invalid"]);
    const listen = async (key: string, certificate: string) => {
      const server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(certificate) }, (_request, response) => {
        requests++;
        if (redirect) response.writeHead(302, { location: "https://127.0.0.1:1/untrusted" });
        response.end('{"readiness":{"state":"ready"}}');
      });
      servers.push(server);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      return `https://127.0.0.1:${(server.address() as { port: number }).port}/api/hardware/agent`;
    };
    const endpoint = await listen(path.join(root, "certs", "cloudx-local.key"), cert);
    const owner: AgentOwner = { kind: "agent", tabId: "tls-agent", executionId: "tls-execution", providerId: "codex" };
    const contexts = new AgentHardwareContext({ dataDir: root, caPath: cert, endpoint: () => endpoint, binding: () => owner });
    const locator = (await contexts.prepare(owner.tabId))!;
    const file = contexts.contextPath(owner);
    const helper = () => run(process.execPath, [HARDWARE_HELPER_PATH, "context"], { env: { PATH: process.env.PATH, CLOUDX_HARDWARE_CONTEXT: file } });
    expect(JSON.parse((await helper()).stdout)).toEqual({ readiness: { state: "ready" } });
    await fs.writeFile(file, JSON.stringify({ ...locator, caPath: undefined }));
    await expect(helper()).rejects.toMatchObject({ stderr: expect.stringMatching(/self-signed certificate|unable to verify/) });
    expect(requests).toBe(1);
    const mismatch = await listen(wrongKey, wrongCert);
    await fs.writeFile(file, JSON.stringify({ ...locator, endpoint: mismatch, caPath: wrongCert }));
    await expect(helper()).rejects.toMatchObject({ stderr: expect.stringContaining("certificate's altnames") });
    expect(requests).toBe(1);
    await fs.writeFile(file, JSON.stringify(locator));
    redirect = true;
    await expect(helper()).rejects.toMatchObject({ stderr: expect.stringContaining("must not redirect") });
    expect(requests).toBe(2);
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 15000);
