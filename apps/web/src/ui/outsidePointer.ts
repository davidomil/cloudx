import { useEffect, type RefObject } from "react";

export const OUTSIDE_POINTER_INSIDE_ATTRIBUTE = "data-outside-pointer-inside";

export function isOutsidePointerTarget(root: HTMLElement | null, target: EventTarget | null): boolean {
  const NodeCtor = root?.ownerDocument.defaultView?.Node;
  return Boolean(root && NodeCtor && target instanceof NodeCtor && !root.contains(target) && !isMarkedInsidePointerTarget(root, target));
}

export function useOutsidePointerDismiss<T extends HTMLElement>(open: boolean, rootRef: RefObject<T | null>, onDismiss: () => void) {
  useEffect(() => {
    if (!open) {
      return;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      if (isOutsidePointerTarget(rootRef.current, event.target)) {
        onDismiss();
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [onDismiss, open, rootRef]);
}

function isMarkedInsidePointerTarget(root: HTMLElement, target: Node): boolean {
  const ElementCtor = root.ownerDocument.defaultView?.Element;
  if (!ElementCtor) {
    return false;
  }
  const element = target instanceof ElementCtor ? target : target.parentElement;
  return Boolean(element?.closest(`[${OUTSIDE_POINTER_INSIDE_ATTRIBUTE}="true"]`));
}
