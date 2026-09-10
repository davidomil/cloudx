import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, GitPullRequest, MessageSquare, Pause, Play, RefreshCw, Settings, Square, Terminal, Trash2 } from "lucide-react";
import { hasUnconfirmedPublication } from "@cloudx/shared";
import type { ForgeChangeRequest, ForgeComment, ForgeDashboard, ForgeIssue, ForgeIssueDetail, ForgeListScope, ForgePage, ForgePlacement, ForgeRepository, ForgeReviewComment, ForgeReviewDraft, ForgeWorker, WorkspaceTab } from "@cloudx/shared";

import { ControlButton } from "./Control.js";
import { ForgeWorkerTabs } from "./ForgeWorkerTabs.js";
import { ForgeWorkerTerminalOverlay } from "./ForgeWorkerTerminalOverlay.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;
type Request = <T>(hook: string, input?: Record<string, unknown>) => Promise<T>;
type RunAction = (work: () => Promise<unknown>, interrupt?: boolean) => Promise<boolean>;
type View = "issues" | "changes" | "workers";
type ReviewEdit = Pick<ForgeReviewDraft, "body" | "event" | "comments">;

export function ForgePanel({ callHook, tab, windowId, paneId, onOpenSettings, workerTabs, active, uiScale, repositorySettingsKey, repositoryChangePending }: {
  callHook: CallHook;
  tab: WorkspaceTab;
  windowId: string;
  paneId: string;
  onOpenSettings?: () => void;
  workerTabs: WorkspaceTab[];
  active: boolean;
  uiScale: number;
  repositorySettingsKey: string;
  repositoryChangePending: boolean;
}) {
  const bridge = useRef(callHook);
  useEffect(() => { bridge.current = callHook; }, [callHook]);
  const request: Request = useCallback(async <T,>(hook: string, input?: Record<string, unknown>) => {
    return await bridge.current<T & Record<string, unknown>>(hook, input, tab.id);
  }, [tab.id]);
  const [view, setView] = useState<View>("issues");
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>();
  const [terminalWorkerId, setTerminalWorkerId] = useState<string>();
  const onViewWorker = (workerId: string) => { setSelectedWorkerId(workerId); setTerminalWorkerId(workerId); };
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; dashboard: ForgeDashboard }>();
  const dashboard = snapshot?.dashboard;
  const repositoryReady = !repositoryChangePending && snapshot?.key === repositorySettingsKey;
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const actionRunning = useRef(false);
  const mounted = useRef(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (repositoryChangePending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoadError(undefined);
    async function loadDashboard() {
      try {
        const next = await request<ForgeDashboard>("forge.dashboard");
        if (cancelled) return;
        setSnapshot({ key: repositorySettingsKey, dashboard: next });
        timer = setTimeout(() => void loadDashboard(), 5000);
      } catch (error) {
        if (!cancelled) setLoadError(errorMessage(error));
      }
    }
    void loadDashboard();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [request, revision, repositorySettingsKey, repositoryChangePending]);

  const runAction: RunAction = async (work, interrupt = false) => {
    if (!interrupt && actionRunning.current) return false;
    if (!interrupt) { actionRunning.current = true; setBusy(true); }
    setActionError(undefined);
    try {
      await work();
      return true;
    } catch (error) {
      if (mounted.current) setActionError(errorMessage(error));
      return false;
    } finally {
      if (!interrupt) actionRunning.current = false;
      if (mounted.current) { if (!interrupt) setBusy(false); refresh(); }
    }
  };

  const placement = { windowId, paneId };
  const repository = repositoryReady ? dashboard?.repository : undefined;
  const workers = dashboard?.workers ?? [];
  const terminalWorker = workers.find(worker => worker.id === terminalWorkerId);
  const changeLabel = repository?.provider === "gitlab" ? "Merge requests" : "Pull requests";
  const awaitingReview = workers.filter((worker) => worker.status === "awaiting_review" && !worker.autoReview?.enabled).length;

  return <section className="forge-panel" aria-label="Forge">
    <header className="forge-header">
      <div><h2><GitPullRequest size={18} /> Forge</h2><p>{repository ? `${repository.provider === "github" ? "GitHub" : "GitLab"} · ${repository.projectPath}` : "Issue workers and reviews"}</p></div>
      <div className="forge-actions">
        {onOpenSettings ? <ControlButton size="compact" onClick={onOpenSettings}><Settings size={14} /> Settings</ControlButton> : null}
        <ControlButton size="compact" iconOnly aria-label="Refresh Forge" title="Refresh Forge" onClick={refresh}><RefreshCw size={14} /></ControlButton>
      </div>
    </header>
    {loadError || actionError ? <div role="alert" className="forge-notice">{actionError ?? loadError}</div> : null}
    {!repositoryReady && !loadError ? <p role="status" className="forge-empty">{repositoryChangePending ? "Updating Forge repository settings…" : "Loading Forge…"}</p> : null}
    {repositoryReady && dashboard && !dashboard.configured ? <div className="forge-empty">
      <p>{dashboard.configurationError ?? "Configure a GitHub or GitLab repository to start work."}</p>
      <p>Choose the repository and templates, then connect the issue worker and reviewer in Forge settings.</p>
      {onOpenSettings ? <ControlButton onClick={onOpenSettings}>Configure Forge</ControlButton> : null}
    </div> : null}
    {dashboard ? <>
      <nav className="forge-tabs" aria-label="Forge sections">
        {(["issues", "changes", "workers"] as const).map((item) => <ControlButton key={item} size="compact" pressed={view === item} onClick={() => setView(item)}>
          {item === "issues" ? "Issues" : item === "changes" ? changeLabel : `Workers (${workers.length})`}
          {item === "workers" && awaitingReview ? <span className="forge-badge">{awaitingReview} awaiting review</span> : null}
        </ControlButton>)}
      </nav>
      {view === "workers" ? <ForgeWorkerTabs workers={workers} selectedWorkerId={selectedWorkerId} onSelectWorker={setSelectedWorkerId}>
        {(worker) => <WorkerCard worker={worker} workers={workers} request={request} placement={placement} runAction={runAction} busy={busy} onViewWorker={onViewWorker} />}
      </ForgeWorkerTabs> : dashboard.configured && repository ? <ForgeItems key={`${repository.provider}:${repository.apiUrl}:${repository.projectPath}:${view}`} kind={view} repository={repository} request={request} revision={revision} workers={workers.filter((worker) => worker.repository.provider === repository.provider && worker.repository.apiUrl === repository.apiUrl && worker.repository.projectPath === repository.projectPath)} placement={placement} runAction={runAction} busy={busy} onViewWorker={onViewWorker} /> : null}
      {active && terminalWorker ? <ForgeWorkerTerminalOverlay key={terminalWorker.id} worker={terminalWorker} workerTabs={workerTabs} uiScale={uiScale} onClose={() => setTerminalWorkerId(undefined)} /> : null}
    </> : null}
  </section>;
}

