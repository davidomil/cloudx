import { useRef, type ReactNode } from "react";
import { useCooperationDialogFocus } from "./cooperationFocus.js";

export function CooperationDialog({ label, className = "cooperation-dialog", onClose, children }: { label: string; className?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useCooperationDialogFocus(ref, onClose);
  return <div className="cooperation-dialog-backdrop"><section ref={ref} role="dialog" aria-modal="true" aria-label={label} className={className}>{children}</section></div>;
}
