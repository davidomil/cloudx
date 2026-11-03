import { useEffect, useState } from "react";
import { Check, CircleHelp, Lightbulb, MessageSquare, Pencil, Send, ShieldAlert, Trash2 } from "lucide-react";
import type { CooperationBoard, CooperationInboxEvent, CooperationOperation, CooperationPrecondition, CooperationReaction, CooperationTarget, CooperationThread } from "@cloudx/shared";
import { FeedbackDelivery } from "./FeedbackDelivery.js";
import { ControlButton } from "../Control.js";
import { boardId, targetAuthor, targetTitle } from "./boardModel.js";

const emotes = [{ kind: "question", glyph: "?", title: "Question", Icon: CircleHelp }, { kind: "agree", glyph: "✓", title: "Agree", Icon: Check }, { kind: "concern", glyph: "!", title: "Concern", Icon: ShieldAlert }, { kind: "idea", glyph: "+", title: "Idea", Icon: Lightbulb }, { kind: "custom", glyph: "★", title: "Custom", Icon: MessageSquare }] as const;
export type FeedbackKind = CooperationReaction["kind"];
interface ComposeDraft { kind: FeedbackKind; description: string; glyph: string; recipientTabId: string }
interface ReplyDraft { text: string; sources: string; requestResponse: boolean; recipientTabId: string }
interface ReactionDraft { editing: boolean; description: string; glyph: string; baseRevision: number }
export interface BoardFeedbackDrafts { compositions: Map<string, ComposeDraft>; replies: Map<string, ReplyDraft>; reactions: Map<string, ReactionDraft> }
export function feedbackDraftKey(target: CooperationTarget) { return `${target.kind}:${target.id}:${target.anchor ? `${target.anchor.blockId}:${target.anchor.blockRevision}:${target.anchor.start}:${target.anchor.end}` : "whole"}`; }
export function hasFeedbackDrafts(drafts: BoardFeedbackDrafts) { return [...drafts.compositions.values()].some(draft => draft.description.length > 0) || [...drafts.replies.values()].some(draft => draft.text.length > 0 || draft.sources.length > 0) || [...drafts.reactions.values()].some(draft => draft.editing); }
interface FeedbackProps { board: CooperationBoard; target: CooperationTarget; initialKind?: FeedbackKind; threadId?: string; inbox: CooperationInboxEvent[]; readOnly: boolean; busy: boolean; drafts: BoardFeedbackDrafts; onDraftChanged: () => void; onOperations: (operations: CooperationOperation[], options?: { observedPreconditions?: CooperationPrecondition[] }) => Promise<boolean>; onThread: (target: CooperationTarget, threadId?: string) => void; onDeliveryChanged: () => void; refreshKey: number }

