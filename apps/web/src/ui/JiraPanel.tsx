import { useCallback, useEffect, useState } from "react";
import { ExternalLink, MessageSquare, RefreshCw, Send } from "lucide-react";

import type { UiContributionRenderContext } from "./uiContributions.js";
import { ControlButton } from "./Control.js";

type JiraCallHook = NonNullable<UiContributionRenderContext["callHook"]>;

interface JiraUserSummary {
  displayName?: string;
  emailAddress?: string;
}

interface JiraIssueSummary {
  key: string;
  url: string;
  summary: string;
  description?: string;
  issueType?: string;
  status?: string;
  priority?: string;
  projectKey?: string;
  assignee?: JiraUserSummary;
  epicKey?: string;
  epicSummary?: string;
  epicUrl?: string;
  updated?: string;
}

interface JiraDashboardGroup {
  id: string;
  title: string;
  issues: JiraIssueSummary[];
}

interface JiraDashboardResponse extends Record<string, unknown> {
  issues: JiraIssueSummary[];
  groups: JiraDashboardGroup[];
  jql: string;
  groupBy: string;
  sortBy: string;
}

interface JiraCommentSummary {
  id: string;
  bodyText: string;
  author?: JiraUserSummary;
  created?: string;
  url: string;
}

interface JiraTransition {
  id?: string;
  name?: string;
  to?: { name?: string };
}

