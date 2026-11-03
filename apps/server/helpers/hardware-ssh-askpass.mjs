import net from "node:net";

const prompt = process.argv[2];
const address = process.env.CLOUDX_SSH_ASKPASS_SOCKET;
if (!address || !prompt || Buffer.byteLength(prompt) > 2048) process.exit(1);
const socket = net.createConnection(address);
const chunks = [];
let bytes = 0;
const fail = () => { socket.destroy(); process.exitCode = 1; };
socket.setTimeout(2000, fail);
socket.on("error", fail);
socket.on("connect", () => socket.end(`${JSON.stringify({ prompt, hint: process.env.SSH_ASKPASS_PROMPT ?? null })}\n`));
socket.on("data", chunk => {
  bytes += chunk.length;
  if (bytes > 1024) fail();
  else chunks.push(chunk);
});
socket.on("end", () => {
  if (process.exitCode || bytes === 0) fail();
  else process.stdout.write(Buffer.concat(chunks));
});
