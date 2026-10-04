import type { IBuffer, IBufferCellPosition, IBufferRange } from "@xterm/xterm";

interface SavedLine {
  text: string;
  columns: number[];
  wrapped: boolean;
}

/** An immutable buffer lets a drag grow after the displayed cells change. */
export class TerminalSelectionSnapshot {
  private readonly lines: SavedLine[];

  constructor(buffer: IBuffer, readonly cols: number) {
    const cell = buffer.getNullCell();
    this.lines = Array.from({ length: buffer.length }, (_, row) => {
      const line = buffer.getLine(row)!;
      const columns = [0];
      let offset = 0;
      for (let column = 0; column < cols;) {
        line.getCell(column, cell);
        offset += (cell.getChars() || " ").length;
        const width = cell.getWidth() || 1;
        for (let index = 0; index < width; index++) columns.push(offset);
        column += width;
      }
      return { text: line.translateToString(true, 0, cols), columns, wrapped: line.isWrapped };
    });
  }

  selection(range: IBufferRange, columnSelection = false): string {
    const result: string[] = [];
    for (let row = range.start.y; row <= range.end.y; row++) {
      const line = this.lines[row];
      if (!line) break;
      const start = columnSelection ? Math.min(range.start.x, range.end.x) : row === range.start.y ? range.start.x : 0;
      const end = columnSelection ? Math.max(range.start.x, range.end.x) : row === range.end.y ? range.end.x : this.cols;
      const text = line.text.slice(line.columns[start], line.columns[end]);
      if (!columnSelection && line.wrapped && result.length) result[result.length - 1] += text;
      else result.push(text);
    }
    return result.join(/Win/u.test(navigator.platform) ? "\r\n" : "\n").replaceAll("\u00a0", " ");
  }

  wordAt(point: IBufferCellPosition, separators: string, above = true, below = true): IBufferRange | undefined {
    const line = this.lines[point.y];
    if (!line || point.x >= this.cols) return undefined;
    const characters = (column: number) => line.text.slice(line.columns[column], line.columns[column + 1]);
    const continuation = (column: number) => line.columns[column] === line.columns[column + 1];
    let start = Math.max(0, point.x);
    if (continuation(start)) start--;
    let end = start + 1;
    const whitespace = (characters(start) || " ") === " ";
    const belongs = (column: number) => whitespace
      ? !continuation(column) && (characters(column) || " ") === " "
      : continuation(column) || !separators.includes(characters(column));
    while (start > 0 && belongs(start - 1)) start--;
    while (end < this.cols && belongs(end)) end++;
    const range = { start: { x: start, y: point.y }, end: { x: end, y: point.y } };
    if (above && start === 0 && line.wrapped && characters(0) !== " ") {
      const previous = this.lines[point.y - 1];
      if (previous && previous.text.slice(previous.columns[this.cols - 1]) !== " ") {
        const word = this.wordAt({ x: this.cols - 1, y: point.y - 1 }, separators, true, false);
        if (word && this.selection(word).trim()) range.start = word.start;
      }
    }
    if (below && end === this.cols && characters(this.cols - 1) !== " ") {
      const next = this.lines[point.y + 1];
      if (next?.wrapped && next.text.slice(0, next.columns[1]) !== " ") {
        const word = this.wordAt({ x: 0, y: point.y + 1 }, separators, false, true);
        if (word && this.selection(word).trim()) range.end = word.end;
      }
    }
    return range;
  }
}
