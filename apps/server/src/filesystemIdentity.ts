import { spawn } from "node:child_process";
import type { DurableDirectoryIdentity } from "./directoryIdentity.js";

export function filesystemIdentity(fd: number): Promise<Pick<DurableDirectoryIdentity, "filesystemId" | "filesystemType">> {
  if (process.platform !== "linux") return Promise.reject(new Error("Durable directory ownership requires Linux and GNU stat."));
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/stat", ["--file-system", "--format=%t:%i", "--", "/proc/self/fd/3"], {
      stdio: ["ignore", "pipe", "ignore", fd], env: { LC_ALL: "C" },
    });
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.stdout!.on("data", chunk => { output += chunk; if (output.length > 256) child.kill("SIGKILL"); });
    child.once("error", error => { clearTimeout(timeout); reject(new Error("Durable filesystem identity requires /usr/bin/stat (GNU coreutils).", { cause: error })); });
    child.once("close", code => {
      clearTimeout(timeout);
      const match = /^([a-f0-9]+):([a-f0-9]{1,32})\n$/u.exec(output);
      if (code !== 0 || !match || /^0+$/u.test(match[2]!)) return reject(new Error("The filesystem did not provide a usable filesystem identity; local resources were preserved."));
      resolve({ filesystemType: match[1]!, filesystemId: match[2]! });
    });
  });
}