export function BoardFeedback({ board, target, initialKind, threadId, inbox, readOnly, busy, drafts, onDraftChanged, onOperations, onThread, onDeliveryChanged, refreshKey }: FeedbackProps) {
  const owner = targetAuthor(board, target);
  const authorMember = owner?.startsWith("agent:") ? board.members.find(member => member.tabId === owner.slice(6)) : undefined;
  const [compose, updateCompose] = useRetainedDraft<ComposeDraft>(drafts.compositions, feedbackDraftKey(target), saved => ({ kind: "question", description: "", glyph: "★", recipientTabId: authorMember?.tabId ?? board.members.find(member => member.role === "responder")?.tabId ?? "", ...saved, ...(initialKind ? { kind: initialKind } : {}) }), onDraftChanged);
  const { kind, description, glyph, recipientTabId } = compose;
  const reactions = board.reactions.filter(reaction => reaction.target.kind === target.kind && reaction.target.id === target.id);
  const threads = board.threads.filter(thread => thread.target.kind === target.kind && thread.target.id === target.id);
  const currentThread = threadId ? threads.find(thread => thread.id === threadId) : undefined;
  const targetChanged = Boolean(target.snapshot || target.anchor?.status === "stale");
  async function react() {
    if (readOnly || busy || targetChanged) return;
    const id = boardId("reaction");
    const nextThread = boardId("thread");
    if (await onOperations([{ kind: "addReaction", reaction: { id, kind, glyph: kind === "custom" ? glyph : emotes.find(emote => emote.kind === kind)!.glyph, description: description.trim(), target, ...(kind === "question" ? { threadId: nextThread } : {}) }, ...(kind === "question" ? { recipientTabId: recipientTabId || null } : {}) }])) {
      updateCompose({ description: "" });
      if (kind === "question") onThread(target, nextThread);
    }
  }
  return <div className="cooperation-feedback">
    <p className="cooperation-record-address">{target.kind} · {target.id}</p><h3>{targetTitle(board, target)}</h3>
    {target.anchor ? <blockquote className={`cooperation-anchor anchor-${target.anchor.status}`}><small>{target.anchor.status === "stale" ? "Original quote · anchor needs review" : "Selected text"}</small>“{target.anchor.exact}”</blockquote> : null}
    {target.snapshot ? <details><summary>Removed target · retained evidence</summary><pre className="cooperation-tombstone">{JSON.stringify(target.snapshot, null, 2)}</pre></details> : null}
    {currentThread ? <ThreadView key={currentThread.id} board={board} thread={currentThread} inbox={inbox} readOnly={readOnly} busy={busy} drafts={drafts} onDraftChanged={onDraftChanged} onOperations={onOperations} onThread={onThread} onDeliveryChanged={onDeliveryChanged} refreshKey={refreshKey} /> : null}
    {!currentThread || reactions.length ? <div className="cooperation-existing-feedback">{reactions.map(reaction => <ReactionRow key={reaction.id} reaction={reaction} board={board} readOnly={readOnly} busy={busy} drafts={drafts} onDraftChanged={onDraftChanged} onOperations={onOperations} onThread={onThread} />)}</div> : null}
    {!currentThread ? threads.map(thread => <button type="button" className="cooperation-thread-link" key={thread.id} onClick={() => onThread(thread.target, thread.id)}><MessageSquare size={15} /><span>{thread.messages[0]?.text ?? "Discussion"}<small>{thread.status} · {thread.messages.length} messages</small></span></button>) : null}
    {targetChanged ? <p className="cooperation-field-help">This target changed or was removed. Reply in the existing discussion, or review its original evidence and choose a new target before adding feedback.</p> : null}
    <form className="cooperation-feedback-compose" onSubmit={event => { event.preventDefault(); void react(); }}>
      <h4>{target.anchor ? "React to this selection" : "Add feedback"}</h4><div className="cooperation-emote-picker" role="group" aria-label="Feedback kind">{emotes.map(emote => <ControlButton key={emote.kind} iconOnly size="compact" selected={kind === emote.kind} aria-pressed={kind === emote.kind} aria-label={emote.title} title={emote.title} disabled={readOnly} onClick={() => updateCompose({ kind: emote.kind })}><emote.Icon size={16} /></ControlButton>)}</div>
      {kind === "custom" ? <label>Custom emote<input maxLength={16} required value={glyph} onChange={event => updateCompose({ glyph: event.target.value })} disabled={readOnly || busy} /></label> : null}
      <label>{kind === "question" ? "Question" : "Feedback description"}<textarea aria-label={kind === "question" ? "Question" : "Feedback description"} required rows={4} maxLength={4000} placeholder={kind === "question" ? "What needs explaining?" : "What would you like your coworker to know?"} value={description} onChange={event => updateCompose({ description: event.target.value })} disabled={readOnly || busy} /></label>
      {kind === "question" ? <label>Responder<select aria-label="Responder" value={recipientTabId} onChange={event => updateCompose({ recipientTabId: event.target.value })} disabled={readOnly || busy}><option value="">No responder · keep in inbox</option>{recipientTabId && !board.members.some(member => member.tabId === recipientTabId) ? <option value={recipientTabId} disabled>Responder is no longer assigned</option> : null}{board.members.map(member => <option key={member.tabId} value={member.tabId}>{member.label}{member.tabId === authorMember?.tabId ? " · author" : ""}</option>)}</select></label> : null}
      {kind === "question" && !recipientTabId ? <p className="cooperation-field-help">Your question stays on the board. Assign a responder to deliver it.</p> : null}
      <ControlButton tone="primary" size="compact" type="submit" disabled={readOnly || busy || targetChanged || !description.trim() || (kind === "custom" && !glyph.trim())}><Send size={14} />{kind === "question" ? "Ask question" : "Add reaction"}</ControlButton>
    </form>
  </div>;
}

