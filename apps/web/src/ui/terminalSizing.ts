export function rowsFittingTerminalViewport(currentRows: number, viewportHeight: number, screenHeight: number): number {
  if (currentRows <= 1 || viewportHeight <= 0 || screenHeight <= viewportHeight + 0.5) {
    return currentRows;
  }
  const rowHeight = screenHeight / currentRows;
  if (rowHeight <= 0) {
    return currentRows;
  }
  const rowsToRemove = Math.max(1, Math.ceil((screenHeight - viewportHeight) / rowHeight));
  return Math.max(1, currentRows - rowsToRemove);
}

export interface VisualViewportBottomInsetInput {
  layoutViewportHeight: number;
  visualViewportHeight?: number;
  visualViewportOffsetTop?: number;
}

export function visualViewportBottomInset(input: VisualViewportBottomInsetInput): number {
  const { layoutViewportHeight, visualViewportHeight, visualViewportOffsetTop = 0 } = input;
  if (
    typeof layoutViewportHeight !== "number" ||
    typeof visualViewportHeight !== "number" ||
    !Number.isFinite(layoutViewportHeight) ||
    !Number.isFinite(visualViewportHeight) ||
    layoutViewportHeight <= 0 ||
    visualViewportHeight <= 0
  ) {
    return 0;
  }
  const visualViewportBottom = visualViewportOffsetTop + visualViewportHeight;
  if (!Number.isFinite(visualViewportBottom)) {
    return 0;
  }
  return Math.max(0, Math.round(layoutViewportHeight - visualViewportBottom));
}

export interface BottomRevealScrollInput {
  targetBottom: number;
  visibleBottom: number;
  margin?: number;
}

export function bottomRevealScrollDelta(input: BottomRevealScrollInput): number {
  const margin = Math.max(0, input.margin ?? 0);
  if (!Number.isFinite(input.targetBottom) || !Number.isFinite(input.visibleBottom)) {
    return 0;
  }
  return Math.max(0, Math.ceil(input.targetBottom - (input.visibleBottom - margin)));
}