function ForgeItems({ kind, repository, request, revision, workers, placement, runAction, busy, onViewWorker }: {
  kind: "issues" | "changes";
  repository: ForgeRepository;
  request: Request;
  revision: number;
  workers: ForgeWorker[];
  placement: ForgePlacement;
  runAction: RunAction;
  busy: boolean;
  onViewWorker?: (workerId: string) => void;
}) {
  const provider = repository.provider;
  const defaultFilter = provider === "github" ? "is:open" : "state=opened";
  const [filterText, setFilterText] = useState(defaultFilter);
  const [query, setQuery] = useState<{ filter: string; page: number; scope?: ForgeListScope }>({ filter: defaultFilter, page: 1 });
  const [page, setPage] = useState<ForgePage<ForgeIssue>>();
  const [selected, setSelected] = useState<ForgeIssue>();
  const [detail, setDetail] = useState<ForgeIssueDetail | ForgeChangeRequest>();
  const [listBusy, setListBusy] = useState(true);
  const [detailBusy, setDetailBusy] = useState(false);
  const [listError, setListError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const [reviewBody, setReviewBody] = useState("");
  const [autoReviewDrafts, setAutoReviewDrafts] = useState<Record<number, boolean>>({});
  const singular = kind === "issues" ? "issue" : provider === "gitlab" ? "merge request" : "pull request";
  const selectedNumber = selected?.number;

  useEffect(() => {
    let cancelled = false;
    setListBusy(true);
    setListError(undefined);
    setPage(undefined);
    void request<ForgePage<ForgeIssue>>(`forge.${kind}.list`, { repository, ...query, perPage: 25 }).then((result) => {
      if (cancelled) return;
      setPage(result);
      setSelected((current) => result.items.find((item) => item.number === current?.number) ?? result.items[0]);
    }).catch((error) => { if (!cancelled) setListError(errorMessage(error)); }).finally(() => { if (!cancelled) setListBusy(false); });
    return () => { cancelled = true; };
  }, [request, kind, query, revision, provider, repository.apiUrl, repository.projectPath]);

  useEffect(() => {
    let cancelled = false;
    setDetail(undefined);
    setDetailError(undefined);
    if (selectedNumber === undefined) { setDetailBusy(false); return; }
    setDetailBusy(true);
    const hook = kind === "issues" ? "forge.issue.get" : "forge.change.get";
    void request<{ issue?: ForgeIssueDetail; change?: ForgeChangeRequest }>(hook, { repository, number: selectedNumber }).then((result) => {
      if (!cancelled) setDetail(kind === "issues" ? result.issue : result.change);
    }).catch((error) => { if (!cancelled) setDetailError(errorMessage(error)); }).finally(() => { if (!cancelled) setDetailBusy(false); });
    return () => { cancelled = true; };
  }, [request, kind, selectedNumber, revision, provider, repository.apiUrl, repository.projectPath]);

  useEffect(() => { setReviewBody(""); }, [selectedNumber]);
  const selectedWorkers = workersForItem(workers, kind, selectedNumber);
  const reviews = selectedWorkers.filter(worker => worker.kind === "review").flatMap(reviewRounds).sort((a, b) => Date.parse(reviewStartedAt(b)) - Date.parse(reviewStartedAt(a)));
  const activeWorker = selectedWorkers.find((worker) => worker.kind === (kind === "issues" ? "issue" : "review") && worker.status !== "completed");
  const unconfirmedPublication = selectedWorkers.some(hasUnconfirmedPublication);
  const currentDetail = detail?.number === selectedNumber ? detail : undefined;
  const changeDetail = kind === "changes" && currentDetail && isChangeRequest(currentDetail) ? currentDetail : undefined;
  const reviewDisabled = busy || unconfirmedPublication || !changeDetail || changeDetail.state !== "open" || changeDetail.merged;
  const item = currentDetail ?? selected;
  const autoReview = activeWorker ? !!activeWorker.autoReview?.enabled : !!autoReviewDrafts[item?.number ?? 0];
  const applyScope = (scope?: ForgeListScope) => {
    if (!scope) setFilterText(defaultFilter);
    setSelected(undefined);
    setQuery({ filter: scope ? filterText.trim() : defaultFilter, page: 1, ...(scope ? { scope } : {}) });
  };

  return <div className="forge-items">
    <form className="forge-filter" onSubmit={(event) => { event.preventDefault(); setSelected(undefined); setQuery({ ...query, filter: filterText.trim(), page: 1 }); }}>
      <div className="forge-quick-filters" role="group" aria-label="Quick filters">
        <ControlButton size="compact" pressed={!query.scope && query.filter === defaultFilter} onClick={() => applyScope()}>All open items</ControlButton>
        {([["assigned_to_me", "Assigned to me"], ["created_by_me", "Created by me"], ["created_by_workers", "Created by Forge workers"]] as const).map(([scope, label]) => <ControlButton key={scope} size="compact" pressed={query.scope === scope} onClick={() => applyScope(scope)}>{label}</ControlButton>)}
      </div>
      <label>Filter {kind === "issues" ? "issues" : provider === "gitlab" ? "merge requests" : "pull requests"}
        <input value={filterText} onChange={(event) => setFilterText(event.target.value)} placeholder={defaultFilter} />
      </label>
      <ControlButton type="submit" size="compact">Apply filter</ControlButton>
      <small>{provider === "github" ? "GitHub search qualifiers" : "GitLab URL query parameters"}</small>
    </form>
    <div className="forge-browser">
      <div className="forge-list" aria-label={`${kind === "issues" ? "Issue" : "Change request"} list`} aria-busy={listBusy}>
        {listError ? <p className="forge-notice" role="alert">{listError}</p> : null}
        {listBusy ? <p role="status" className="forge-empty">Loading {kind === "issues" ? "issues" : "requests"}…</p> : null}
        {page?.items.map((entry) => {
          const itemWorkers = workersForItem(workers, kind, entry.number);
          const drafts = itemWorkers.filter((worker) => worker.kind === "review" && worker.draft && worker.draft.status !== "posted");
          const comments = drafts.reduce((count, worker) => count + (worker.draft?.comments.length ?? 0), 0);
          return <button type="button" key={entry.number} className={`forge-item${selectedNumber === entry.number ? " selected" : ""}`} onClick={() => setSelected(entry)} aria-pressed={selectedNumber === entry.number}>
            <span className="forge-item-title">#{entry.number} {entry.title}</span>
            <span className="forge-muted">{entry.state} · {entry.author}{entry.labels.length ? ` · ${entry.labels.join(", ")}` : ""}</span>
            <ItemWorkerStats workers={itemWorkers} />
            {kind === "changes" && drafts.length ? <span className="forge-badge"><MessageSquare size={13} /> {comments} suggested {comments === 1 ? "comment" : "comments"} · {drafts.length} review {drafts.length === 1 ? "draft" : "drafts"}</span> : null}
          </button>;
        })}
        {page && !page.items.length ? <p className="forge-empty">No {kind === "issues" ? "issues" : "requests"} match this filter.</p> : null}
        <div className="forge-pagination">
          <ControlButton size="compact" disabled={listBusy || query.page === 1} onClick={() => { setSelected(undefined); setQuery({ ...query, page: query.page - 1 }); }}>Previous</ControlButton>
          <span>Page {query.page}</span>
          <ControlButton size="compact" disabled={listBusy || !page?.nextPage} onClick={() => { if (page?.nextPage) { setSelected(undefined); setQuery({ ...query, page: page.nextPage }); } }}>Next</ControlButton>
        </div>
      </div>
      <div className="forge-detail" aria-label={`${singular} detail`} aria-busy={detailBusy}>
        {item ? <>
          <div className="forge-detail-heading"><h3>#{item.number} {item.title}</h3><a href={item.url} target="_blank" rel="noreferrer" aria-label={`Open ${singular} #${item.number}`}><ExternalLink size={16} /></a></div>
          <p className="forge-muted">{item.state} · {item.author}</p>
          {kind === "changes" ? <section className="forge-change-actions" aria-label={`${singular} review actions`}>
            {changeDetail ? <p className="forge-muted">{changeDetail.merged ? "Merged" : changeDetail.draft ? "Draft" : changeDetail.approved ? "Approved" : "Awaiting approval"} · {changeDetail.unresolvedDiscussions} unresolved discussions</p> : null}
            <div className="forge-change-toolbar">
              <div className="forge-actions">
                <ControlButton size="compact" disabled={reviewDisabled || !!activeWorker} onClick={() => void runAction(() => request("forge.review.start", { repository, number: item.number, autoPost: false, ...placement }))}>Review</ControlButton>
                <ControlButton size="compact" disabled={reviewDisabled || !!activeWorker} onClick={() => void runAction(() => request("forge.review.start", { repository, number: item.number, autoPost: true, ...placement }))}>Review and post</ControlButton>
              </div>
              {selectedWorkers.filter(worker => worker.kind === "issue").map(worker => <WorkerCard key={worker.id} worker={worker} workers={workers} request={request} placement={placement} runAction={runAction} busy={busy} onViewWorker={onViewWorker} />)}
            </div>
            <div className="forge-review-decision">
              <label className="forge-field">Review message<textarea value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} placeholder="Message for approval or requested changes" rows={2} /></label>
              <div className="forge-actions">
                <ControlButton size="compact" disabled={reviewDisabled || !reviewBody.trim()} onClick={() => void runAction(() => request("forge.change.review", { repository, number: item.number, headSha: changeDetail!.headSha, event: "request_changes", body: reviewBody }))}>Mark as request changes</ControlButton>
                <ControlButton size="compact" disabled={reviewDisabled} onClick={() => void runAction(() => request("forge.change.review", { repository, number: item.number, headSha: changeDetail!.headSha, event: "approve", body: reviewBody }))}><Check size={14} /> Mark as approved</ControlButton>
              </div>
            </div>
            <p className="forge-muted">Reviews are submitted using the configured reviewer identity. A message is required when requesting changes.</p>
          </section> : null}
          {detailBusy ? <p role="status">Loading latest details…</p> : null}
          {detailError ? <p role="alert" className="forge-notice">{detailError}</p> : null}
          {kind === "changes" ? reviews.map(({ worker, archivedDraft }) => <WorkerCard key={`${worker.id}:${archivedDraft?.id ?? worker.draft?.id ?? worker.attemptId ?? "active"}`} worker={worker} workers={workers} archivedDraft={archivedDraft} request={request} placement={placement} runAction={runAction} busy={busy} onViewWorker={onViewWorker} collapsible canSubmitReview={!unconfirmedPublication && !reviewDisabled && worker.draft?.headSha === changeDetail?.headSha} />) : selectedWorkers.map(worker => <WorkerCard key={worker.id} worker={worker} workers={workers} request={request} placement={placement} runAction={runAction} busy={busy} onViewWorker={onViewWorker} showAutoReview={false} canSubmitReview={!unconfirmedPublication} />)}
          <p className="forge-prose">{item.body}</p>
          {kind === "issues" ? <>
            <div className="forge-actions">
              <ControlButton tone="primary" size="compact" disabled={busy || !!activeWorker || item.state !== "open"} onClick={() => void runAction(() => request("forge.issue.start", { repository, number: item.number, autoReview, ...placement }))}><Play size={14} /> Start work</ControlButton>
              <AutoReviewToggle enabled={autoReview} disabled={busy || (!activeWorker && item.state !== "open")} onChange={enabled => {
                if (activeWorker) void runAction(() => request("forge.worker.autoReview", { id: activeWorker.id, enabled, ...placement }));
                else setAutoReviewDrafts(drafts => ({ ...drafts, [item.number]: enabled }));
              }} />
            </div>
            <p className="forge-muted">{autoReview ? "Automatically review changes, address feedback, and merge after approval." : "The worker opens a PR/MR and waits for review. Resume after review to address comments, merge when approved, and clean up."}</p>
          </> : null}
          <ForgeComments comments={currentDetail?.comments ?? []} />
        </> : <p className="forge-empty">Select {kind === "issues" ? "an issue" : `a ${singular}`}.</p>}
      </div>
    </div>
  </div>;
}

