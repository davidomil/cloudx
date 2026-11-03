import fs from "node:fs/promises";
import net, { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HardwareProviderError } from "./HardwareValidation.js";

const helper = fileURLToPath(new URL("../../../helpers/hardware-ssh-askpass.mjs", import.meta.url));
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** One native password prompt. The only secret-bearing channel is the private socket. */
export class SshAskpass {
  readonly environment: Record<string, string>;
  private readonly server = net.createServer(socket => this.accept(socket));
  private readonly sockets = new Set<net.Socket>();
  private readonly password: Buffer;
  private used = false;
  private closing?: Promise<void>;

  private constructor(readonly directory: string, password: string, private readonly username: string, private readonly host: string) {
    this.password = Buffer.from(`${password}\n`);
    this.environment = { SSH_ASKPASS: path.join(directory, "askpass"), SSH_ASKPASS_REQUIRE: "force", CLOUDX_SSH_ASKPASS_SOCKET: path.join(directory, "socket") };
  }

  static async create(password: string, username: string, host: string): Promise<SshAskpass> {
    if (typeof password !== "string" || !password || Buffer.byteLength(password) > 1023 || Buffer.from(password).toString("utf8") !== password || /[\0\r\n]/.test(password)) throw new HardwareProviderError("CREDENTIAL_UNAVAILABLE", "The SSH password must contain 1–1023 UTF-8 bytes without NUL or line breaks.");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ssh-auth-"));
    const broker = new SshAskpass(directory, password, username, host);
    try {
      await fs.chmod(directory, 0o700);
      await fs.access(helper);
      await fs.writeFile(broker.environment.SSH_ASKPASS, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`, { mode: 0o700 });
      await new Promise<void>((resolve, reject) => {
        broker.server.once("error", reject);
        broker.server.listen(broker.environment.CLOUDX_SSH_ASKPASS_SOCKET, () => { broker.server.removeListener("error", reject); resolve(); });
      });
      return broker;
    } catch (error) { await broker.close(); throw error; }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.password.fill(0);
      for (const socket of this.sockets) socket.destroy();
      if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
      await fs.rm(this.directory, { recursive: true, force: true });
    })();
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let request = "";
    socket.on("data", chunk => {
      request += chunk.toString("utf8");
      if (Buffer.byteLength(request) > 4096 || this.closing) return socket.destroy();
      if (!request.endsWith("\n")) return;
      try {
        const value = JSON.parse(request);
        if (!this.used && this.matchesPasswordPrompt(value.prompt) && value.hint === null) { this.used = true; socket.end(this.password); }
        else socket.end();
      } catch { socket.destroy(); }
    });
  }

  private matchesPasswordPrompt(value: unknown): boolean {
    const prefix = `${this.username}@`, suffix = "'s password: ";
    if (typeof value !== "string" || !value.startsWith(prefix) || !value.endsWith(suffix)) return false;
    const promptHost = value.slice(prefix.length, -suffix.length);
    const normalize = (host: string) => isIP(host) === 6 ? new URL(`http://[${host}]/`).hostname : host.toLowerCase();
    return normalize(promptHost) === normalize(this.host);
  }
}
