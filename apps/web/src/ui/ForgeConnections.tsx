import { useCallback, useEffect, useRef, useState } from "react";
import type { ForgeConnectionAction, ForgeConnections as ConnectionState, ForgeConnectionStatus, ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";

import { connectForgeGitLab, getForgeConnections, startForgeGitHubConnection } from "../api.js";
import { ControlButton } from "./Control.js";

const roles = ["worker", "reviewer"] as const;
const roleName = (role: ForgeCredentialRole) => role === "worker" ? "issue worker" : "reviewer";

export function ForgeConnections({ repository, savedRepository }: { repository?: ForgeRepository; savedRepository?: ForgeRepository }) {
  const [connections, setConnections] = useState<ConnectionState>();
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [setupToken, setSetupToken] = useState("");
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  const actionRunning = useRef(false);
  const generation = useRef(0);
  const readVersion = useRef(0);
  const consentWindows = useRef(0);
  const preparingWindow = useRef<Window | undefined>(undefined);
  const repositoryKey = repositoryIdentity(repository);
  const savedKey = repositoryIdentity(savedRepository);
  const repositorySaved = Boolean(repository && repositoryKey === savedKey);
  const matchesServer = Boolean(connections?.repository && sameRepository(repository, connections.repository));
  const statuses = matchesServer ? connections?.roles : undefined;
  const renewTokens = statuses?.some(role => role.state === "expired") && !statuses.some(role => role.state === "disconnected");
  const failedSetup = statuses?.some(role => role.state === "failed");
  const refreshConnections = useCallback(() => setRefresh(value => value + 1), []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; preparingWindow.current?.close(); preparingWindow.current = undefined; };
  }, []);

  useEffect(() => {
    generation.current += 1;
    preparingWindow.current?.close();
    preparingWindow.current = undefined;
    setSetupToken("");
    setNotice(undefined);
    setError(undefined);
  }, [repositoryKey, savedKey]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const version = ++readVersion.current;
    setLoadError(undefined);
    void getForgeConnections(controller.signal).then(next => {
      if (controller.signal.aborted || version !== readVersion.current) return;
      setConnections(next);
      if (next.roles.some(role => role.state === "registering" || role.state === "installing")) {
        timer = setTimeout(() => { if (version === readVersion.current) refreshConnections(); }, 2000);
      }
    }).catch(cause => {
      if (!controller.signal.aborted && version === readVersion.current) setLoadError(message(cause));
    });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [repositoryKey, savedKey, refresh, refreshConnections]);

  useEffect(() => {
    window.addEventListener("focus", refreshConnections);
    return () => window.removeEventListener("focus", refreshConnections);
  }, [refreshConnections]);

  const disabled = !repositorySaved || !matchesServer || Boolean(connections?.configurationError) || busy || Boolean(loadError);

  async function connectGitHub(role: ForgeCredentialRole) {
    if (disabled || !repository || actionRunning.current) return;
    const target = `cloudx-forge-${role}-${Date.now()}-${++consentWindows.current}`;
    const popup = window.open("", target, "popup,width=720,height=760");
    if (!popup) { setError("Allow popups for CloudX, then connect again."); return; }
    preparingWindow.current = popup;
    popup.document.title = "Connect GitHub to Forge";
    popup.document.body.textContent = "Preparing GitHub setup…";
    actionRunning.current = true;
    readVersion.current += 1;
    setBusy(true);
    setError(undefined);
    const attempt = generation.current;
    try {
      const action = await startForgeGitHubConnection(repository, role);
      if (!mounted.current || generation.current !== attempt) { popup.close(); return; }
      if (popup.closed) throw new Error("The GitHub setup window was closed. Connect again to continue.");
      popup.opener = null;
      openConsent(action, popup);
      preparingWindow.current = undefined;
      setNotice("Complete setup in the GitHub window. Connection status updates here after installation.");
    } catch (cause) {
      popup.close();
      preparingWindow.current = undefined;
      if (mounted.current && generation.current === attempt) setError(message(cause));
    } finally {
      actionRunning.current = false;
      if (mounted.current) { setBusy(false); refreshConnections(); }
    }
  }

  async function connectGitLab() {
    if (disabled || !repository || !setupToken.trim() || actionRunning.current) return;
    const token = setupToken;
    setSetupToken("");
    actionRunning.current = true;
    readVersion.current += 1;
    setBusy(true);
    setError(undefined);
    const attempt = generation.current;
    let connected = false;
    try {
      const next = await connectForgeGitLab(repository, token);
      connected = true;
      readVersion.current += 1;
      if (mounted.current && generation.current === attempt) setConnections(next);
    } catch (cause) {
      if (mounted.current && generation.current === attempt) setError(message(cause));
    } finally {
      actionRunning.current = false;
      if (mounted.current) { setBusy(false); if (!connected) refreshConnections(); }
    }
  }

  return <section className="forge-connections" aria-label="Forge connections">
    <div className="forge-connection-heading"><h5>Connections</h5><ControlButton size="compact" onClick={refreshConnections} disabled={busy}>Refresh connections</ControlButton></div>
    {!repositorySaved ? <p role="status">Save repository settings first to connect the issue worker and reviewer.</p> : null}
    {!connections && !loadError ? <p role="status">Loading connections…</p> : null}
    {error || loadError || connections?.configurationError ? <p role="alert">{error ?? loadError ?? connections?.configurationError}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="forge-connection-roles">
      {roles.map(role => {
        const connection = statuses?.find(item => item.role === role);
        return <article key={role} aria-label={`${roleName(role)} connection`} className="forge-connection-role">
          <div><strong>{role === "worker" ? "Issue worker" : "Reviewer"}</strong><span className="forge-status" role="status">{connectionLabel(connection)}</span></div>
          {connection?.name ? <p>{connection.name}</p> : null}
          {connection?.message ? <p role={connection.state === "failed" ? "alert" : undefined}>{connection.message}</p> : null}
          {connection?.expiresAt ? <small>{connectionExpiry(repository?.provider, connection.state, connection.expiresAt)}</small> : null}
          {repository?.provider === "github" && connection?.state !== "failed" ? <ControlButton size="compact" onClick={() => void connectGitHub(role)} disabled={disabled || connection?.state === "connected"}>{connectionAction(role, connection)}</ControlButton> : null}
        </article>;
      })}
    </div>
    {repository?.provider === "gitlab" && failedSetup ? <p>Inspect the GitLab project service accounts before continuing. CloudX will not repeat an uncertain setup operation.</p> : null}
    {repository?.provider === "gitlab" && !failedSetup && !statuses?.every(role => role.state === "connected") ? <div className="forge-gitlab-setup">
      <label>One-time GitLab setup token<input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={4096} value={setupToken} disabled={disabled} onChange={event => setSetupToken(event.target.value)} /></label>
      <small>Use GitLab 18.11 or later and a personal access token with api scope from a project Maintainer or Owner.</small>
      <small>Creates missing issue-worker and reviewer bot accounts or renews expired tokens. The setup token is used once and is not saved. Active connections are kept.</small>
      <ControlButton onClick={() => void connectGitLab()} disabled={disabled || !setupToken.trim()}>{renewTokens ? "Renew expired GitLab tokens" : "Create GitLab bot connections"}</ControlButton>
      {busy ? <p role="status">Connecting GitLab bots…</p> : null}
    </div> : null}
  </section>;
}

