import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { ChevronDown, Columns2, GitBranch, Mic, MicOff, PanelTopOpen, RefreshCw, Rows3, SquarePlus, Wifi, WifiOff, X } from "lucide-react";

import type { CreateTabRequest, PathOption, PluginDescriptor, PluginId, TabLayoutState, WorkspaceTab, WorkspaceTabsUpdate } from "@cloudx/shared";

import { closeTab, createTab, getHealth, getPathOptions, getPlugins, getTabs, setActiveTab, startAudioStream, submitTranscript, voiceAudioConstraints, type VoiceAudioStreamSession } from "../api.js";
import { FileBrowserPanel } from "./FileBrowserPanel.js";
import {
  activatePane,
  activatePaneTab,
  addTabToPane,
  defaultLayout,
  findPane,
  isStoredLayout,
  listPanes,
  placeTabInPane,
  reconcileLayout,
  removePane,
  removeTabFromPanes,
  resolveTabCreationPaneId,
  resizeSplit,
  splitPane,
  type LayoutDirection,
  type LayoutNode,
  type Pane
} from "./layout.js";
import { shouldSubmitVoiceConsoleKey } from "./keyboard.js";
import { clearFocusedAttention, isTabFocused, updateAttentionTabs } from "./tabAttention.js";
import { disposeTerminalView, disposeTerminalViewsExcept, TerminalPanel } from "./TerminalPanel.js";
import { applyVoiceWorkspaceResults, buildClientVoiceContext, voiceConsoleValue } from "./voiceWorkspace.js";
import { WebViewerPanel } from "./WebViewerPanel.js";

type ConnectionStatus = "checking" | "connected" | "disconnected";

const LAYOUT_KEY = "cloudx-layout-v2";
const AUDIO_INPUT_KEY = "cloudx-audio-input-v1";

