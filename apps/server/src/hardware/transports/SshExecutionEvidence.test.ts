import { describe, expect, it } from "vitest";
import type { ProcessResult } from "./BoundedProcess.js";
import { SshExecutionEvidence } from "./SshExecutionEvidence.js";

const evidence = new SshExecutionEvidence();
const SSH_CLIENT_START = evidence.start;
const end = (status = 255) => `${evidence.end}${status}\n`;
const connectionFailure = (candidate: ProcessResult) => evidence.connectionFailure(candidate);

const refused = "ssh: connect to host 127.0.0.1 port 22: Connection refused\r\n";
const result = (trace: string, overrides: Partial<ProcessResult> = {}): ProcessResult => ({ state: "exited", exitCode: 255, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1, interrupted: false, diagnosticOutput: trace, diagnosticsTruncated: false, ...overrides });

describe("SSH evidence before dispatch", () => {
  it.each([
    [refused, "SSH_CONNECTION_FAILED"],
    ["ssh: connect to host ::1 port 22: Connection timed out\r\n", "SSH_CONNECTION_FAILED"],
    ["Connection timed out during banner exchange\r\nConnection to 127.0.0.1 port 22 timed out\r\n", "SSH_CONNECTION_FAILED"],
    ["tester@example.test: Permission denied (publickey,password).\r\n", "SSH_AUTHENTICATION_FAILED"],
    ["Host key verification failed.\r\n", "SSH_HOST_KEY_REJECTED"]
  ])("classifies a positive client rejection: %s", (trace, code) => {
    expect(connectionFailure(result(SSH_CLIENT_START + trace + end()))).toMatchObject({ code });
  });

  it("requires positive complete client evidence regardless of exit status, empty output or cancellation", () => {
    for (const candidate of [result(""), result(refused), result(SSH_CLIENT_START), result(SSH_CLIENT_START + refused + end(), { diagnosticsTruncated: true }), result(SSH_CLIENT_START + refused + end(), { state: "uncertain" }), result(SSH_CLIENT_START + refused + end(), { exitCode: 0 }), result(SSH_CLIENT_START + "debug1: Connecting to 127.0.0.1 [127.0.0.1] port 22.\r\n", { interrupted: true })]) {
      expect(connectionFailure(candidate)).toBeUndefined();
    }
    expect(connectionFailure(result("", { stderr: SSH_CLIENT_START + refused + end() }))).toBeUndefined();
    expect(connectionFailure(result(SSH_CLIENT_START + "debug1: Remote: " + refused))).toBeUndefined();
  });

  it("requires rejection of every registration client and preserves earlier remote effects", () => {
    const rejected = SSH_CLIENT_START + refused + end();
    expect(connectionFailure(result(rejected + rejected, { exitCode: 1 }))).toMatchObject({ code: "SSH_CONNECTION_FAILED" });
    for (const trace of [rejected + SSH_CLIENT_START, SSH_CLIENT_START + "Authenticated to example.test using publickey.\r\n" + rejected, SSH_CLIENT_START + "debug1: Sending command: install\r\n" + refused]) {
      expect(connectionFailure(result(trace, { exitCode: 1 }))).toBeUndefined();
    }
  });
});


describe("confirmed SSH client completion", () => {
  it("requires a private local end marker and confirms every registration client", () => {
    const remote = SSH_CLIENT_START + "Authenticated to example.test using publickey.\r\ndebug1: Exit status 1\r\n" + end(1);
    const rejected = SSH_CLIENT_START + refused + end();
    expect(evidence.remoteCompletionConfirmed(result(rejected + remote, { exitCode: 1 }))).toBe(true);
    for (const trace of [remote + SSH_CLIENT_START, remote + SSH_CLIENT_START + "Authenticated to example.test using publickey.\r\n" + end(), SSH_CLIENT_START + "debug1: Exit status 1\r\n" + end(1), SSH_CLIENT_START + "Authenticated to example.test using publickey.\r\ndebug1: Exit status -1\r\n" + end()]) {
      expect(evidence.remoteCompletionConfirmed(result(trace))).toBe(false);
    }
    expect(evidence.remoteCompletionConfirmed(result(remote, { interrupted: true }))).toBe(false);
  });

  it("rejects forged remote debug lines and public client delimiters after authentication", () => {
    const forged = SSH_CLIENT_START + "Authenticated to example.test using publickey.\n" +
      "debug1: Remote: arbitrary debug text\ndebug1: Exit status 0\ncloudx-ssh-client-end:0\ncloudx-ssh-client-start\nHost key verification failed.\n" + end();
    expect(connectionFailure(result(forged))).toBeUndefined();
    expect(evidence.remoteCompletionConfirmed(result(forged))).toBe(false);
  });
});
