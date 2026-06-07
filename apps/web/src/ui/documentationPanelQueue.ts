import type { DocumentationIngestJob } from "./DocumentationPanel.js";

export interface DocumentationIngestController {
  queue: DocumentationIngestJob[];
  processing: boolean;
  disposed: boolean;
}

const documentationIngestControllers = new Map<string, DocumentationIngestController>();

export function documentationIngestController(stateKey: string): DocumentationIngestController {
  const existing = documentationIngestControllers.get(stateKey);
  if (existing) {
    return existing;
  }
  const controller = { queue: [], processing: false, disposed: false };
  documentationIngestControllers.set(stateKey, controller);
  return controller;
}

export function disposeDocumentationIngestController(stateKey: string): void {
  const controller = documentationIngestControllers.get(stateKey);
  if (!controller) {
    return;
  }
  controller.disposed = true;
  controller.queue.length = 0;
  documentationIngestControllers.delete(stateKey);
}

export function disposeDocumentationIngestControllersExcept(activeStateKeys: Set<string>): void {
  for (const stateKey of Array.from(documentationIngestControllers.keys())) {
    if (!activeStateKeys.has(stateKey)) {
      disposeDocumentationIngestController(stateKey);
    }
  }
}
