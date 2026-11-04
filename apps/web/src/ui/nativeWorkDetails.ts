import type { WorkspaceTab } from "@cloudx/shared";

const OPEN_DETAILS_EVENT = "cloudx:open-native-work-details";

export interface NativeWorkPresentation {
  explicitOpen: boolean;
  dismissedIncidents: string[];
}

export function nativeWorkPresentationKey(tab: WorkspaceTab): string {
  return `cloudx.nativeWork.details:${JSON.stringify([tab.id, tab.nativeWork?.executionId, tab.nativeWork?.threadId])}`;
}

export function readNativeWorkPresentation(key: string): NativeWorkPresentation {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (saved && typeof saved === "object" && "explicitOpen" in saved && typeof saved.explicitOpen === "boolean" &&
        "dismissedIncidents" in saved && Array.isArray(saved.dismissedIncidents) && saved.dismissedIncidents.every(value => typeof value === "string")) {
      return { explicitOpen: saved.explicitOpen, dismissedIncidents: saved.dismissedIncidents };
    }
  } catch { /* Browser storage is optional. */ }
  return { explicitOpen: false, dismissedIncidents: [] };
}

export function saveNativeWorkPresentation(key: string, presentation: NativeWorkPresentation): void {
  try { sessionStorage.setItem(key, JSON.stringify(presentation)); } catch { /* Presentation still works in memory. */ }
}

export function openNativeWorkDetails(tab: WorkspaceTab): void {
  if (!tab.nativeWork) return;
  const key = nativeWorkPresentationKey(tab);
  saveNativeWorkPresentation(key, { ...readNativeWorkPresentation(key), explicitOpen: true });
  window.dispatchEvent(new CustomEvent(OPEN_DETAILS_EVENT, { detail: key }));
}

export function onOpenNativeWorkDetails(key: string, open: () => void): () => void {
  const listener = (event: Event) => { if ((event as CustomEvent<unknown>).detail === key) open(); };
  window.addEventListener(OPEN_DETAILS_EVENT, listener);
  return () => window.removeEventListener(OPEN_DETAILS_EVENT, listener);
}
