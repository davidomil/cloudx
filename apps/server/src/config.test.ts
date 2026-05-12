import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultLocalHttpsPaths, loadConfig } from "./config.js";
import { DEFAULT_TERMINAL_REPLAY_BYTES } from "./plugins/CodexTerminalPlugin.js";

describe("loadConfig", () => {
  it("defaults to LAN/Tailscale-facing host and port", () => {
    const config = loadConfig({ HOME: "/workspace/test" } as NodeJS.ProcessEnv);

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3001);
    expect(config.terminalReplayBytes).toBe(DEFAULT_TERMINAL_REPLAY_BYTES);
  });

  it("leaves configured allowed roots as user-facing path expressions", () => {
    const config = loadConfig({ CLOUDX_ALLOWED_ROOTS: "~:/tmp/cloudx" } as NodeJS.ProcessEnv);

    expect(config.allowedRoots).toEqual(["~", "/tmp/cloudx"]);
  });

  it("parses terminal replay buffer size", () => {
    const config = loadConfig({ CLOUDX_TERMINAL_REPLAY_BYTES: "2097152" } as NodeJS.ProcessEnv);

    expect(config.terminalReplayBytes).toBe(2_097_152);
  });

  it("rejects invalid terminal replay buffer size", () => {
    expect(() => loadConfig({ CLOUDX_TERMINAL_REPLAY_BYTES: "0" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_TERMINAL_REPLAY_BYTES/);
  });

  it("parses HTTPS key and certificate paths together", () => {
    const config = loadConfig({
      CLOUDX_HTTPS_KEY_PATH: "certs/key.pem",
      CLOUDX_HTTPS_CERT_PATH: "certs/cert.pem"
    } as NodeJS.ProcessEnv);

    expect(config.https).toEqual({
      keyPath: expect.stringMatching(/certs\/key\.pem$/),
      certPath: expect.stringMatching(/certs\/cert\.pem$/)
    });
  });

  it("rejects partial HTTPS configuration", () => {
    expect(() => loadConfig({ CLOUDX_HTTPS_KEY_PATH: "certs/key.pem" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_HTTPS_KEY_PATH/);
    expect(() => loadConfig({ CLOUDX_HTTPS_CERT_PATH: "certs/cert.pem" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_HTTPS_KEY_PATH/);
  });

  it("auto-detects the local self-signed certificate when it exists in the data directory", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-cert-"));
    const localCert = defaultLocalHttpsPaths(dataDir);
    await fs.mkdir(path.dirname(localCert.keyPath), { recursive: true });
    await fs.writeFile(localCert.keyPath, "key");
    await fs.writeFile(localCert.certPath, "cert");

    const config = loadConfig({ CLOUDX_DATA_DIR: dataDir } as NodeJS.ProcessEnv);

    expect(config.https).toEqual(localCert);
  });

  it("does not enable HTTPS automatically when the local certificate is missing", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-no-cert-"));

    const config = loadConfig({ CLOUDX_DATA_DIR: dataDir } as NodeJS.ProcessEnv);

    expect(config.https).toBeUndefined();
  });
});