function workersForItem(workers: ForgeWorker[], kind: "issues" | "changes", number?: number) {
  if (number === undefined) return [];
  if (kind === "changes") return workers.filter(worker => (worker.kind === "issue" ? worker.changeNumber : worker.number) === number);
  const issueWorkers = workers.filter(worker => worker.kind === "issue" && worker.number === number);
  const issueWorkerIds = new Set(issueWorkers.map(worker => worker.id));
  return workers.filter(worker => issueWorkerIds.has(worker.id) || (worker.kind === "review" && !!worker.issueWorkerId && issueWorkerIds.has(worker.issueWorkerId)));
}

type ReviewRound = { worker: ForgeWorker; archivedDraft?: ForgeReviewDraft };

function reviewRounds(worker: ForgeWorker): ReviewRound[] {
  return [{ worker }, ...(worker.reviewHistory ?? []).map(archivedDraft => ({ worker, archivedDraft }))];
}

function reviewStartedAt({ worker, archivedDraft }: ReviewRound): string {
  return archivedDraft?.startedAt ?? worker.draft?.startedAt ?? worker.startedAt;
}

function ItemWorkerStats({ workers }: { workers: ForgeWorker[] }) {
  const currentWorkers = workers.filter(worker => worker.status !== "completed" || (worker.kind === "review" && worker.draft?.status === "post_failed"));
  if (!currentWorkers.length) return null;
  return <span className="forge-item-workers">
    {currentWorkers.map(worker => {
      const postFailed = worker.status === "completed" && worker.draft?.status === "post_failed";
      return <span key={worker.id} className="forge-item-worker">
        <span className={`forge-status forge-status-${postFailed ? "failed" : worker.status}`}>{worker.kind === "issue" ? "Coding" : "Review"} · {postFailed ? "post failed" : worker.status.replaceAll("_", " ")}</span>
        {worker.autoReview?.enabled ? <span className="forge-muted">Auto review · {worker.autoReview.phase}</span> : null}
        {worker.error ? <span className="forge-item-worker-error" title={worker.error}>{worker.error}</span> : null}
      </span>;
    })}
  </span>;
}

