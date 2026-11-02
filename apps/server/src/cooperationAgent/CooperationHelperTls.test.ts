import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { AgentCooperationContext, COOPERATION_HELPER_PATH } from "./AgentCooperationContext.js";

const run = promisify(execFile);

it("trusts only the configured local TLS certificate and retains hostname verification without following redirects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-cooperation-tls-"));
  let requests = 0;
  let redirect = false;
  const servers: https.Server[] = [];
  try {
    await run(process.execPath, ["scripts/create-local-cert.mjs"], { env: { ...process.env, CLOUDX_DATA_DIR: root } });
    const cert = path.join(root, "certs", "cloudx-local.crt");
    const wrongCert = path.join(root, "wrong.crt");
    const wrongKey = path.join(root, "wrong.key");
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-noenc", "-keyout", wrongKey,
      "-out", wrongCert, "-subj", "/CN=wrong.invalid", "-addext", "subjectAltName=DNS:wrong.invalid"]);
    const listen = async (keyPath: string, certPath: string) => {
      const server = https.createServer({ key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) }, (_request, response) => {
        requests += 1;
        if (redirect) response.writeHead(302, { location: "https://127.0.0.1:1/untrusted" });
        response.end('{"boardId":null}');
      });
      servers.push(server);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      return `https://127.0.0.1:${(server.address() as { port: number }).port}/api/cooperation/agent`;
    };
    const endpoint = await listen(path.join(root, "certs", "cloudx-local.key"), cert);
    const contexts = new AgentCooperationContext({ dataDir: root, endpoint: () => endpoint, caPath: cert,
      binding: () => ({ tabId: "tls-agent", boardId: null, assignmentGeneration: 0, providerId: "codex" }) });
    const locator = await contexts.prepare("tls-agent");
    expect(locator.caPath).toBe(cert);
    const env = { PATH: process.env.PATH, CLOUDX_COOPERATION_CONTEXT: contexts.contextPath("tls-agent") };
    const helper = () => run(process.execPath, [COOPERATION_HELPER_PATH, "context"], { env });
    expect(JSON.parse((await helper()).stdout)).toEqual({ boardId: null });
    expect(requests).toBe(1);
    const writeLocator = (value: object) => fs.writeFile(env.CLOUDX_COOPERATION_CONTEXT, JSON.stringify(value));
    await writeLocator({ ...locator, caPath: undefined });
    await expect(helper()).rejects.toMatchObject({ stderr: expect.stringMatching(/self-signed certificate|unable to verify/u) });
    await writeLocator({ ...locator, caPath: wrongCert });
    await expect(helper()).rejects.toMatchObject({ stderr: expect.stringMatching(/self-signed certificate|unable to verify/u) });
    expect(requests).toBe(1);
    const mismatchedEndpoint = await listen(wrongKey, wrongCert);
    await writeLocator({ ...locator, endpoint: mismatchedEndpoint, caPath: wrongCert });
    await expect(helper()).rejects.toMatchObject({ stderr: expect.stringContaining("certificate's altnames") });
    expect(requests).toBe(1);
    await writeLocator(locator);
    redirect = true;
    await expect(helper()).rejects.toMatchObject({ stderr: expect.stringContaining("must not redirect") });
    expect(requests).toBe(2);
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 15000);
