import { X } from "lucide-react";
import { isCooperationLinkUrl } from "@cloudx/shared";
import { ControlButton } from "../Control.js";
import { CooperationDialog } from "./CooperationDialog.js";

interface LinkDraft { url: string; title: string; description: string }
interface LinkEditorProps {
  draft: LinkDraft; busy: boolean;
  onChange: (patch: Partial<LinkDraft>) => void;
  onClose: () => void; onSave: () => void;
}

export function BoardLinkEditor({ draft, busy, onChange, onClose, onSave }: LinkEditorProps) {
  const valid = isCooperationLinkUrl(draft.url.trim()) && Array.from(draft.title).length <= 200 && Array.from(draft.description).length <= 16000;
  return <CooperationDialog label="Add link" onClose={onClose}>
    <header>
      <h2>Add link</h2>
      <ControlButton iconOnly aria-label="Close link editor" onClick={onClose}><X size={16} /></ControlButton>
    </header>
    <form className="cooperation-link-editor" onSubmit={event => { event.preventDefault(); if (valid && !busy) onSave(); }}>
      <fieldset disabled={busy}>
        <label>Link URL<input autoFocus aria-label="Link URL" type="url" required maxLength={4096} value={draft.url} onChange={event => onChange({ url: event.target.value })} /></label>
        <label>Title<input aria-label="Link title" maxLength={200} value={draft.title} onChange={event => onChange({ title: event.target.value })} /></label>
        <label>Description<textarea aria-label="Link description" maxLength={16000} rows={4} value={draft.description} onChange={event => onChange({ description: event.target.value })} /></label>
      </fieldset>
      <ControlButton type="submit" tone="primary" disabled={busy || !valid}>Add link</ControlButton>
    </form>
  </CooperationDialog>;
}
