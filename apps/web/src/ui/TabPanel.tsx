import { useEffect, useState, type ReactNode } from "react";

export function TabPanel({ active, keepMounted, children }: { active: boolean; keepMounted: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(active);

  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);

  if (!active && !(keepMounted && opened)) return null;

  return <div className="pane-tab-panel" hidden={!active}>{children}</div>;
}
