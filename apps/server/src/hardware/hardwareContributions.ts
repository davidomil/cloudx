import { readFileSync } from "node:fs";
import type { PluginRuleContribution, PluginSkillContribution } from "@cloudx/plugin-api";
import { HARDWARE_HELPER_PATH } from "./AgentHardwareContext.js";

const helper = 'node "$CLOUDX_HARDWARE_HELPER"';
const protocol = `The host supplies CLOUDX_HARDWARE_CONTEXT and CLOUDX_HARDWARE_HELPER for this exact execution. Run ${helper} COMMAND. If unavailable, deliberately relaunch the AI tab; do not copy a context from another execution. The helper reads private credentials and never prints them.

Commands:
- context: authenticated owner and readiness.
- tags list, types list, statuses list, items list, reservations list: use optional --input query.json; page until nextCursor is null.
- items get --id ID: full current notes, revisions, aliases, access metadata, and holds.
- statuses refresh --input refresh.json: requestId, hardwareId, optional statusIds; reservationId and generation when owned.
- reserve --input reserve.json: requestId, hardwareId, expectedItemRevision, purpose.
- access open/close --input claim.json: requestId, reservationId, generation.
- access invoke --input operation.json: requestId, reservationId, generation, operationId, input.
- release --input release.json: requestId, reservationId, generation.
- receipt --request REQUEST_ID: observe the same persisted operation after a lost response or while running.

Each mutation requires a unique requestId. Record it before dispatch. Reuse only the identical request; never create a replacement ID after a timeout. A running receipt does not grant access. Observe the original receipt until succeeded, failed, or unknown. Unknown effects retain the claim. JSON input files supply data, never interpolated shell arguments. The server derives the owner; omit owner, caller, and targetTabId. A changed execution or attempt cannot inherit a claim.`;

export const HARDWARE_RULES: PluginRuleContribution[] = [{
  id: "hardware-access-policy", description: "Discover, reserve, inspect, and release shared hardware through managed access.",
  text: `Use the Hardware plugin for shared hardware work. Invoke hardware-discover, hardware-reserve, hardware-access, and hardware-release as needed. Discover current capabilities, reserve a suitable item exclusively, wait for an active claim, then reread all notes and confirm suitability before validation or deployment. Notes guide your behavior, including restrictions such as Do not reboot; they are not an enforced command allowlist. A reservation authorizes broad work for the task without per-command approval. Follow existing host controls and higher-priority instructions. Use the exact reservation generation for managed access. Release explicitly when work ends, including known failures. A lost heartbeat, completed turn, idle tab, browser disconnect, or server detach never proves the owner ended. Stop on unknown effects or changed ownership; do not bypass the hold with raw access or override another owner.`
}];

const workflows = [
  ["hardware-discover", "Find suitable SSH or UART hardware and inspect all current machine notes.", `1. Read context, then list the complete tags, types, and statuses catalogs. Use stable IDs in filters.
2. List items. Filters combine text, typeIds, tags.all/any/none, exact typed statuses, availability, and ownedByMe. Boolean false can be a valid required value. Stale or failed observations do not prove readiness.
3. Read each candidate with items get. Read its full notes, connection type, physical aliases, readiness, and current hold. No discovery command opens a device.
4. Select one suitable available item and record its revision and a concrete purpose. Continue with hardware-reserve. A listing does not guarantee acquisition.`],
  ["hardware-reserve", "Reserve hardware exclusively for this exact AI execution or worker attempt.", `1. Discover and inspect the current item. Save a reserve.json payload with a unique requestId, hardwareId, expectedItemRevision, and purpose.
2. Run reserve --input reserve.json. Record the claim and original receipt. Preparing is held but does not permit access.
3. Observe receipt --request REQUEST_ID until the operation succeeds and the reservation is active. A conflict grants no access. Do not select another machine or repeat preparation automatically.
4. Read items get again. Read the notes in full and verify suitability before validation or deployment. Release unsuitable hardware immediately. Continue with hardware-access only while this exact execution owns the active generation.`],
  ["hardware-access", "Run validation and deployment through managed SSH or UART access.", `1. Confirm this exact execution owns an active reservation. Reread the notes before the next work phase. Follow the setup and restrictions.
2. Open managed access with the claim reference and unique requestId. Observe its receipt. A failed open does not authorize a different raw transport.
3. Invoke an advertised operation: ssh.exec, ssh.upload, ssh.download, uart.read, uart.write, or uart.set-lines. Use bounded inputs. SSH scripts travel on stdin. Transfers require admitted local regular files and explicit remote paths. UART uses exact base64 bytes and explicit line endings; a prompt does not prove a shell exit code.
4. Opening a UART can affect DTR/RTS; follow the board procedure. Track task-started background work. Killing local SSH does not prove remote descendants ended.
5. Record actual outcomes. Stop after OWNER_CHANGED, STALE_RESERVATION, invalid phase, or unknown effects. Close and release through hardware-release when the work is settled.`],
  ["hardware-release", "Close managed hardware access and confirm release without discarding uncertainty.", `1. Stop and account for task-started activity using the device procedure. Record validation or deployment outcomes, including failure.
2. Close managed access with the exact held generation and a unique requestId. Observe the original receipt. Close can settle handles in recovery, but cannot erase unknown external effects.
3. Release with the same reservationId and generation and a new unique requestId. Observe the release receipt until success. Only a successful release proves the resource is free.
4. If recovery is required, report its reservation, reason, and unresolved effects. Keep it held for operator inspection. Do not force release, use a fresh request to repeat hooks, or transfer ownership to a replacement attempt.`]
] as const;

export const HARDWARE_SKILLS: PluginSkillContribution[] = workflows.map(([id, description, workflow]) => ({
  id, name: id, description, instructions: `# ${id.replaceAll("-", " ")}\n\n${workflow}\n\n## Helper protocol\n\n${protocol}\n`,
  ...(id === "hardware-discover" ? { files: [{ path: "scripts/hardware-helper.mjs", content: readFileSync(HARDWARE_HELPER_PATH, "utf8"), executable: true }] } : {})
}));
