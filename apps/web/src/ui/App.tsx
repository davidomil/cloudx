import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { AlertTriangle, Bot, ChevronDown, Columns2, GitBranch, LayoutTemplate, Mic, MicOff, MoreHorizontal, PanelTopOpen, Pencil, Play, Plus, RefreshCw, Rows3, Save, Search, Settings, SquarePlus, Trash2, Wifi, WifiOff, Wrench, X } from "lucide-react";

import { RULES_SKILLS_PLUGIN_ID, UI_RENDERER_ICON_BUTTON, UI_RENDERER_STATUS_DOT, type CloudxConfigResponse, type CloudxConfigValues, type ConfigValue, type CreateTabRequest, type PersonalityProfile, type PersonalityProfileStore, type PluginDescriptor, type PluginId, type TabLayoutState, type UiContributionDescriptor, type UiContributionSlot, type VoiceExecutionResult, type WorkspaceLayoutTemplate, type WorkspaceStateResponse, type WorkspaceTab, type WorkspaceTabsUpdate, type WorkspaceWindow } from "@cloudx/shared";

import {
  applyLayoutTemplate,
  callHook,
  closeTab,
  createTab,
  createWindow,
  deleteLayoutTemplate,
  deleteWindow,
  getConfig,
  getHealth,
  getPlugins,
  getWorkspace,
  saveLayoutTemplate,
  searchWorkspaceWindows,
  selectWindow,
  setActiveTab,
  startAudioStream,
  submitTranscript,
  updateConfig,
  updateLayoutTemplate,
  updateWindow,
  voiceAudioConstraints,
  type VoiceAudioStreamSession
} from "../api.js";
import { ControlButton } from "./Control.js";
import { FileBrowserPanel } from "./FileBrowserPanel.js";
import { PathEntry } from "./PathEntry.js";
import {
  activatePane,
  activatePaneTab,
  addTabToPane,
  defaultLayout,
  findPane,
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
import { SettingsDialog } from "./SettingsDialog.js";
import { clearFocusedAttention, isTabFocused, updateAttentionTabs } from "./tabAttention.js";
import { applyTerminalColorTheme, applyTerminalUiScale, disposeTerminalView, disposeTerminalViewsExcept, TerminalPanel } from "./TerminalPanel.js";
import { applyCloudxTheme, readTerminalColorTheme } from "./theme.js";
import { normalizeUiScale, uiScaleFactor } from "./uiScale.js";
import { attemptPortraitOrientationLock } from "./orientationLock.js";
import { useOutsidePointerDismiss } from "./outsidePointer.js";
import { ProfileSelect, RulesSkillsPanel, TabProfileSelector, TabProfileToolbar, pluginMetadataForProfile, selectedProfileId } from "./RulesSkillsPanel.js";
import {
  PLUGIN_WEBVIEW_RENDERER,
  PluginWebviewPanel,
  UiContributionRegistry,
  buildUiContributionHookInput,
  collectUiContributions,
  selectPluginPanelContribution,
  selectTabIndicatorContribution,
  selectTabSettingsContributions,
  type UiContributionRenderContext
} from "./uiContributions.js";
import { applyVoiceWorkspaceResults, buildClientVoiceContext, voiceConsoleValue } from "./voiceWorkspace.js";
import { WebViewerPanel } from "./WebViewerPanel.js";
import { WorktreeManagerPanel } from "./WorktreeManagerPanel.js";

type ConnectionStatus = "checking" | "connected" | "disconnected";

const AUDIO_INPUT_KEY = "cloudx-audio-input-v1";
const MOBILE_ACTIONS_QUERY = "(max-width: 760px), all and (hover: none) and (pointer: coarse) and (max-width: 960px) and (max-height: 520px)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQuery = window.matchMedia(query);
    const updateMatches = () => setMatches(mediaQuery.matches);
    updateMatches();
    mediaQuery.addEventListener("change", updateMatches);
    return () => mediaQuery.removeEventListener("change", updateMatches);
  }, [query]);
  return matches;
}

function usePortraitOrientationLock() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const requestLock = () => {
      void attemptPortraitOrientationLock(window, document);
    };
    requestLock();
    document.addEventListener("pointerdown", requestLock, { passive: true });
    document.addEventListener("visibilitychange", requestLock);
    window.screen.orientation?.addEventListener("change", requestLock);
    return () => {
      document.removeEventListener("pointerdown", requestLock);
      document.removeEventListener("visibilitychange", requestLock);
      window.screen.orientation?.removeEventListener("change", requestLock);
    };
  }, []);
}

function useMobileZoomSuppression() {
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
      return;
    }
    const preventGestureZoom = (event: Event) => event.preventDefault();
    const preventMultiTouchZoom = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    };
    document.addEventListener("gesturestart", preventGestureZoom, { passive: false } as AddEventListenerOptions);
    document.addEventListener("gesturechange", preventGestureZoom, { passive: false } as AddEventListenerOptions);
    document.addEventListener("gestureend", preventGestureZoom, { passive: false } as AddEventListenerOptions);
    document.addEventListener("touchmove", preventMultiTouchZoom, { passive: false });
    return () => {
      document.removeEventListener("gesturestart", preventGestureZoom);
      document.removeEventListener("gesturechange", preventGestureZoom);
      document.removeEventListener("gestureend", preventGestureZoom);
      document.removeEventListener("touchmove", preventMultiTouchZoom);
    };
  }, []);
}

