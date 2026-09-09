import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GitBranch, RefreshCw } from "lucide-react";
import type { RulesSkillsGitState } from "@cloudx/shared";

import { ControlButton } from "./Control.js";

export interface RulesSkillsGitActions {
  onLoadGit: () => Promise<RulesSkillsGitState>;
  onSetGitOrigin: (originUrl: string) => Promise<RulesSkillsGitState>;
  onPullGit: () => Promise<RulesSkillsGitState>;
  onPushGit: () => Promise<RulesSkillsGitState>;
}

export function RulesSkillsGitPanel({ onLoadGit, onSetGitOrigin, onPullGit, onPushGit, disabled, hasUnsavedChanges }: RulesSkillsGitActions & { disabled: boolean; hasUnsavedChanges: boolean }) {
  const [git, setGit] = useState<RulesSkillsGitState>();
  const [originDraft, setOriginDraft] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("");
  const running = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setPending("Loading Git status…");
    running.current = true;
    onLoadGit().then((state) => {
      if (active) setGit(state);
    }).catch((err) => {
      if (active) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (active) {
        running.current = false;
        setPending(undefined);
      }
    });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [onLoadGit]);

  async function run(message: string, action: () => Promise<RulesSkillsGitState>, success: string) {
    if (running.current || disabled) return;
    running.current = true;
    setPending(message);
    setError(undefined);
    setStatus("");
    try {
      const state = await action();
      if (mounted.current) {
        setGit(state);
        setStatus(success);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      running.current = false;
      if (mounted.current) setPending(undefined);
    }
  }

  const origin = originDraft ?? git?.originUrl ?? "";
  const originChanged = origin.trim() !== (git?.originUrl ?? "");
  const busy = disabled || Boolean(pending);
  const canSync = git?.isRepository && git.hasCommits && git.branch && git.originUrl && !originChanged;

  return (
    <section className="rules-skills-git" aria-label="Rules and skills Git" aria-busy={Boolean(pending)}>
      <div className="rules-skills-git-heading">
        <h3><GitBranch size={15} /> Git checkout</h3>
        <ControlButton size="compact" iconOnly onClick={() => void run("Refreshing Git status…", onLoadGit, "Git status refreshed.")} disabled={busy} aria-label="Refresh Git status" title="Refresh Git status"><RefreshCw size={15} /></ControlButton>
      </div>
      {git ? <p className="rules-skills-git-root">{git.rootPath}</p> : null}
      {git?.isRepository ? <>
        <p>{git.branch ? `Branch: ${git.branch}` : "Detached HEAD. Check out a branch before syncing."}{!git.hasCommits ? " No commits yet." : ""}</p>
        <form className="rules-skills-git-origin" onSubmit={(event) => {
          event.preventDefault();
          if (!origin.trim() || !originChanged) return;
          void run("Saving origin…", async () => {
            const state = await onSetGitOrigin(origin.trim());
            if (mounted.current) setOriginDraft(undefined);
            return state;
          }, "Origin saved.");
        }}>
          <label>Origin URL<input value={origin} onChange={(event) => setOriginDraft(event.target.value)} disabled={busy} placeholder="git@host:owner/rules-skills.git" autoComplete="off" spellCheck={false} /></label>
          <ControlButton type="submit" size="compact" disabled={busy || !origin.trim() || !originChanged}>Save origin</ControlButton>
        </form>
        {!git.originUrl ? <p>Set origin to pull or push this checkout.</p> : null}
        {originChanged ? <p>Save the origin change before syncing.</p> : null}
        {hasUnsavedChanges ? <p>Save or discard template and rule edits before pulling.</p> : null}
        {git.hasChanges ? <p>Uncommitted catalog changes. Commit or discard them locally before pulling.</p> : null}
        <p>Pull updates this catalog from origin. Push sends existing commits to the same branch on origin; it does not create commits.</p>
        <div className="rules-skills-git-actions">
          <ControlButton size="compact" onClick={() => void run("Pulling…", onPullGit, "Pulled from origin. Rules and skills refreshed.")} disabled={busy || !canSync || hasUnsavedChanges || git.hasChanges}><ArrowDown size={14} /> Pull</ControlButton>
          <ControlButton size="compact" onClick={() => void run("Pushing commits…", onPushGit, "Commits pushed to origin.")} disabled={busy || !canSync || !git.hasCommits}><ArrowUp size={14} /> Push commits</ControlButton>
        </div>
      </> : git ? <p>This catalog is not a Git checkout. Use an existing Git checkout at this catalog root to configure origin, pull, and push.</p> : null}
      {pending || status ? <p role="status">{pending ?? status}</p> : null}
      {error ? <div className="window-menu-error" role="alert">{error}</div> : null}
    </section>
  );
}