function sameRepository(left: ForgeRepository | undefined, right: ForgeRepository): boolean {
  return left?.provider === right.provider && left.apiUrl === right.apiUrl && left.projectPath === right.projectPath;
}

function repositoryIdentity(repository?: ForgeRepository): string {
  return JSON.stringify(repository ? [repository.provider, repository.apiUrl, repository.projectPath] : null);
}

function connectionLabel(connection?: ForgeConnectionStatus): string {
  if (!connection) return "Not connected";
  return { disconnected: "Not connected", registering: "Awaiting registration", installing: "Awaiting installation", connected: "Connected", expired: "Token expired", failed: "Needs attention" }[connection.state];
}

function connectionAction(role: ForgeCredentialRole, connection?: ForgeConnectionStatus): string {
  const name = roleName(role);
  if (connection?.state === "registering") return `Continue ${name} registration`;
  if (connection?.state === "installing") return `Continue ${name} installation`;
  return `Connect ${name}`;
}

function connectionExpiry(provider: ForgeRepository["provider"] | undefined, state: ForgeConnectionStatus["state"], expiresAt: string): string {
  if (provider === "gitlab") return `Token ${state === "expired" ? "expired" : "expires"} ${new Date(expiresAt).toLocaleDateString()}.`;
  if (Date.parse(expiresAt) <= Date.now()) return "Setup expired. Continue to reopen it.";
  return `Complete setup before ${new Date(expiresAt).toLocaleTimeString()}.`;
}

function openConsent(action: ForgeConnectionAction, popup: Window) {
  if (action.method === "GET") { popup.location.href = action.url; return; }
  const form = popup.document.createElement("form");
  form.method = "POST";
  form.action = action.url;
  form.target = "_self";
  form.hidden = true;
  for (const [name, value] of Object.entries(action.fields ?? {})) {
    const input = popup.document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  popup.document.body.append(form);
  try { HTMLFormElement.prototype.submit.call(form); } finally { form.remove(); }
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
