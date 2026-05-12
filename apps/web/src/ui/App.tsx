import { useEffect, useMemo, useState } from "react";
import { Columns2, GitBranch, Mic, MicOff, PanelTopOpen, Plus, RefreshCw, Rows3, Wifi, X } from "lucide-react";

import type { PluginDescriptor, PluginId, TabLayoutState, WorkspaceTab } from "@cloudx/shared";

import { closeTab, createTab, getPlugins, getTabs, setActiveTab, submitAudio, submitTranscript } from "../api.js";
import { FileBrowserPanel } from "./FileBrowserPanel.js";
import { TerminalPanel } from "./TerminalPanel.js";

type Pane = TabLayoutState["panes"][number];
type LayoutDirection = TabLayoutState["direction"];

const LAYOUT_KEY = "cloudx-layout-v1";

export function App() {
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [panes, setPanes] = useState<Pane[]>(loadLayout().panes);
  const [layoutDirection, setLayoutDirection] = useState<LayoutDirection>(loadLayout().direction);
  const [activePaneId, setActivePaneId] = useState(loadLayout().activePaneId);
  const [activeTabId, setActiveTabId] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "processing">("idle");
  const [manualTranscript, setManualTranscript] = useState("");

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    persistLayout({ panes, direction: layoutDirection, activePaneId });
  }, [activePaneId, layoutDirection, panes]);

  const tabById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const pluginById = useMemo(() => new Map(plugins.map((plugin) => [plugin.id, plugin])), [plugins]);

  async function refresh() {
    const [pluginList, tabState] = await Promise.all([getPlugins(), getTabs()]);
    setPlugins(pluginList);
    setTabs(tabState.tabs);
    setActiveTabId(tabState.activeTabId);
    setPanes((current) => reconcilePanes(current, tabState.tabs, tabState.activeTabId));
  }

  async function activateTab(tabId: string, paneId = activePaneId) {
    setActiveTabId(tabId);
    setActivePaneId(paneId);
    setPanes((current) => current.map((pane) => (pane.id === paneId ? { ...pane, activeTabId: tabId } : pane)));
    await setActiveTab(tabId);
  }

  function split(direction: LayoutDirection) {
    setLayoutDirection(direction);
    setPanes((current) => {
      if (current.length >= 4) return current;
      const next = [...current, { id: `pane-${crypto.randomUUID()}`, tabIds: [], activeTabId: undefined, size: 100 }];
      return normalizeSizes(next);
    });
  }

  function resizePane(index: number, deltaPixels: number, containerPixels: number) {
    if (containerPixels <= 0) return;
    const delta = (deltaPixels / containerPixels) * 100;
    setPanes((current) => {
      const next = current.map((pane) => ({ ...pane }));
      const left = next[index];
      const right = next[index + 1];
      if (!left || !right) return current;
      left.size = Math.max(12, left.size + delta);
      right.size = Math.max(12, right.size - delta);
      return normalizeSizes(next);
    });
  }

  function handleDropTab(targetPaneId: string, tabId: string, beforeTabId?: string) {
    if (!tabId) return;
    setPanes((current) => {
      const withoutTab = current.map((pane) => ({ ...pane, tabIds: pane.tabIds.filter((id) => id !== tabId) }));
      return withoutTab.map((pane) => {
        if (pane.id !== targetPaneId) return pane;
        const tabIds = beforeTabId ? insertBefore(pane.tabIds, tabId, beforeTabId) : [...pane.tabIds, tabId];
        return { ...pane, tabIds, activeTabId: tabId };
      });
    });
    void activateTab(tabId, targetPaneId);
  }

  async function handleCreate(input: { pluginId: PluginId; cwd: string; title: string; createDirectory: boolean }) {
    setError(undefined);
    try {
      const tab = await createTab(input);
      setTabs((current) => [...current, tab]);
      setPanes((current) =>
        current.map((pane) =>
          pane.id === activePaneId
            ? {
                ...pane,
                tabIds: [...pane.tabIds, tab.id],
                activeTabId: tab.id
              }
            : pane
        )
      );
      setActiveTabId(tab.id);
      setCreateOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleClose(tabId: string) {
    setError(undefined);
    try {
      const result = await closeTab(tabId);
      setTabs((current) => current.filter((tab) => tab.id !== tabId));
      setPanes((current) =>
        current.map((pane) => {
          const tabIds = pane.tabIds.filter((id) => id !== tabId);
          return { ...pane, tabIds, activeTabId: pane.activeTabId === tabId ? tabIds[0] : pane.activeTabId };
        })
      );
      setActiveTabId(result.activeTabId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleManualTranscript() {
    if (!manualTranscript.trim()) return;
    setVoiceState("processing");
    setError(undefined);
    try {
      await submitTranscript(manualTranscript, activeTabId);
      setManualTranscript("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVoiceState("idle");
    }
  }

  async function handleMic() {
    setError(undefined);
    if (voiceState !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not expose microphone capture.");
      return;
    }
    setVoiceState("recording");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
        };
      });
      recorder.start();
      window.setTimeout(() => recorder.state === "recording" && recorder.stop(), 5000);
      const audio = await stopped;
      setVoiceState("processing");
      await submitAudio(audio, activeTabId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVoiceState("idle");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <GitBranch size={18} />
          <span>Cloudx</span>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={17} />
          </button>
          <button className="icon-button" onClick={() => split("row")} title="Split columns">
            <Columns2 size={17} />
          </button>
          <button className="icon-button" onClick={() => split("column")} title="Split rows">
            <Rows3 size={17} />
          </button>
          <button className="primary-button" onClick={() => setCreateOpen(true)}>
            <Plus size={17} />
            New
          </button>
          <button className={`mic-button ${voiceState}`} onClick={() => void handleMic()} title="Record voice command">
            {voiceState === "recording" ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
        </div>
      </header>

      <section className="status-strip">
        <span>
          <Wifi size={14} /> 0.0.0.0:3001
        </span>
        <span>{activeTabId ? `Active ${tabById.get(activeTabId)?.title ?? activeTabId}` : "No active tab"}</span>
        <span>{voiceState}</span>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className={`pane-grid ${layoutDirection}`}>
        {panes.map((pane, index) => (
          <div
            className={`workspace-pane ${pane.id === activePaneId ? "active" : ""}`}
            key={pane.id}
            style={{ flexBasis: `${pane.size}%` }}
            onClick={() => setActivePaneId(pane.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleDropTab(pane.id, event.dataTransfer.getData("text/tab-id"))}
          >
            <div className="tab-strip">
              {pane.tabIds.map((tabId) => {
                const tab = tabById.get(tabId);
                if (!tab) return null;
                const selected = (pane.activeTabId ?? activeTabId) === tabId;
                return (
                  <button
                    key={tabId}
                    draggable
                    className={`tab-button ${selected ? "selected" : ""}`}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.stopPropagation();
                      handleDropTab(pane.id, event.dataTransfer.getData("text/tab-id"), tabId);
                    }}
                    onDragStart={(event) => event.dataTransfer.setData("text/tab-id", tabId)}
                    onClick={() => void activateTab(tabId, pane.id)}
                  >
                    <span>{tab.title}</span>
                    <small>{tab.status}</small>
                    <X
                      size={13}
                      className="tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleClose(tabId);
                      }}
                    />
                  </button>
                );
              })}
              <button className="new-tab-inline" onClick={() => setCreateOpen(true)} title="New tab">
                <PanelTopOpen size={16} />
              </button>
            </div>
            <div className="pane-body">
              {pane.activeTabId && tabById.has(pane.activeTabId) ? (
                <PluginPanel tab={tabById.get(pane.activeTabId)!} plugin={pluginById.get(tabById.get(pane.activeTabId)!.pluginId)} active={activeTabId === pane.activeTabId} />
              ) : (
                <div className="empty-pane">
                  <PanelTopOpen size={28} />
                  <span>Drop a tab here or create a plugin tab.</span>
                </div>
              )}
            </div>
            {index < panes.length - 1 ? <ResizeHandle direction={layoutDirection} onResize={(delta, total) => resizePane(index, delta, total)} /> : null}
          </div>
        ))}
      </section>

      <footer className="voice-console">
        <input value={manualTranscript} onChange={(event) => setManualTranscript(event.target.value)} placeholder="Type a voice transcript fallback, e.g. 'tell the active Codex tab to run tests'" />
        <button onClick={() => void handleManualTranscript()} disabled={voiceState !== "idle"}>
          Send
        </button>
      </footer>

      {createOpen ? <CreateTabDialog plugins={plugins} onCancel={() => setCreateOpen(false)} onCreate={handleCreate} /> : null}
    </main>
  );
}

function PluginPanel({ tab, plugin, active }: { tab: WorkspaceTab; plugin: PluginDescriptor | undefined; active: boolean }) {
  if (plugin?.panelKind === "file-browser") {
    return <FileBrowserPanel tab={tab} />;
  }
  if (plugin?.panelKind === "terminal" || !plugin) {
    return <TerminalPanel tab={tab} active={active} />;
  }
  return <div className="empty-pane">No panel registered for {plugin.displayName}</div>;
}

function ResizeHandle({ direction, onResize }: { direction: LayoutDirection; onResize: (deltaPixels: number, containerPixels: number) => void }) {
  return (
    <div
      className={`resize-handle ${direction}`}
      onPointerDown={(event) => {
        const start = direction === "row" ? event.clientX : event.clientY;
        const container = event.currentTarget.parentElement?.parentElement;
        const total = direction === "row" ? container?.clientWidth ?? 1 : container?.clientHeight ?? 1;
        const onMove = (moveEvent: PointerEvent) => {
          const current = direction === "row" ? moveEvent.clientX : moveEvent.clientY;
          onResize(current - start, total);
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      }}
    />
  );
}

function reconcilePanes(current: Pane[], tabs: WorkspaceTab[], activeTabId?: string): Pane[] {
  const known = new Set(tabs.map((tab) => tab.id));
  const assigned = new Set<string>();
  const panes = current.map((pane) => {
    const tabIds = pane.tabIds.filter((tabId) => known.has(tabId));
    tabIds.forEach((tabId) => assigned.add(tabId));
    return {
      ...pane,
      tabIds,
      activeTabId: pane.activeTabId && known.has(pane.activeTabId) ? pane.activeTabId : tabIds[0]
    };
  });
  const unassigned = tabs.map((tab) => tab.id).filter((tabId) => !assigned.has(tabId));
  const first = panes[0] ?? { id: "pane-1", tabIds: [], size: 100 };
  return normalizeSizes([
    {
      ...first,
      tabIds: [...first.tabIds, ...unassigned],
      activeTabId: activeTabId ?? first.activeTabId ?? unassigned[0]
    },
    ...panes.slice(1)
  ]);
}

function normalizeSizes(panes: Pane[]): Pane[] {
  const total = panes.reduce((sum, pane) => sum + (pane.size || 100), 0) || 100;
  return panes.map((pane) => ({ ...pane, size: (pane.size || 100) * (100 / total) }));
}

function insertBefore(items: string[], item: string, before: string): string[] {
  const filtered = items.filter((candidate) => candidate !== item);
  const index = filtered.indexOf(before);
  if (index === -1) return [...filtered, item];
  return [...filtered.slice(0, index), item, ...filtered.slice(index)];
}

function loadLayout(): TabLayoutState {
  if (typeof window === "undefined") {
    return defaultLayout();
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? "") as TabLayoutState;
    if (Array.isArray(parsed.panes) && parsed.panes.length > 0 && (parsed.direction === "row" || parsed.direction === "column")) {
      return parsed;
    }
  } catch {
    return defaultLayout();
  }
  return defaultLayout();
}

function persistLayout(layout: TabLayoutState) {
  window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
}

function defaultLayout(): TabLayoutState {
  return {
    panes: [{ id: "pane-1", tabIds: [], activeTabId: undefined, size: 100 }],
    direction: "row",
    activePaneId: "pane-1"
  };
}

function CreateTabDialog({
  plugins,
  onCancel,
  onCreate
}: {
  plugins: PluginDescriptor[];
  onCancel: () => void;
  onCreate: (input: { pluginId: PluginId; cwd: string; title: string; createDirectory: boolean }) => Promise<void>;
}) {
  const creatablePlugins = plugins.filter((plugin) => plugin.creatable);
  const [pluginId, setPluginId] = useState<PluginId>("codex-terminal");
  const [cwd, setCwd] = useState("");
  const [title, setTitle] = useState("");
  const [createDirectory, setCreateDirectory] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await onCreate({ pluginId, cwd, title, createDirectory });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog">
        <h2>New tab</h2>
        <label>
          Plugin
          <select value={pluginId} onChange={(event) => setPluginId(event.target.value)}>
            {creatablePlugins.map((plugin) => (
              <option key={plugin.id} value={plugin.id}>
                {plugin.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Directory
          <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/workspace/project" />
        </label>
        <label>
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional tab title" />
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={createDirectory} onChange={(event) => setCreateDirectory(event.target.checked)} />
          Create directory if needed
        </label>
        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary-button" onClick={() => void submit()} disabled={!cwd || busy}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
