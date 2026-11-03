import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Download, ExternalLink, FileText, Link2 } from "lucide-react";
import { isCooperationLinkUrl, type CooperationFileAsset, type CooperationItem } from "@cloudx/shared";
import { cooperationAssetUrl } from "../../cooperationApi.js";

export function BoardText({ text }: { text: string }) {
  const parts = [];
  let offset = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const url = noteUrl(match[0]);
    if (!isCooperationLinkUrl(url)) continue;
    parts.push(text.slice(offset, match.index));
    parts.push(<a key={match.index} className="nodrag nopan" href={url} target="_blank" rel="noreferrer noopener">{url}</a>);
    offset = match.index + url.length;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}

function noteUrl(token: string): string {
  const opening = { ")": "(", "]": "[", "}": "{" };
  let url = token.replace(/[.,!?;:]+$/u, "");
  while (/[)\]}]$/u.test(url)) {
    const last = url.at(-1)! as keyof typeof opening;
    if (url.split(opening[last]).length >= url.split(last).length) break;
    url = url.slice(0, -1);
  }
  return url;
}

export function BoardLink({ content, panning = false }: { content: Extract<CooperationItem, { kind: "link" }>["content"]; panning?: boolean }) {
  return <div className={`cooperation-link-content${panning ? "" : " nodrag nopan nowheel"}`}>
    <span className="cooperation-link-host"><Link2 size={15} />{new URL(content.url).host}</span>
    <p>{content.description}</p>
    <a className="nodrag nopan nowheel" href={content.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} /><span>{content.url}</span></a>
  </div>;
}

export function BoardFile({ boardId, item, asset, panning = false }: { boardId: string; item: Extract<CooperationItem, { kind: "file" }>; asset?: CooperationFileAsset; panning?: boolean }) {
  const [failed, setFailed] = useState(false);
  const player = useRef<HTMLMediaElement | null>(null);
  const url = asset ? cooperationAssetUrl(boardId, asset.id) : undefined;
  useEffect(() => {
    setFailed(false);
    const media = player.current;
    if (!media || !url) return;
    media.src = url;
    return () => { media.pause(); media.removeAttribute("src"); media.load(); };
  }, [url]);
  if (!asset) return <p className="cooperation-file-content" role="status">Original file unavailable.</p>;
  const media = { ref: (element: HTMLMediaElement | null) => { player.current = element; }, className: "nodrag nopan nowheel", controls: true, preload: "metadata", src: url, onError: () => setFailed(true), onKeyDown: (event: KeyboardEvent<HTMLMediaElement>) => event.stopPropagation(), onClick: (event: MouseEvent<HTMLMediaElement>) => event.stopPropagation(), "aria-label": item.content.title };
  return <div className={`cooperation-file-content${panning ? "" : " nodrag nopan nowheel"}`}>
    {asset.mime.startsWith("audio/") ? <audio key={asset.id} {...media} /> : asset.mime.startsWith("video/") ? <video key={asset.id} {...media} playsInline /> : <FileText size={28} aria-hidden="true" />}
    {failed ? <p role="status">This browser cannot play this file. Download the original to open it.</p> : null}
    <p className="cooperation-file-description">{item.content.description}</p>
    <small>{asset.name} · {asset.mime} · {formatAssetSize(asset.byteLength)}</small>
    <a className="cooperation-file-download nodrag nopan" href={`${url}?download=1`} download={asset.name}><Download size={13} />Download original</a>
  </div>;
}

function formatAssetSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
