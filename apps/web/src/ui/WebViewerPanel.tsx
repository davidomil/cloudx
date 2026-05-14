import { useEffect, useState, type FormEvent } from "react";
import { ExternalLink, RefreshCw, X } from "lucide-react";

import type { WorkspaceTab } from "@cloudx/shared";

import { runTabAction } from "../api.js";
import { ControlButton, ControlLink } from "./Control.js";

interface LocalWebState {
  url?: string;
  updatedAt?: string;
}

export function WebViewerPanel({ tab }: { tab: WorkspaceTab }) {
  const [url, setUrl] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setBusy(true);
    void runTabAction<LocalWebState>(tab.id, "get_state", {})
      .then((state) => {
        if (cancelled) return;
        const nextUrl = state.url ?? "";
        setUrl(nextUrl);
        setDraftUrl(nextUrl);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tab.id]);

  async function openUrl(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const state = await runTabAction<LocalWebState>(tab.id, "open_url", { url: draftUrl });
      const nextUrl = state.url ?? "";
      setUrl(nextUrl);
      setDraftUrl(nextUrl);
      setReloadKey((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearUrl() {
    setBusy(true);
    setError(undefined);
    try {
      await runTabAction<LocalWebState>(tab.id, "clear_url", {});
      setUrl("");
      setDraftUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const frameSrc = url ? localWebFrameSrc(tab.id, url) : "";

  return (
    <div className="web-viewer-panel">
      <form className="web-viewer-toolbar" onSubmit={(event) => void openUrl(event)}>
        <input value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} placeholder="http://127.0.0.1:5173?token=..." inputMode="url" autoComplete="url" aria-label="Local website URL" />
        <ControlButton type="submit" disabled={!draftUrl.trim() || busy} title="Open URL">
          Open
        </ControlButton>
        <ControlButton type="button" iconOnly onClick={() => setReloadKey((current) => current + 1)} disabled={!url} title="Reload viewer">
          <RefreshCw size={15} />
        </ControlButton>
        <ControlButton type="button" iconOnly onClick={() => void clearUrl()} disabled={!url || busy} title="Clear URL">
          <X size={15} />
        </ControlButton>
        {url ? (
          <ControlLink className="web-viewer-popout" iconOnly href={frameSrc} target="_blank" rel="noreferrer" title="Open proxied view in a new browser tab">
            <ExternalLink size={15} />
          </ControlLink>
        ) : null}
      </form>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="web-viewer-content">
        {url ? (
          <iframe
            key={`${tab.id}:${reloadKey}:${url}`}
            className="web-viewer-frame"
            src={frameSrc}
            title={`${tab.title} local web viewer`}
            referrerPolicy="no-referrer"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-same-origin allow-scripts"
          />
        ) : (
          <div className="empty-pane">
            <span>Enter a local URL to load a dashboard.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function localWebFrameSrc(tabId: string, targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl);
    const path = parsed.pathname.replace(/^\/+/, "");
    const normalizedPath = path ? `/${path}` : "/";
    return `/api/local-web/${encodeURIComponent(tabId)}/proxy${normalizedPath}${parsed.search}${parsed.hash}`;
  } catch {
    return targetUrl;
  }
}
