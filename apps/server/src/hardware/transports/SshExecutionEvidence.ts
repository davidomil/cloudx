import { randomUUID } from "node:crypto";
import type { ProcessResult } from "./BoundedProcess.js";

export class SshExecutionEvidence {
  private readonly nonce = randomUUID();
  readonly start = `cloudx-ssh-client-start:${this.nonce}\n`;
  readonly end = `cloudx-ssh-client-end:${this.nonce}:`;

  connectionFailure(result: ProcessResult): { code: string; message: string } | undefined {
    const clients = this.clients(result);
    if (!clients || result.exitCode === 0) return;
    let failure: { code: string; message: string } | undefined;
    for (const client of clients) {
      if (!client.trimEnd().endsWith(`${this.end}255`)) return;
      // ssh-copy-id launches several clients. A later rejection cannot erase
      // an earlier authenticated session, even if remote debug text mimics errors.
      if (/^(?:Authenticated to |debug1: (?:Authentication succeeded|Sending command:|Sending subsystem:|Entering interactive session))/m.test(client)) return;
      const lines = client.split(/\r?\n/);
      if (lines.includes("cloudx-ssh-client-unavailable")) {
        failure = { code: "TRANSPORT_NOT_STARTED", message: "The OpenSSH executable was unavailable before remote command dispatch." };
      } else if (lines.some(line => /^ssh: connect to host [a-zA-Z0-9.:-]+ port \d+: (?:Connection timed out|Connection refused|No route to host|Network is unreachable)$/.test(line)) || lines.includes("Connection timed out during banner exchange")) {
        failure = { code: "SSH_CONNECTION_FAILED", message: "SSH connection establishment failed before remote command dispatch." };
      } else if (lines.includes("Host key verification failed.")) {
        failure = { code: "SSH_HOST_KEY_REJECTED", message: "SSH host-key verification rejected the connection before remote command dispatch." };
      } else if (lines.some(line => /^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?@[a-zA-Z0-9.:-]+: Permission denied \([a-zA-Z0-9,@._-]+\)\.$/.test(line))) {
        failure = { code: "SSH_AUTHENTICATION_FAILED", message: "SSH authentication was rejected before remote command dispatch." };
      } else return;
    }
    return failure;
  }

  remoteCompletionConfirmed(result: ProcessResult): boolean {
    const clients = this.clients(result);
    if (!clients || result.interrupted) return false;
    let completed = false;
    const settled = clients.every(client => {
      const lastLine = client.trimEnd().split(/\r?\n/).at(-1)!;
      const status = lastLine.startsWith(this.end) ? lastLine.slice(this.end.length) : "";
      if (!/^\d+$/.test(status) || Number(status) > 255) return false;
      if (this.connectionFailure({ ...result, diagnosticOutput: this.start + client, exitCode: Number(status) })) return true;
      // An actual SSH exit below 255 confirms remote completion only with an
      // authenticated session. Local launch/logging errors can also exit 1/127.
      // Status 255 stays uncertain even if server debug text claims Exit status.
      if (Number(status) === 255 || !/^Authenticated to /m.test(client) || !client.split(/\r?\n/).includes(`debug1: Exit status ${status}`)) return false;
      completed = true;
      return true;
    });
    return settled && completed;
  }

  private clients(result: ProcessResult): string[] | undefined {
    if (result.state !== "exited" || result.diagnosticsTruncated || !result.diagnosticOutput?.startsWith(this.start)) return;
    return result.diagnosticOutput.slice(this.start.length).split(this.start);
  }
}
