import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_MODEL } from "@cloudx/shared";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_ASR_TIMEOUT_MS, MAX_ASR_TIMEOUT_MS } from "./asrClient.js";
import {
  DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
  DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
  MAX_DOCUMENTATION_UPLOAD_MAX_BYTES,
  MAX_VOICE_AUDIO_UPLOAD_MAX_BYTES,
  defaultLocalHttpsPaths,
  loadConfig,
  networkBindWarning,
  shouldWarnForNetworkBind
} from "./config.js";
import {
  DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
  DEFAULT_DOCUMENTATION_TIMEOUT_MS,
  MAX_DOCUMENTATION_RESPONSE_MAX_BYTES,
  MAX_DOCUMENTATION_TIMEOUT_MS
} from "./documentation/DocumentationClient.js";
import { DEFAULT_TERMINAL_REPLAY_BYTES } from "./plugins/CodexTerminalPlugin.js";

describe("loadConfig", () => {
  it("defaults to localhost host and port", () => {
    const config = loadConfig({ HOME: "/workspace/test" } as NodeJS.ProcessEnv);

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3001);
    expect(config.logLevel).toBe("info");
    expect(config.terminalReplayBytes).toBe(DEFAULT_TERMINAL_REPLAY_BYTES);
    expect(config.voiceModel).toBe(DEFAULT_VOICE_MODEL);
    expect(config.asrTimeoutMs).toBe(DEFAULT_ASR_TIMEOUT_MS);
    expect(config.documentationTimeoutMs).toBe(DEFAULT_DOCUMENTATION_TIMEOUT_MS);
    expect(config.documentationResponseMaxBytes).toBe(DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES);
    expect(config.documentationUploadMaxBytes).toBe(DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES);
    expect(config.voiceAudioUploadMaxBytes).toBe(DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES);
  });

  it("detects network-facing bind hosts for startup warnings", () => {
    expect(shouldWarnForNetworkBind("0.0.0.0")).toBe(true);
    expect(shouldWarnForNetworkBind("::")).toBe(true);
    expect(shouldWarnForNetworkBind("127.0.0.1")).toBe(false);
    expect(networkBindWarning("0.0.0.0", 3001)).toContain("Public internet unsupported");
    expect(networkBindWarning("0.0.0.0", 3001, "http")).toContain("Local URL: http://127.0.0.1:3001");
  });

  it("leaves configured allowed roots as user-facing path expressions", () => {
    const config = loadConfig({ CLOUDX_ALLOWED_ROOTS: "~:/tmp/cloudx" } as NodeJS.ProcessEnv);

    expect(config.allowedRoots).toEqual(["~", "/tmp/cloudx"]);
  });

  it("parses terminal replay buffer size", () => {
    const config = loadConfig({ CLOUDX_TERMINAL_REPLAY_BYTES: "2097152" } as NodeJS.ProcessEnv);

    expect(config.terminalReplayBytes).toBe(2_097_152);
  });

  it("parses runtime log level", () => {
    expect(loadConfig({ CLOUDX_LOG_LEVEL: "debug" } as NodeJS.ProcessEnv).logLevel).toBe("debug");
    expect(loadConfig({ CLOUDX_LOG_LEVEL: "TRACE" } as NodeJS.ProcessEnv).logLevel).toBe("trace");
  });

  it("parses ASR timeout", () => {
    const config = loadConfig({ CLOUDX_ASR_TIMEOUT_MS: "45000" } as NodeJS.ProcessEnv);

    expect(config.asrTimeoutMs).toBe(45_000);
  });

  it("parses documentation timeout", () => {
    const config = loadConfig({ CLOUDX_DOCUMENTATION_TIMEOUT_MS: "3600000" } as NodeJS.ProcessEnv);

    expect(config.documentationTimeoutMs).toBe(3_600_000);
  });

  it("parses documentation response and upload size limits", () => {
    const config = loadConfig({
      CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES: "16777216",
      CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES: "536870912"
    } as NodeJS.ProcessEnv);

    expect(config.documentationResponseMaxBytes).toBe(16_777_216);
    expect(config.documentationUploadMaxBytes).toBe(536_870_912);
  });

  it("parses voice audio upload body limit", () => {
    const config = loadConfig({ CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES: "2097152" } as NodeJS.ProcessEnv);

    expect(config.voiceAudioUploadMaxBytes).toBe(2_097_152);
  });

  it("parses and validates the Codex voice model", () => {
    expect(loadConfig({ CLOUDX_VOICE_MODEL: " gpt-5.4-mini " } as NodeJS.ProcessEnv).voiceModel).toBe("gpt-5.4-mini");
    expect(() => loadConfig({ CLOUDX_VOICE_MODEL: "" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_VOICE_MODEL/);
    expect(() => loadConfig({ CLOUDX_VOICE_MODEL: "gpt 5.4" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_VOICE_MODEL/);
  });

  it("keeps raw voice transcript logging opt-in", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).voiceDebugTranscripts).toBe(false);
    expect(loadConfig({ CLOUDX_VOICE_DEBUG_TRANSCRIPTS: "true" } as NodeJS.ProcessEnv).voiceDebugTranscripts).toBe(true);
  });

  it("keeps automation startup disabling opt-in", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).automationStartDisabled).toBe(false);
    expect(loadConfig({ CLOUDX_AUTOMATION_START_DISABLED: "1" } as NodeJS.ProcessEnv).automationStartDisabled).toBe(true);
  });

  it("rejects invalid terminal replay buffer size", () => {
    expect(() => loadConfig({ CLOUDX_TERMINAL_REPLAY_BYTES: "0" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_TERMINAL_REPLAY_BYTES/);
    expect(() => loadConfig({ CLOUDX_TERMINAL_REPLAY_BYTES: "1024abc" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_TERMINAL_REPLAY_BYTES/);
  });

  it("rejects invalid port", () => {
    expect(() => loadConfig({ CLOUDX_PORT: "0" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_PORT/);
    expect(() => loadConfig({ CLOUDX_PORT: "3001abc" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_PORT/);
  });

  it("rejects invalid runtime log level", () => {
    expect(() => loadConfig({ CLOUDX_LOG_LEVEL: "verbose" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_LOG_LEVEL/);
    expect(() => loadConfig({ CLOUDX_LOG_LEVEL: "" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_LOG_LEVEL/);
  });

  it("rejects invalid ASR timeout", () => {
    expect(() => loadConfig({ CLOUDX_ASR_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_ASR_TIMEOUT_MS/);
    expect(() => loadConfig({ CLOUDX_ASR_TIMEOUT_MS: "1.5" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_ASR_TIMEOUT_MS/);
    expect(() => loadConfig({ CLOUDX_ASR_TIMEOUT_MS: "1e3" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_ASR_TIMEOUT_MS/);
    expect(() => loadConfig({ CLOUDX_ASR_TIMEOUT_MS: "1abc" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_ASR_TIMEOUT_MS/);
    expect(() => loadConfig({ CLOUDX_ASR_TIMEOUT_MS: String(MAX_ASR_TIMEOUT_MS + 1) } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_ASR_TIMEOUT_MS/);
  });

  it("rejects invalid documentation timeout", () => {
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_TIMEOUT_MS/);
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_TIMEOUT_MS: "1.5" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_TIMEOUT_MS/);
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_TIMEOUT_MS: "1e3" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_TIMEOUT_MS/);
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_TIMEOUT_MS: "1abc" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_TIMEOUT_MS/);
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_TIMEOUT_MS: String(MAX_DOCUMENTATION_TIMEOUT_MS + 1) } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_TIMEOUT_MS/);
  });

  it("rejects invalid documentation response and upload size limits", () => {
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES: "0" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES/);
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES: "1.5" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES/);
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES: String(MAX_DOCUMENTATION_RESPONSE_MAX_BYTES + 1) } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_RESPONSE_MAX_BYTES/);
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES: "0" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES/);
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES: "1.5" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES/);
    expect(() => loadConfig({ CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES: String(MAX_DOCUMENTATION_UPLOAD_MAX_BYTES + 1) } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES/);
  });

  it("rejects invalid voice audio upload body limit", () => {
    expect(() => loadConfig({ CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES: "0" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES/);
    expect(() => loadConfig({ CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES: "1.5" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES/);
    expect(() => loadConfig({ CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES: "1e3" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES/);
    expect(() => loadConfig({ CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES: "1abc" } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES/);
    expect(() => loadConfig({ CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES: String(MAX_VOICE_AUDIO_UPLOAD_MAX_BYTES + 1) } as NodeJS.ProcessEnv)).toThrow(/CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES/);
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
