import { useCallback, useEffect, useId, useMemo, useRef, useState, type Dispatch, type FocusEvent as ReactFocusEvent, type FormEvent as ReactFormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { completeFromList, type Completion } from "@codemirror/autocomplete";
import { python, pythonLanguage } from "@codemirror/lang-python";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { EditorState, type Extension } from "@codemirror/state";
import { basicSetup, EditorView } from "codemirror";
import {
  BaseEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  reconnectEdge,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type EdgeProps,
  type EdgeTypes,
  type FinalConnectionState,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type XYPosition
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CheckCircle2, FlaskConical, PauseCircle, Play, Plus, Save, Search, ShieldAlert, ToggleLeft, ToggleRight, Trash2, X, Zap } from "lucide-react";

import type {
  AutomationCatalogResponse,
  AutomationEdgeRoute,
  AutomationGroup,
  AutomationNodeCatalogEntry,
  AutomationPortDescriptor,
  AutomationPortKind,
  AutomationRunSummary,
  AutomationRunStatus,
  AutomationSafety,
  AutomationTestCase,
  AutomationTestRunSample,
  AutomationType,
  AutomationValidationDiagnostic,
  AutomationValidationSummary,
  WorkspaceTab
} from "@cloudx/shared";
import { AUTOMATION_FSTRING_TYPE_ID, DEFAULT_AUTOMATION_ALLOWED_SAFETY, automationEntryWithDynamicPorts, automationFStringInputNames } from "@cloudx/shared";

import {
  cancelAutomationRun,
  deleteAutomationGroup,
  getAutomationCatalog,
  getAutomationGroups,
  getAutomationRuns,
  saveAutomationGroup,
  setAutomationGroupEnabled,
  startAutomationTestRun,
  validateAutomationGraph
} from "../api.js";
import { createBrowserId } from "./browserId.js";
import { ControlButton } from "./Control.js";
import {
  automationGraphsEqual,
  edgeRouteFromData,
  flowEdgeData,
  flowFromGraph,
  graphFromFlow,
  handleForPort,
  handleKind,
  handlePort,
  routedEdgePath,
  type AutomationEdgeData,
  type AutomationNodeData,
  type FlowEdge,
  type FlowNode
} from "./automationGraphAdapter.js";
import {
  automationTypeAssignable,
  connectedDataInputIds,
  connectionIsValid,
  deleteEdgesForHandle,
  dataInputConflictEdges,
  hasProgramFlowConflict,
  portIsConnectable,
  programFlowConflictEdges,
  removeConnectionConflicts,
  removeProgramFlowConflicts,
  type AutomationHandleRef,
  type ConnectionLike
} from "./automationConnection.js";
import { PluginPanelDock } from "./PluginPanelDock.js";

export { automationGraphsEqual, flowFromGraph, graphFromFlow, routedEdgePath } from "./automationGraphAdapter.js";
export { automationTypeAssignable, connectedDataInputIds, connectionIsValid, dataInputConflictEdges, deleteEdgesForHandle, hasProgramFlowConflict, programFlowConflictEdges, removeConnectionConflicts, removeProgramFlowConflicts } from "./automationConnection.js";

interface AutomationPanelProps {
  tab: WorkspaceTab;
  liveRuns?: AutomationRunSummary[];
  onAutomationGroupsChanged?: () => Promise<void> | void;
  state?: AutomationPanelState;
  onStateChange?: (updater: AutomationPanelStateUpdater) => void;
}

interface PortTooltipPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

const PORT_TOOLTIP_GAP = 8;
const PORT_TOOLTIP_MARGIN = 10;
const PORT_TOOLTIP_MAX_WIDTH = 280;
const PORT_TOOLTIP_MAX_HEIGHT = 260;
const PORT_TOOLTIP_MIN_HEIGHT = 72;

export interface PaletteState {
  x: number;
  y: number;
  flowX: number;
  flowY: number;
  compatibility?: PaletteCompatibility;
}

export interface PaletteCompatibility extends AutomationHandleRef {
  handleType: "source" | "target";
  kind: AutomationPortKind;
  type: AutomationType;
}

export interface AutomationPanelState {
  loaded: boolean;
  catalog: AutomationCatalogResponse;
  groups: AutomationGroup[];
  selectedGroupId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  allowedSafety: AutomationSafety[] | undefined;
  testCases: AutomationTestCase[];
  selectedNodeId: string | undefined;
  selectedTestCaseId: string | undefined;
  testCasePayloadDraft: string;
  validation: AutomationValidationSummary | undefined;
  runs: AutomationRunSummary[];
  lastTestSample: AutomationTestRunSample | undefined;
  palette: PaletteState | undefined;
  paletteSearch: string;
  search: string;
  createGroupOpen: boolean;
  createGroupName: string;
  status: string;
}

export type AutomationPanelStateUpdater = (state: AutomationPanelState | undefined) => AutomationPanelState;

export interface AutomationPaletteGroup {
  id: string;
  title: string;
  entries: AutomationNodeCatalogEntry[];
}

export interface PaletteConnectionPlan {
  direction: "from-origin" | "to-origin";
  entryPortId: string;
  entryPortKind: AutomationPortKind;
  converter?: AutomationNodeCatalogEntry;
  converterInputPortId?: string;
  converterOutputPortId?: string;
}

const automationNodeTypes: NodeTypes = {
  automation: AutomationNodeView
};

const automationEdgeTypes: EdgeTypes = {
  automation: AutomationRoutableEdge
};

const PALETTE_VIEWPORT_MARGIN = 10;
const PALETTE_MAX_WIDTH = 330;
const PALETTE_MAX_HEIGHT = 420;
const SEARCH_PALETTE_GAP = 8;
const CONNECTED_NODE_SPACING = 230;

type AutomationSafetyToggle = Extract<AutomationSafety, "external" | "destructive">;

interface AutomationSafetyToggleCopy {
  actionLabel: string;
  confirmation: string;
  description: string;
  status: string;
  title: string;
}

const AUTOMATION_SAFETY_EXPLANATIONS: Record<AutomationSafetyToggle, string> = {
  external: "External hooks can run shell commands, send terminal input, submit voice requests, fetch Git refs, or otherwise reach outside the automation graph.",
  destructive: "Destructive hooks can stop or remove active workspace state; current examples include stopping a running terminal process."
};
const AUTOMATION_TEST_STATUS_OPTIONS: AutomationRunStatus[] = ["succeeded", "failed", "cancelled"];

export const automationMiniMapTheme = {
  bgColor: "var(--automation-minimap-background)",
  maskColor: "var(--automation-minimap-mask)",
  maskStrokeColor: "var(--automation-minimap-mask-stroke)",
  nodeColor: "var(--automation-minimap-node)",
  nodeStrokeColor: "var(--automation-minimap-node-stroke)",
  nodeBorderRadius: 4,
  nodeStrokeWidth: 1.5
} as const;

export function createInitialAutomationPanelState(): AutomationPanelState {
  return {
    loaded: false,
    catalog: { nodes: [] },
    groups: [],
    selectedGroupId: "",
    nodes: [],
    edges: [],
    allowedSafety: undefined,
    testCases: [],
    selectedNodeId: undefined,
    selectedTestCaseId: undefined,
    testCasePayloadDraft: "",
    validation: undefined,
    runs: [],
    lastTestSample: undefined,
    palette: undefined,
    paletteSearch: "",
    search: "",
    createGroupOpen: false,
    createGroupName: "",
    status: "Loading automation."
  };
}

function automationPanelStateHasUnsavedChanges(state: AutomationPanelState): boolean {
  const selectedGroup = state.groups.find((group) => group.id === state.selectedGroupId);
  if (!selectedGroup) {
    return false;
  }
  const currentGraph = automationGraphFromPanelState(state.nodes, state.edges, selectedGroup.graph, state.allowedSafety);
  const selectedTestCase = selectedTestCaseFromList(state.testCases, state.selectedTestCaseId);
  const testCaseDraftChanged = Boolean(selectedTestCase && state.testCasePayloadDraft !== automationTestCasePayloadText(selectedTestCase));
  return !automationGraphsEqual(currentGraph, selectedGroup.graph) || !automationTestCasesEqual(state.testCases, selectedGroup.testCases ?? []) || testCaseDraftChanged;
}

function useAutomationPanelState(
  state: AutomationPanelState | undefined,
  onStateChange: ((updater: AutomationPanelStateUpdater) => void) | undefined
): [AutomationPanelState, Dispatch<SetStateAction<AutomationPanelState>>] {
  const [localState, setLocalState] = useState<AutomationPanelState>(() => createInitialAutomationPanelState());
  const panelState = state ?? localState;
  const setPanelState = useCallback<Dispatch<SetStateAction<AutomationPanelState>>>((nextState) => {
    if (!onStateChange) {
      setLocalState(nextState);
      return;
    }
    onStateChange((previous) => {
      const base = { ...createInitialAutomationPanelState(), ...previous };
      return typeof nextState === "function" ? (nextState as (current: AutomationPanelState) => AutomationPanelState)(base) : nextState;
    });
  }, [onStateChange]);
  return [panelState, setPanelState];
}

function useAutomationStateField<K extends keyof AutomationPanelState>(
  key: K,
  panelState: AutomationPanelState,
  setPanelState: Dispatch<SetStateAction<AutomationPanelState>>
): [AutomationPanelState[K], Dispatch<SetStateAction<AutomationPanelState[K]>>] {
  const setValue = useCallback<Dispatch<SetStateAction<AutomationPanelState[K]>>>((nextValue) => {
    setPanelState((previous) => {
      const currentValue = previous[key];
      const resolvedValue = typeof nextValue === "function" ? (nextValue as (current: AutomationPanelState[K]) => AutomationPanelState[K])(currentValue) : nextValue;
      return { ...previous, [key]: resolvedValue };
    });
  }, [key, setPanelState]);
  return [panelState[key], setValue];
}

export function AutomationPanel({ tab, liveRuns, onAutomationGroupsChanged, state, onStateChange }: AutomationPanelProps) {
  return (
    <ReactFlowProvider>
      <AutomationPanelInner tab={tab} liveRuns={liveRuns} onAutomationGroupsChanged={onAutomationGroupsChanged} state={state} onStateChange={onStateChange} />
    </ReactFlowProvider>
  );
}

function AutomationPanelInner({ tab, liveRuns, onAutomationGroupsChanged, state, onStateChange }: AutomationPanelProps) {
  const { fitView, screenToFlowPosition } = useReactFlow<FlowNode, FlowEdge>();
  const [panelState, setPanelState] = useAutomationPanelState(state, onStateChange);
  const [loaded] = useAutomationStateField("loaded", panelState, setPanelState);
  const [catalog] = useAutomationStateField("catalog", panelState, setPanelState);
  const [groups, setGroups] = useAutomationStateField("groups", panelState, setPanelState);
  const [selectedGroupId, setSelectedGroupId] = useAutomationStateField("selectedGroupId", panelState, setPanelState);
  const [nodes, setNodes] = useAutomationStateField("nodes", panelState, setPanelState);
  const [edges, setEdges] = useAutomationStateField("edges", panelState, setPanelState);
  const [allowedSafety, setAllowedSafety] = useAutomationStateField("allowedSafety", panelState, setPanelState);
  const [testCases, setTestCases] = useAutomationStateField("testCases", panelState, setPanelState);
  const [selectedNodeId, setSelectedNodeId] = useAutomationStateField("selectedNodeId", panelState, setPanelState);
  const [selectedTestCaseId, setSelectedTestCaseId] = useAutomationStateField("selectedTestCaseId", panelState, setPanelState);
  const [testCasePayloadDraft, setTestCasePayloadDraft] = useAutomationStateField("testCasePayloadDraft", panelState, setPanelState);
  const [validation, setValidation] = useAutomationStateField("validation", panelState, setPanelState);
  const [runs, setRuns] = useAutomationStateField("runs", panelState, setPanelState);
  const [lastTestSample, setLastTestSample] = useAutomationStateField("lastTestSample", panelState, setPanelState);
  const [palette, setPalette] = useAutomationStateField("palette", panelState, setPanelState);
  const [paletteSearch, setPaletteSearch] = useAutomationStateField("paletteSearch", panelState, setPanelState);
  const [search, setSearch] = useAutomationStateField("search", panelState, setPanelState);
  const [createGroupOpen, setCreateGroupOpen] = useAutomationStateField("createGroupOpen", panelState, setPanelState);
  const [createGroupName, setCreateGroupName] = useAutomationStateField("createGroupName", panelState, setPanelState);
  const [status, setStatus] = useAutomationStateField("status", panelState, setPanelState);
  const [transientStatus, setTransientStatus] = useState<string | undefined>();
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const fitViewFrameRef = useRef<number | undefined>(undefined);
  const nodeCountRef = useRef(0);
  const cleanCacheRefreshAttemptedRef = useRef(false);
  const reconnectingEdgeIdRef = useRef<string | undefined>(undefined);
  const suppressNextPaneClickRef = useRef(false);
  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const catalogByType = useMemo(() => new Map(catalog.nodes.map((entry) => [entry.typeId, entry])), [catalog.nodes]);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const currentGraph = useMemo(() => {
    if (!selectedGroup) {
      return undefined;
    }
    return automationGraphFromPanelState(nodes, edges, selectedGroup.graph, allowedSafety);
  }, [allowedSafety, edges, nodes, selectedGroup]);
  const selectedTestCase = selectedTestCaseFromList(testCases, selectedTestCaseId);
  const testCaseDraftChanged = Boolean(selectedTestCase && testCasePayloadDraft !== automationTestCasePayloadText(selectedTestCase));
  const hasUnsavedChanges = Boolean(
    selectedGroup &&
      currentGraph &&
      (!automationGraphsEqual(currentGraph, selectedGroup.graph) || !automationTestCasesEqual(testCases, selectedGroup.testCases ?? []) || testCaseDraftChanged)
  );
  const selectedNodeConnectedInputIds = useMemo(() => connectedDataInputIds(selectedNodeId, edges), [edges, selectedNodeId]);
  const updateEdgeRoute = useCallback((edgeId: string, route: AutomationEdgeRoute) => {
    setEdges((current) => current.map((edge) => (edge.id === edgeId ? { ...edge, data: flowEdgeData(handleKind(edge.sourceHandle), route) } : edge)));
  }, []);
  const renderedEdges = useMemo<FlowEdge[]>(
    () =>
      edges.map((edge) => ({
        ...edge,
        data: {
          ...flowEdgeData(edge.data?.kind ?? handleKind(edge.sourceHandle), edgeRouteFromData(edge.data)),
          onRouteChange: updateEdgeRoute
        }
      })),
    [edges, updateEdgeRoute]
  );
  const externalSafetyAllowed = automationSafetyEnabled(allowedSafety, "external");
  const destructiveSafetyAllowed = automationSafetyEnabled(allowedSafety, "destructive");
  const externalSafetyCopy = automationSafetyToggleCopy("external", externalSafetyAllowed);
  const destructiveSafetyCopy = automationSafetyToggleCopy("destructive", destructiveSafetyAllowed);
  const externalSafetyDescriptionId = useId();
  const destructiveSafetyDescriptionId = useId();
  const updateSafetyPolicy = useCallback((safety: AutomationSafetyToggle, enabled: boolean) => {
    setAllowedSafety((current) => automationAllowedSafetyWithToggle(current, safety, enabled));
    setStatus(automationSafetyToggleCopy(safety, enabled).confirmation);
  }, []);

  const currentTestCasesForSave = useCallback((): AutomationTestCase[] => {
    return selectedTestCaseId ? automationTestCasesWithPayloadDraft(testCases, selectedTestCaseId, testCasePayloadDraft) : testCases;
  }, [selectedTestCaseId, testCasePayloadDraft, testCases]);

  const selectTestCase = useCallback((testCaseId: string) => {
    let currentTestCases: AutomationTestCase[];
    try {
      currentTestCases = currentTestCasesForSave();
    } catch (error) {
      setStatus(automationStatusFromError("Update test fixture", error));
      return;
    }
    const nextTestCase = selectedTestCaseFromList(currentTestCases, testCaseId);
    setTestCases(currentTestCases);
    setSelectedTestCaseId(nextTestCase?.id);
    setTestCasePayloadDraft(automationTestCasePayloadText(nextTestCase));
    setStatus(nextTestCase ? `Selected test case ${nextTestCase.name}.` : "No test case selected.");
  }, [currentTestCasesForSave]);

  const updateSelectedTestCase = useCallback((update: (testCase: AutomationTestCase) => AutomationTestCase) => {
    const activeId = selectedTestCase?.id;
    if (!activeId) {
      return;
    }
    setTestCases((current) => current.map((testCase) => (testCase.id === activeId ? update(testCase) : testCase)));
  }, [selectedTestCase?.id]);

  const addTestCase = useCallback(() => {
    let currentTestCases: AutomationTestCase[];
    try {
      currentTestCases = currentTestCasesForSave();
    } catch (error) {
      setStatus(automationStatusFromError("Add test case", error));
      return;
    }
    const testCase = newAutomationTestCase(createBrowserId("test-case"), currentTestCases.length + 1);
    setTestCases([...currentTestCases, testCase]);
    setSelectedTestCaseId(testCase.id);
    setTestCasePayloadDraft(automationTestCasePayloadText(testCase));
    setStatus("Test case added.");
  }, [currentTestCasesForSave]);

  const deleteSelectedTestCase = useCallback(() => {
    if (!selectedTestCase) {
      return;
    }
    const nextTestCases = testCases.filter((testCase) => testCase.id !== selectedTestCase.id);
    const nextTestCase = nextTestCases[0];
    setTestCases(nextTestCases);
    setSelectedTestCaseId(nextTestCase?.id);
    setTestCasePayloadDraft(automationTestCasePayloadText(nextTestCase));
    setStatus("Test case removed.");
  }, [selectedTestCase, testCases]);

  const updateSelectedTestCasePayloadDraft = useCallback((value: string) => {
    setTestCasePayloadDraft(value);
    if (!selectedTestCase) {
      return;
    }
    try {
      const payload = parseAutomationTestCasePayload(value);
      setTestCases((current) => current.map((testCase) => (testCase.id === selectedTestCase.id ? { ...testCase, payload } : testCase)));
    } catch {
      return;
    }
  }, [selectedTestCase]);

  const focusDiagnostic = useCallback((diagnostic: AutomationValidationDiagnostic) => {
    if (diagnostic.nodeId && nodes.some((node) => node.id === diagnostic.nodeId)) {
      setSelectedNodeId(diagnostic.nodeId);
      setStatus(`Focused node ${diagnostic.nodeId}.`);
      return;
    }
    if (diagnostic.edgeId) {
      const edge = currentGraph?.edges.find((candidate) => candidate.id === diagnostic.edgeId);
      const nodeId = edge?.targetNodeId ?? edge?.sourceNodeId;
      if (nodeId && nodes.some((node) => node.id === nodeId)) {
        setSelectedNodeId(nodeId);
        setStatus(`Focused edge ${diagnostic.edgeId}.`);
        return;
      }
    }
    setStatus("Diagnostic has no focusable node or edge.");
  }, [currentGraph?.edges, nodes]);

  useEffect(() => {
    nodeCountRef.current = nodes.length;
  }, [nodes.length]);

  const scheduleAutomationViewFit = useCallback(() => {
    const ownerWindow = canvasRef.current?.ownerDocument.defaultView;
    if (!ownerWindow || !nodeCountRef.current) {
      return;
    }
    if (fitViewFrameRef.current !== undefined) {
      ownerWindow.cancelAnimationFrame(fitViewFrameRef.current);
    }
    fitViewFrameRef.current = ownerWindow.requestAnimationFrame(() => {
      fitViewFrameRef.current = undefined;
      void fitView({ padding: 0.18, duration: 140 });
    });
  }, [fitView]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    let width = 0;
    let height = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }
      const nextWidth = entry.contentRect.width;
      const nextHeight = entry.contentRect.height;
      if (nextWidth <= 0 || nextHeight <= 0) {
        return;
      }
      if (Math.abs(nextWidth - width) < 1 && Math.abs(nextHeight - height) < 1) {
        return;
      }
      width = nextWidth;
      height = nextHeight;
      scheduleAutomationViewFit();
    });
    observer.observe(canvas);

    return () => {
      observer.disconnect();
      const ownerWindow = canvas.ownerDocument.defaultView;
      if (ownerWindow && fitViewFrameRef.current !== undefined) {
        ownerWindow.cancelAnimationFrame(fitViewFrameRef.current);
        fitViewFrameRef.current = undefined;
      }
    };
  }, [scheduleAutomationViewFit]);

  useEffect(() => {
    const refreshCleanCachedState = loaded && !hasUnsavedChanges && !cleanCacheRefreshAttemptedRef.current;
    if (loaded && !refreshCleanCachedState) {
      return undefined;
    }
    cleanCacheRefreshAttemptedRef.current = true;
    let cancelled = false;
    void Promise.all([getAutomationCatalog(), getAutomationGroups(), getAutomationRuns()])
      .then(([catalogResponse, groupResponse, runResponse]) => {
        if (cancelled) {
          return;
        }
        setPanelState((current) => {
          if (refreshCleanCachedState && automationPanelStateHasUnsavedChanges(current)) {
            return current;
          }
          const group = groupResponse.find((candidate) => candidate.id === current.selectedGroupId) ?? groupResponse[0];
          if (!group) {
            return {
              ...current,
              loaded: true,
              catalog: catalogResponse,
              groups: groupResponse,
              runs: runResponse.runs,
              selectedGroupId: "",
              nodes: [],
              edges: [],
              allowedSafety: undefined,
              testCases: [],
              selectedNodeId: undefined,
              selectedTestCaseId: undefined,
              testCasePayloadDraft: "",
              validation: undefined,
              lastTestSample: undefined,
              status: "No automation groups saved."
            };
          }
          const flow = flowFromGraph(group, catalogResponse);
          const firstTestCase = (group.testCases ?? [])[0];
          return {
            ...current,
            loaded: true,
            catalog: catalogResponse,
            groups: groupResponse,
            runs: runResponse.runs,
            selectedGroupId: group.id,
            nodes: flow.nodes,
            edges: flow.edges,
            allowedSafety: group.graph.allowedSafety,
            testCases: group.testCases ?? [],
            selectedNodeId: undefined,
            selectedTestCaseId: firstTestCase?.id,
            testCasePayloadDraft: automationTestCasePayloadText(firstTestCase),
            validation: group.lastValidation,
            lastTestSample: undefined,
            status: "Automation loaded."
          };
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus(automationStatusFromError("Load automation", error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasUnsavedChanges, loaded]);

  useEffect(() => {
    if (liveRuns) {
      setRuns(liveRuns);
    }
  }, [liveRuns]);

  useEffect(() => {
    if (!palette) {
      return undefined;
    }

    const onDocumentPointerDown = (event: PointerEvent) => {
      if (shouldClosePaletteForPointer(event.button, event.target, paletteRef.current)) {
        setPalette(undefined);
      }
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPalette(undefined);
      }
    };
    const onDocumentContextMenu = (event: MouseEvent) => {
      if (palette.compatibility) {
        event.preventDefault();
        setPalette(undefined);
        setStatus("Connector cancelled.");
      }
    };

    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown);
    document.addEventListener("contextmenu", onDocumentContextMenu, true);
    return () => {
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown);
      document.removeEventListener("contextmenu", onDocumentContextMenu, true);
    };
  }, [palette]);

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return undefined;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges]);

  const selectGroup = useCallback((group: AutomationGroup) => {
    if (group.id !== selectedGroupId && hasUnsavedChanges && !confirmDiscardUnsavedChanges(selectedGroup?.name)) {
      setStatus("Switch cancelled. Save or discard the current changes first.");
      return;
    }
    setSelectedGroupId(group.id);
    const flow = flowFromGraph(group, catalog);
    const firstTestCase = (group.testCases ?? [])[0];
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setAllowedSafety(group.graph.allowedSafety);
    setTestCases(group.testCases ?? []);
    setSelectedNodeId(undefined);
    setSelectedTestCaseId(firstTestCase?.id);
    setTestCasePayloadDraft(automationTestCasePayloadText(firstTestCase));
    setValidation(group.lastValidation);
    setLastTestSample(undefined);
    setStatus(`Selected ${group.name}.`);
  }, [catalog, hasUnsavedChanges, selectedGroup?.name, selectedGroupId]);

  const openCreateGroupForm = useCallback(() => {
    if (hasUnsavedChanges && !confirmDiscardUnsavedChanges(selectedGroup?.name)) {
      setStatus("Create cancelled. Save or discard the current changes first.");
      return;
    }
    setCreateGroupName(nextAutomationGroupName(groups));
    setCreateGroupOpen(true);
  }, [groups, hasUnsavedChanges, selectedGroup?.name]);

  const reportAutomationGroupsChanged = useCallback(async (successStatus: string) => {
    try {
      await onAutomationGroupsChanged?.();
      setStatus(successStatus);
    } catch (error) {
      setStatus(`${successStatus} ${automationStatusFromError("Refresh automation triggers", error)}`);
    }
  }, [onAutomationGroupsChanged]);

  const createAutomationGroup = useCallback(async (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = normalizedAutomationGroupName(createGroupName);
    if (!name) {
      setStatus("Automation name is required.");
      return;
    }
    const group = newAutomationGroup(name, createBrowserId("automation"), new Date().toISOString());
    try {
      const saved = await saveAutomationGroup(group);
      const flow = flowFromGraph(saved, catalog);
      setGroups((current) => [...current.filter((candidate) => candidate.id !== saved.id), saved]);
      setSelectedGroupId(saved.id);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setAllowedSafety(saved.graph.allowedSafety);
      setTestCases(saved.testCases ?? []);
      setSelectedNodeId(undefined);
      setSelectedTestCaseId(undefined);
      setTestCasePayloadDraft("");
      setValidation(saved.lastValidation);
      setLastTestSample(undefined);
      setPalette(undefined);
      setCreateGroupOpen(false);
      await reportAutomationGroupsChanged(`Created ${saved.name}. Add a trigger node to start.`);
    } catch (error) {
      setStatus(automationStatusFromError("Create automation", error));
    }
  }, [catalog, createGroupName, reportAutomationGroupsChanged]);

  const deleteCurrentGroup = useCallback(async () => {
    if (!selectedGroup) {
      return;
    }
    if (!window.confirm(`Delete automation ${selectedGroup.name}?`)) {
      setStatus("Delete cancelled.");
      return;
    }
    try {
      const nextGroups = await deleteAutomationGroup(selectedGroup.id);
      const nextSelectedGroup = selectedAutomationGroupAfterDelete(groups, nextGroups, selectedGroup.id, selectedGroupId);
      setGroups(nextGroups);
      setCreateGroupOpen(false);
      setPalette(undefined);
      setLastTestSample(undefined);
      if (nextSelectedGroup) {
        const flow = flowFromGraph(nextSelectedGroup, catalog);
        setSelectedGroupId(nextSelectedGroup.id);
        setNodes(flow.nodes);
        setEdges(flow.edges);
        setAllowedSafety(nextSelectedGroup.graph.allowedSafety);
        setTestCases(nextSelectedGroup.testCases ?? []);
        setSelectedNodeId(undefined);
        const firstTestCase = (nextSelectedGroup.testCases ?? [])[0];
        setSelectedTestCaseId(firstTestCase?.id);
        setTestCasePayloadDraft(automationTestCasePayloadText(firstTestCase));
        setValidation(nextSelectedGroup.lastValidation);
        await reportAutomationGroupsChanged(`Deleted ${selectedGroup.name}. Selected ${nextSelectedGroup.name}.`);
        return;
      }
      setSelectedGroupId("");
      setNodes([]);
      setEdges([]);
      setAllowedSafety(undefined);
      setTestCases([]);
      setSelectedNodeId(undefined);
      setSelectedTestCaseId(undefined);
      setTestCasePayloadDraft("");
      setValidation(undefined);
      await reportAutomationGroupsChanged(`Deleted ${selectedGroup.name}.`);
    } catch (error) {
      setStatus(automationStatusFromError("Delete automation", error));
    }
  }, [catalog, groups, reportAutomationGroupsChanged, selectedGroup, selectedGroupId]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const isValidConnection = useCallback((connection: Connection | FlowEdge) => {
    const reconnectingEdgeId = reconnectingEdgeIdRef.current;
    return connectionIsValid(connection, nodes, catalogByType, edges, reconnectingEdgeId, { allowProgramFlowReplacement: !reconnectingEdgeId, allowDataInputReplacement: !reconnectingEdgeId });
  }, [catalogByType, edges, nodes]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connectionIsValid(connection, nodes, catalogByType, edges, undefined, { allowProgramFlowReplacement: true, allowDataInputReplacement: true })) {
      setStatus("Connection rejected by automation type validation.");
      return;
    }
    setEdges((current) => addEdge(flowEdgeFromConnection(connection), removeConnectionConflicts(connection, current)));
  }, [catalogByType, edges, nodes]);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
    if (connectionState.isValid || connectionState.toHandle || !connectionState.fromHandle) {
      return;
    }
    const point = clientPointFromEvent(event);
    const compatibility = compatibilityFromConnectionState(connectionState, nodes, catalogByType);
    if (!point || !compatibility) {
      return;
    }
    setPaletteSearch("");
    suppressNextPaneClickRef.current = true;
    setPalette(paletteStateFromPoint(point.x, point.y, window.innerWidth, window.innerHeight, screenToFlowPosition, compatibility));
    setStatus("Select a compatible node for this connector.");
  }, [catalogByType, nodes, screenToFlowPosition]);

  const onReconnectStart = useCallback((_event: unknown, edge: FlowEdge) => {
    reconnectingEdgeIdRef.current = edge.id;
  }, []);

  const onReconnect = useCallback((oldEdge: FlowEdge, newConnection: Connection) => {
    if (!connectionIsValid(newConnection, nodes, catalogByType, edges, oldEdge.id)) {
      setStatus("Connection rejected by automation type validation.");
      return;
    }
    setEdges((current) =>
      reconnectEdge(oldEdge, newConnection, current, { shouldReplaceId: false }).map((edge) =>
        edge.id === oldEdge.id ? normalizeFlowEdge(edge as FlowEdge) : edge as FlowEdge
      )
    );
    setStatus("Connection moved.");
  }, [catalogByType, edges, nodes]);

  const onReconnectEnd = useCallback(() => {
    reconnectingEdgeIdRef.current = undefined;
  }, []);

  const saveCurrentGroup = useCallback(async () => {
    if (!selectedGroup || !currentGraph) {
      return;
    }
    try {
      const savedTestCases = currentTestCasesForSave();
      const group = await saveAutomationGroup({ ...selectedGroup, graph: currentGraph, testCases: savedTestCases });
      setGroups((current) => current.map((candidate) => (candidate.id === group.id ? group : candidate)));
      setAllowedSafety(group.graph.allowedSafety);
      setTestCases(group.testCases ?? []);
      const activeTestCase = selectedTestCaseFromList(group.testCases ?? [], selectedTestCaseId);
      setSelectedTestCaseId(activeTestCase?.id);
      setTestCasePayloadDraft(automationTestCasePayloadText(activeTestCase));
      setValidation(group.lastValidation);
      setLastTestSample(undefined);
      await reportAutomationGroupsChanged("Automation saved.");
    } catch (error) {
      setStatus(automationStatusFromError("Save automation", error));
    }
  }, [currentGraph, currentTestCasesForSave, reportAutomationGroupsChanged, selectedGroup, selectedTestCaseId]);

  const validateCurrentGroup = useCallback(async () => {
    if (!selectedGroup || !currentGraph) {
      return;
    }
    try {
      const result = await validateAutomationGraph(selectedGroup.id, currentGraph);
      setValidation(result);
      setStatus(result.valid ? (hasUnsavedChanges ? "Unsaved graph is valid." : "Graph is valid.") : "Graph has validation errors.");
    } catch (error) {
      setStatus(automationStatusFromError("Validate automation", error));
    }
  }, [currentGraph, hasUnsavedChanges, selectedGroup]);

  const testCurrentGroup = useCallback(async () => {
    if (!selectedGroup || !currentGraph) {
      return;
    }
    try {
      const runTestCases = currentTestCasesForSave();
      const testCase = selectedTestCaseFromList(runTestCases, selectedTestCaseId);
      const result = await startAutomationTestRun(selectedGroup.id, currentGraph, testCase?.payload, testCase?.id, testCase);
      setRuns(result.runs);
      setLastTestSample(result.sample);
      const assertionFailed = result.sample.assertions?.some((assertion) => !assertion.passed);
      setStatus(
        assertionFailed
          ? "Automation test assertions failed."
          : result.sample.status === "succeeded"
            ? (hasUnsavedChanges ? "Unsaved test run succeeded." : "Test run succeeded.")
            : "Test run finished."
      );
    } catch (error) {
      setStatus(automationStatusFromError("Run automation test", error));
    }
  }, [currentGraph, currentTestCasesForSave, hasUnsavedChanges, selectedGroup, selectedTestCaseId]);

  const cancelRun = useCallback(async (runId: string) => {
    try {
      const result = await cancelAutomationRun(runId);
      setRuns(result.runs);
      setStatus("Automation run cancelled.");
    } catch (error) {
      setStatus(automationStatusFromError("Cancel automation run", error));
    }
  }, []);

  const toggleGroup = useCallback(async (group: AutomationGroup) => {
    if (group.id === selectedGroupId && hasUnsavedChanges) {
      setStatus("Save changes before enabling or disabling this automation.");
      return;
    }
    try {
      const updated = await setAutomationGroupEnabled(group.id, !group.enabled);
      setGroups((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
      await reportAutomationGroupsChanged(updated.enabled ? "Automation enabled." : "Automation disabled.");
    } catch (error) {
      setStatus(automationStatusFromError("Update automation", error));
    }
  }, [hasUnsavedChanges, reportAutomationGroupsChanged, selectedGroupId]);

  const openSearchPalette = useCallback((value: string, input: HTMLInputElement) => {
    setSearch(value);
    if (palette?.compatibility) {
      return;
    }
    setPaletteSearch(value);
    if (!value.trim()) {
      setPalette(undefined);
      return;
    }
    setPalette(
      searchPaletteStateFromRects(
        input.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
        screenToFlowPosition,
        canvasRef.current?.getBoundingClientRect()
      )
    );
  }, [palette?.compatibility, screenToFlowPosition]);

  const addNode = useCallback((entry: AutomationNodeCatalogEntry) => {
    const position = palette ? { x: palette.flowX, y: palette.flowY } : { x: 180, y: 160 };
    if (palette?.compatibility) {
      const plan = connectionPlanForEntry(entry, palette.compatibility, catalog.nodes, edges);
      if (!plan) {
        setStatus("That node is not compatible with this connector.");
        return;
      }
      const created = connectedNodesForPlan(entry, plan, palette.compatibility, position);
      setNodes((current) => [...current, ...created.nodes]);
      setEdges((current) => [...created.edges.reduce((next, edge) => removeConnectionConflicts(edge, next), current), ...created.edges]);
      setSelectedNodeId(created.selectedNodeId);
      setPalette(undefined);
      setStatus(plan.converter ? `Node connected through ${plan.converter.title}.` : "Node connected.");
      return;
    }

    const id = createBrowserId("node");
    setNodes((current) => [...current, automationFlowNode(id, entry, position)]);
    setSelectedNodeId(id);
    setPalette(undefined);
  }, [catalog.nodes, edges, palette]);

  const deleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) {
      return;
    }
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(undefined);
  }, [selectedNodeId]);

  const deleteHandleConnection = useCallback((target: EventTarget | null): boolean => {
    const handle = automationHandleFromTarget(target);
    if (!handle) {
      return false;
    }
    const nextEdges = deleteEdgesForHandle(edges, handle);
    setEdges(nextEdges);
    setStatus(nextEdges.length === edges.length ? "No connection on this port." : "Connection removed.");
    return true;
  }, [edges]);

  const paletteCompatibility = palette?.compatibility;
  const paletteGroups = useMemo(() => groupedPaletteEntries(catalog.nodes, paletteSearch, paletteCompatibility, edges), [catalog.nodes, edges, paletteCompatibility, paletteSearch]);

  return (
    <div className="automation-panel" data-testid="automation-panel">
      <PluginPanelDock compactAt="medium" className="automation-panel-dock" items={[
        {
          id: "automations",
          label: "Automation groups",
          icon: <Zap size={15} />,
          children: (
            <aside className="automation-rail" aria-label="Automation groups">
              <div className="automation-rail-header">
                <span className="automation-rail-title">
                  <Zap size={16} />
                  <span>Automation</span>
                </span>
                <div className="automation-rail-actions">
                  <ControlButton className="icon-button" title="New automation" aria-label="New automation" onClick={openCreateGroupForm}>
                    <Plus size={14} />
                  </ControlButton>
                  <ControlButton className="icon-button automation-delete-group" tone="danger" title="Delete selected automation" aria-label="Delete selected automation" disabled={!selectedGroup} onClick={deleteCurrentGroup}>
                    <Trash2 size={14} />
                  </ControlButton>
                </div>
              </div>
              {createGroupOpen ? (
                <form className="automation-create-form" onSubmit={createAutomationGroup}>
                  <label>
                    <span>Name</span>
                    <input autoFocus value={createGroupName} onChange={(event) => setCreateGroupName(event.target.value)} aria-label="Automation name" />
                  </label>
                  <div className="automation-create-actions">
                    <ControlButton size="compact" onClick={() => setCreateGroupOpen(false)}>
                      Cancel
                    </ControlButton>
                    <ControlButton size="compact" tone="primary" type="submit">
                      Create
                    </ControlButton>
                  </div>
                </form>
              ) : null}
              <div className="automation-group-list">
                {groups.map((group) => (
                  <button key={group.id} className={`automation-group ${group.id === selectedGroupId ? "selected" : ""} ${group.id === selectedGroupId && hasUnsavedChanges ? "dirty" : ""}`} onClick={() => selectGroup(group)}>
                    <span>{group.name}</span>
                    <small>{group.id === selectedGroupId && hasUnsavedChanges ? "Unsaved changes" : group.enabled ? "Enabled" : "Disabled"}</small>
                  </button>
                ))}
              </div>
            </aside>
          )
        },
        {
          id: "inspector",
          label: "Automation inspector",
          icon: <ShieldAlert size={15} />,
          children: (
            <aside className="automation-inspector" aria-label="Automation inspector">
              <div className="automation-inspector-header">
                <span>Inspector</span>
                {selectedNodeId ? (
                  <ControlButton className="automation-delete-button" tone="danger" title="Delete selected node" aria-label="Delete selected node" onClick={deleteSelectedNode}>
                    <Trash2 size={15} />
                    <span>Delete Node</span>
                  </ControlButton>
                ) : null}
              </div>
              {selectedNode ? <NodeInspector node={selectedNode} connectedInputIds={selectedNodeConnectedInputIds} onChange={(config) => updateNodeConfig(selectedNode.id, config, setNodes)} /> : <p>Select a node to inspect configuration and ports.</p>}
              <div className="automation-validation">
                <strong>Validation</strong>
                {hasUnsavedChanges ? <small className="automation-unsaved-note">Current canvas has unsaved changes.</small> : null}
                {(validation?.diagnostics ?? []).length === 0 ? <p>No diagnostics.</p> : null}
                {(validation?.diagnostics ?? []).map((diagnostic) => (
                  <div key={`${diagnostic.code}:${diagnostic.nodeId ?? diagnostic.edgeId ?? diagnostic.message}`} className={`automation-diagnostic ${diagnostic.severity}`}>
                    <p>{diagnostic.message}</p>
                    {diagnostic.nodeId || diagnostic.edgeId ? (
                      <ControlButton size="compact" onClick={() => focusDiagnostic(diagnostic)}>
                        Focus
                      </ControlButton>
                    ) : null}
                  </div>
                ))}
              </div>
            </aside>
          )
        },
        {
          id: "runs",
          label: "Automation runs",
          icon: <Play size={15} />,
          children: (
            <section className="automation-run-drawer" aria-label="Automation run history">
              <div className="automation-run-header">
                <span>Runs</span>
                <small>{runs.length} recent</small>
              </div>
              <div className="automation-test-cases">
                <div className="automation-test-case-header">
                  <span>Test Cases</span>
                  <div>
                    <ControlButton size="compact" onClick={addTestCase} disabled={!selectedGroup}>
                      Add
                    </ControlButton>
                    <ControlButton size="compact" tone="danger" onClick={deleteSelectedTestCase} disabled={!selectedTestCase}>
                      Delete
                    </ControlButton>
                  </div>
                </div>
                <label>
                  <span>Case</span>
                  <select aria-label="Automation test case" value={selectedTestCase?.id ?? ""} disabled={testCases.length === 0} onChange={(event) => selectTestCase(event.target.value)}>
                    {testCases.length === 0 ? <option value="">Generated sample</option> : null}
                    {testCases.map((testCase) => (
                      <option key={testCase.id} value={testCase.id}>{testCase.name}</option>
                    ))}
                  </select>
                </label>
                {selectedTestCase ? (
                  <>
                    <label>
                      <span>Name</span>
                      <input aria-label="Test case name" value={selectedTestCase.name} onChange={(event) => updateSelectedTestCase((testCase) => ({ ...testCase, name: event.target.value }))} />
                    </label>
                    <label>
                      <span>Trigger Payload</span>
                      <textarea aria-label="Trigger fixture payload" rows={5} value={testCasePayloadDraft} onChange={(event) => updateSelectedTestCasePayloadDraft(event.target.value)} spellCheck={false} />
                    </label>
                    <label>
                      <span>Expected Status</span>
                      <select
                        aria-label="Expected run status"
                        value={selectedTestCase.expected?.status ?? ""}
                        onChange={(event) => updateSelectedTestCase((testCase) => automationTestCaseWithExpected(testCase, { status: (event.target.value || undefined) as AutomationRunStatus | undefined }))}
                      >
                        <option value="">Any</option>
                        {AUTOMATION_TEST_STATUS_OPTIONS.map((status) => (
                          <option key={status} value={status}>{status}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Expected Error Text</span>
                      <input
                        aria-label="Expected error text"
                        value={selectedTestCase.expected?.errorIncludes ?? ""}
                        onChange={(event) => updateSelectedTestCase((testCase) => automationTestCaseWithExpected(testCase, { errorIncludes: event.target.value }))}
                      />
                    </label>
                    <label>
                      <span>Expected Trace Text</span>
                      <textarea
                        aria-label="Expected trace text"
                        rows={3}
                        value={(selectedTestCase.expected?.traceIncludes ?? []).join("\n")}
                        onChange={(event) => updateSelectedTestCase((testCase) => automationTestCaseWithExpected(testCase, { traceIncludes: event.target.value.split("\n") }))}
                      />
                    </label>
                  </>
                ) : (
                  <p>Add a test case to persist a trigger fixture and expected run assertions.</p>
                )}
              </div>
              {runs.slice(0, 5).map((run) => (
                <div key={run.id} className={`automation-run ${run.status}`}>
                  {run.status === "running" ? <Play size={13} /> : run.status === "cancelled" ? <PauseCircle size={13} /> : <CheckCircle2 size={13} />}
                  <span>{run.status}</span>
                  <small>{run.trace.at(-1)?.message ?? run.error ?? run.startedAt}</small>
                  {run.status === "running" || run.status === "queued" ? (
                    <ControlButton className="icon-button automation-run-cancel" title="Cancel run" aria-label="Cancel run" onClick={() => cancelRun(run.id)}>
                      <X size={12} />
                    </ControlButton>
                  ) : null}
                </div>
              ))}
              {lastTestSample ? (
                <div className={`automation-test-sample ${lastTestSample.status}`}>
                  <div className="automation-test-sample-title">
                    <span>{lastTestSample.testCaseName ?? "Sample Run"}</span>
                    <small>{hasUnsavedChanges ? `${lastTestSample.triggerId} unsaved` : lastTestSample.triggerId}</small>
                  </div>
                  <pre>{JSON.stringify(lastTestSample.payload, null, 2)}</pre>
                  {lastTestSample.assertions?.length ? (
                    <div className="automation-test-assertions">
                      {lastTestSample.assertions.map((assertion) => (
                        <p key={assertion.id} className={assertion.passed ? "passed" : "failed"}>
                          {assertion.label}{assertion.message ? `: ${assertion.message}` : ""}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  <div className="automation-test-trace">
                    {lastTestSample.trace.slice(0, 6).map((entry) => (
                      <p key={entry.id} className={entry.level}>
                        {entry.message}
                      </p>
                    ))}
                    {lastTestSample.error ? <p className="error">{lastTestSample.error}</p> : null}
                  </div>
                </div>
              ) : null}
            </section>
          )
        }
      ]} />

      <section className="automation-workbench">
        <div className="automation-toolbar">
          <ControlButton className="icon-button" title={hasUnsavedChanges ? "Save automation changes" : "Automation is saved"} aria-label="Save automation" disabled={!selectedGroup} onClick={saveCurrentGroup}>
            <Save size={16} />
          </ControlButton>
          <ControlButton className="icon-button" title="Validate graph" aria-label="Validate graph" disabled={!selectedGroup} onClick={validateCurrentGroup}>
            <CheckCircle2 size={16} />
          </ControlButton>
          <ControlButton className="icon-button" title={hasUnsavedChanges ? "Run test on unsaved canvas" : "Run test on saved automation"} aria-label="Run test" disabled={!selectedGroup} onClick={testCurrentGroup}>
            <FlaskConical size={16} />
          </ControlButton>
          {selectedGroup ? (
            <ControlButton className="icon-button" title={hasUnsavedChanges ? "Save changes before changing enabled state" : selectedGroup.enabled ? "Disable automation" : "Enable automation"} aria-label={selectedGroup.enabled ? "Disable automation" : "Enable automation"} onClick={() => toggleGroup(selectedGroup)}>
              {selectedGroup.enabled ? <ToggleRight size={17} /> : <ToggleLeft size={17} />}
            </ControlButton>
          ) : null}
          <ControlButton
            className={`icon-button automation-safety-toggle ${externalSafetyAllowed ? "active" : ""}`}
            title={externalSafetyCopy.title}
            aria-label={externalSafetyCopy.actionLabel}
            aria-describedby={externalSafetyDescriptionId}
            aria-pressed={externalSafetyAllowed}
            disabled={!selectedGroup}
            onFocus={() => setTransientStatus(externalSafetyCopy.status)}
            onBlur={() => setTransientStatus(undefined)}
            onMouseEnter={() => setTransientStatus(externalSafetyCopy.status)}
            onMouseLeave={() => setTransientStatus(undefined)}
            onClick={() => updateSafetyPolicy("external", !externalSafetyAllowed)}
          >
            <ShieldAlert size={16} />
          </ControlButton>
          <ControlButton
            className={`icon-button automation-safety-toggle destructive ${destructiveSafetyAllowed ? "active" : ""}`}
            title={destructiveSafetyCopy.title}
            aria-label={destructiveSafetyCopy.actionLabel}
            aria-describedby={destructiveSafetyDescriptionId}
            aria-pressed={destructiveSafetyAllowed}
            disabled={!selectedGroup}
            onFocus={() => setTransientStatus(destructiveSafetyCopy.status)}
            onBlur={() => setTransientStatus(undefined)}
            onMouseEnter={() => setTransientStatus(destructiveSafetyCopy.status)}
            onMouseLeave={() => setTransientStatus(undefined)}
            onClick={() => updateSafetyPolicy("destructive", !destructiveSafetyAllowed)}
          >
            <Trash2 size={16} />
          </ControlButton>
          <span id={externalSafetyDescriptionId} className="visually-hidden">
            {externalSafetyCopy.description}
          </span>
          <span id={destructiveSafetyDescriptionId} className="visually-hidden">
            {destructiveSafetyCopy.description}
          </span>
          {selectedGroup ? <span className={`automation-save-state ${hasUnsavedChanges ? "dirty" : "saved"}`}>{hasUnsavedChanges ? "Unsaved" : "Saved"}</span> : null}
          <div className="automation-search">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => openSearchPalette(event.currentTarget.value, event.currentTarget)}
              onFocus={(event) => {
                if (search.trim()) {
                  openSearchPalette(search, event.currentTarget);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !palette?.compatibility) {
                  setPalette(undefined);
                }
              }}
              placeholder="Search nodes"
              aria-label="Search automation nodes"
              aria-expanded={Boolean(palette && !palette.compatibility)}
            />
          </div>
          <span className="automation-status" role="status">
            {transientStatus ?? status}
          </span>
        </div>

        <div
          ref={canvasRef}
          className="automation-canvas"
          onContextMenu={(event) => {
            if (palette?.compatibility) {
              event.preventDefault();
              event.stopPropagation();
              setPalette(undefined);
              setStatus("Connector cancelled.");
              return;
            }
            if (deleteHandleConnection(event.target)) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            setPaletteSearch(search);
            openPalette(event, setPalette, screenToFlowPosition);
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={renderedEdges}
            nodeTypes={automationNodeTypes}
            edgeTypes={automationEdgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onReconnectStart={onReconnectStart}
            onReconnectEnd={onReconnectEnd}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => {
              if (suppressNextPaneClickRef.current) {
                suppressNextPaneClickRef.current = false;
                return;
              }
              setPalette(undefined);
            }}
            connectionRadius={22}
            reconnectRadius={16}
            fitView
            minZoom={0.25}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable {...automationMiniMapTheme} />
          </ReactFlow>
          {palette ? (
            <div ref={paletteRef} className="automation-palette" style={{ left: palette.x, top: palette.y }} role="dialog" aria-label="Add automation node">
              <div className="automation-palette-title">{palette.compatibility ? "Compatible Nodes" : "Add Node"}</div>
              <label className="automation-palette-search">
                <Search size={13} />
                <input
                  autoFocus
                  value={paletteSearch}
                  onChange={(event) => {
                    setPaletteSearch(event.target.value);
                    if (!palette.compatibility) {
                      setSearch(event.target.value);
                    }
                  }}
                  placeholder="Search nodes"
                  aria-label="Search node palette"
                />
              </label>
              <div className="automation-palette-groups">
                {paletteGroups.map((group) => (
                  <section key={group.id} className="automation-palette-group">
                    <div className="automation-palette-group-title">
                      <span>{group.title}</span>
                      <small>{group.entries.length}</small>
                    </div>
                    {group.entries.map((entry) => {
                      const plan = palette.compatibility ? connectionPlanForEntry(entry, palette.compatibility, catalog.nodes, edges) : undefined;
                      const safety = automationPaletteEntrySafety(entry);
                      return (
                        <button key={entry.typeId} className={automationPaletteEntryClassName(safety)} onClick={() => addNode(entry)}>
                          <span>{entry.title}</span>
                          <small>{automationPaletteEntryMetaText(entry, plan)}</small>
                        </button>
                      );
                    })}
                  </section>
                ))}
                {paletteGroups.length === 0 ? <p className="automation-palette-empty">No matching nodes.</p> : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>

    </div>
  );
}

const AUTOMATION_SAFETY_ORDER: AutomationSafety[] = ["read", "write", "external", "destructive"];

export function automationStatusFromError(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${message}`;
}

export function automationSafetyEnabled(allowedSafety: AutomationSafety[] | undefined, safety: AutomationSafety): boolean {
  return (allowedSafety ?? DEFAULT_AUTOMATION_ALLOWED_SAFETY).includes(safety);
}

export function automationAllowedSafetyWithToggle(allowedSafety: AutomationSafety[] | undefined, safety: AutomationSafety, enabled: boolean): AutomationSafety[] | undefined {
  const next = new Set(allowedSafety ?? DEFAULT_AUTOMATION_ALLOWED_SAFETY);
  if (enabled) {
    next.add(safety);
  } else {
    next.delete(safety);
  }
  const ordered = AUTOMATION_SAFETY_ORDER.filter((candidate) => next.has(candidate));
  return automationSafetyMatchesDefault(ordered) ? undefined : ordered;
}

export function automationSafetyToggleCopy(safety: AutomationSafetyToggle, allowed: boolean): AutomationSafetyToggleCopy {
  const actionLabel = `${allowed ? "Disallow" : "Allow"} ${safety} automation hooks`;
  const description = AUTOMATION_SAFETY_EXPLANATIONS[safety];
  const state = allowed ? "allowed" : "blocked";
  return {
    actionLabel,
    confirmation: `${automationSafetyLabel(safety)} automation hooks are ${state}.`,
    description,
    status: `${automationSafetyLabel(safety)} automation hooks are ${state} in this graph. ${description}`,
    title: `${actionLabel}. ${description}`
  };
}

export function automationPaletteEntryMetaText(entry: AutomationNodeCatalogEntry, plan?: PaletteConnectionPlan): string {
  return [plan?.converter ? `${entry.kind} via ${plan.converter.title}` : entry.kind, automationPaletteEntrySafetyLabel(entry)].filter(Boolean).join(" - ");
}

function automationPaletteEntrySafety(entry: AutomationNodeCatalogEntry): AutomationSafetyToggle | undefined {
  return entry.safety === "external" || entry.safety === "destructive" ? entry.safety : undefined;
}

function automationPaletteEntrySafetyLabel(entry: AutomationNodeCatalogEntry): string | undefined {
  const safety = automationPaletteEntrySafety(entry);
  return safety ? `${automationSafetyLabel(safety)} hook` : undefined;
}

function automationPaletteEntryClassName(safety: AutomationSafetyToggle | undefined): string {
  return ["automation-palette-entry", safety ? `automation-palette-entry-${safety}` : ""].filter(Boolean).join(" ");
}

export function automationGraphFromPanelState(nodes: FlowNode[], edges: FlowEdge[], baseGraph: AutomationGroup["graph"], allowedSafety: AutomationSafety[] | undefined): AutomationGroup["graph"] {
  const graph = graphFromFlow(nodes, edges, baseGraph);
  if (allowedSafety !== undefined) {
    return { ...graph, allowedSafety: [...allowedSafety] };
  }
  const { allowedSafety: _staleAllowedSafety, ...graphWithDefaultSafety } = graph;
  return graphWithDefaultSafety;
}

export function selectedAutomationGroupAfterDelete<T extends Pick<AutomationGroup, "id">>(previousGroups: T[], nextGroups: T[], deletedGroupId: string, selectedGroupId: string): T | undefined {
  if (selectedGroupId !== deletedGroupId) {
    return nextGroups.find((group) => group.id === selectedGroupId);
  }
  const deletedIndex = previousGroups.findIndex((group) => group.id === deletedGroupId);
  return deletedIndex === -1 ? undefined : nextGroups[Math.min(deletedIndex, nextGroups.length - 1)];
}

function automationSafetyMatchesDefault(allowedSafety: AutomationSafety[]): boolean {
  return AUTOMATION_SAFETY_ORDER.every((safety) => allowedSafety.includes(safety) === DEFAULT_AUTOMATION_ALLOWED_SAFETY.includes(safety));
}

function automationSafetyLabel(safety: AutomationSafety): string {
  return safety.slice(0, 1).toUpperCase() + safety.slice(1);
}

function AutomationNodeView({ data, selected }: NodeProps<FlowNode>) {
  const entry = data.entry;
  const primitiveSummary = primitiveConfigSummary(entry, data.config ?? {});
  const inputPorts = visiblePorts(entry.inputs);
  const outputPorts = visiblePorts(entry.outputs);
  return (
    <div className={`automation-node ${entry.kind} ${selected ? "selected" : ""}`}>
      <div className="automation-node-title">
        <span>{entry.title}</span>
        <small>{entry.kind}</small>
        {primitiveSummary ? (
          <em className="automation-node-summary" title={primitiveSummary}>
            {primitiveSummary}
          </em>
        ) : null}
      </div>
      <div className="automation-node-ports">
        <div>
          {inputPorts.map((port, index) => (
            <PortRow key={port.id} port={port} index={index} total={inputPorts.length} />
          ))}
        </div>
        <div>
          {outputPorts.map((port, index) => (
            <PortRow key={port.id} port={port} index={index} total={outputPorts.length} />
          ))}
        </div>
      </div>
    </div>
  );
}

type EdgeRouteDragAxis = "x" | "y" | "xy";

function AutomationRoutableEdge({ id, sourceX, sourceY, targetX, targetY, markerStart, markerEnd, interactionWidth, style, selected, animated, data }: EdgeProps<FlowEdge>) {
  const { screenToFlowPosition } = useReactFlow<FlowNode, FlowEdge>();
  const route = edgeRouteFromData(data);
  const { path, control } = routedEdgePath(sourceX, sourceY, targetX, targetY, route);
  const kind = data?.kind ?? "data";

  const startDrag = (event: ReactPointerEvent<SVGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const start = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const initial = edgeRouteFromData(data) ?? {};
    const onMove = (moveEvent: PointerEvent) => {
      const current = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
      const offsetX = clampRouteOffset((initial.offsetX ?? 0) + current.x - start.x);
      data?.onRouteChange?.(id, {
        offsetX
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth ?? 24}
        className={`automation-routed-edge ${kind} ${animated ? "animated" : ""}`}
        style={style}
      />
      <path className="automation-edge-route-drag-path" d={path} onPointerDown={startDrag} />
      <EdgeRouteHandle
        edgeId={id}
        handleId="bend"
        point={control}
        axis="x"
        kind={kind}
        selected={selected}
        onPointerDown={startDrag}
      />
    </>
  );
}

function EdgeRouteHandle({
  edgeId,
  handleId,
  point,
  axis,
  kind,
  selected,
  onPointerDown
}: {
  edgeId: string;
  handleId: string;
  point: XYPosition;
  axis: EdgeRouteDragAxis;
  kind: AutomationPortKind;
  selected?: boolean;
  onPointerDown: (event: ReactPointerEvent<SVGElement>) => void;
}) {
  return (
    <rect
      className={`automation-edge-route-handle ${kind} ${axis}-axis ${selected ? "selected" : ""}`}
      data-testid={handleId === "bend" ? `automation-edge-route-${edgeId}` : `automation-edge-route-${edgeId}-${handleId}`}
      x={point.x - 4.5}
      y={point.y - 4.5}
      width={9}
      height={9}
      rx={1.5}
      onPointerDown={onPointerDown}
    >
      <title>{axis === "x" ? "Move connector break horizontally" : axis === "y" ? "Move connector break vertically" : "Move connector route"}</title>
    </rect>
  );
}

function PortRow({ port, index, total }: { port: AutomationPortDescriptor; index: number; total: number }) {
  const isInput = port.direction === "input";
  const top = `${((index + 1) / (total + 1)) * 100}%`;
  const tooltipId = useId();
  const tooltip = portTooltipText(port);
  const [tooltipPlacement, setTooltipPlacement] = useState<PortTooltipPlacement | undefined>();

  useEffect(() => {
    if (!tooltipPlacement) {
      return;
    }
    const close = () => setTooltipPlacement(undefined);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [tooltipPlacement]);

  const showTooltip = (target: HTMLElement) => {
    setTooltipPlacement(portTooltipPlacementFromRect(target.getBoundingClientRect(), port.direction));
  };

  const handlePointerEnter = (event: ReactPointerEvent<HTMLElement>) => showTooltip(event.currentTarget);
  const handleFocus = (event: ReactFocusEvent<HTMLElement>) => showTooltip(event.currentTarget);

  return (
    <div className={`automation-port ${port.kind} ${isInput ? "input" : "output"}`}>
      <Handle
        id={`${port.kind}:${isInput ? "in" : "out"}:${port.id}`}
        type={isInput ? "target" : "source"}
        position={isInput ? Position.Left : Position.Right}
        style={{ top }}
      />
      <span
        className="automation-port-label"
        tabIndex={0}
        aria-describedby={tooltipPlacement ? tooltipId : undefined}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={() => setTooltipPlacement(undefined)}
        onFocus={handleFocus}
        onBlur={() => setTooltipPlacement(undefined)}
      >
        {port.label}
      </span>
      {tooltipPlacement
        ? createPortal(
            <span
              id={tooltipId}
              className="automation-port-tooltip"
              role="tooltip"
              style={{
                left: tooltipPlacement.left,
                top: tooltipPlacement.top,
                width: tooltipPlacement.width,
                maxHeight: tooltipPlacement.maxHeight
              }}
            >
              {tooltip}
            </span>,
            document.body
          )
        : null}
    </div>
  );
}

function NodeInspector({ node, connectedInputIds, onChange }: { node: FlowNode; connectedInputIds: Set<string>; onChange: (config: Record<string, unknown>) => void }) {
  const config = node.data.config ?? {};
  const isFString = node.data.entry.typeId === AUTOMATION_FSTRING_TYPE_ID;
  const rows = configEntries(node.data.entry, config).filter((row) => !isFString || (row.key !== "template" && row.key !== "inputNames"));
  return (
    <div className="automation-node-inspector">
      <strong>{node.data.entry.title}</strong>
      <small>{node.data.entry.typeId}</small>
      {isFString ? <FStringInspectorControls config={config} onChange={onChange} /> : null}
      {rows.map((row) => (
        <label key={row.key} className={connectedInputIds.has(row.key) ? "connected" : undefined}>
          <span title={row.port ? portTooltipText(row.port) : undefined}>{row.port?.label ?? row.key}</span>
          {row.port?.codeEditor ? (
            <CodeConfigEditor
              disabled={connectedInputIds.has(row.key)}
              label={row.port.label}
              port={row.port}
              value={String(row.value ?? "")}
              onChange={(value) => onChange({ ...config, [row.key]: value })}
            />
          ) : row.port?.options?.values.length ? (
            <select disabled={connectedInputIds.has(row.key)} value={String(row.value ?? "")} onChange={(event) => onChange({ ...config, [row.key]: coerceConfigValue(row.value, event.target.value, row.port) })}>
              {!row.port.required ? <option value="">Unset</option> : null}
              {row.port.options.values.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : row.port?.type.kind === "boolean" || typeof row.value === "boolean" ? (
            <select disabled={connectedInputIds.has(row.key)} value={String(row.value === true)} onChange={(event) => onChange({ ...config, [row.key]: event.target.value === "true" })}>
              <option value="false">False</option>
              <option value="true">True</option>
            </select>
          ) : (
            <input disabled={connectedInputIds.has(row.key)} value={String(row.value ?? "")} onChange={(event) => onChange({ ...config, [row.key]: coerceConfigValue(row.value, event.target.value, row.port) })} />
          )}
          {connectedInputIds.has(row.key) ? <small className="automation-config-help connected">Connected input. Disconnect it to edit the default value.</small> : row.port?.description ? <small className="automation-config-help">{row.port.description}</small> : null}
        </label>
      ))}
    </div>
  );
}

function CodeConfigEditor({ disabled, label, port, value, onChange }: { disabled: boolean; label: string; port: AutomationPortDescriptor; value: string; onChange: (value: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  const extensions = useMemo(() => codeEditorExtensions(port, label, disabled, onChangeRef), [disabled, label, port]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const view = new EditorView({
      doc: value,
      extensions,
      parent: container
    });
    viewRef.current = view;
    return () => {
      viewRef.current = undefined;
      view.destroy();
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === view.state.doc.toString()) {
      return;
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={containerRef} className="automation-code-editor" style={{ minHeight: port.codeEditor?.minHeight ?? 180 }} />;
}

function codeEditorExtensions(port: AutomationPortDescriptor, label: string, disabled: boolean, onChangeRef: { current: (value: string) => void }): Extension[] {
  const codeEditor = port.codeEditor;
  const completions = codeEditor?.completions?.map<Completion>((completion) => ({
    label: completion.label,
    type: completion.type,
    detail: completion.detail,
    info: completion.info,
    apply: completion.apply
  })) ?? [];
  return [
    basicSetup,
    EditorView.lineWrapping,
    EditorView.editable.of(!disabled),
    EditorState.readOnly.of(disabled),
    EditorView.contentAttributes.of({ "aria-label": label }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    }),
    ...automationCodeLanguageExtensions(codeEditor?.language, completions)
  ];
}

export function automationCodeLanguageExtensions(language: string | undefined, completions: Completion[]): Extension[] {
  const completionSource = completions.length ? completeFromList(completions) : undefined;
  if (language === "python") {
    return [
      python(),
      ...(completionSource ? [pythonLanguage.data.of({ autocomplete: completionSource })] : [])
    ];
  }
  if (language === "bash") {
    const bashLanguage = StreamLanguage.define(shell);
    return [
      bashLanguage,
      ...(completionSource ? [bashLanguage.data.of({ autocomplete: completionSource })] : [])
    ];
  }
  return [];
}

function FStringInspectorControls({ config, onChange }: { config: Record<string, unknown>; onChange: (config: Record<string, unknown>) => void }) {
  const inputNames = automationFStringInputNames(config);
  return (
    <div className="automation-fstring-config">
      <label>
        <span>Template</span>
        <textarea
          value={typeof config.template === "string" ? config.template : "Hello {value}"}
          onChange={(event) => onChange({ ...config, template: event.target.value })}
          rows={3}
        />
        <small className="automation-config-help">Use Python-style fields such as {"{name}"}. Use {"{{"} and {"}}"} for literal braces.</small>
      </label>
      <div className="automation-dynamic-inputs">
        <div className="automation-dynamic-inputs-title">
          <span>Inputs</span>
          <ControlButton className="icon-button" title="Add f-string input" aria-label="Add f-string input" onClick={() => onChange(addFStringInputName(config))}>
            <Plus size={14} />
          </ControlButton>
        </div>
        {inputNames.map((name, index) => (
          <div key={`${name}:${index}`} className="automation-dynamic-input-row">
            <input aria-label={`F-string input ${index + 1}`} value={name} onChange={(event) => onChange(renameFStringInputName(config, index, event.target.value))} />
            <ControlButton className="icon-button" tone="danger" title={`Remove ${name}`} aria-label={`Remove ${name}`} onClick={() => onChange(removeFStringInputName(config, index))}>
              <X size={14} />
            </ControlButton>
          </div>
        ))}
      </div>
    </div>
  );
}

export function normalizedAutomationGroupName(value: string): string | undefined {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || undefined;
}

export function nextAutomationGroupName(groups: Pick<AutomationGroup, "name">[]): string {
  const base = "New automation";
  const existing = new Set(groups.map((group) => group.name.trim().toLowerCase()).filter(Boolean));
  if (!existing.has(base.toLowerCase())) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

export function newAutomationGroup(name: string, id: string, now: string): AutomationGroup {
  return {
    id,
    name,
    enabled: false,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      variables: []
    }
  };
}

export function newAutomationTestCase(id: string, index: number): AutomationTestCase {
  return {
    id,
    name: `Test case ${index}`,
    payload: {},
    expected: { status: "succeeded" }
  };
}

export function selectedTestCaseFromList(testCases: AutomationTestCase[], selectedTestCaseId: string | undefined): AutomationTestCase | undefined {
  return testCases.find((testCase) => testCase.id === selectedTestCaseId) ?? testCases[0];
}

export function automationTestCasePayloadText(testCase: AutomationTestCase | undefined): string {
  return testCase ? JSON.stringify(testCase.payload, null, 2) : "";
}

export function parseAutomationTestCasePayload(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}") as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Trigger fixture payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function automationTestCasesWithPayloadDraft(testCases: AutomationTestCase[], selectedTestCaseId: string, payloadDraft: string): AutomationTestCase[] {
  const selected = selectedTestCaseFromList(testCases, selectedTestCaseId);
  if (!selected) {
    return testCases;
  }
  const payload = parseAutomationTestCasePayload(payloadDraft);
  return testCases.map((testCase) => (testCase.id === selected.id ? { ...testCase, payload } : testCase));
}

export function automationTestCaseWithExpected(testCase: AutomationTestCase, patch: NonNullable<AutomationTestCase["expected"]>): AutomationTestCase {
  const expected = {
    ...testCase.expected,
    ...patch,
    errorIncludes: patch.errorIncludes === undefined ? testCase.expected?.errorIncludes : patch.errorIncludes.trim(),
    traceIncludes: patch.traceIncludes === undefined ? testCase.expected?.traceIncludes : patch.traceIncludes.map((entry) => entry.trim()).filter(Boolean)
  };
  const compactExpected = Object.fromEntries(Object.entries(expected).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0) && value !== ""));
  return {
    ...testCase,
    expected: Object.keys(compactExpected).length > 0 ? compactExpected as AutomationTestCase["expected"] : undefined
  };
}

export function automationTestCasesEqual(left: AutomationTestCase[], right: AutomationTestCase[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clampRouteOffset(value: number): number {
  return Math.max(-1200, Math.min(1200, Math.round(value)));
}

export function shouldClosePaletteForPointer(button: number, target: EventTarget | null, paletteElement: HTMLElement | null): boolean {
  if (button !== 0) {
    return false;
  }
  if (!target || !paletteElement) {
    return true;
  }
  if (typeof Node !== "undefined" && target instanceof Node) {
    return !paletteElement.contains(target);
  }
  return true;
}

export function connectionPlanForEntry(
  entry: AutomationNodeCatalogEntry,
  compatibility: PaletteCompatibility,
  catalogEntries: AutomationNodeCatalogEntry[],
  _edges: ConnectionLike[] = []
): PaletteConnectionPlan | undefined {
  if (compatibility.handleType === "source") {
    const input = entry.inputs.find((port) => compatibleInputPort(compatibility, port));
    if (input) {
      return { direction: "from-origin", entryPortId: input.id, entryPortKind: input.kind };
    }

    const converter = findConverterFromSource(compatibility, entry, catalogEntries);
    if (converter) {
      return {
        direction: "from-origin",
        entryPortId: converter.targetInput.id,
        entryPortKind: converter.targetInput.kind,
        converter: converter.entry,
        converterInputPortId: converter.input.id,
        converterOutputPortId: converter.output.id
      };
    }
    return undefined;
  }

  const output = entry.outputs.find((port) => compatibleOutputPort(port, compatibility));
  if (output) {
    return { direction: "to-origin", entryPortId: output.id, entryPortKind: output.kind };
  }

  const converter = findConverterToTarget(entry, compatibility, catalogEntries);
  if (converter) {
    return {
      direction: "to-origin",
      entryPortId: converter.sourceOutput.id,
      entryPortKind: converter.sourceOutput.kind,
      converter: converter.entry,
      converterInputPortId: converter.input.id,
      converterOutputPortId: converter.output.id
    };
  }
  return undefined;
}

export function groupedPaletteEntries(entries: AutomationNodeCatalogEntry[], search: string, compatibility?: PaletteCompatibility, edges: ConnectionLike[] = []): AutomationPaletteGroup[] {
  const query = search.trim().toLowerCase();
  const groups = new Map<string, AutomationPaletteGroup>();

  for (const entry of entries) {
    if (compatibility && !connectionPlanForEntry(entry, compatibility, entries, edges)) {
      continue;
    }
    const group = paletteGroupForEntry(entry);
    if (query && !paletteEntrySearchText(entry, group.title).includes(query)) {
      continue;
    }
    const existing = groups.get(group.id) ?? { ...group, entries: [] };
    existing.entries.push(entry);
    groups.set(group.id, existing);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      entries: [...group.entries].sort((left, right) => left.title.localeCompare(right.title))
    }))
    .sort(comparePaletteGroups);
}

function compatibleInputPort(source: PaletteCompatibility, targetPort: AutomationPortDescriptor): boolean {
  return portIsConnectable(targetPort) && targetPort.direction === "input" && source.kind === targetPort.kind && (targetPort.kind === "exec" || automationTypeAssignable(source.type, targetPort.type));
}

function compatibleOutputPort(sourcePort: AutomationPortDescriptor, target: PaletteCompatibility): boolean {
  return portIsConnectable(sourcePort) && sourcePort.direction === "output" && sourcePort.kind === target.kind && (sourcePort.kind === "exec" || automationTypeAssignable(sourcePort.type, target.type));
}

function findConverterFromSource(
  source: PaletteCompatibility,
  targetEntry: AutomationNodeCatalogEntry,
  catalogEntries: AutomationNodeCatalogEntry[]
): { entry: AutomationNodeCatalogEntry; input: AutomationPortDescriptor; output: AutomationPortDescriptor; targetInput: AutomationPortDescriptor } | undefined {
  if (source.kind !== "data") {
    return undefined;
  }
  for (const targetInput of targetEntry.inputs.filter((port) => port.kind === "data" && portIsConnectable(port))) {
    for (const converter of catalogEntries.filter((candidate) => candidate.kind === "converter")) {
      const input = converter.inputs.find((port) => compatibleInputPort(source, port));
      const output = converter.outputs.find((port) => port.kind === "data" && port.direction === "output" && automationTypeAssignable(port.type, targetInput.type));
      if (input && output) {
        return { entry: converter, input, output, targetInput };
      }
    }
  }
  return undefined;
}

function findConverterToTarget(
  sourceEntry: AutomationNodeCatalogEntry,
  target: PaletteCompatibility,
  catalogEntries: AutomationNodeCatalogEntry[]
): { entry: AutomationNodeCatalogEntry; input: AutomationPortDescriptor; output: AutomationPortDescriptor; sourceOutput: AutomationPortDescriptor } | undefined {
  if (target.kind !== "data") {
    return undefined;
  }
  for (const sourceOutput of sourceEntry.outputs.filter((port) => port.kind === "data" && portIsConnectable(port))) {
    for (const converter of catalogEntries.filter((candidate) => candidate.kind === "converter")) {
      const input = converter.inputs.find((port) => port.kind === "data" && port.direction === "input" && automationTypeAssignable(sourceOutput.type, port.type));
      const output = converter.outputs.find((port) => compatibleOutputPort(port, target));
      if (input && output) {
        return { entry: converter, input, output, sourceOutput };
      }
    }
  }
  return undefined;
}

export function paletteGroupForEntry(entry: AutomationNodeCatalogEntry): Pick<AutomationPaletteGroup, "id" | "title"> {
  if (entry.pluginId) {
    return { id: `plugin:${entry.pluginId}`, title: `Plugin: ${entry.pluginId}` };
  }
  if (entry.kind === "primitive") {
    return { id: "primitive", title: "Primitives" };
  }
  if (entry.kind === "converter") {
    return { id: "converter", title: "Converters" };
  }
  return { id: "core", title: "CloudX Core" };
}

function comparePaletteGroups(left: AutomationPaletteGroup, right: AutomationPaletteGroup): number {
  const leftRank = paletteGroupRank(left.id);
  const rightRank = paletteGroupRank(right.id);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.title.localeCompare(right.title);
}

function paletteGroupRank(id: string): number {
  if (id.startsWith("plugin:")) {
    return 0;
  }
  if (id === "core") {
    return 1;
  }
  if (id === "primitive") {
    return 2;
  }
  return 3;
}

function paletteEntrySearchText(entry: AutomationNodeCatalogEntry, groupTitle: string): string {
  return [entry.title, entry.description, entry.typeId, entry.kind, entry.pluginId, entry.hookId, entry.triggerId, groupTitle].filter(Boolean).join(" ").toLowerCase();
}

function updateNodeConfig(nodeId: string, config: Record<string, unknown>, setNodes: (update: (nodes: FlowNode[]) => FlowNode[]) => void): void {
  setNodes((current) =>
    current.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            data: {
              ...node.data,
              config,
              entry: automationEntryWithDynamicPorts(node.data.entry, config)
            }
          }
        : node
    )
  );
}

function automationHandleFromTarget(target: EventTarget | null): AutomationHandleRef | undefined {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return undefined;
  }
  const handle = target.closest<HTMLElement>(".react-flow__handle");
  const nodeId = handle?.dataset.nodeid;
  const handleId = handle?.dataset.handleid;
  return nodeId && handleId ? { nodeId, handleId } : undefined;
}

function flowEdgeFromConnection(connection: Connection): FlowEdge {
  return normalizeFlowEdge({
    ...connection,
    id: createBrowserId("edge"),
    type: "automation",
    data: flowEdgeData(handleKind(connection.sourceHandle))
  });
}

function normalizeFlowEdge(edge: FlowEdge): FlowEdge {
  const kind = handleKind(edge.sourceHandle);
  return {
    ...edge,
    type: "automation",
    reconnectable: true,
    animated: kind === "exec",
    data: flowEdgeData(kind, edgeRouteFromData(edge.data))
  };
}

function flowEdgeFromEndpoints(source: string, sourceHandle: string, target: string, targetHandle: string): FlowEdge {
  return normalizeFlowEdge({
    id: createBrowserId("edge"),
    source,
    sourceHandle,
    target,
    targetHandle,
    type: "automation",
    data: flowEdgeData(handleKind(sourceHandle))
  });
}

function automationFlowNode(id: string, entry: AutomationNodeCatalogEntry, position: XYPosition): FlowNode {
  const config = defaultConfigForEntry(entry);
  return {
    id,
    type: "automation",
    position,
    data: { entry: automationEntryWithDynamicPorts(entry, config), config }
  };
}

function connectedNodesForPlan(
  entry: AutomationNodeCatalogEntry,
  plan: PaletteConnectionPlan,
  compatibility: PaletteCompatibility,
  position: XYPosition
): { nodes: FlowNode[]; edges: FlowEdge[]; selectedNodeId: string } {
  const mainId = createBrowserId("node");
  const mainNode = automationFlowNode(mainId, entry, position);
  const entryHandle = handleForPort(plan.entryPortKind, plan.direction === "from-origin" ? "in" : "out", plan.entryPortId);

  if (!plan.converter) {
    const edge =
      plan.direction === "from-origin"
        ? flowEdgeFromEndpoints(compatibility.nodeId, compatibility.handleId, mainId, entryHandle)
        : flowEdgeFromEndpoints(mainId, entryHandle, compatibility.nodeId, compatibility.handleId);
    return { nodes: [mainNode], edges: [edge], selectedNodeId: mainId };
  }

  const converterId = createBrowserId("node");
  const converterPosition =
    plan.direction === "from-origin"
      ? { x: position.x - CONNECTED_NODE_SPACING, y: position.y }
      : { x: position.x + CONNECTED_NODE_SPACING, y: position.y };
  const converterNode = automationFlowNode(converterId, plan.converter, converterPosition);
  const converterInputHandle = handleForPort(plan.entryPortKind, "in", plan.converterInputPortId ?? "");
  const converterOutputHandle = handleForPort(plan.entryPortKind, "out", plan.converterOutputPortId ?? "");

  if (plan.direction === "from-origin") {
    return {
      nodes: [converterNode, mainNode],
      edges: [
        flowEdgeFromEndpoints(compatibility.nodeId, compatibility.handleId, converterId, converterInputHandle),
        flowEdgeFromEndpoints(converterId, converterOutputHandle, mainId, entryHandle)
      ],
      selectedNodeId: mainId
    };
  }

  return {
    nodes: [mainNode, converterNode],
    edges: [
      flowEdgeFromEndpoints(mainId, entryHandle, converterId, converterInputHandle),
      flowEdgeFromEndpoints(converterId, converterOutputHandle, compatibility.nodeId, compatibility.handleId)
    ],
    selectedNodeId: mainId
  };
}

export function compatibilityFromConnectionState(connectionState: FinalConnectionState, nodes: FlowNode[], catalogByType: Map<string, AutomationNodeCatalogEntry>): PaletteCompatibility | undefined {
  const fromHandle = connectionState.fromHandle;
  if (!fromHandle?.id) {
    return undefined;
  }
  const node = nodes.find((candidate) => candidate.id === fromHandle.nodeId);
  const entry = node ? node.data.entry : undefined;
  if (!entry) {
    return undefined;
  }
  const portKind = handleKind(fromHandle.id);
  const portId = handlePort(fromHandle.id);
  const port =
    fromHandle.type === "source"
      ? entry.outputs.find((candidate) => candidate.kind === portKind && candidate.id === portId)
      : entry.inputs.find((candidate) => candidate.kind === portKind && candidate.id === portId);
  if (!port || !portIsConnectable(port)) {
    return undefined;
  }
  return {
    nodeId: fromHandle.nodeId,
    handleId: fromHandle.id,
    handleType: fromHandle.type,
    kind: port.kind,
    type: port.type
  };
}

function clientPointFromEvent(event: MouseEvent | TouchEvent): XYPosition | undefined {
  if ("changedTouches" in event) {
    const touch = event.changedTouches.item(0);
    return touch ? { x: touch.clientX, y: touch.clientY } : undefined;
  }
  return { x: event.clientX, y: event.clientY };
}

type ScreenToFlowPosition = (clientPosition: XYPosition) => XYPosition;

interface PaletteAnchorRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export function palettePositionFromPoint(clientX: number, clientY: number, viewportWidth: number, viewportHeight: number): Pick<PaletteState, "x" | "y"> {
  const width = Math.min(PALETTE_MAX_WIDTH, Math.max(0, viewportWidth - PALETTE_VIEWPORT_MARGIN * 2));
  const height = Math.min(PALETTE_MAX_HEIGHT, Math.max(0, viewportHeight - PALETTE_VIEWPORT_MARGIN * 2));
  const maxX = Math.max(PALETTE_VIEWPORT_MARGIN, viewportWidth - width - PALETTE_VIEWPORT_MARGIN);
  const maxY = Math.max(PALETTE_VIEWPORT_MARGIN, viewportHeight - height - PALETTE_VIEWPORT_MARGIN);
  return {
    x: Math.min(Math.max(clientX, PALETTE_VIEWPORT_MARGIN), maxX),
    y: Math.min(Math.max(clientY, PALETTE_VIEWPORT_MARGIN), maxY)
  };
}

export function paletteStateFromPoint(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
  screenToFlowPosition: ScreenToFlowPosition,
  compatibility?: PaletteCompatibility
): PaletteState {
  const screen = palettePositionFromPoint(clientX, clientY, viewportWidth, viewportHeight);
  const flow = screenToFlowPosition({ x: clientX, y: clientY });
  return { ...screen, flowX: flow.x, flowY: flow.y, compatibility };
}

export function searchPaletteStateFromRects(
  searchRect: PaletteAnchorRect,
  viewportWidth: number,
  viewportHeight: number,
  screenToFlowPosition: ScreenToFlowPosition,
  canvasRect?: PaletteAnchorRect
): PaletteState {
  const screen = palettePositionFromPoint(searchRect.left, searchRect.bottom + SEARCH_PALETTE_GAP, viewportWidth, viewportHeight);
  const placementAnchor = canvasRect && canvasRect.width > 0 && canvasRect.height > 0
    ? { x: canvasRect.left + canvasRect.width / 2, y: canvasRect.top + canvasRect.height / 2 }
    : { x: searchRect.left, y: searchRect.bottom + PALETTE_MAX_HEIGHT / 2 };
  const flow = screenToFlowPosition(placementAnchor);
  return { ...screen, flowX: flow.x, flowY: flow.y };
}

function openPalette(event: ReactMouseEvent<HTMLDivElement>, setPalette: (palette: PaletteState | undefined) => void, screenToFlowPosition: ScreenToFlowPosition): void {
  event.preventDefault();
  setPalette(paletteStateFromPoint(event.clientX, event.clientY, window.innerWidth, window.innerHeight, screenToFlowPosition));
}

function confirmDiscardUnsavedChanges(groupName: string | undefined): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  const subject = groupName ? `"${groupName}"` : "this automation";
  return window.confirm(`Discard unsaved changes to ${subject}?`);
}

function visiblePorts(ports: AutomationPortDescriptor[]): AutomationPortDescriptor[] {
  return ports.filter(portIsConnectable);
}

export function defaultConfigForEntry(entry: AutomationNodeCatalogEntry): Record<string, unknown> {
  const inputDefaults = defaultInputConfigForEntry(entry);
  if (entry.typeId === "primitive:constant.string") {
    return { ...inputDefaults, value: "" };
  }
  if (entry.typeId === "primitive:constant.number") {
    return { ...inputDefaults, value: 0 };
  }
  if (entry.typeId === "primitive:constant.boolean") {
    return { ...inputDefaults, value: false };
  }
  if (entry.typeId === "primitive:stringTemplate") {
    return { ...inputDefaults, template: "${value}" };
  }
  if (entry.typeId === AUTOMATION_FSTRING_TYPE_ID) {
    return { ...inputDefaults, template: "Hello {value}", inputNames: ["value"], value: "" };
  }
  if (entry.typeId === "primitive:variables.create" || entry.typeId === "primitive:variables.get" || entry.typeId === "primitive:variables.set") {
    return { ...inputDefaults, name: "value" };
  }
  if (entry.typeId === "primitive:array.literal") {
    return { ...inputDefaults, items: "[]" };
  }
  if (entry.typeId === "primitive:array.append") {
    return { ...inputDefaults, array: "[]", item: "" };
  }
  if (entry.typeId === "primitive:array.get") {
    return { ...inputDefaults, array: "[]", index: 0 };
  }
  if (entry.typeId === "primitive:array.length") {
    return { ...inputDefaults, array: "[]" };
  }
  if (entry.typeId === "primitive:log") {
    return { ...inputDefaults, message: "Automation step completed." };
  }
  return inputDefaults;
}

function defaultInputConfigForEntry(entry: AutomationNodeCatalogEntry): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const port of entry.inputs) {
    if (port.kind !== "data") {
      continue;
    }
    if (port.defaultValue !== undefined) {
      defaults[port.id] = port.defaultValue;
      continue;
    }
    if (port.options?.values.length && port.required) {
      defaults[port.id] = port.options.values[0]?.value ?? "";
      continue;
    }
    const simpleDefault = simpleDefaultForType(port.type);
    if (simpleDefault !== undefined) {
      defaults[port.id] = simpleDefault;
    } else if (port.required) {
      defaults[port.id] = "";
    }
  }
  return defaults;
}

function simpleDefaultForType(type: AutomationType): unknown {
  if (type.kind === "string") {
    return "";
  }
  if (type.kind === "number") {
    return 0;
  }
  if (type.kind === "boolean") {
    return false;
  }
  if (type.kind === "null") {
    return null;
  }
  if (type.kind === "union" && type.options?.length === 1) {
    return simpleDefaultForType(type.options[0]);
  }
  return undefined;
}

export function portTooltipText(port: AutomationPortDescriptor): string {
  const parts = [
    port.description,
    `${port.direction === "input" ? "Input" : "Output"} ${port.kind}`,
    `Format: ${formatAutomationType(port.type)}`,
    port.required ? "Required" : undefined,
    port.defaultValue !== undefined ? `Default: ${formatConfigValue(port.defaultValue)}` : undefined,
    port.options?.values.length ? `Choices: ${port.options.values.map((option) => option.label).join(", ")}` : undefined,
    port.options?.source ? `Source: ${port.options.source}` : undefined
  ].filter(Boolean);
  return parts.join("\n");
}

export function portTooltipPlacementFromRect(
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  direction: AutomationPortDescriptor["direction"],
  viewport = currentViewportSize()
): PortTooltipPlacement {
  const width = Math.min(PORT_TOOLTIP_MAX_WIDTH, Math.max(120, viewport.width - PORT_TOOLTIP_MARGIN * 2));
  const maxLeft = Math.max(PORT_TOOLTIP_MARGIN, viewport.width - width - PORT_TOOLTIP_MARGIN);
  const preferredLeft = direction === "input" ? rect.left : rect.right - width;
  const left = clampNumber(preferredLeft, PORT_TOOLTIP_MARGIN, maxLeft);

  const belowSpace = viewport.height - rect.bottom - PORT_TOOLTIP_GAP - PORT_TOOLTIP_MARGIN;
  const aboveSpace = rect.top - PORT_TOOLTIP_GAP - PORT_TOOLTIP_MARGIN;
  const placeAbove = belowSpace < 120 && aboveSpace > belowSpace;
  const availableHeight = placeAbove ? aboveSpace : belowSpace;
  const maxHeight = Math.max(PORT_TOOLTIP_MIN_HEIGHT, Math.min(PORT_TOOLTIP_MAX_HEIGHT, availableHeight));
  const preferredTop = placeAbove ? rect.top - PORT_TOOLTIP_GAP - maxHeight : rect.bottom + PORT_TOOLTIP_GAP;
  const maxTop = Math.max(PORT_TOOLTIP_MARGIN, viewport.height - maxHeight - PORT_TOOLTIP_MARGIN);
  const top = clampNumber(preferredTop, PORT_TOOLTIP_MARGIN, maxTop);

  return { left, top, width, maxHeight };
}

export function formatAutomationType(type: AutomationType): string {
  if (type.kind === "array") {
    return `array<${formatAutomationType(type.items ?? { kind: "unknown" })}>`;
  }
  if (type.kind === "object") {
    const required = new Set(type.required ?? []);
    const fields = Object.entries(type.properties ?? {});
    if (!fields.length) {
      return "object";
    }
    return `{ ${fields.map(([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${formatAutomationType(value)}`).join(", ")} }`;
  }
  if (type.kind === "union") {
    return (type.options ?? []).map((option) => formatAutomationType(option)).join(" | ") || "unknown";
  }
  return type.kind;
}

function formatConfigValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  return JSON.stringify(value);
}

function currentViewportSize(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

interface ConfigEntry {
  key: string;
  value: unknown;
  port?: AutomationPortDescriptor;
}

function configEntries(entry: AutomationNodeCatalogEntry, config: Record<string, unknown>): ConfigEntry[] {
  const keys = new Set([...Object.keys(defaultConfigForEntry(entry)), ...Object.keys(config)]);
  if (entry.typeId === AUTOMATION_FSTRING_TYPE_ID) {
    for (const port of entry.inputs.filter((port) => port.kind === "data")) {
      keys.add(port.id);
    }
  }
  const defaults = defaultConfigForEntry(entry);
  return Array.from(keys).map((key) => {
    const configured = Object.prototype.hasOwnProperty.call(config, key);
    return {
      key,
      value: configured ? config[key] : defaults[key],
      port: entry.inputs.find((port) => port.id === key && port.kind === "data")
    };
  });
}

function addFStringInputName(config: Record<string, unknown>): Record<string, unknown> {
  const names = automationFStringInputNames(config);
  let index = names.length + 1;
  let name = `value${index}`;
  while (names.includes(name)) {
    index += 1;
    name = `value${index}`;
  }
  return { ...config, inputNames: [...names, name], [name]: "" };
}

function renameFStringInputName(config: Record<string, unknown>, index: number, rawName: string): Record<string, unknown> {
  const nextName = normalizeFStringInputName(rawName);
  const names = automationFStringInputNames(config);
  const previousName = names[index];
  if (!nextName || !previousName || (names.includes(nextName) && nextName !== previousName)) {
    return config;
  }
  const next: Record<string, unknown> = { ...config, inputNames: names.map((name, candidateIndex) => (candidateIndex === index ? nextName : name)) };
  if (previousName !== nextName) {
    next[nextName] = Object.prototype.hasOwnProperty.call(config, previousName) ? config[previousName] : "";
    delete next[previousName];
  }
  return next;
}

function removeFStringInputName(config: Record<string, unknown>, index: number): Record<string, unknown> {
  const names = automationFStringInputNames(config);
  const removed = names[index];
  const next: Record<string, unknown> = { ...config, inputNames: names.filter((_name, candidateIndex) => candidateIndex !== index) };
  if (removed) {
    delete next[removed];
  }
  return next;
}

function normalizeFStringInputName(value: string): string | undefined {
  const normalized = value.trim().replace(/[^A-Za-z0-9_]/g, "_").replace(/^[0-9]+/, "");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized) ? normalized : undefined;
}

function coerceConfigValue(previous: unknown, value: string, port?: AutomationPortDescriptor): unknown {
  if (port?.type.kind === "number" || typeof previous === "number") {
    const next = Number(value);
    return Number.isFinite(next) ? next : previous;
  }
  if (port?.type.kind === "boolean" || typeof previous === "boolean") {
    return value === "true";
  }
  return value;
}

export function primitiveConfigSummary(entry: AutomationNodeCatalogEntry, config: Record<string, unknown>, maxEntries = 3): string | undefined {
  if (entry.kind !== "primitive") {
    return undefined;
  }
  const rows = configEntries(entry, config).filter((row) => row.value !== undefined);
  if (!rows.length) {
    return undefined;
  }
  const parts = rows.slice(0, maxEntries).map((row) => `${configSummaryLabel(row)}: ${formatPrimitiveSummaryValue(row.value)}`);
  if (rows.length > maxEntries) {
    parts.push(`+${rows.length - maxEntries}`);
  }
  return parts.join(" · ");
}

function configSummaryLabel(row: ConfigEntry): string {
  return row.port?.label ?? row.key.replace(/([A-Z])/g, " $1").replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase()).trim();
}

function formatPrimitiveSummaryValue(value: unknown): string {
  const formatted = formatConfigValue(value);
  const singleLine = formatted.replace(/\s+/g, " ").trim();
  const summary = singleLine || "\"\"";
  return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
}
