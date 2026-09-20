import fs from "node:fs/promises";
import path from "node:path";

// Codex supplies this event over stdin; the receipt path comes only from CloudX.
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 16_384) throw new Error("Codex session event exceeds the size limit.");
}
const event = JSON.parse(input);
if (!event || typeof event !== "object" || event.hook_event_name !== "SessionStart" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(event.session_id) ||
    typeof event.cwd !== "string" || !path.isAbsolute(event.cwd) ||
    event.transcript_path != null && (typeof event.transcript_path !== "string" || !path.isAbsolute(event.transcript_path))) {
  throw new Error("Invalid Codex session identity event.");
}
const receipt = process.argv[2];
if (!receipt || !path.isAbsolute(receipt)) throw new Error("A conversation receipt path is required.");
const staging = `${receipt}.${process.pid}.tmp`;
try {
  const file = await fs.open(staging, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ sessionId: event.session_id, transcriptPath: event.transcript_path, cwd: event.cwd }));
    await file.sync();
  } finally { await file.close(); }
  await fs.rename(staging, receipt);
} finally { await fs.rm(staging, { force: true }); }
