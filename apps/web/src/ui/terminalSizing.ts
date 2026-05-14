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