export function App() {
  const initialLayout = useMemo(() => defaultLayout(), []);
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  const [config, setConfig] = useState<CloudxConfigResponse | undefined>();
  const [profileStore, setProfileStore] = useState<PersonalityProfileStore | undefined>();
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [windows, setWindows] = useState<WorkspaceWindow[]>([]);
  const [activeWindowId, setActiveWindowId] = useState<string | undefined>();
  const [templates, setTemplates] = useState<WorkspaceLayoutTemplate[]>([]);
  const [layout, setLayout] = useState<TabLayoutState>(initialLayout);
  const [activeTabId, setActiveTabId] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [windowMenuOpen, setWindowMenuOpen] = useState(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tabSettings, setTabSettings] = useState<{ tabId: string; sectionId?: string } | undefined>();
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
  const windowsRef = useRef<WorkspaceWindow[]>([]);
  const activeWindowIdRef = useRef<string | undefined>(undefined);
  const layoutRef = useRef<TabLayoutState>(initialLayout);
  const activeTabIdRef = useRef<string | undefined>(undefined);
  const createTargetPaneIdRef = useRef<string | undefined>(undefined);
  const persistLayoutTimerRef = useRef<number | undefined>(undefined);
  const pendingLayoutPersistWindowIdRef = useRef<string | undefined>(undefined);
  const pendingLayoutPersistRef = useRef<TabLayoutState | undefined>(undefined);
  const audioSessionRef = useRef<VoiceAudioStreamSession | undefined>(undefined);
  const topbarMicControlRef = useRef<HTMLDivElement | null>(null);
  const footerMicControlRef = useRef<HTMLDivElement | null>(null);
  const mobileActionsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void refresh();
    const closeWorkspaceSocket = subscribeWorkspaceUpdates(
      (update) => {
        if (update.windows && update.templates && update.activeWindowId) {
          applyWorkspaceState({
            tabs: update.tabs,
            activeTabId: update.activeTabId,
            windows: update.windows,
            activeWindowId: update.activeWindowId,
            templates: update.templates
          }, { preservePendingLayout: true });
        } else {
          applyWorkspaceTabs(update.tabs, update.activeTabId);
        }
        setConnectionStatus("connected");
      },
      () => setConnectionStatus("disconnected")
    );
    const interval = window.setInterval(() => void checkConnection(), 5000);
    return () => {
      audioSessionRef.current?.cancel();
      closeWorkspaceSocket();
      if (persistLayoutTimerRef.current !== undefined) {
        window.clearTimeout(persistLayoutTimerRef.current);
      }
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
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  useEffect(() => {
    activeWindowIdRef.current = activeWindowId;
  }, [activeWindowId]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    if (!audioInputMenuOpen) {
      return;
    }
    function closeAudioInputMenuOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (topbarMicControlRef.current?.contains(target) || footerMicControlRef.current?.contains(target)) {
        return;
      }
      setAudioInputMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeAudioInputMenuOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeAudioInputMenuOnOutsidePointer);
  }, [audioInputMenuOpen]);

  useOutsidePointerDismiss(mobileActionsOpen, mobileActionsRef, () => setMobileActionsOpen(false));

  useEffect(() => {
    if (!findPane(layout.root, layout.activePaneId)) {
      updateLayout((current) => activatePane(current, listPanes(current.root)[0]?.id ?? defaultLayout().activePaneId));
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
  const serverLabel = window.location.host || "Cloudx";
  const activeTab = activeTabId ? tabById.get(activeTabId) : undefined;
  const activeWindow = activeWindowId ? windows.find((window) => window.id === activeWindowId) : windows[0];
  const microphoneUnavailableReason = getMicrophoneUnavailableReason();
  const aiControlEnabled = config?.values.global.aiControlEnabled !== false;
  const microphoneEnabled = aiControlEnabled && config?.values.global.microphoneEnabled !== false;
  const uiScale = normalizeUiScale(config?.values.global.uiScale);
  const voiceConsoleText = voiceConsoleValue(voiceState, manualTranscript, voiceMessage, liveTranscript);
  const uiContributions = useMemo(() => collectUiContributions(plugins), [plugins]);
  const mobileActionsEnabled = useMediaQuery(MOBILE_ACTIONS_QUERY);

  usePortraitOrientationLock();
  useMobileZoomSuppression();

  useEffect(() => {
    if (!config) {
      return;
    }
    applyCloudxTheme(config.values.global.themeId);
    applyTerminalColorTheme(readTerminalColorTheme());
  }, [config?.values.global.themeId]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-scale", uiScaleFactor(uiScale));
    applyTerminalUiScale(uiScale);
  }, [uiScale]);

  async function refresh() {
    setConnectionStatus("checking");
    try {
      const [pluginList, workspaceState, configState, profiles] = await Promise.all([getPlugins(), getWorkspace(), getConfig(), loadProfileStore()]);
      setPlugins(pluginList);
      setConfig(configState);
      setProfileStore(profiles);
      applyWorkspaceState(workspaceState);
      setConnectionStatus("connected");
      setError(undefined);
    } catch (err) {
      setConnectionStatus("disconnected");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadProfileStore(): Promise<PersonalityProfileStore | undefined> {
    try {
      const result = await callHook<{ store: PersonalityProfileStore }>("rules-skills.profiles.list");
      return result.store;
    } catch {
      return undefined;
    }
  }

  function applyWorkspaceState(state: WorkspaceStateResponse, options: { preservePendingLayout?: boolean } = {}) {
    const effectiveState = options.preservePendingLayout ? workspaceStateWithPreservedLayout(state, layoutRef.current, pendingLayoutPersistWindowIdRef.current) : state;
    const nextLayout = effectiveState.windows.find((window) => window.id === effectiveState.activeWindowId)?.layout ?? effectiveState.windows[0]?.layout ?? defaultLayout();
    tabsRef.current = effectiveState.tabs;
    windowsRef.current = effectiveState.windows;
    activeWindowIdRef.current = effectiveState.activeWindowId;
    layoutRef.current = nextLayout;
    activeTabIdRef.current = effectiveState.activeTabId;
    setTabs(effectiveState.tabs);
    setWindows(effectiveState.windows);
    setActiveWindowId(effectiveState.activeWindowId);
    setTemplates(effectiveState.templates);
    setActiveTabId(effectiveState.activeTabId);
    commitLayout(nextLayout, { persist: false });
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
    commitLayout(nextLayout);
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

  function commitLayout(nextLayout: TabLayoutState, options: { persist?: boolean } = {}) {
    const windowId = activeWindowIdRef.current;
    layoutRef.current = nextLayout;
    setLayout(nextLayout);
    if (windowId) {
      setWindows((current) => current.map((window) => (window.id === windowId ? { ...window, layout: nextLayout, updatedAt: new Date().toISOString() } : window)));
      windowsRef.current = windowsRef.current.map((window) => (window.id === windowId ? { ...window, layout: nextLayout, updatedAt: new Date().toISOString() } : window));
    }
    if (options.persist === false || !windowId) {
      return;
    }
    pendingLayoutPersistWindowIdRef.current = windowId;
    pendingLayoutPersistRef.current = nextLayout;
    if (persistLayoutTimerRef.current !== undefined) {
      window.clearTimeout(persistLayoutTimerRef.current);
    }
    const layoutForPersistence = nextLayout;
    persistLayoutTimerRef.current = window.setTimeout(() => {
      void updateWindow(windowId, { layout: layoutForPersistence })
        .then(() => {
          if (pendingLayoutPersistWindowIdRef.current === windowId && pendingLayoutPersistRef.current === layoutForPersistence) {
            pendingLayoutPersistWindowIdRef.current = undefined;
            pendingLayoutPersistRef.current = undefined;
          }
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, 200);
  }

  function updateLayout(updater: (current: TabLayoutState) => TabLayoutState) {
    commitLayout(updater(layoutRef.current));
  }

  async function activateTab(tabId: string, paneId = activePaneId) {
    activeTabIdRef.current = tabId;
    setActiveTabId(tabId);
    updateLayout((current) => activatePaneTab(current, paneId, tabId));
    await setActiveTab(tabId);
  }

  function split(direction: LayoutDirection) {
    const effectiveDirection = mobileActionsEnabled ? "column" : direction;
    updateLayout((current) => splitPane(current, effectiveDirection, () => `pane-${crypto.randomUUID()}`, () => `split-${crypto.randomUUID()}`));
  }

  function resizePane(splitId: string, deltaPixels: number, containerPixels: number, startSizes: [number, number]) {
    updateLayout((current) => resizeSplit(current, splitId, deltaPixels, containerPixels, startSizes));
  }

  function selectPaneForCreation(paneId: string) {
    createTargetPaneIdRef.current = paneId;
    setCreateTargetPaneId(paneId);
    const nextLayout = activatePane(layoutRef.current, paneId);
    layoutRef.current = nextLayout;
    commitLayout(nextLayout);
  }

  function openCreateDialogForPane(paneId: string) {
    selectPaneForCreation(paneId);
    setCreateOpen(true);
  }

  function handleDropTab(targetPaneId: string, tabId: string, beforeTabId?: string) {
    if (!tabId) return;
    updateLayout((current) => placeTabInPane(current, targetPaneId, tabId, beforeTabId));
    void activateTab(tabId, targetPaneId);
  }

  function handlePaneFocus(pane: Pane) {
    if (pane.activeTabId) {
      void activateTab(pane.activeTabId, pane.id);
      return;
    }
    updateLayout((current) => activatePane(current, pane.id));
  }

  function handleClosePane(paneId: string) {
    updateLayout((current) => removePane(current, paneId));
    if (createTargetPaneIdRef.current === paneId) {
      createTargetPaneIdRef.current = undefined;
    }
    setCreateTargetPaneId((current) => (current === paneId ? undefined : current));
  }

  async function handleCreate(input: CreateTabRequest) {
    setError(undefined);
    try {
      const tab = await createTab({ ...input, windowId: input.windowId ?? activeWindowIdRef.current });
      setTabs((current) => upsertTab(current, tab));
      const targetPaneId = createTargetPaneIdRef.current ?? createTargetPaneId;
      updateLayout((current) => addTabToPane(current, resolveTabCreationPaneId(current, targetPaneId), tab.id));
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
      updateLayout((current) => removeTabFromPanes(current, tabId));
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
    if (!aiControlEnabled) {
      setError("AI control is disabled in Cloudx settings.");
      return;
    }
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
    if (!microphoneEnabled) {
      setError("Microphone capture is disabled in Cloudx settings.");
      return;
    }
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
    if (!microphoneEnabled) {
      return;
    }
    if (microphoneUnavailableReason) {
      setError(microphoneUnavailableReason);
      return;
    }
    const nextOpen = !audioInputMenuOpen;
    setAudioInputMenuOpen(nextOpen);
    if (nextOpen) {
      setAudioInputError(undefined);
      try {
        await requestAudioInputEnumerationAccess();
      } catch (err) {
        setAudioInputError(err instanceof Error ? err.message : String(err));
      }
      await refreshAudioInputs();
    }
  }

  function chooseAudioInput(deviceId?: string) {
    setSelectedAudioInputId(deviceId);
    persistAudioInputId(deviceId);
    setAudioInputMenuOpen(false);
  }

  function applyVoiceResult(result: Awaited<ReturnType<typeof submitTranscript>>) {
    applyWorkspaceExecutionResults(result.results);
  }

  function applyHookResult(result: Record<string, unknown>) {
    applyHookUiInstruction(result.uiInstruction);
    applyWorkspaceExecutionResults([{ action: "ui-hook", ok: true, result }]);
  }

  function applyHookUiInstruction(instruction: unknown) {
    if (!isRecord(instruction) || instruction.type !== "open_tab_settings" || typeof instruction.tabId !== "string") {
      return;
    }
    setTabSettings({ tabId: instruction.tabId, sectionId: typeof instruction.sectionId === "string" ? instruction.sectionId : undefined });
  }

  function applyWorkspaceExecutionResults(results: VoiceExecutionResult["results"]) {
    const next = applyVoiceWorkspaceResults(
      { layout: layoutRef.current, tabs: tabsRef.current, activeTabId: activeTabIdRef.current },
      {
        accepted: true,
        plan: { transcript: "", summary: "", actions: [] },
        results
      },
      {
        createPaneId: () => `pane-${crypto.randomUUID()}`,
        createSplitId: () => `split-${crypto.randomUUID()}`
      }
    );
    tabsRef.current = next.tabs;
    layoutRef.current = next.layout;
    activeTabIdRef.current = next.activeTabId;
    setTabs(next.tabs);
    commitLayout(next.layout);
    setActiveTabId(next.activeTabId);
  }

  async function handleUiContributionHook(contribution: UiContributionDescriptor, context: UiContributionRenderContext = {}) {
    if (!contribution.hookId) {
      return;
    }
    try {
      await callUiHook(contribution.hookId, buildUiContributionHookInput(contribution, context), context.tab?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function callUiHook<T extends Record<string, unknown> = Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}, targetTabId?: string): Promise<T> {
    const result = await callHook<T>(hookId, input, targetTabId);
    applyHookResult(result);
    setError(undefined);
    return result;
  }

  function currentVoiceClientContext() {
    return buildClientVoiceContext(layoutRef.current, tabsRef.current, windowsRef.current, activeWindowIdRef.current);
  }

  async function handleSaveConfig(values: CloudxConfigValues) {
    const nextConfig = await updateConfig(values);
    setConfig(nextConfig);
    setSettingsOpen(false);
    if (nextConfig.values.global.aiControlEnabled === false || nextConfig.values.global.microphoneEnabled === false) {
      setAudioInputMenuOpen(false);
    }
  }

  function pluginConfig(pluginId: PluginId): Record<string, ConfigValue> {
    return config?.values.plugins[pluginId] ?? {};
  }

  async function handleCreateWindow(name: string, defaultCwd: string, profileId?: string) {
    applyWorkspaceState(await createWindow({ name, defaultCwd, pluginMetadata: pluginMetadataForProfile(profileId) }));
  }

  async function handleSelectWindow(windowId: string) {
    applyWorkspaceState(await selectWindow(windowId));
    setWindowMenuOpen(false);
  }

  async function handleRenameWindow(windowId: string, name: string, defaultCwd: string, profileId?: string) {
    applyWorkspaceState(await updateWindow(windowId, { name, defaultCwd, pluginMetadata: { [RULES_SKILLS_PLUGIN_ID]: profileId ? { selectedProfileId: profileId } : null } }));
  }

  async function handleDeleteWindow(windowId: string) {
    const target = windows.find((window) => window.id === windowId);
    if (!target) return;
    applyWorkspaceState(await deleteWindow(windowId));
    setWindowMenuOpen(false);
  }

  async function handleContextSearch(query: string) {
    return searchWorkspaceWindows(query);
  }

  async function handleSaveTemplate(name: string, basePath: string) {
    const result = await saveLayoutTemplate({ name, basePath, windowId: activeWindowId });
    applyWorkspaceState(result.workspace);
  }

  async function handleRenameTemplate(templateId: string, name: string) {
    const result = await updateLayoutTemplate(templateId, { name });
    applyWorkspaceState(result.workspace);
  }

  async function handleDeleteTemplate(templateId: string) {
    const target = templates.find((template) => template.id === templateId);
    if (!target) return;
    if (!window.confirm(`Delete layout template ${target.name}?`)) {
      return;
    }
    const result = await deleteLayoutTemplate(templateId);
    applyWorkspaceState(result.workspace);
  }

  async function handleApplyTemplate(templateId: string, projectPath: string, name?: string) {
    const result = await applyLayoutTemplate(templateId, { projectPath, name });
    applyWorkspaceState(result.workspace);
    setTemplateMenuOpen(false);
  }

  async function handleSaveProfile(profile: PersonalityProfile) {
    const result = await callHook<{ store: PersonalityProfileStore }>("rules-skills.profiles.save", { profile });
    setProfileStore(result.store);
  }

  async function handleDeleteProfile(profileId: string) {
    const result = await callHook<{ store: PersonalityProfileStore }>("rules-skills.profiles.delete", { profileId });
    setProfileStore(result.store);
  }

  async function handleSetDefaultProfile(profileId: string | undefined) {
    const result = await callHook<{ store: PersonalityProfileStore }>("rules-skills.profiles.setDefault", profileId ? { profileId } : {});
    setProfileStore(result.store);
  }

  async function handleSetTabProfile(tabId: string, profileId: string | undefined) {
    await callHook("workspace.tabs.setPluginMetadata", profileId ? { tabId, pluginId: RULES_SKILLS_PLUGIN_ID, metadata: { selectedProfileId: profileId } } : { tabId, pluginId: RULES_SKILLS_PLUGIN_ID });
  }

  function renderMicControl(className: string, ref: RefObject<HTMLDivElement | null>, iconSize: number) {
    if (!microphoneEnabled) {
      return null;
    }
    return (
      <div className={`mic-control ${className}`} ref={ref}>
        <ControlButton className={`mic-button ${voiceState} ${microphoneUnavailableReason ? "unavailable" : ""}`} iconOnly onClick={() => void handleMic()} title={microphoneUnavailableReason ?? (voiceState === "recording" ? "Stop voice command" : "Record voice command")}>
          {voiceState === "recording" ? <MicOff size={iconSize} /> : <Mic size={iconSize} />}
        </ControlButton>
        <ControlButton
          className={`mic-source-button ${audioInputMenuOpen ? "open" : ""}`}
          iconOnly
          pressed={audioInputMenuOpen}
          onClick={() => void toggleAudioInputMenu()}
          disabled={voiceState !== "idle" || Boolean(microphoneUnavailableReason)}
          title="Select microphone"
          aria-label="Select microphone"
          aria-expanded={audioInputMenuOpen}
          aria-haspopup="menu"
        >
          <ChevronDown size={13} />
        </ControlButton>
        {audioInputMenuOpen ? (
          <div className="mic-source-menu" role="menu" aria-label="Microphone devices">
            <ControlButton type="button" className={!selectedAudioInputId ? "selected" : ""} selected={!selectedAudioInputId} onClick={() => chooseAudioInput(undefined)} role="menuitem">
              <span>Browser default</span>
              {!selectedAudioInputId ? <small>Selected</small> : null}
            </ControlButton>
            {audioInputs.map((device, index) => (
              <ControlButton
                type="button"
                className={selectedAudioInputId === device.deviceId ? "selected" : ""}
                selected={selectedAudioInputId === device.deviceId}
                onClick={() => chooseAudioInput(device.deviceId)}
                role="menuitem"
                key={device.deviceId || `audioinput-${index}`}
              >
                <span>{audioInputLabel(device, index)}</span>
                {selectedAudioInputId === device.deviceId ? <small>Selected</small> : null}
              </ControlButton>
            ))}
            {audioInputs.length === 0 ? <div className="mic-source-empty">No microphones found.</div> : null}
            {audioInputError ? <div className="mic-source-error">{audioInputError}</div> : null}
          </div>
        ) : null}
      </div>
    );
  }

  const uiContributionRegistry = new UiContributionRegistry({
    [UI_RENDERER_ICON_BUTTON]: (contribution, context) => {
      if (!contribution.hookId) {
        return null;
      }
      return (
        <ControlButton
          type="button"
          className="compact-icon-button"
          size="compact"
          iconOnly
          onClick={(event) => {
            event.stopPropagation();
            void handleUiContributionHook(contribution, context);
          }}
          title={contribution.title}
          aria-label={contribution.title}
        >
          {uiContributionIcon(contribution.icon)}
        </ControlButton>
      );
    },
    [PLUGIN_WEBVIEW_RENDERER]: (contribution, context) => <PluginWebviewPanel contribution={contribution} context={context} />,
    [UI_RENDERER_STATUS_DOT]: (_contribution, context) => (context.tab ? <TabIndicatorDot tab={context.tab} attention={context.attention} /> : null),
    "audio-ai.voice-control": () => renderMicControl("topbar-mic-control", topbarMicControlRef, 17),
    "audio-ai.voice-console": () => {
      if (!aiControlEnabled) {
        return null;
      }
      return (
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
          {renderMicControl("voice-console-mic-control", footerMicControlRef, 25)}
        </footer>
      );
    },
    "rules-skills.profile-panel": (_contribution, context) => (
      <RulesSkillsPanel
        store={profileStore}
        plugins={context.plugins ?? plugins}
        onSave={handleSaveProfile}
        onDelete={handleDeleteProfile}
        onSetDefault={handleSetDefaultProfile}
      />
    ),
    "rules-skills.tab-profile-menu": (_contribution, context) => {
      if (!context.tab || context.tab.pluginId !== "codex-terminal" || !profileStore) {
        return null;
      }
      return (
        <TabProfileSelector
          tab={context.tab}
          profiles={profileStore.profiles}
          defaultProfileId={profileStore.defaultProfileId}
          onSelect={(profileId) => void handleSetTabProfile(context.tab!.id, profileId)}
        />
      );
    },
    "rules-skills.tab-profile-settings": (_contribution, context) => {
      if (!context.tab || context.tab.pluginId !== "codex-terminal" || !profileStore) {
        return null;
      }
      return (
        <section className="tab-settings-section">
          <h3>Personality</h3>
          <ProfileSelect
            value={selectedProfileId(context.tab)}
            profiles={profileStore.profiles}
            defaultProfileId={profileStore.defaultProfileId}
            onChange={(profileId) => void handleSetTabProfile(context.tab!.id, profileId || undefined)}
            label="Profile"
            includeInherited
          />
        </section>
      );
    }
  });

  function renderUiContributions(slot: UiContributionSlot, context: { tab?: WorkspaceTab; attention?: boolean } = {}): Array<ReactElement | null> {
    return uiContributions.filter((contribution) => contribution.slot === slot).map((contribution) => renderUiContribution(contribution, context));
  }

  function renderUiContribution(contribution: UiContributionDescriptor, context: { tab?: WorkspaceTab; attention?: boolean } = {}): ReactElement | null {
    return uiContributionRegistry.render(contribution, {
      plugins,
      config: config?.values.global,
      uiScale,
      callHook: callUiHook,
      ...context
    });
  }

  function renderTabIndicator(tab: WorkspaceTab, attention: boolean): ReactElement | null {
    const contribution = selectTabIndicatorContribution(plugins, tab);
    return contribution ? renderUiContribution(contribution, { tab, attention }) : null;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <GitBranch size={18} />
          <span className="brand-mark cyber-glitch" data-text="Cloudx">
            Cloudx
          </span>
          <span className={`connection-status ${connectionStatus}`} title={`${connectionStatus}: ${serverLabel}`} aria-label={`${connectionStatus}: ${serverLabel}`}>
            {connectionStatus === "connected" ? <Wifi size={14} /> : <WifiOff size={14} />}
          </span>
          {activeTab ? <span className="brand-active-tab" title={`Active tab: ${activeTab.title}`}>{activeTab.title}</span> : null}
          {voiceState !== "idle" ? <span className={`voice-status ${voiceState}`}>{voiceState}</span> : null}
        </div>
        <div className="topbar-actions">
          <WindowSwitcher
            windows={windows}
            tabs={tabs}
            profileStore={profileStore}
            activeWindow={activeWindow}
            open={windowMenuOpen}
            onOpenChange={setWindowMenuOpen}
            onSelect={handleSelectWindow}
            onCreate={handleCreateWindow}
            onUpdate={handleRenameWindow}
            onDelete={handleDeleteWindow}
            onContextSearch={handleContextSearch}
          />
          <div className="mobile-action-menu" ref={mobileActionsRef}>
            <ControlButton className="icon-button" iconOnly pressed={mobileActionsOpen} onClick={() => setMobileActionsOpen((open) => !open)} title="Workspace actions" aria-label="Workspace actions" aria-expanded={mobileActionsOpen} aria-haspopup="menu">
              <MoreHorizontal size={19} />
            </ControlButton>
            {mobileActionsOpen ? (
              <div className={`mobile-action-menu-popover ${templateMenuOpen ? "template-open" : ""}`} role="menu" aria-label="Workspace actions">
                <ControlButton className="icon-button" iconOnly onClick={() => window.location.reload()} title="Reload app" aria-label="Reload app" role="menuitem">
                  <RefreshCw size={17} />
                </ControlButton>
                <ControlButton className="icon-button" iconOnly onClick={() => { setSettingsOpen(true); setMobileActionsOpen(false); }} title="Settings" aria-label="Settings" role="menuitem">
                  <Settings size={17} />
                </ControlButton>
                <ControlButton className="icon-button" iconOnly onClick={() => { split("column"); setMobileActionsOpen(false); }} title="Split vertically" aria-label="Split vertically" role="menuitem">
                  <Rows3 size={17} />
                </ControlButton>
                {mobileActionsEnabled ? (
                  <TemplateMenu
                    open={templateMenuOpen}
                    templates={templates}
                    activeWindow={activeWindow}
                    onOpenChange={setTemplateMenuOpen}
                    onSave={handleSaveTemplate}
                    onRename={handleRenameTemplate}
                    onDelete={handleDeleteTemplate}
                    onApply={handleApplyTemplate}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="topbar-action-cluster">
            <ControlButton className="icon-button" iconOnly onClick={() => window.location.reload()} title="Reload app">
              <RefreshCw size={17} />
            </ControlButton>
            <ControlButton className="icon-button" iconOnly onClick={() => setSettingsOpen(true)} title="Settings">
              <Settings size={17} />
            </ControlButton>
            <ControlButton className="icon-button" iconOnly onClick={() => split("row")} title="Split columns">
              <Columns2 size={17} />
            </ControlButton>
            <ControlButton className="icon-button" iconOnly onClick={() => split("column")} title="Split rows">
              <Rows3 size={17} />
            </ControlButton>
            {!mobileActionsEnabled ? (
              <TemplateMenu
                open={templateMenuOpen}
                templates={templates}
                activeWindow={activeWindow}
                onOpenChange={setTemplateMenuOpen}
                onSave={handleSaveTemplate}
                onRename={handleRenameTemplate}
                onDelete={handleDeleteTemplate}
                onApply={handleApplyTemplate}
              />
            ) : null}
            {renderUiContributions("app.topbar.actions")}
          </div>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="pane-root">
        {renderLayoutNode(layout.root)}
      </section>

      {renderUiContributions("app.footer.actions")}

      {createOpen ? <CreateTabDialog plugins={plugins} profiles={profileStore?.profiles ?? []} defaultCwd={activeWindow?.defaultCwd ?? "~"} onCancel={closeCreateDialog} onCreate={handleCreate} /> : null}
      {settingsOpen && config ? (
        <SettingsDialog
          config={config}
          profileStore={profileStore}
          onCancel={() => setSettingsOpen(false)}
          onSave={handleSaveConfig}
          onSaveDefaultProfile={handleSetDefaultProfile}
        />
      ) : null}
      {tabSettings && tabById.has(tabSettings.tabId) ? (
        <TabSettingsDialog
          tab={tabById.get(tabSettings.tabId)!}
          plugin={pluginById.get(tabById.get(tabSettings.tabId)!.pluginId)}
          plugins={plugins}
          sectionId={tabSettings.sectionId}
          config={pluginConfig(tabById.get(tabSettings.tabId)!.pluginId)}
          uiScale={uiScale}
          uiContributionRegistry={uiContributionRegistry}
          callHook={callUiHook}
          onClose={() => setTabSettings(undefined)}
        />
      ) : null}
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
        <ResizeHandle direction={node.direction} sizes={[node.sizes[0], node.sizes[1]]} onResize={(delta, total, startSizes) => resizePane(node.id, delta, total, startSizes)} />
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
              <div
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
                }}
              >
                <button
                  type="button"
                  className="tab-activation"
                  onClick={(event) => {
                    event.stopPropagation();
                    void activateTab(tabId, pane.id);
                  }}
                >
                  <span className="tab-title">{tab.title}</span>
                  {renderTabIndicator(tab, shouldBlink)}
                </button>
                <div className="tab-actions">
                  {renderUiContributions("tab.actions.trailing", { tab })}
                  <button
                    type="button"
                    className="tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleClose(tabId);
                    }}
                    aria-label={`Close ${tab.title}`}
                    title={`Close ${tab.title}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            );
          })}
          <ControlButton
            type="button"
            className="new-tab-inline add-tab-button"
            tone="primary"
            iconOnly
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
          </ControlButton>
          {panes.length > 1 ? (
            <ControlButton
              className="new-tab-inline pane-close-button"
              iconOnly
              onClick={(event) => {
                event.stopPropagation();
                handleClosePane(pane.id);
              }}
              title="Close pane"
            >
              <X size={16} />
            </ControlButton>
          ) : null}
        </div>
        <div className="pane-body">
          {pane.activeTabId && tabById.has(pane.activeTabId) ? (
            <PluginPanel
              tab={tabById.get(pane.activeTabId)!}
              plugin={pluginById.get(tabById.get(pane.activeTabId)!.pluginId)}
              plugins={plugins}
              active={paneActive}
              config={pluginConfig(tabById.get(pane.activeTabId)!.pluginId)}
              uiScale={uiScale}
              profileStore={profileStore}
              uiContributionRegistry={uiContributionRegistry}
              callHook={callUiHook}
              onSetTabProfile={handleSetTabProfile}
            />
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

function WindowSwitcher({
  windows,
  tabs,
  profileStore,
  activeWindow,
  open,
  onOpenChange,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  onContextSearch
}: {
  windows: WorkspaceWindow[];
  tabs: WorkspaceTab[];
  profileStore?: PersonalityProfileStore;
  activeWindow?: WorkspaceWindow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (windowId: string) => Promise<void>;
  onCreate: (name: string, defaultCwd: string, profileId?: string) => Promise<void>;
  onUpdate: (windowId: string, name: string, defaultCwd: string, profileId?: string) => Promise<void>;
  onDelete: (windowId: string) => Promise<void>;
  onContextSearch: (query: string) => Promise<{ matches: Array<{ window: WorkspaceWindow; score: number; reasons: string[] }> }>;
}) {
  const [query, setQuery] = useState("");
  const [contextMode, setContextMode] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);
  const [contextMatches, setContextMatches] = useState<Array<{ window: WorkspaceWindow; score: number; reasons: string[] }>>([]);
  const [draftName, setDraftName] = useState(activeWindow?.name ?? "");
  const [draftCwd, setDraftCwd] = useState(activeWindow?.defaultCwd ?? "~");
  const [draftProfileId, setDraftProfileId] = useState(selectedProfileId(activeWindow));
  const [dialogMode, setDialogMode] = useState<"create" | "edit" | undefined>();
  const [editingWindow, setEditingWindow] = useState<WorkspaceWindow | undefined>();
  const [deleteCandidate, setDeleteCandidate] = useState<WorkspaceWindow | undefined>();
  const [error, setError] = useState<string | undefined>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);

  useOutsidePointerDismiss(open, rootRef, () => onOpenChange(false));

  useEffect(() => {
    setDraftName(activeWindow?.name ?? "");
    setDraftCwd(activeWindow?.defaultCwd ?? "~");
    setDraftProfileId(selectedProfileId(activeWindow));
  }, [activeWindow?.id, activeWindow?.name, activeWindow?.defaultCwd, activeWindow?.pluginMetadata]);

  useEffect(() => {
    if (!open || !contextMode || !query.trim()) {
      setContextMatches([]);
      setContextBusy(false);
      return;
    }
    let cancelled = false;
    setContextBusy(true);
    const timer = window.setTimeout(() => {
      void onContextSearch(query)
        .then((result) => {
          if (!cancelled) {
            setContextMatches(result.matches);
            setError(undefined);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setContextBusy(false);
          }
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [contextMode, onContextSearch, open, query]);

  const visibleWindows = contextMode && query.trim()
    ? contextMatches.map((match) => match.window)
    : windows.filter((window) => !query.trim() || window.name.toLowerCase().includes(query.trim().toLowerCase()));

  function openCreateDialog() {
    setDialogMode("create");
    setEditingWindow(undefined);
    setDeleteCandidate(undefined);
    setDraftName("");
    setDraftCwd(activeWindow?.defaultCwd ?? "~");
    setDraftProfileId("");
    setError(undefined);
  }

  function openEditDialog(window: WorkspaceWindow) {
    setDialogMode("edit");
    setEditingWindow(window);
    setDeleteCandidate(undefined);
    setDraftName(window.name);
    setDraftCwd(window.defaultCwd);
    setDraftProfileId(selectedProfileId(window));
    setError(undefined);
  }

  function openDeleteWarning(window: WorkspaceWindow) {
    setDialogMode(undefined);
    setEditingWindow(undefined);
    setDeleteCandidate(window);
    setError(undefined);
  }

  async function submitWindowDialog() {
    try {
      if (dialogMode === "edit" && editingWindow) {
        await onUpdate(editingWindow.id, draftName, draftCwd, draftProfileId || undefined);
      } else {
        await onCreate(draftName, draftCwd, draftProfileId || undefined);
      }
      setDialogMode(undefined);
      setEditingWindow(undefined);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function confirmDeleteWindow() {
    if (!deleteCandidate) {
      return;
    }
    try {
      await onDelete(deleteCandidate.id);
      setDeleteCandidate(undefined);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="window-switcher" ref={rootRef}>
      <ControlButton className="window-switcher-button" pressed={open} onClick={() => onOpenChange(!open)} title="Workspace windows">
        <PanelTopOpen size={15} />
        <span>{activeWindow?.name ?? "Window"}</span>
      </ControlButton>
      {open ? (
        <div className="window-menu">
          <div className="window-search-row">
            <ControlButton type="button" className={contextMode ? "active" : ""} iconOnly pressed={contextMode} onClick={() => setContextMode((current) => !current)} title={contextMode ? "Context search" : "Name search"}>
              {contextMode ? <Bot size={15} className={contextBusy ? "spinning" : ""} /> : <Search size={15} />}
            </ControlButton>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={contextMode ? "Search by context" : "Search windows"} />
          </div>
          <div className="window-list">
            {visibleWindows.map((window) => {
              const tabCount = tabCountForWindow(window, tabsById);
              return (
                <div key={window.id} className={`window-menu-row ${window.id === activeWindow?.id ? "selected" : ""}`}>
                  <button type="button" className="window-row-main" onClick={() => void onSelect(window.id)}>
                    <span>{window.name}</span>
                    <small>{tabCount} tabs · {window.defaultCwd}</small>
                  </button>
                  <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => openEditDialog(window)} title={`Edit ${window.name}`} aria-label={`Edit ${window.name}`}>
                    <Wrench size={14} />
                  </ControlButton>
                  <ControlButton type="button" className="compact-icon-button danger" tone="danger" size="compact" iconOnly onClick={() => openDeleteWarning(window)} title={`Delete ${window.name}`} aria-label={`Delete ${window.name}`}>
                    <Trash2 size={14} />
                  </ControlButton>
                </div>
              );
            })}
            {visibleWindows.length === 0 ? <div className="window-menu-empty">No windows match.</div> : null}
          </div>
          <div className="menu-footer-actions">
            <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={openCreateDialog} title="Create window" aria-label="Create window">
              <Plus size={15} />
            </ControlButton>
          </div>
          {dialogMode ? (
            <div className="menu-form-panel">
              <strong>{dialogMode === "edit" ? "Edit window" : "Create window"}</strong>
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Window name" />
              <PathEntry inputId="window-default-directory" value={draftCwd} onChange={setDraftCwd} placeholder="Default directory" ariaLabel="Window default directory" />
              {profileStore ? (
                <ProfileSelect
                  value={draftProfileId}
                  profiles={profileStore.profiles}
                  defaultProfileId={profileStore.defaultProfileId}
                  onChange={setDraftProfileId}
                  label="Personality"
                  includeInherited
                  inheritedLabel="Use default"
                />
              ) : null}
              <div className="menu-form-actions">
                <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => void submitWindowDialog()} disabled={!draftName.trim() || !draftCwd.trim()} title={dialogMode === "edit" ? "Save window" : "Create window"} aria-label={dialogMode === "edit" ? "Save window" : "Create window"}>
                  {dialogMode === "edit" ? <Save size={15} /> : <Plus size={15} />}
                </ControlButton>
                <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => setDialogMode(undefined)} title="Cancel" aria-label="Cancel">
                  <X size={15} />
                </ControlButton>
              </div>
            </div>
          ) : null}
          {deleteCandidate ? (
            <WindowDeleteWarning
              window={deleteCandidate}
              tabCount={tabCountForWindow(deleteCandidate, tabsById)}
              onCancel={() => setDeleteCandidate(undefined)}
              onConfirm={() => void confirmDeleteWindow()}
            />
          ) : null}
          {error ? <div className="window-menu-error">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function tabCountForWindow(window: WorkspaceWindow, tabsById: Map<string, WorkspaceTab>): number {
  return listPanes(window.layout.root).reduce((count, pane) => count + pane.tabIds.filter((tabId) => tabsById.has(tabId)).length, 0);
}

function WindowDeleteWarning({ window, tabCount, onCancel, onConfirm }: { window: WorkspaceWindow; tabCount: number; onCancel: () => void; onConfirm: () => void }) {
  const titleId = `delete-window-${window.id}-title`;
  const descriptionId = `delete-window-${window.id}-description`;
  return (
    <div className="menu-warning-panel" role="alertdialog" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <div className="menu-warning-heading">
        <AlertTriangle size={17} />
        <strong id={titleId}>Close window</strong>
      </div>
      <p id={descriptionId}>
        {tabCount > 0 ? `${window.name} has ${tabCount} open tab${tabCount === 1 ? "" : "s"}. Closing it will close those tabs.` : `${window.name} will be removed from the workspace.`}
      </p>
      <div className="menu-form-actions">
        <ControlButton type="button" className="compact-icon-button danger" tone="danger" size="compact" iconOnly onClick={onConfirm} title="Close window" aria-label="Close window">
          <Trash2 size={15} />
        </ControlButton>
        <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={onCancel} title="Cancel" aria-label="Cancel">
          <X size={15} />
        </ControlButton>
      </div>
    </div>
  );
}

function TemplateMenu({
  open,
  templates,
  activeWindow,
  onOpenChange,
  onSave,
  onRename,
  onDelete,
  onApply
}: {
  open: boolean;
  templates: WorkspaceLayoutTemplate[];
  activeWindow?: WorkspaceWindow;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, basePath: string) => Promise<void>;
  onRename: (templateId: string, name: string) => Promise<void>;
  onDelete: (templateId: string) => Promise<void>;
  onApply: (templateId: string, projectPath: string, name?: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [projectPath, setProjectPath] = useState(activeWindow?.defaultCwd ?? "~");
  const [windowName, setWindowName] = useState("");
  const [dialog, setDialog] = useState<{ kind: "save" } | { kind: "load" | "rename"; template: WorkspaceLayoutTemplate } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useOutsidePointerDismiss(open, rootRef, () => onOpenChange(false));

  useEffect(() => {
    setProjectPath(activeWindow?.defaultCwd ?? "~");
  }, [activeWindow?.id, activeWindow?.defaultCwd]);

  async function submitSave() {
    try {
      await onSave(name, activeWindow?.defaultCwd ?? "~");
      setName("");
      setDialog(undefined);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitApply(template: WorkspaceLayoutTemplate) {
    try {
      await onApply(template.id, projectPath, windowName || undefined);
      setDialog(undefined);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitRename(template: WorkspaceLayoutTemplate) {
    try {
      await onRename(template.id, name);
      setDialog(undefined);
      setName("");
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function openLoadDialog(template: WorkspaceLayoutTemplate) {
    setDialog({ kind: "load", template });
    setProjectPath(activeWindow?.defaultCwd ?? template.basePath);
    setWindowName("");
    setError(undefined);
  }

  function openRenameDialog(template: WorkspaceLayoutTemplate) {
    setDialog({ kind: "rename", template });
    setName(template.name);
    setError(undefined);
  }

  function openSaveDialog() {
    setDialog({ kind: "save" });
    setName(activeWindow?.name ? `${activeWindow.name} template` : "");
    setError(undefined);
  }

  return (
    <div className="template-menu-root" ref={rootRef}>
      <ControlButton className="icon-button" iconOnly pressed={open} onClick={() => onOpenChange(!open)} title="Layout templates">
        <LayoutTemplate size={17} />
      </ControlButton>
      {open ? (
        <div className="template-menu">
          <div className="template-list">
            {templates.map((template) => (
              <div key={template.id} className="template-menu-row">
                <button type="button" className="template-row-main" onClick={() => openLoadDialog(template)}>
                  <span>{template.name}</span>
                  <small>{template.tabs.length} tabs · {template.basePath}</small>
                </button>
                <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => openLoadDialog(template)} title={`Load ${template.name}`} aria-label={`Load ${template.name}`}>
                  <Play size={14} />
                </ControlButton>
                <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => openRenameDialog(template)} title={`Rename ${template.name}`} aria-label={`Rename ${template.name}`}>
                  <Pencil size={14} />
                </ControlButton>
                <ControlButton type="button" className="compact-icon-button danger" tone="danger" size="compact" iconOnly onClick={() => void onDelete(template.id)} title={`Delete ${template.name}`} aria-label={`Delete ${template.name}`}>
                  <Trash2 size={14} />
                </ControlButton>
              </div>
            ))}
            {templates.length === 0 ? <div className="window-menu-empty">No templates saved.</div> : null}
          </div>
          <div className="menu-footer-actions">
            <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={openSaveDialog} title="Save current layout as template" aria-label="Save current layout as template">
              <Save size={15} />
            </ControlButton>
          </div>
          {dialog ? (
            <div className="menu-form-panel">
              <strong>{dialog.kind === "save" ? "Save current layout" : dialog.kind === "rename" ? "Rename template" : "Load template"}</strong>
              {dialog.kind === "load" ? (
                <>
                  <PathEntry inputId="template-project-path" value={projectPath} onChange={setProjectPath} placeholder="Project path" ariaLabel="Template project path" />
                  <input value={windowName} onChange={(event) => setWindowName(event.target.value)} placeholder="New window name" />
                </>
              ) : (
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Template name" />
              )}
              <div className="menu-form-actions">
                {dialog.kind === "save" ? (
                  <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => void submitSave()} disabled={!name.trim()} title="Save template" aria-label="Save template">
                    <Save size={15} />
                  </ControlButton>
                ) : null}
                {dialog.kind === "rename" ? (
                  <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => void submitRename(dialog.template)} disabled={!name.trim()} title="Rename template" aria-label="Rename template">
                    <Save size={15} />
                  </ControlButton>
                ) : null}
                {dialog.kind === "load" ? (
                  <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => void submitApply(dialog.template)} disabled={!projectPath.trim()} title="Load template" aria-label="Load template">
                    <Play size={15} />
                  </ControlButton>
                ) : null}
                <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={() => setDialog(undefined)} title="Cancel" aria-label="Cancel">
                  <X size={15} />
                </ControlButton>
              </div>
            </div>
          ) : null}
          {error ? <div className="window-menu-error">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function TabIndicatorDot({ tab, attention }: { tab: WorkspaceTab; attention?: boolean }) {
  const title = tab.indicator.message ? `${tab.indicator.label}: ${tab.indicator.message}` : tab.indicator.label;
  return <span className={`tab-indicator ${tab.indicator.color} ${attention ? "attention" : ""}`} title={title} aria-label={title} />;
}

function uiContributionIcon(icon?: string): ReactElement {
  switch (icon) {
    case "alert":
      return <AlertTriangle size={15} />;
    case "bot":
      return <Bot size={15} />;
    case "columns":
      return <Columns2 size={15} />;
    case "layout":
      return <LayoutTemplate size={15} />;
    case "mic":
      return <Mic size={15} />;
    case "panel":
      return <PanelTopOpen size={15} />;
    case "pencil":
      return <Pencil size={15} />;
    case "play":
      return <Play size={15} />;
    case "plus":
      return <Plus size={15} />;
    case "refresh":
      return <RefreshCw size={15} />;
    case "rows":
      return <Rows3 size={15} />;
    case "save":
      return <Save size={15} />;
    case "search":
      return <Search size={15} />;
    case "settings":
      return <Settings size={15} />;
    case "square-plus":
      return <SquarePlus size={15} />;
    case "trash":
      return <Trash2 size={15} />;
    case "wrench":
      return <Wrench size={15} />;
    case "x":
      return <X size={15} />;
    default:
      return <MoreHorizontal size={15} />;
  }
}

function PluginPanel({
  tab,
  plugin,
  plugins,
  active,
  config,
  uiScale,
  profileStore,
  uiContributionRegistry,
  callHook,
  onSetTabProfile
}: {
  tab: WorkspaceTab;
  plugin: PluginDescriptor | undefined;
  plugins: PluginDescriptor[];
  active: boolean;
  config: Record<string, ConfigValue>;
  uiScale: number;
  profileStore?: PersonalityProfileStore;
  uiContributionRegistry: UiContributionRegistry;
  callHook: UiContributionRenderContext["callHook"];
  onSetTabProfile: (tabId: string, profileId: string | undefined) => Promise<void>;
}) {
  const panelContribution = selectPluginPanelContribution(plugins, plugin);
  if (panelContribution) {
    const panel = uiContributionRegistry.render(panelContribution, { tab, plugin, plugins, active, config, uiScale, callHook });
    if (panel) {
      return panel;
    }
  }
  if (plugin?.panelKind === "file-browser") {
    return <FileBrowserPanel tab={tab} config={config} />;
  }
  if (plugin?.panelKind === "web-viewer") {
    return <WebViewerPanel tab={tab} />;
  }
  if (plugin?.panelKind === "worktree-manager") {
    return <WorktreeManagerPanel tab={tab} config={config} />;
  }
  if (plugin?.panelKind === "terminal" || !plugin) {
    if (tab.pluginId === "codex-terminal" && profileStore) {
      return (
        <div className="terminal-profile-shell">
          <TabProfileToolbar tab={tab} profiles={profileStore.profiles} defaultProfileId={profileStore.defaultProfileId} onSelect={(profileId) => onSetTabProfile(tab.id, profileId)} />
          <TerminalPanel tab={tab} active={active} uiScale={uiScale} />
        </div>
      );
    }
    return <TerminalPanel tab={tab} active={active} uiScale={uiScale} />;
  }
  return <div className="empty-pane">No panel registered for {plugin.displayName}</div>;
}

function TabSettingsDialog({
  tab,
  plugin,
  plugins,
  sectionId,
  config,
  uiScale,
  uiContributionRegistry,
  callHook,
  onClose
}: {
  tab: WorkspaceTab;
  plugin: PluginDescriptor | undefined;
  plugins: PluginDescriptor[];
  sectionId?: string;
  config: Record<string, ConfigValue>;
  uiScale: number;
  uiContributionRegistry: UiContributionRegistry;
  callHook: UiContributionRenderContext["callHook"];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useOutsidePointerDismiss(true, dialogRef, onClose);
  const sections = selectTabSettingsContributions(plugins, tab);
  const requestedSection = sectionId ? sections.find((section) => section.id === sectionId) : undefined;
  const orderedSections = requestedSection ? [requestedSection, ...sections.filter((section) => section.id !== requestedSection.id)] : sections;

  return (
    <div className="dialog-backdrop">
      <div className="dialog tab-settings-dialog" ref={dialogRef}>
        <h2>{tab.title}</h2>
        <p>{plugin?.displayName ?? tab.pluginId}</p>
        {orderedSections.length ? (
          orderedSections.map((contribution) => (
            <div key={contribution.id} className="tab-settings-contribution">
              {uiContributionRegistry.render(contribution, { tab, plugin, plugins, config, uiScale, callHook })}
            </div>
          ))
        ) : (
          <div className="empty-pane">No tab settings are registered for this plugin.</div>
        )}
        <div className="dialog-actions">
          <ControlButton onClick={onClose}>Close</ControlButton>
        </div>
      </div>
    </div>
  );
}

function ResizeHandle({ direction, sizes, onResize }: { direction: LayoutDirection; sizes: [number, number]; onResize: (deltaPixels: number, containerPixels: number, startSizes: [number, number]) => void }) {
  return (
    <div
      className={`resize-handle ${direction}`}
      onPointerDown={(event) => {
        event.preventDefault();
        const start = direction === "row" ? event.clientX : event.clientY;
        const handle = event.currentTarget;
        const container = handle.parentElement;
        const bounds = container?.getBoundingClientRect();
        const total = direction === "row" ? bounds?.width ?? 1 : bounds?.height ?? 1;
        const startSizes: [number, number] = [sizes[0], sizes[1]];
        handle.setPointerCapture(event.pointerId);
        const onMove = (moveEvent: PointerEvent) => {
          const current = direction === "row" ? moveEvent.clientX : moveEvent.clientY;
          onResize(current - start, total, startSizes);
        };
        const onUp = () => {
          if (handle.hasPointerCapture(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId);
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
      }}
    />
  );
}

function loadAudioInputId(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.localStorage.getItem(AUDIO_INPUT_KEY) || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export async function requestAudioInputEnumerationAccess(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not expose microphone capture.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

function upsertTab(tabs: WorkspaceTab[], tab: WorkspaceTab): WorkspaceTab[] {
  const existingIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
  if (existingIndex === -1) {
    return [...tabs, tab];
  }
  return [...tabs.slice(0, existingIndex), tab, ...tabs.slice(existingIndex + 1)];
}

export function workspaceStateWithPreservedLayout(state: WorkspaceStateResponse, localLayout: TabLayoutState, pendingWindowId: string | undefined): WorkspaceStateResponse {
  if (!pendingWindowId || state.activeWindowId !== pendingWindowId) {
    return state;
  }
  return {
    ...state,
    windows: state.windows.map((window) => (window.id === pendingWindowId ? { ...window, layout: localLayout } : window))
  };
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
    if (message.type === "tabs" || message.type === "workspace") {
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
  profiles,
  defaultCwd,
  onCancel,
  onCreate
}: {
  plugins: PluginDescriptor[];
  profiles: PersonalityProfile[];
  defaultCwd: string;
  onCancel: () => void;
  onCreate: (input: CreateTabRequest) => Promise<void>;
}) {
  const creatablePlugins = plugins.filter((plugin) => plugin.creatable);
  const [pluginId, setPluginId] = useState<PluginId>("codex-terminal");
  const [cwd, setCwd] = useState(defaultCwd);
  const [title, setTitle] = useState("");
  const [localWebUrl, setLocalWebUrl] = useState("");
  const [profileId, setProfileId] = useState("");
  const [createDirectory, setCreateDirectory] = useState(false);
  const [busy, setBusy] = useState(false);
  const selectedPlugin = creatablePlugins.find((plugin) => plugin.id === pluginId);
  const isLocalWeb = selectedPlugin?.panelKind === "web-viewer";
  const isCodex = selectedPlugin?.id === "codex-terminal";
  const requiresDirectory = selectedPlugin?.requiresDirectory ?? true;
  const titlePlaceholder = defaultTabTitlePlaceholder(selectedPlugin, cwd, localWebUrl);

  useEffect(() => {
    if (!requiresDirectory) {
      setCreateDirectory(false);
    }
  }, [requiresDirectory]);

  useEffect(() => {
    if (!isCodex) {
      setProfileId("");
    }
  }, [isCodex]);

  async function submit() {
    setBusy(true);
    try {
      const initialInput = isLocalWeb && localWebUrl.trim() ? { url: localWebUrl.trim() } : undefined;
      await onCreate({
        pluginId,
        cwd: requiresDirectory ? cwd : undefined,
        title,
        createDirectory: requiresDirectory ? createDirectory : false,
        initialInput,
        pluginMetadata: isCodex ? pluginMetadataForProfile(profileId || undefined) : undefined
      });
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
        {requiresDirectory ? (
          <div className="field-group">
            <label htmlFor="new-tab-directory">Directory</label>
            <PathEntry inputId="new-tab-directory" value={cwd} onChange={setCwd} ariaLabel="New tab directory" />
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
        {isCodex && profiles.length > 0 ? (
          <ProfileSelect value={profileId} profiles={profiles} onChange={setProfileId} label="Personality" includeInherited />
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
          <ControlButton onClick={onCancel}>Cancel</ControlButton>
          <ControlButton className="primary-button" tone="primary" onClick={() => void submit()} disabled={(requiresDirectory && !cwd.trim()) || busy}>
            Create
          </ControlButton>
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