function ReactionRow({ reaction, board, readOnly, busy, drafts, onDraftChanged, onOperations, onThread }: { reaction: CooperationReaction; board: CooperationBoard; readOnly: boolean; busy: boolean; drafts: BoardFeedbackDrafts; onDraftChanged: () => void; onOperations: FeedbackProps["onOperations"]; onThread: FeedbackProps["onThread"] }) {
  const [{ editing, description, glyph, baseRevision }, updateDraft] = useRetainedDraft(drafts.reactions, reaction.id, saved => saved ?? { editing: false, description: reaction.description, glyph: reaction.glyph, baseRevision: reaction.revision }, onDraftChanged);
  const stale = baseRevision !== reaction.revision;
  const loadCurrent = (editing: boolean) => updateDraft({ editing, description: reaction.description, glyph: reaction.glyph, baseRevision: reaction.revision });
  const setDescription = (description: string) => updateDraft({ description });
  const setGlyph = (glyph: string) => updateDraft({ glyph });
  async function save() {
    if (readOnly || busy || stale) return;
    if (await onOperations([{ kind: "updateReaction", reactionId: reaction.id, patch: { description, glyph } }], { observedPreconditions: [{ targetKind: "reaction", targetId: reaction.id, expectedRevision: baseRevision }] })) updateDraft({ editing: false });
  }
  return <div className="cooperation-reaction-row"><span className={`cooperation-reaction reaction-${reaction.kind}`}>{reaction.glyph}</span>{editing ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
    {stale ? <div className="cooperation-error" role="alert">This reaction changed while you were editing. Your draft is retained.<ControlButton size="compact" disabled={busy} onClick={() => loadCurrent(true)}>Discard draft and load current reaction</ControlButton></div> : null}
    <fieldset disabled={readOnly || busy}><label>Reaction glyph<input required maxLength={16} value={glyph} onChange={event => setGlyph(event.target.value)} /></label><label>Edit reaction<textarea aria-label="Edit reaction" required value={description} onChange={event => setDescription(event.target.value)} maxLength={4000} /></label></fieldset>
    <ControlButton type="submit" size="compact" disabled={readOnly || busy || stale}>Save reaction</ControlButton><ControlButton size="compact" disabled={busy} onClick={() => loadCurrent(false)}>Cancel</ControlButton>
  </form> : <div><p>{reaction.description}</p><small>{actorLabel(board, reaction.author)} · {reaction.kind}{reaction.target.anchor?.status === "stale" ? " · stale selection" : ""}</small>{reaction.threadId ? <button type="button" className="cooperation-text-action" onClick={() => onThread(reaction.target, reaction.threadId)}>Open discussion</button> : null}</div>}{!readOnly && !editing ? <div className="cooperation-reaction-controls"><ControlButton size="compact" iconOnly aria-label={`Edit reaction: ${reaction.description}`} disabled={busy} onClick={() => loadCurrent(true)}><Pencil size={12} /></ControlButton><ControlButton size="compact" iconOnly aria-label={`Remove reaction: ${reaction.description}`} disabled={busy} onClick={() => void onOperations([{ kind: "removeReaction", reactionId: reaction.id }])}><Trash2 size={12} /></ControlButton></div> : null}</div>;
}