function AutoReviewToggle({ enabled, disabled, onChange }: { enabled: boolean; disabled: boolean; onChange: (enabled: boolean) => void }) {
  return <label className="forge-auto-review-toggle"><input type="checkbox" aria-label="Auto review" checked={enabled} disabled={disabled} onChange={event => onChange(event.target.checked)} /> Auto review</label>;
}

function autoReviewProgress(worker: ForgeWorker) {
  if (!worker.autoReview?.enabled) return undefined;
  const action = worker.pendingPublication ? "Retry publication" : "Resume";
  if (["paused", "stopped"].includes(worker.status)) return `Auto review is enabled. ${action} to continue the loop.`;
  if (["failed", "cleanup_failed"].includes(worker.status)) return `Auto review is waiting for attention. ${action} after resolving the error.`;
  return `Auto review · ${{ implementing: "Implementing changes", reviewing: "Reviewing changes", merging: "Waiting to merge" }[worker.autoReview.phase]}`;
}

function WorkerCard({ worker, workers, archivedDraft, request, placement, runAction, busy, onViewWorker, canSubmitReview = true, showAutoReview = true, collapsible = false }: {
  worker: ForgeWorker;
  workers: ForgeWorker[];
  archivedDraft?: ForgeReviewDraft;
  request: Request;
  placement: ForgePlacement;
  runAction: RunAction;
  busy: boolean;
  onViewWorker?: (workerId: string) => void;
  canSubmitReview?: boolean;
  showAutoReview?: boolean;
  collapsible?: boolean;
}) {
  const [controlling, setControlling] = useState(false);
  const controlRunning = useRef(false);
  async function interruptWorker(action: "pause" | "stop") {
    if (controlRunning.current) return;
    controlRunning.current = true; setControlling(true);
    try { await runAction(() => request(`forge.worker.${action}`, { id: worker.id }), true); }
    finally { controlRunning.current = false; setControlling(false); }
  }
  const automaticReview = !!worker.autoReview?.enabled;
  const reviews = workers.filter(candidate => worker.kind === "issue" && candidate.kind === "review" && candidate.number === worker.changeNumber &&
    candidate.repository.provider === worker.repository.provider && candidate.repository.apiUrl === worker.repository.apiUrl && candidate.repository.projectPath === worker.repository.projectPath);
  const reviewRunning = reviews.some(review => ["starting", "running"].includes(review.status));
  const canPause = ["starting", "running", "awaiting_publication", "awaiting_merge"].includes(worker.status) || (worker.status === "awaiting_review" && automaticReview);
  const canResume = !reviewRunning && ["paused", "failed", "stopped", "cleanup_failed", "awaiting_review", "awaiting_merge"].includes(worker.status);
  const canSync = worker.kind === "issue" && !!worker.changeNumber && !!worker.headSha && !worker.pendingPublication && !worker.mergeAttempted &&
    ["paused", "failed", "stopped", "awaiting_review", "awaiting_merge"].includes(worker.status) && !reviewRunning &&
    !reviews.some(review => review.draft && ["posting", "post_failed"].includes(review.draft.status));
  const canStop = ["starting", "running", "awaiting_publication", "awaiting_merge", "paused", "awaiting_review", "failed"].includes(worker.status);
  const progress = worker.providerRetryAt ? undefined : autoReviewProgress(worker);
  const draft = archivedDraft ?? worker.draft;
  const card = <article className="forge-worker" aria-label={`${worker.kind} worker #${worker.number}`}>
    <div className="forge-worker-heading"><strong>{worker.kind === "issue" ? "Issue" : "Review"} #{worker.number} · {worker.title}</strong>{!archivedDraft ? <span className={`forge-status forge-status-${worker.status}`}>{worker.status.replaceAll("_", " ")}</span> : null}</div>
    <p className="forge-muted">{worker.repository.projectPath}{worker.branch ? ` · ${worker.branch}` : ""}</p>
    {!archivedDraft && worker.error ? <p role="alert" className="forge-notice">{worker.error}</p> : null}
    {!archivedDraft && worker.providerRetryAt ? <p role="status">Worker will retry automatically at <time dateTime={worker.providerRetryAt}>{new Date(worker.providerRetryAt).toLocaleString()}</time>.</p> : null}
    {!archivedDraft && worker.status === "awaiting_publication" ? <p role="status">The commit was pushed. Waiting for {worker.repository.provider === "github" ? "GitHub to confirm the pull" : "GitLab to confirm the merge"} request update; work continues automatically.</p> : null}
    {!archivedDraft && progress ? <p role="status" className="forge-auto-review-status">{progress}</p> : !archivedDraft && worker.status === "awaiting_review" ? <p role="status">Ready for review. Resume after feedback to address comments and check approval.</p> : null}
    {!archivedDraft ? <div className="forge-actions">
      {canPause ? <ControlButton size="compact" disabled={controlling} onClick={() => void interruptWorker("pause")}><Pause size={14} /> Pause</ControlButton> : null}
      {canResume ? <ControlButton size="compact" disabled={busy} onClick={() => void runAction(() => request("forge.worker.resume", { id: worker.id, ...placement }))}><Play size={14} /> {worker.pendingPublication ? "Retry publication" : "Resume"}</ControlButton> : null}
      {canSync ? <ControlButton size="compact" disabled={busy} onClick={() => void runAction(() => request("forge.worker.syncAndReview", { id: worker.id, ...placement }))}><RefreshCw size={14} /> Sync and re-review</ControlButton> : null}
      {canStop ? <ControlButton size="compact" disabled={controlling} onClick={() => void interruptWorker("stop")}><Square size={13} /> Stop</ControlButton> : null}
      {showAutoReview && worker.kind === "issue" && worker.status !== "completed" ? <AutoReviewToggle enabled={automaticReview} disabled={busy} onChange={enabled => void runAction(() => request("forge.worker.autoReview", { id: worker.id, enabled, ...placement }))} /> : null}
      {onViewWorker ? <ControlButton size="compact" onClick={() => onViewWorker(worker.id)}><Terminal size={14} /> View worker</ControlButton> : null}
      {worker.changeUrl ? <a href={worker.changeUrl} target="_blank" rel="noreferrer">Open PR/MR <ExternalLink size={12} /></a> : null}
    </div> : null}
    {draft ? <ReviewEditor key={draft.id} worker={worker} draft={draft} archived={!!archivedDraft} request={request} runAction={runAction} busy={busy} canSubmitReview={canSubmitReview} /> : null}
  </article>;
  if (!collapsible) return card;
  const comments = draft?.comments.length ?? 0;
  const status = draft?.status === "post_failed" ? "failed" : worker.status;
  const startedAt = reviewStartedAt({ worker, archivedDraft });
  return <details className="forge-worker-history">
    <summary>
      <strong>Review #{worker.number}</strong> · <time dateTime={startedAt}>{new Date(startedAt).toLocaleString()}</time>{!archivedDraft ? <> · <span className={`forge-status forge-status-${status}`}>{draft?.status === "post_failed" ? "post failed" : status.replaceAll("_", " ")}</span></> : null}
      {draft ? <span className="forge-muted"> · {draft.status === "posted" ? "Posted review" : "Suggested review"} · {comments} {comments === 1 ? "comment" : "comments"}</span> : null}
    </summary>
    {card}
  </details>;
}

