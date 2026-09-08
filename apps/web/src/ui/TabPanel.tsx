import { useState, type ReactNode } from "react";
import { UI_RENDERER_PLUGIN_WEBVIEW, type PluginDescriptor, type UiContributionDescriptor } from "@cloudx/shared";

export function tabPanelSupportsFileTransfers(plugin: PluginDescriptor | undefined, contribution: UiContributionDescriptor | undefined): boolean {
  return plugin?.panelKind === "file-browser" || plugin?.panelKind === "web-viewer" || contribution?.renderer === UI_RENDERER_PLUGIN_WEBVIEW;
}

export function TabPanel({ selected, retain, children }: { selected: boolean; retain: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(selected);
  if (selected && !visited) {
    setVisited(true);
  }

  return selected || (retain && visited) ? (
    <div hidden={!selected} style={{ display: selected ? "contents" : "none" }}>
      {children}
    </div>
  ) : null;
}
