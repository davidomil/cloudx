import fs from "node:fs/promises";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { BoundedProcessSet } from "./BoundedProcess.js";
import { SshAskpass } from "./SshAskpass.js";

const signal = () => new AbortController().signal;

describe("private SSH password delivery", () => {
  it("answers one password prompt without putting the secret in argv, environment or files", async () => {
    const askpass = await SshAskpass.create("private-password", "tester", "example.test");
    const processes = new BoundedProcessSet();
    try {
      expect(JSON.stringify(askpass.environment)).not.toContain("private-password");
      expect((await fs.stat(askpass.directory)).mode & 0o777).toBe(0o700);
      for (const file of await fs.readdir(askpass.directory)) {
        if ((await fs.stat(`${askpass.directory}/${file}`)).isFile()) expect(await fs.readFile(`${askpass.directory}/${file}`, "utf8")).not.toContain("private-password");
      }
      const command = { executable: askpass.environment.SSH_ASKPASS, args: ["tester@example.test's password: "], environment: askpass.environment, timeoutMs: 1000, maxOutputBytes: 100, signal: signal() };
      expect(await processes.run(command)).toMatchObject({ exitCode: 0, stdout: "private-password\n" });
      expect(await processes.run(command)).toMatchObject({ exitCode: 1, stdout: "" });
    } finally { await processes.close(signal()); await askpass.close(); }
    await expect(fs.stat(askpass.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await askpass.close();
  });

  it("rejects host confirmation, passphrase and password-change prompts without consuming the password", async () => {
    const askpass = await SshAskpass.create("private-password", "tester", "example.test");
    const processes = new BoundedProcessSet();
    try {
      for (const prompt of ["Are you sure you want to continue connecting?", "Enter passphrase for key '/tmp/key': ", "Enter tester@example.test's new password: ", "other@example.test's password: "]) {
        expect(await processes.run({ executable: askpass.environment.SSH_ASKPASS, args: [prompt], environment: askpass.environment, timeoutMs: 1000, maxOutputBytes: 100, signal: signal() })).toMatchObject({ exitCode: 1, stdout: "" });
      }
      expect(await processes.run({ executable: askpass.environment.SSH_ASKPASS, args: ["tester@example.test's password: "], environment: askpass.environment, timeoutMs: 1000, maxOutputBytes: 100, signal: signal() })).toMatchObject({ exitCode: 0, stdout: "private-password\n" });
    } finally { await processes.close(signal()); await askpass.close(); }
  });

  it("rejects credentials that native askpass would truncate or reinterpret", async () => {
    for (const password of ["", "a\0b", "a\rb", "a\nb", "a".repeat(1024), "€".repeat(342), "\ud800"]) await expect(SshAskpass.create(password, "tester", "example.test")).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    const askpass = await SshAskpass.create("a".repeat(1023), "tester", "example.test");
    await askpass.close();
  });

  it("matches OpenSSH lowercase DNS and canonical numeric IPv6 without truncating the user or hostname", async () => {
    const username = "u".repeat(64);
    for (const [host, native] of [["Example.TEST", "example.test"], ["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"], ["::ffff:7f00:1", "::ffff:127.0.0.1"], [Array(4).fill("a".repeat(60)).join("."), Array(4).fill("a".repeat(60)).join(".")]]) {
      const askpass = await SshAskpass.create("fixture-password", username, host);
      const processes = new BoundedProcessSet();
      try { expect(await processes.run({ executable: askpass.environment.SSH_ASKPASS, args: [`${username}@${native}'s password: `], environment: askpass.environment, timeoutMs: 1000, maxOutputBytes: 100, signal: signal() })).toMatchObject({ exitCode: 0, stdout: "fixture-password\n" }); }
      finally { await processes.close(signal()); await askpass.close(); }
    }
  });

  it("closes unfinished local requests and refuses confirmation hints without exposing the password", async () => {
    const askpass = await SshAskpass.create("private-password", "tester", "example.test");
    const processes = new BoundedProcessSet();
    const client = net.createConnection(askpass.environment.CLOUDX_SSH_ASKPASS_SOCKET);
    client.on("error", () => {});
    const closed = new Promise<void>(resolve => client.once("close", () => resolve()));
    try {
      await new Promise<void>(resolve => client.once("connect", () => resolve()));
      client.write("{");
      expect(await processes.run({ executable: askpass.environment.SSH_ASKPASS, args: ["tester@example.test's password: "], environment: { ...askpass.environment, SSH_ASKPASS_PROMPT: "confirm" }, timeoutMs: 1000, maxOutputBytes: 100, signal: signal() })).toMatchObject({ exitCode: 1, stdout: "" });
      await askpass.close();
      await closed;
      expect(client.destroyed).toBe(true);
      await expect(fs.stat(askpass.directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { client.destroy(); await processes.close(signal()); await askpass.close(); }
  });
});