export function App() {
  const initialLayout = useMemo(() => loadLayout(), []);
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [layout, setLayout] = useState<TabLayoutState>(initialLayout);
  const [activeTabId, setActiveTabId] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createTargetPaneId, setCreateTargetPaneId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("checking");
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "processing">("idle");
  const [voiceMessage, setVoiceMessage] = useState<string | undefined>();
  const [liveTranscript, setLiveTranscript] = useState<string | undefined>();
  const [manualTranscript, setManualTranscript] = useState("");
  const [attentionTabIds, setAttentionTabIds] = useState<Set<string>>(() => new Set());
  const [selectedAudioInputId, setSelectedAudioInputId] = useState<string | undefined>(() => loadAudioInputId());
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioInputMenuOpen, setAudioInputMenuOpen] = useState(false);
  const [audioInputError, setAudioInputError] = useState<string | undefined>();
  const tabsRef = useRef<WorkspaceTab[]>([]);
  const layoutRef = useRef<TabLayoutState>(initialLayout);
  const activeTabIdRef = useRef<string | undefined>(undefined);
  const createTargetPaneIdRef = useRef<string | undefined>(undefined);
  const audioSessionRef = useRef<VoiceAudioStreamSession | undefined>(undefined);

  useEffect(() => {
    void refresh();
    const closeWorkspaceSocket = subscribeWorkspaceUpdates(
      (update) => {
        applyWorkspaceTabs(update.tabs, update.activeTabId);
        setConnectionStatus("connected");
      },
      () => setConnectionStatus("disconnected")
    );
    const interval = window.setInterval(() => void checkConnection(), 5000);
    return () => {
      audioSessionRef.current?.cancel();
      closeWorkspaceSocket();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    void refreshAudioInputs();
    if (typeof navigator === "undefined") {
      return;
    }
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) {
      return;
    }
    const handleDeviceChange = () => void refreshAudioInputs();
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, []);

  useEffect(() => {
    persistLayout(layout);
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    if (!findPane(layout.root, layout.activePaneId)) {
      setLayout((current) => activatePane(current, listPanes(current.root)[0]?.id ?? defaultLayout().activePaneId));
    }
  }, [layout]);

  useEffect(() => {
    disposeTerminalViewsExcept(new Set(tabs.map((tab) => tab.id)));
  }, [tabs]);

  useEffect(() => {
    setAttentionTabIds((current) => clearFocusedAttention(current, layout));
  }, [layout]);

  const tabById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const pluginById = useMemo(() => new Map(plugins.map((plugin) => [plugin.id, plugin])), [plugins]);
  const panes = useMemo(() => listPanes(layout.root), [layout.root]);
  const activePaneId = layout.activePaneId;
  const serverLabel = window.location.host || "server";
  const activeTab = activeTabId ? tabById.get(activeTabId) : undefined;
  const microphoneUnavailableReason = getMicrophoneUnavailableReason();
  const voiceConsoleText = voiceConsoleValue(voiceState, manualTranscript, voiceMessage, liveTranscript);

  async function refresh() {
    setConnectionStatus("checking");
    try {
      const [pluginList, tabState] = await Promise.all([getPlugins(), getTabs()]);
      setPlugins(pluginList);
      applyWorkspaceTabs(tabState.tabs, tabState.activeTabId);
      setConnectionStatus("connected");
      setError(undefined);
    } catch (err) {
      setConnectionStatus("disconnected");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function applyWorkspaceTabs(nextTabs: WorkspaceTab[], nextActiveTabId?: string) {
    const previousTabs = new Map(tabsRef.current.map((tab) => [tab.id, tab]));
    let nextLayout = reconcileLayout(layoutRef.current, nextTabs, nextActiveTabId);
    if (createTargetPaneIdRef.current && nextActiveTabId && !previousTabs.has(nextActiveTabId)) {
      nextLayout = addTabToPane(nextLayout, resolveTabCreationPaneId(nextLayout, createTargetPaneIdRef.current), nextActiveTabId);
    }
    tabsRef.current = nextTabs;
    layoutRef.current = nextLayout;
    activeTabIdRef.current = nextActiveTabId;
    setTabs(nextTabs);
    setActiveTabId(nextActiveTabId);
    setLayout(nextLayout);
    setAttentionTabIds((current) => updateAttentionTabs(current, previousTabs, nextTabs, nextLayout));
  }

  async function checkConnection() {
    try {
      await getHealth();
      setConnectionStatus("connected");
    } catch {
      setConnectionStatus("disconnected");
    }
  }

  async function activateTab(tabId: string, paneId = activePaneId) {
    activeTabIdRef.current = tabId;
    setActiveTabId(tabId);
    setLayout((current) => activatePaneTab(current, paneId, tabId));
    await setActiveTab(tabId);
  }

  function split(direction: LayoutDirection) {
    setLayout((current) => splitPane(current, direction, () => `pane-${crypto.randomUUID()}`, () => `split-${crypto.randomUUID()}`));
  }

  function resizePane(splitId: string, deltaPixels: number, containerPixels: number) {
    setLayout((current) => resizeSplit(current, splitId, deltaPixels, containerPixels));
  }

  function selectPaneForCreation(paneId: string) {
    createTargetPaneIdRef.current = paneId;
    setCreateTargetPaneId(paneId);
    const nextLayout = activatePane(layoutRef.current, paneId);
    layoutRef.current = nextLayout;
    setLayout(nextLayout);
  }

  function openCreateDialogForPane(paneId: string) {
    selectPaneForCreation(paneId);
    setCreateOpen(true);
  }

  function handleDropTab(targetPaneId: string, tabId: string, beforeTabId?: string) {
    if (!tabId) return;
    setLayout((current) => placeTabInPane(current, targetPaneId, tabId, beforeTabId));
    void activateTab(tabId, targetPaneId);
  }

  function handlePaneFocus(pane: Pane) {
    if (pane.activeTabId) {
      void activateTab(pane.activeTabId, pane.id);
      return;
    }
    setLayout((current) => activatePane(current, pane.id));
  }

  function handleClosePane(paneId: string) {
    setLayout((current) => removePane(current, paneId));
    if (createTargetPaneIdRef.current === paneId) {
      createTargetPaneIdRef.current = undefined;
    }
    setCreateTargetPaneId((current) => (current === paneId ? undefined : current));
  }

  async function handleCreate(input: CreateTabRequest) {
    setError(undefined);
    try {
      const tab = await createTab(input);
      setTabs((current) => upsertTab(current, tab));
      const targetPaneId = createTargetPaneIdRef.current ?? createTargetPaneId;
      setLayout((current) => addTabToPane(current, resolveTabCreationPaneId(current, targetPaneId), tab.id));
      activeTabIdRef.current = tab.id;
      setActiveTabId(tab.id);
      setCreateOpen(false);
      createTargetPaneIdRef.current = undefined;
      setCreateTargetPaneId(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function closeCreateDialog() {
    setCreateOpen(false);
    createTargetPaneIdRef.current = undefined;
    setCreateTargetPaneId(undefined);
  }

  async function handleClose(tabId: string) {
    setError(undefined);
    try {
      const result = await closeTab(tabId);
      setTabs((current) => current.filter((tab) => tab.id !== tabId));
      setLayout((current) => removeTabFromPanes(current, tabId));
      activeTabIdRef.current = result.activeTabId;
      setActiveTabId(result.activeTabId);
      disposeTerminalView(tabId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleTranscriptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (voiceState !== "idle") {
      event.preventDefault();
      return;
    }
    if (!shouldSubmitVoiceConsoleKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) {
      return;
    }
    event.preventDefault();
    void handleManualTranscript();
  }

  async function handleManualTranscript() {
    if (!manualTranscript.trim()) return;
    setVoiceState("processing");
    setVoiceMessage("AI is thinking and controlling Cloudx...");
    setLiveTranscript(undefined);
    setError(undefined);
    try {
      const result = await submitTranscript(manualTranscript, activeTabId, currentVoiceClientContext());
      setManualTranscript("");
      await refresh();
      applyVoiceResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVoiceState("idle");
      setVoiceMessage(undefined);
    }
  }

  async function handleMic() {
    setError(undefined);
    setAudioInputMenuOpen(false);
    if (voiceState === "recording" && audioSessionRef.current) {
      setVoiceState("processing");
      setVoiceMessage("Stopping recording and transcribing with local Faster Whisper.");
      try {
        const result = await audioSessionRef.current.stop();
        audioSessionRef.current = undefined;
        await refresh();
        applyVoiceResult(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        audioSessionRef.current = undefined;
        setVoiceState("idle");
        setVoiceMessage(undefined);
        setLiveTranscript(undefined);
      }
      return;
    }
    if (voiceState !== "idle") return;
    if (microphoneUnavailableReason) {
      setError(microphoneUnavailableReason);
      return;
    }
    setVoiceState("recording");
    setVoiceMessage("Listening and streaming microphone audio...");
    setLiveTranscript(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: voiceAudioConstraints(selectedAudioInputId) });
      void refreshAudioInputs();
      audioSessionRef.current = await startAudioStream(
        stream,
        activeTabId,
        currentVoiceClientContext(),
        (status) => {
          setVoiceState(status.status === "recording" || status.status === "receiving" ? "recording" : "processing");
          setVoiceMessage(status.message);
        },
        (transcript) => {
          setLiveTranscript(transcript.text);
          if (transcript.final) {
            setVoiceMessage("AI is thinking and controlling Cloudx...");
          }
        }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVoiceState("idle");
      setVoiceMessage(undefined);
      setLiveTranscript(undefined);
    }
  }

  async function refreshAudioInputs() {
    if (typeof navigator === "undefined") {
      return;
    }
    if (!navigator.mediaDevices?.enumerateDevices) {
      setAudioInputs([]);
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(devices.filter((device) => device.kind === "audioinput"));
      setAudioInputError(undefined);
    } catch (err) {
      setAudioInputError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleAudioInputMenu() {
    if (voiceState !== "idle") {
      return;
    }
    if (microphoneUnavailableReason) {
      setError(microphoneUnavailableReason);
      return;
    }
    const nextOpen = !audioInputMenuOpen;
    setAudioInputMenuOpen(nextOpen);
    if (nextOpen) {
      await refreshAudioInputs();
    }
  }

  function chooseAudioInput(deviceId?: string) {
    setSelectedAudioInputId(deviceId);
    persistAudioInputId(deviceId);
    setAudioInputMenuOpen(false);
  }

  function applyVoiceResult(result: Awaited<ReturnType<typeof submitTranscript>>) {
    const next = applyVoiceWorkspaceResults(
      { layout: layoutRef.current, tabs: tabsRef.current, activeTabId: activeTabIdRef.current },
      result,
      {
        createPaneId: () => `pane-${crypto.randomUUID()}`,
        createSplitId: () => `split-${crypto.randomUUID()}`
      }
    );
    tabsRef.current = next.tabs;
    layoutRef.current = next.layout;
    activeTabIdRef.current = next.activeTabId;
    setTabs(next.tabs);
    setLayout(next.layout);
    setActiveTabId(next.activeTabId);
  }

  function currentVoiceClientContext() {
    return buildClientVoiceContext(layoutRef.current, tabsRef.current);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <GitBranch size={18} />
          <span className="brand-mark cyber-glitch" data-text="Cloudx">
            Cloudx
          </span>
          <span className={`connection-status ${connectionStatus}`} title={`Server ${connectionStatus}: ${serverLabel}`}>
            {connectionStatus === "connected" ? <Wifi size={14} /> : <WifiOff size={14} />} {serverLabel}
          </span>
          {activeTab ? <span className="brand-active-tab" title={`Active tab: ${activeTab.title}`}>{activeTab.title}</span> : null}
          {voiceState !== "idle" ? <span className={`voice-status ${voiceState}`}>{voiceState}</span> : null}
        </div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={() => window.location.reload()} title="Reload app">
            <RefreshCw size={17} />
          </button>
          <button className="icon-button" onClick={() => split("row")} title="Split columns">
            <Columns2 size={17} />
          </button>
          <button className="icon-button" onClick={() => split("column")} title="Split rows">
            <Rows3 size={17} />
          </button>
          <div className="mic-control">
            <button className={`mic-button ${voiceState} ${microphoneUnavailableReason ? "unavailable" : ""}`} onClick={() => void handleMic()} title={microphoneUnavailableReason ?? (voiceState === "recording" ? "Stop voice command" : "Record voice command")}>
              {voiceState === "recording" ? <MicOff size={17} /> : <Mic size={17} />}
            </button>
            <button
              className={`mic-source-button ${audioInputMenuOpen ? "open" : ""}`}
              onClick={() => void toggleAudioInputMenu()}
              disabled={voiceState !== "idle" || Boolean(microphoneUnavailableReason)}
              title="Select microphone"
              aria-label="Select microphone"
              aria-expanded={audioInputMenuOpen}
              aria-haspopup="menu"
            >
              <ChevronDown size={13} />
            </button>
            {audioInputMenuOpen ? (
              <div className="mic-source-menu" role="menu" aria-label="Microphone devices">
                <button type="button" className={!selectedAudioInputId ? "selected" : ""} onClick={() => chooseAudioInput(undefined)} role="menuitem">
                  <span>Browser default</span>
                  {!selectedAudioInputId ? <small>Selected</small> : null}
                </button>
                {audioInputs.map((device, index) => (
                  <button
                    type="button"
                    className={selectedAudioInputId === device.deviceId ? "selected" : ""}
                    onClick={() => chooseAudioInput(device.deviceId)}
                    role="menuitem"
                    key={device.deviceId || `audioinput-${index}`}
                  >
                    <span>{audioInputLabel(device, index)}</span>
                    {selectedAudioInputId === device.deviceId ? <small>Selected</small> : null}
                  </button>
                ))}
                {audioInputs.length === 0 ? <div className="mic-source-empty">No microphones found.</div> : null}
                {audioInputError ? <div className="mic-source-error">{audioInputError}</div> : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="pane-root">
        {renderLayoutNode(layout.root)}
      </section>

      <footer className="voice-console">
        <textarea
          aria-label="Voice transcript"
          value={voiceConsoleText}
          onChange={(event) => {
            if (voiceState === "idle") {
              setManualTranscript(event.target.value);
            }
          }}
          onKeyDown={handleTranscriptKeyDown}
          placeholder={voiceState === "idle" ? "Type voice command. Enter sends, Shift+Enter newline." : "AI is thinking..."}
          rows={2}
          readOnly={voiceState !== "idle"}
          aria-busy={voiceState === "processing"}
          aria-disabled={voiceState !== "idle"}
        />
      </footer>

      {createOpen ? <CreateTabDialog plugins={plugins} onCancel={closeCreateDialog} onCreate={handleCreate} /> : null}
    </main>
  );

  function renderLayoutNode(node: LayoutNode): ReactElement {
    if (node.type === "pane") {
      return renderPane(node.pane);
    }
    return (
      <div className={`pane-split ${node.direction}`} data-split-id={node.id}>
        <div className="pane-split-child" style={{ flexBasis: `${node.sizes[0]}%` }}>
          {renderLayoutNode(node.children[0])}
        </div>
        <ResizeHandle direction={node.direction} onResize={(delta, total) => resizePane(node.id, delta, total)} />
        <div className="pane-split-child" style={{ flexBasis: `${node.sizes[1]}%` }}>
          {renderLayoutNode(node.children[1])}
        </div>
      </div>
    );
  }

  function renderPane(pane: Pane): ReactElement {
    const paneActive = pane.id === activePaneId;
    return (
      <div
        className={`workspace-pane ${paneActive ? "active" : ""}`}
        key={pane.id}
        data-pane-id={pane.id}
        onClick={() => handlePaneFocus(pane)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => handleDropTab(pane.id, event.dataTransfer.getData("text/tab-id"))}
      >
        <div className="tab-strip">
          {pane.tabIds.map((tabId) => {
            const tab = tabById.get(tabId);
            if (!tab) return null;
            const selected = pane.activeTabId === tabId;
            const focused = isTabFocused(layout, tabId);
            const shouldBlink = attentionTabIds.has(tabId) && !focused;
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
                onClick={(event) => {
                  event.stopPropagation();
                  void activateTab(tabId, pane.id);
                }}
              >
                <span className="tab-title">{tab.title}</span>
                <TabIndicatorDot tab={tab} attention={shouldBlink} />
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
          <button
            type="button"
            className="new-tab-inline add-tab-button"
            onPointerDown={(event) => {
              event.stopPropagation();
              selectPaneForCreation(pane.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              openCreateDialogForPane(pane.id);
            }}
            title="Add tab to this pane"
          >
            <SquarePlus size={18} />
          </button>
          {panes.length > 1 ? (
            <button
              className="new-tab-inline pane-close-button"
              onClick={(event) => {
                event.stopPropagation();
                handleClosePane(pane.id);
              }}
              title="Close pane"
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
        <div className="pane-body">
          {pane.activeTabId && tabById.has(pane.activeTabId) ? (
            <PluginPanel tab={tabById.get(pane.activeTabId)!} plugin={pluginById.get(tabById.get(pane.activeTabId)!.pluginId)} active={paneActive} />
          ) : (
            <div className="empty-pane">
              <PanelTopOpen size={28} />
              <span>Drop a tab here or create a plugin tab.</span>
            </div>
          )}
        </div>
      </div>
    );
  }
}

function TabIndicatorDot({ tab, attention }: { tab: WorkspaceTab; attention?: boolean }) {
  const title = tab.indicator.message ? `${tab.indicator.label}: ${tab.indicator.message}` : tab.indicator.label;
  return <span className={`tab-indicator ${tab.indicator.color} ${attention ? "attention" : ""}`} title={title} aria-label={title} />;
}

function PluginPanel({ tab, plugin, active }: { tab: WorkspaceTab; plugin: PluginDescriptor | undefined; active: boolean }) {
  if (plugin?.panelKind === "file-browser") {
    return <FileBrowserPanel tab={tab} />;
  }
  if (plugin?.panelKind === "web-viewer") {
    return <WebViewerPanel tab={tab} />;
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

function loadLayout(): TabLayoutState {
  if (typeof window === "undefined") {
    return defaultLayout();
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? "") as unknown;
    if (isStoredLayout(parsed)) {
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

function loadAudioInputId(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.localStorage.getItem(AUDIO_INPUT_KEY) || undefined;
}

function persistAudioInputId(deviceId: string | undefined) {
  if (deviceId) {
    window.localStorage.setItem(AUDIO_INPUT_KEY, deviceId);
    return;
  }
  window.localStorage.removeItem(AUDIO_INPUT_KEY);
}

function audioInputLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `Microphone ${index + 1}`;
}

function upsertTab(tabs: WorkspaceTab[], tab: WorkspaceTab): WorkspaceTab[] {
  const existingIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
  if (existingIndex === -1) {
    return [...tabs, tab];
  }
  return [...tabs.slice(0, existingIndex), tab, ...tabs.slice(existingIndex + 1)];
}

function getMicrophoneUnavailableReason(): string | undefined {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Microphone capture requires HTTPS or localhost. Run Cloudx over https://<host>:3001 and trust the local Cloudx certificate on this device.";
  }
  if (typeof navigator === "undefined") {
    return "This browser does not expose microphone capture.";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser does not expose microphone capture.";
  }
  if (typeof MediaRecorder === "undefined") {
    return "This browser does not support MediaRecorder microphone upload.";
  }
  return undefined;
}

function subscribeWorkspaceUpdates(onUpdate: (update: WorkspaceTabsUpdate) => void, onDisconnect: () => void): () => void {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/workspace`);
  let closedByClient = false;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as WorkspaceTabsUpdate;
    if (message.type === "tabs") {
      onUpdate(message);
    }
  });
  socket.addEventListener("close", () => {
    if (!closedByClient) {
      onDisconnect();
    }
  });

  return () => {
    closedByClient = true;
    socket.close();
  };
}

function CreateTabDialog({
  plugins,
  onCancel,
  onCreate
}: {
  plugins: PluginDescriptor[];
  onCancel: () => void;
  onCreate: (input: CreateTabRequest) => Promise<void>;
}) {
  const creatablePlugins = plugins.filter((plugin) => plugin.creatable);
  const [pluginId, setPluginId] = useState<PluginId>("codex-terminal");
  const [cwd, setCwd] = useState("~");
  const [title, setTitle] = useState("");
  const [localWebUrl, setLocalWebUrl] = useState("");
  const [createDirectory, setCreateDirectory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pathOptions, setPathOptions] = useState<PathOption[]>([]);
  const [pathOptionsOpen, setPathOptionsOpen] = useState(false);
  const [highlightedPathOption, setHighlightedPathOption] = useState(0);
  const [pathOptionsError, setPathOptionsError] = useState<string | undefined>();
  const selectedPlugin = creatablePlugins.find((plugin) => plugin.id === pluginId);
  const isLocalWeb = selectedPlugin?.panelKind === "web-viewer";
  const requiresDirectory = selectedPlugin?.requiresDirectory ?? true;
  const titlePlaceholder = defaultTabTitlePlaceholder(selectedPlugin, cwd, localWebUrl);

  useEffect(() => {
    if (!requiresDirectory) {
      setPathOptionsOpen(false);
      setCreateDirectory(false);
      return;
    }
    if (!pathOptionsOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadPathOptions();
    }, 120);

    async function loadPathOptions() {
      try {
        const options = await getPathOptions(cwd);
        if (cancelled) return;
        setPathOptions(options);
        setHighlightedPathOption(0);
        setPathOptionsError(undefined);
      } catch (err) {
        if (cancelled) return;
        setPathOptions([]);
        setPathOptionsError(err instanceof Error ? err.message : String(err));
      }
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cwd, pathOptionsOpen, requiresDirectory]);

  async function submit() {
    setBusy(true);
    try {
      const initialInput = isLocalWeb && localWebUrl.trim() ? { url: localWebUrl.trim() } : undefined;
      await onCreate({
        pluginId,
        cwd: requiresDirectory ? cwd : undefined,
        title,
        createDirectory: requiresDirectory ? createDirectory : false,
        initialInput
      });
    } finally {
      setBusy(false);
    }
  }

  function choosePathOption(option: PathOption) {
    setCwd(option.value);
    setPathOptionsOpen(false);
    setHighlightedPathOption(0);
  }

  function handlePathKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!pathOptionsOpen || pathOptions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedPathOption((current) => (current + 1) % pathOptions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedPathOption((current) => (current - 1 + pathOptions.length) % pathOptions.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = pathOptions[highlightedPathOption];
      if (option) {
        choosePathOption(option);
      }
    } else if (event.key === "Escape") {
      setPathOptionsOpen(false);
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
        {requiresDirectory ? (
          <div className="field-group">
            <label htmlFor="new-tab-directory">Directory</label>
            <div className="path-autocomplete">
              <input
                id="new-tab-directory"
                value={cwd}
                onChange={(event) => {
                  setCwd(event.target.value);
                  setPathOptionsOpen(true);
                }}
                onFocus={() => setPathOptionsOpen(true)}
                onBlur={() => window.setTimeout(() => setPathOptionsOpen(false), 100)}
                onKeyDown={handlePathKeyDown}
                placeholder="~, ~/project, or relative/path"
                autoComplete="off"
                aria-autocomplete="list"
                aria-controls="new-tab-path-options"
                aria-expanded={pathOptionsOpen}
              />
              {pathOptionsOpen ? (
                <div id="new-tab-path-options" className="path-options" role="listbox">
                  {pathOptions.length > 0 ? (
                    pathOptions.map((option, index) => (
                      <button
                        key={`${option.kind}:${option.value}`}
                        type="button"
                        className={`path-option ${index === highlightedPathOption ? "active" : ""}`}
                        role="option"
                        aria-selected={index === highlightedPathOption}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setHighlightedPathOption(index)}
                        onClick={() => choosePathOption(option)}
                      >
                        <span>{option.label}</span>
                        {option.detail ? <small>{option.detail}</small> : null}
                      </button>
                    ))
                  ) : (
                    <div className="path-options-empty">{pathOptionsError ?? "No matching directories."}</div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {isLocalWeb ? (
          <label>
            URL
            <input
              value={localWebUrl}
              onChange={(event) => setLocalWebUrl(event.target.value)}
              placeholder="http://127.0.0.1:5173?token=..."
              inputMode="url"
              autoComplete="url"
            />
          </label>
        ) : null}
        <label>
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={titlePlaceholder} />
        </label>
        {requiresDirectory ? (
          <label className="checkbox-row">
            <input type="checkbox" checked={createDirectory} onChange={(event) => setCreateDirectory(event.target.checked)} />
            Create directory if needed
          </label>
        ) : null}
        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary-button" onClick={() => void submit()} disabled={(requiresDirectory && !cwd.trim()) || busy}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function defaultTabTitlePlaceholder(plugin: PluginDescriptor | undefined, cwd: string, localWebUrl: string): string {
  const acronym = plugin?.acronym ?? "TAB";
  const context = plugin?.requiresDirectory === false ? localWebTitleContext(localWebUrl) : folderNameFromPathInput(cwd);
  return `${acronym} - ${context}`;
}

function folderNameFromPathInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "folder";
  }
  const normalized = trimmed.replace(/[\\/]+$/, "");
  if (normalized === "~") {
    return "home";
  }
  if (normalized === ".") {
    return "current";
  }
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? "folder";
}

function localWebTitleContext(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "local";
  }
  try {
    return new URL(trimmed).host || "local";
  } catch {
    return "local";
  }
}