function ReviewEditor({ worker, draft, archived, request, runAction, busy, canSubmitReview }: {
  worker: ForgeWorker;
  draft: ForgeReviewDraft;
  archived: boolean;
  request: Request;
  runAction: RunAction;
  busy: boolean;
  canSubmitReview: boolean;
}) {
  const [edit, setEdit] = useState<ReviewEdit>(() => ({ body: draft.body, event: draft.event, comments: draft.comments.map((comment) => ({ ...comment })) }));
  const [saved, setSaved] = useState(false);
  const locked = archived || busy || draft.status !== "draft";
  const valid = edit.comments.every((comment) => comment.body.trim() && (!comment.path || (Number.isSafeInteger(comment.line) && Number(comment.line) > 0))) && (edit.event !== "request_changes" || !!edit.body.trim()) && (!!edit.body.trim() || edit.comments.length > 0);
  function updateEdit(next: ReviewEdit) { setEdit(next); setSaved(false); }
  function updateComment(index: number, change: Partial<ForgeReviewComment>) {
    updateEdit({ ...edit, comments: edit.comments.map((comment, position) => position === index ? { ...comment, ...change } : comment) });
  }
  async function saveReview(submit: boolean) {
    const successful = await runAction(async () => {
      await request("forge.review.save", { id: worker.id, draftId: draft.id, ...edit });
      if (submit) await request("forge.review.submit", { id: worker.id, draftId: draft.id });
    });
    if (successful) setSaved(true);
  }
  return <details className="forge-review" open>
    <summary><MessageSquare size={14} /> {draft.status === "posted" ? "Posted review" : "Suggested review"} · {edit.comments.length} {edit.comments.length === 1 ? "comment" : "comments"}</summary>
    <fieldset disabled={locked}>
      <label className="forge-field">Review outcome<select value={edit.event} onChange={(event) => updateEdit({ ...edit, event: event.target.value as ReviewEdit["event"] })}><option value="comment">Comment</option><option value="request_changes">Request changes</option><option value="approve">Approve</option></select></label>
      <label className="forge-field">Review summary<textarea rows={3} maxLength={100_000} value={edit.body} onChange={(event) => updateEdit({ ...edit, body: event.target.value })} /></label>
      {edit.comments.map((comment, index) => <div className="forge-draft-comment" key={index}>
        <div className="forge-comment-location">
          <label>File<input maxLength={4096} aria-label={`Comment ${index + 1} file`} value={comment.path ?? ""} onChange={(event) => updateComment(index, event.target.value ? { path: event.target.value } : { path: undefined, oldPath: undefined, line: undefined, side: undefined })} placeholder="General comment" /></label>
          <label>Line<input type="number" min={1} step={1} disabled={!comment.path} aria-label={`Comment ${index + 1} line`} value={comment.line ?? ""} onChange={(event) => updateComment(index, { line: event.target.value ? Number(event.target.value) : undefined })} /></label>
          <label>Side<select disabled={!comment.path} aria-label={`Comment ${index + 1} side`} value={comment.side ?? "RIGHT"} onChange={(event) => updateComment(index, { side: event.target.value as "LEFT" | "RIGHT" })}><option value="RIGHT">New</option><option value="LEFT">Old</option></select></label>
          <ControlButton size="compact" iconOnly aria-label={`Remove comment ${index + 1}`} title="Remove comment" onClick={() => updateEdit({ ...edit, comments: edit.comments.filter((_, position) => position !== index) })}><Trash2 size={14} /></ControlButton>
        </div>
        <label className="forge-field">Comment {index + 1}<textarea rows={3} maxLength={20_000} value={comment.body} onChange={(event) => updateComment(index, { body: event.target.value })} /></label>
      </div>)}
      <div className="forge-actions">
        <ControlButton size="compact" disabled={edit.comments.length >= 100} onClick={() => updateEdit({ ...edit, comments: [...edit.comments, { body: "" }] })}>Add comment</ControlButton>
        <ControlButton size="compact" disabled={!valid} onClick={() => void saveReview(false)}>Save draft</ControlButton>
        <ControlButton tone="primary" size="compact" disabled={!valid || !canSubmitReview} onClick={() => void saveReview(true)}>Submit review</ControlButton>
      </div>
    </fieldset>
    {archived ? <p className="forge-muted">Previous review · read-only</p> : null}
    {!valid && !locked ? <p className="forge-muted">Add a summary or comment, fill every comment body, and provide a positive whole line number for each file comment. Requested changes need a summary.</p> : null}
    {draft.status === "posted" ? <p role="status">Review posted.</p> : draft.status === "posting" ? <p role="status">Posting review…</p> : saved ? <p role="status">Draft saved.</p> : null}
    {draft.status === "post_failed" ? <p role="alert" className="forge-notice">Submission could be incomplete. Inspect the PR/MR for published comments before starting another review.</p> : null}
  </details>;
}

function ForgeComments({ comments }: { comments: ForgeComment[] }) {
  return <section className="forge-comments"><h4>Comments ({comments.length})</h4>{comments.map((comment) => <article key={comment.id}>
    <strong>{comment.author}</strong>{comment.path ? <span className="forge-muted"> · {comment.path}{comment.line ? `:${comment.line}` : ""}</span> : null}
    {comment.resolved !== undefined ? <span className="forge-muted"> · {comment.resolved ? "Resolved" : "Unresolved"}</span> : null}
    <p className="forge-prose">{comment.body}</p>
  </article>)}</section>;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isChangeRequest(item: ForgeIssueDetail | ForgeChangeRequest): item is ForgeChangeRequest { return "headSha" in item; }
