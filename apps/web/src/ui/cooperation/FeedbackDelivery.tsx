import { useEffect, useState } from "react";
import { Send, UserRoundCheck } from "lucide-react";
import type { CooperationBoard, CooperationInboxEvent } from "@cloudx/shared";
import { getCooperationAgentStatus, redirectCooperationFeedback, sendCooperationFeedback, type CooperationAgentStatus } from "../../cooperationApi.js";
import { ControlButton } from "../Control.js";

export function FeedbackDelivery({ board, event, onChanged, refreshKey = 0 }: { board: CooperationBoard; event: CooperationInboxEvent; onChanged: () => void; refreshKey?: number }) {
  const [status, setStatus] = useState<CooperationAgentStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [redirecting, setRedirecting] = useState(false);
  const [recipient, setRecipient] = useState(event.recipientTabId ?? board.members.find(member => member.role === "responder")?.tabId ?? "");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (!event.recipientTabId) { setStatus(undefined); return; }
    let disposed = false;
    void getCooperationAgentStatus(event.recipientTabId).then(value => { if (!disposed) setStatus(value); }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [event.recipientTabId, event.state, event.boardRevision, refreshKey]);
  useEffect(() => { if (!board.members.some(member => member.tabId === recipient)) setRecipient(board.members.find(member => member.role === "responder")?.tabId ?? board.members[0]?.tabId ?? ""); }, [board.members, recipient]);
  async function send() {
    setBusy(true); setError(undefined);
    try {
      const result = await sendCooperationFeedback(board.boardId, [event.eventId]);
      const delivery = result.deliveries[0];
      if (delivery) setStatus({ tabId: event.recipientTabId!, ...delivery, completions: [] });
      onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="cooperation-feedback-delivery"><p className={`cooperation-delivery delivery-${event.state}`}>{event.state === "needsResponder" ? "Needs a responder" : `${board.members.find(member => member.tabId === event.recipientTabId)?.label ?? event.recipientTabId} · ${event.state === "nativeAccepted" ? "accepted by agent runtime" : event.state}`}</p>{status?.reason ? <p className="cooperation-field-help">{status.state}: {status.reason}</p> : null}{event.state === "unknown" ? <p className="cooperation-field-help">Inspect the original AI session before redirecting uncertain delivery.</p> : null}{board.status !== "closed" ? <div className="cooperation-delivery-actions">{event.state === "queued" ? <ControlButton size="compact" disabled={busy} onClick={() => void send()}><Send size={12} />Send now</ControlButton> : null}{["needsResponder", "queued", "unknown"].includes(event.state) ? <ControlButton size="compact" disabled={busy || !board.members.length} onClick={() => setRedirecting(!redirecting)}><UserRoundCheck size={12} />{event.state === "needsResponder" ? "Choose responder" : "Redirect feedback"}</ControlButton> : null}</div> : null}{redirecting ? <form onSubmit={submit => { submit.preventDefault(); setBusy(true); setError(undefined); void redirectCooperationFeedback(board.boardId, event.eventId, recipient).then(() => { setRedirecting(false); onChanged(); }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)); }}><label>Feedback responder<select aria-label="Feedback responder" value={recipient} onChange={change => setRecipient(change.target.value)}>{board.members.map(member => <option key={member.tabId} value={member.tabId}>{member.label}</option>)}</select></label>{event.state === "unknown" ? <label className="cooperation-checkbox"><input type="checkbox" checked={confirmed} onChange={change => setConfirmed(change.target.checked)} />I inspected the original session and want to redirect this event.</label> : null}<ControlButton size="compact" type="submit" disabled={busy || !recipient || event.state === "unknown" && !confirmed}>Confirm responder</ControlButton></form> : null}{error ? <p className="cooperation-error" role="alert">{error}</p> : null}</div>;
}
