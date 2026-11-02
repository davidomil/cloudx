import { useEffect, useRef, type RefObject } from "react";

export function useCooperationDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    if (!dialog) return;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(element => !element.closest("[hidden]") && !(element instanceof HTMLInputElement && element.type === "hidden"));
    (dialog.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), textarea:not(:disabled)") ?? controls()[0])?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const targets = controls();
      const current = targets.indexOf(document.activeElement as HTMLElement);
      if (!targets.length) { event.preventDefault(); return; }
      if (current === -1 || !event.shiftKey && current === targets.length - 1) { event.preventDefault(); targets[0]?.focus(); }
      else if (event.shiftKey && current === 0) { event.preventDefault(); targets.at(-1)?.focus(); }
    };
    dialog.addEventListener("keydown", keyboard);
    return () => { dialog.removeEventListener("keydown", keyboard); if (previous?.isConnected && !previous.closest("[hidden]")) previous.focus(); };
  }, [ref]);
}
