import { createHash } from "node:crypto";
import path from "node:path";
import { COOPERATION_LIMITS, boundsIntersect, itemBounds, type CooperationBoard, type CooperationItem, type CooperationTarget } from "@cloudx/shared";
import { CooperationError } from "./CooperationError.js";
import { BlackboardRepository } from "./BlackboardRepository.js";

export function boardMarkdown(board: CooperationBoard): string {
  const originalPaths = new Map(board.assets.map(asset => [asset.id, asset.relativePath]));
  const lines = [`# ${board.title}`, "", `Board: ${board.boardId} | schemaVersion: ${board.schemaVersion} | revision: ${board.revision} | cursor: ${board.eventCursor} | ${board.status}`, "",
    "Original paths are relative to blackboard.md.", "", "## Members", ...board.members.map(member => `- ${member.label} [${member.tabId}] (${member.providerId}, ${member.role}, generation ${member.assignmentGeneration})`), "", "## Items"];
  for (const item of [...board.items].sort((a, b) => a.geometry.y - b.geometry.y || a.geometry.x - b.geometry.x || a.id.localeCompare(b.id))) lines.push(...itemMarkdown(item, originalPaths), "");
  lines.push("## Connections");
  for (const edge of board.connections) lines.push(`- [${edge.id}] revision ${edge.revision}: ${edge.from.itemId}:${edge.from.port} → ${edge.to.itemId}:${edge.to.port} (${edge.direction}) — ${edge.description}`, `  Route: ${JSON.stringify(edge.waypoints)}; by ${edge.createdBy}, updated ${edge.updatedBy}`);
  lines.push("", "## Regions");
  for (const region of board.regions) lines.push(`- [${region.id}] ${region.title}: ${region.mode}; owner ${region.ownerActor}; revision ${region.revision}; geometry ${JSON.stringify(region.geometry)}; protected ${region.protectedItemIds.join(", ") || "geometric overlap"}`,
    `  Items: ${board.items.filter(item => region.protectedItemIds.includes(item.id) || boundsIntersect(itemBounds(item), region.geometry)).map(item => item.id).join(", ") || "none"}`);
  lines.push("", "## Feedback");
  for (const reaction of board.reactions) {
    lines.push(`- [${reaction.id}] ${reaction.glyph} ${reaction.description} (${reaction.kind}, ${reaction.author}, revision ${reaction.revision})`);
    if (reaction.threadId) lines.push(`  Thread: ${reaction.threadId}`);
    lines.push(...targetMarkdown(reaction.target, originalPaths));
  }
  lines.push("", "## Threads");
  for (const thread of board.threads) {
    lines.push(`### [${thread.id}] ${thread.status} (revision ${thread.revision})`);
    if (thread.questionReactionId) lines.push(`  Question reaction: ${thread.questionReactionId}`);
    lines.push(...targetMarkdown(thread.target, originalPaths));
    for (const message of thread.messages) lines.push(`- [${message.id}] ${message.author}: ${message.text}`, ...message.sourceRefs.map(source => `  Source: ${source}`));
  }
  lines.push("", "## Original assets");
  for (const asset of board.assets) {
    const description = asset.kind === "file" ? asset.name : `${asset.width}×${asset.height}`;
    lines.push(`- [${asset.id}] ${asset.relativePath} (${asset.mime}; ${description}; ${asset.byteLength} bytes; sha256 ${asset.sha256})`);
  }
  return `${lines.join("\n")}\n`;
}

function itemMarkdown(item: CooperationItem, originalPaths: ReadonlyMap<string, string>): string[] {
  const lines = [`### [${item.id}] ${item.content.title} (${item.kind}, revision ${item.revision})`, `Geometry: ${JSON.stringify(item.geometry)}; by ${item.createdBy}, updated ${item.updatedBy}`];
  if (item.kind === "note" || item.kind === "code") {
    for (const block of item.content.blocks) lines.push(`Block [${block.id}] revision ${block.revision}:`, block.text);
    if (item.kind === "code") lines.push(`Language: ${item.content.language}`);
  } else if (item.kind === "shape") lines.push(`Shape: ${item.content.shape}; ${item.content.label}`);
  else if (item.kind === "image") lines.push(`Original image asset: ${item.content.assetId}`, `Description: ${item.content.alt}`);
  else if (item.kind === "file") lines.push(`Original file asset: ${item.content.assetId}`, `Description: ${item.content.description}`);
  else if (item.kind === "link") lines.push(`URL: ${item.content.url}`, `Description: ${item.content.description}`);
  else lines.push(`Drawing: ${item.content.description}`, `Editable strokes: ${JSON.stringify(item.content.strokes)}`);
  if (item.kind === "image" || item.kind === "file") lines.push(originalPath(item, originalPaths));
  return lines;
}

function originalPath(item: Extract<CooperationItem, { kind: "image" | "file" }>, originalPaths: ReadonlyMap<string, string>): string {
  const relativePath = originalPaths.get(item.content.assetId);
  if (!relativePath) throw new CooperationError("ASSET_INVALID", "The item original is missing from the board manifest.");
  return `Path: ${relativePath}`;
}

function targetMarkdown(target: CooperationTarget, originalPaths: ReadonlyMap<string, string>): string[] {
  const lines = [`  Target: ${target.kind} [${target.id}]`];
  if (target.anchor) lines.push(`  Selected text (${target.anchor.status}): ${JSON.stringify(target.anchor.exact)}; block ${target.anchor.blockId}@${target.anchor.blockRevision}, code points ${target.anchor.start}..${target.anchor.end}`,
    `  Prefix: ${JSON.stringify(target.anchor.prefix)}`, `  Suffix: ${JSON.stringify(target.anchor.suffix)}`);
  if (target.snapshot) {
    lines.push(`  Removed at board revision ${target.snapshot.removedAtBoardRevision}; preserved record:`, JSON.stringify(target.snapshot.record, null, 2));
    const record = target.snapshot.record;
    if ("kind" in record && (record.kind === "image" || record.kind === "file")) lines.push(originalPath(record, originalPaths));
  }
  return lines;
}

export class BoardFileProjection {
  constructor(private readonly repository: BlackboardRepository) {}

  paths(boardId: string) {
    const directory = path.join(this.repository.rootDir, "boards", boardId);
    return { jsonPath: path.join(directory, "blackboard.json"), markdownPath: path.join(directory, "blackboard.md") };
  }

  serialize(board: CooperationBoard) { return `${JSON.stringify(board, null, 2)}\n`; }
  hash(board: CooperationBoard) { return createHash("sha256").update(this.serialize(board)).digest("hex"); }

  async publish(board: CooperationBoard): Promise<void> {
    await this.repository.writeText(`boards/${board.boardId}/blackboard.json`, this.serialize(board));
    await this.repository.writeText(`boards/${board.boardId}/blackboard.md`, boardMarkdown(board));
  }

  async verify(board: CooperationBoard): Promise<void> {
    try {
      const json = await this.repository.readText(`boards/${board.boardId}/blackboard.json`, COOPERATION_LIMITS.snapshotBytes * 2);
      const markdown = await this.repository.readText(`boards/${board.boardId}/blackboard.md`, COOPERATION_LIMITS.snapshotBytes * 2);
      if (json === this.serialize(board) && markdown === boardMarkdown(board)) return;
    } catch { /* Report the managed-document error without exposing filesystem details. */ }
    throw new CooperationError("INTEGRITY_ERROR", "The board projection differs from committed state. Repair its projection before writing.");
  }
}