function ThreadView({ board, thread, inbox, readOnly, busy, drafts, onDraftChanged, onOperations, onThread, onDeliveryChanged, refreshKey }: { board: CooperationBoard; thread: CooperationThread; inbox: CooperationInboxEvent[]; readOnly: boolean; busy: boolean; drafts: BoardFeedbackDrafts; onDraftChanged: () => void; onOperations: FeedbackProps["onOperations"]; onThread: FeedbackProps["onThread"]; onDeliveryChanged: () => void; refreshKey: number }) {
  const [{ text, sources, requestResponse, recipientTabId }, updateDraft] = useRetainedDraft(drafts.replies, thread.id, saved => saved ?? { text: "", sources: "", requestResponse: false, recipientTabId: board.members.find(member => member.role === "responder")?.tabId ?? "" }, onDraftChanged);
  const setText = (text: string) => updateDraft({ text });
  const setSources = (sources: string) => updateDraft({ sources });
  const setRequestResponse = (requestResponse: boolean) => updateDraft({ requestResponse });
  const setRecipientTabId = (recipientTabId: string) => updateDraft({ recipientTabId });
  const [reattaching, setReattaching] = useState(false);
  const [newTargetId, setNewTargetId] = useState(board.items[0]?.id ?? "");
  const deliveries = inbox.filter(event => event.threadId === thread.id);
  return <section className="cooperation-thread" aria-label="Anchored discussion"><div className="cooperation-thread-status">{thread.status === "resolved" ? <Check size={14} /> : <CircleHelp size={14} />}<span>{thread.status === "resolved" ? "Resolved by you" : thread.status === "answered" ? "Answered · awaiting your review" : "Open question"}</span></div>
    {thread.messages.map(message => <article className={`cooperation-thread-message ${message.author.startsWith("agent:") ? "from-agent" : "from-user"}`} key={message.id} data-message-id={message.id} onContextMenu={event => { event.preventDefault(); onThread({ kind: "threadMessage", id: message.id }); }}><header><strong>{actorLabel(board, message.author)}</strong><ControlButton iconOnly size="compact" aria-label="React to message" onClick={() => onThread({ kind: "threadMessage", id: message.id })}><MessageSquare size={12} /></ControlButton></header><p>{message.text}</p>{message.sourceRefs.length ? <ul className="cooperation-source-refs">{message.sourceRefs.map(source => <li key={source}>{/^https?:\/\//i.test(source) ? <a href={source} target="_blank" rel="noreferrer">{source}</a> : <code>{source}</code>}</li>)}</ul> : null}</article>)}
    {deliveries.map(delivery => <FeedbackDelivery key={delivery.eventId} board={board} event={delivery} onChanged={onDeliveryChanged} refreshKey={refreshKey} />)}
    {!readOnly ? <ControlButton className="cooperation-resolve" tone="primary" disabled={busy} onClick={() => void onOperations([{ kind: "resolveThread", threadId: thread.id, resolved: thread.status !== "resolved" }])}><Check size={15} />{thread.status === "resolved" ? "Reopen question" : "Resolve question"}</ControlButton> : null}
    {thread.target.anchor?.status === "stale" || thread.target.snapshot ? <><p className="cooperation-error">The target changed or was removed. Review the original evidence before reattaching.</p><ControlButton size="compact" disabled={readOnly || busy} onClick={() => setReattaching(!reattaching)}>Choose a new target</ControlButton>{reattaching ? <form onSubmit={event => { event.preventDefault(); const target: CooperationTarget = { kind: "item", id: newTargetId }; const operations: CooperationOperation[] = [{ kind: "reattachTarget", targetKind: "thread", targetId: thread.id, target }]; void onOperations(operations).then(saved => { if (saved) { setReattaching(false); onThread(target, thread.id); } }); }}><label>New target item<select aria-label="New target item" value={newTargetId} onChange={event => setNewTargetId(event.target.value)}>{board.items.map(item => <option key={item.id} value={item.id}>{item.content.title}</option>)}</select></label><ControlButton size="compact" type="submit" disabled={!newTargetId || busy}>Attach to whole item</ControlButton></form> : null}</> : null}
    <form className="cooperation-thread-reply" onSubmit={event => { event.preventDefault(); void onOperations([{ kind: "appendThreadMessage", threadId: thread.id, message: { id: boardId("message"), text: text.trim(), sourceRefs: sources.split("\n").map(line => line.trim()).filter(Boolean) }, requestResponse, ...(requestResponse ? { recipientTabId: recipientTabId || null } : {}) }]).then(saved => { if (saved) { setText(""); setSources(""); } }); }}><label>Reply<textarea aria-label="Reply" rows={4} required maxLength={32000} value={text} onChange={event => setText(event.target.value)} disabled={readOnly || busy || thread.status === "resolved"} /></label><details><summary>Sources and response</summary><label>Sources · one per line<textarea aria-label="Sources · one per line" rows={2} value={sources} onChange={event => setSources(event.target.value)} disabled={readOnly || busy} /></label><label className="cooperation-checkbox"><input type="checkbox" checked={requestResponse} onChange={event => setRequestResponse(event.target.checked)} disabled={readOnly || busy} />Request a response</label>{requestResponse ? <label>Reply responder<select aria-label="Reply responder" value={recipientTabId} onChange={event => setRecipientTabId(event.target.value)} disabled={readOnly || busy}><option value="">Keep in board inbox</option>{board.members.map(member => <option key={member.tabId} value={member.tabId}>{member.label}</option>)}</select></label> : null}</details><ControlButton tone="primary" size="compact" type="submit" disabled={readOnly || busy || thread.status === "resolved" || !text.trim()}><Send size={14} />Reply in thread</ControlButton></form>
  </section>;
}

function actorLabel(board: CooperationBoard, actor: string) {
  return actor.startsWith("user:") ? "You" : board.members.find(member => member.tabId === actor.slice(6))?.label ?? actor;
}

function useRetainedDraft<T>(store: Map<string, T>, key: string, initial: (saved: T | undefined) => T, onChanged: () => void) {
  const [, redraw] = useState(() => { store.set(key, initial(store.get(key))); return 0; });
  if (!store.has(key)) store.set(key, initial(undefined));
  const draft = store.get(key)!;
  useEffect(onChanged, [draft, onChanged]);
  return [draft, (patch: Partial<T>) => { store.set(key, { ...store.get(key)!, ...patch }); redraw(version => version + 1); onChanged(); }] as const;
}
