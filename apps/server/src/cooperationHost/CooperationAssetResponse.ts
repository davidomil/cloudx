import type { FastifyReply } from "fastify";
import type { CooperationAsset } from "@cloudx/shared";

const inlineMedia = new Set([
  "audio/aac", "audio/flac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/x-wav",
  "video/mp4", "video/ogg", "video/quicktime", "video/webm"
]);

export function sendCooperationAsset(reply: FastifyReply, original: { asset: CooperationAsset; bytes: Buffer }, request: {
  method: string; range?: string; ifRange?: string; download: boolean;
}) {
  const { asset, bytes } = original;
  const inline = !request.download && (asset.kind !== "file" || inlineMedia.has(asset.mime));
  const etag = `"${asset.sha256}"`;
  reply.header("x-content-type-options", "nosniff").header("accept-ranges", "bytes").header("etag", etag)
    .type(inline ? asset.mime : "application/octet-stream");
  if (!inline) {
    const name = asset.kind === "file" ? asset.name : `${asset.id}.${asset.mime === "image/jpeg" ? "jpg" : asset.mime.slice(6)}`;
    const encoded = encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encoded}`);
  }
  if (request.method === "GET" && request.range && /^bytes=/i.test(request.range) && (!request.ifRange || request.ifRange === etag)) {
    const range = byteRange(request.range, bytes.length);
    if (!range) return reply.code(416).header("content-range", `bytes */${bytes.length}`).send();
    const [start, end] = range;
    return reply.code(206).header("content-range", `bytes ${start}-${end}/${bytes.length}`)
      .header("content-length", end - start + 1).send(bytes.subarray(start, end + 1));
  }
  return reply.header("content-length", bytes.length).send(bytes);
}

function byteRange(header: string, size: number): [number, number] | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || !size || !match[1] && !match[2]) return;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 ? [Math.max(0, size - suffix), size - 1] : undefined;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start < size && start <= end ? [start, end] : undefined;
}