export function JiraPanel({ callHook }: { callHook: JiraCallHook }) {
  const [dashboard, setDashboard] = useState<JiraDashboardResponse | undefined>();
  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const [selectedIssue, setSelectedIssue] = useState<JiraIssueSummary | undefined>();
  const [comments, setComments] = useState<JiraCommentSummary[]>([]);
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [commentDraft, setCommentDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const loadDashboard = useCallback(async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const response = await callHook<JiraDashboardResponse>("jira.dashboard.list");
      setDashboard(response);
      setSelectedKey((current) => current ?? response.issues[0]?.key);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [callHook]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const loadIssueDetails = useCallback(async (issueKey: string) => {
    const [issueResponse, commentResponse, transitionResponse] = await Promise.all([
      callHook<{ issue: JiraIssueSummary }>("jira.issue.get", { issueIdOrKey: issueKey }),
      callHook<{ comments: JiraCommentSummary[] }>("jira.issue.comments.list", { issueIdOrKey: issueKey }),
      callHook<{ transitions: JiraTransition[] }>("jira.issue.transitions.list", { issueIdOrKey: issueKey })
    ]);
    setSelectedIssue(issueResponse.issue);
    setComments(commentResponse.comments);
    setTransitions(transitionResponse.transitions);
  }, [callHook]);

  useEffect(() => {
    if (!selectedKey) {
      setSelectedIssue(undefined);
      setComments([]);
      setTransitions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      setNotice(undefined);
      try {
        if (!cancelled) {
          await loadIssueDetails(selectedKey);
        }
      } catch (error) {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadIssueDetails, selectedKey]);

  const addComment = useCallback(async () => {
    const body = commentDraft.trim();
    if (!selectedKey || !body) {
      return;
    }
    setActionBusy(true);
    setNotice(undefined);
    try {
      await callHook("jira.issue.comment.add", { issueIdOrKey: selectedKey, body });
      setCommentDraft("");
      await loadIssueDetails(selectedKey);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  }, [callHook, commentDraft, loadIssueDetails, selectedKey]);

  const transitionIssue = useCallback(async (transitionId: string | undefined) => {
    if (!selectedKey || !transitionId) {
      return;
    }
    setActionBusy(true);
    setNotice(undefined);
    try {
      await callHook("jira.issue.transition", { issueIdOrKey: selectedKey, transitionId });
      await Promise.all([loadDashboard(), loadIssueDetails(selectedKey)]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  }, [callHook, loadDashboard, loadIssueDetails, selectedKey]);

  return (
    <section className="jira-panel">
      <header className="jira-panel-header">
        <div>
          <h2>Jira</h2>
          <p>{dashboard?.jql ?? "Dashboard"}</p>
        </div>
        <ControlButton size="compact" iconOnly title="Refresh Jira" aria-label="Refresh Jira" onClick={() => void loadDashboard()} disabled={busy}>
          <RefreshCw size={15} />
        </ControlButton>
      </header>
      {notice ? <div className="jira-notice" role="alert">{notice}</div> : null}
      <div className="jira-panel-body">
        <div className="jira-dashboard-list" aria-label="Jira issues">
          {(dashboard?.groups ?? []).map((group) => (
            <section className="jira-group" key={group.id}>
              <h3>{group.title}</h3>
              {group.issues.map((issue) => (
                <button type="button" key={issue.key} className={`jira-issue-row${selectedKey === issue.key ? " selected" : ""}`} onClick={() => setSelectedKey(issue.key)}>
                  <span className="jira-issue-key">{issue.key}</span>
                  <span className="jira-issue-summary">{issue.summary}</span>
                  <span className="jira-issue-meta">{[issue.priority, issue.status].filter(Boolean).join(" · ")}</span>
                </button>
              ))}
            </section>
          ))}
          {!busy && dashboard && dashboard.issues.length === 0 ? <div className="empty-pane">No Jira issues matched the dashboard JQL.</div> : null}
        </div>
        <aside className="jira-detail" aria-label="Jira issue detail">
          {selectedIssue ? (
            <>
              <div className="jira-detail-title">
                <div>
                  <span className="jira-issue-key">{selectedIssue.key}</span>
                  <h3>{selectedIssue.summary}</h3>
                </div>
                <a className="jira-open-link" href={selectedIssue.url} target="_blank" rel="noreferrer" aria-label={`Open ${selectedIssue.key} in Jira`}>
                  <ExternalLink size={15} />
                </a>
              </div>
              <dl className="jira-fields">
                <div><dt>Status</dt><dd>{selectedIssue.status ?? "Unknown"}</dd></div>
                <div><dt>Priority</dt><dd>{selectedIssue.priority ?? "None"}</dd></div>
                <div>
                  <dt>Epic</dt>
                  <dd>
                    {selectedIssue.epicKey && selectedIssue.epicUrl ? (
                      <a href={selectedIssue.epicUrl} target="_blank" rel="noreferrer">{selectedIssue.epicKey}{selectedIssue.epicSummary ? ` ${selectedIssue.epicSummary}` : ""}</a>
                    ) : selectedIssue.epicKey ? `${selectedIssue.epicKey}${selectedIssue.epicSummary ? ` ${selectedIssue.epicSummary}` : ""}` : "None"}
                  </dd>
                </div>
                <div><dt>Assignee</dt><dd>{selectedIssue.assignee?.displayName ?? "Unassigned"}</dd></div>
              </dl>
              {selectedIssue.description ? <p className="jira-description">{selectedIssue.description}</p> : null}
              <section className="jira-transitions">
                <h4>Transitions</h4>
                <div>
                  {transitions.map((transition) => (
                    <button type="button" className="jira-transition-pill" key={transition.id ?? transition.name} onClick={() => void transitionIssue(transition.id)} disabled={actionBusy || !transition.id}>
                      {transition.name ?? transition.to?.name ?? transition.id}
                    </button>
                  ))}
                  {transitions.length === 0 ? <span className="jira-muted">None</span> : null}
                </div>
              </section>
              <section className="jira-comments">
                <h4><MessageSquare size={14} /> Comments</h4>
                <form className="jira-comment-form" onSubmit={(event) => {
                  event.preventDefault();
                  void addComment();
                }}>
                  <textarea value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} placeholder="Add a Jira comment" disabled={actionBusy} />
                  <ControlButton type="submit" size="compact" iconOnly title="Add comment" aria-label="Add comment" disabled={actionBusy || !commentDraft.trim()}>
                    <Send size={14} />
                  </ControlButton>
                </form>
                {comments.map((comment) => (
                  <article key={comment.id} className="jira-comment">
                    <strong>{comment.url ? <a href={comment.url} target="_blank" rel="noreferrer">{comment.author?.displayName ?? "Jira user"}</a> : comment.author?.displayName ?? "Jira user"}</strong>
                    <p>{comment.bodyText}</p>
                  </article>
                ))}
                {comments.length === 0 ? <span className="jira-muted">No comments</span> : null}
              </section>
            </>
          ) : (
            <div className="empty-pane">Select a Jira issue.</div>
          )}
        </aside>
      </div>
    </section>
  );
}
