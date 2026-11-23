import { useEffect, useRef, type ReactNode } from "react";

export function WorkspaceTabStrip({ selection, children }: { selection: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = ref.current;
    const selected = strip?.querySelector<HTMLElement>(".tab-button.selected");
    if (!strip || !selected) return;
    const revealSelectedTab = () => {
      const bounds = strip.getBoundingClientRect();
      const tab = selected.getBoundingClientRect();
      if (tab.left < bounds.left) strip.scrollLeft += tab.left - bounds.left;
      else if (tab.right > bounds.right) strip.scrollLeft += tab.right - bounds.right;
    };
    revealSelectedTab();
    let width = strip.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === strip.clientWidth) return;
      width = strip.clientWidth;
      revealSelectedTab();
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [selection]);
  return <div ref={ref} className="tab-strip" role="group" aria-label="Workspace tabs">{children}</div>;
}
