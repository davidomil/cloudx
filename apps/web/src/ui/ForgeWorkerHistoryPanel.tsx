import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ForgeWorkerHistory } from "@cloudx/shared";

import { installTerminalMobileScroller } from "./terminalMobileScroll.js";
import { readTerminalColorTheme } from "./theme.js";
import { scaledTerminalFontSize } from "./uiScale.js";

export function ForgeWorkerHistoryPanel({ history, uiScale }: { history: ForgeWorkerHistory; uiScale: number }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current!;
    const terminal = new Terminal({
      cols: history.screen.cols,
      rows: history.screen.rows,
      disableStdin: true,
      cursorInactiveStyle: "none",
      screenReaderMode: true,
      reflowCursorLine: true,
      fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
      fontSize: scaledTerminalFontSize(14, uiScale),
      lineHeight: 1.25,
      theme: readTerminalColorTheme()
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler(event => event.key !== "Escape");
    const releaseScroller = installTerminalMobileScroller(terminal, container, null);
    let disposed = false;
    const observer = new ResizeObserver(() => fit.fit());
    // Saved mouse tracking must not consume scrolling or text selection.
    terminal.write(`${history.screen.data}\x1b[?1000l\x1b[?25l`, () => {
      if (disposed) return;
      // Reserve one row per saved cell so even the narrowest fit retains history.
      terminal.options.scrollback = terminal.buffer.normal.length * terminal.cols;
      fit.fit();
      terminal.scrollToBottom();
      observer.observe(container);
    });
    return () => {
      disposed = true;
      observer.disconnect();
      releaseScroller();
      terminal.dispose();
    };
  }, [history, uiScale]);

  return <div ref={containerRef} className="terminal-panel" role="region" aria-label="Saved worker terminal output" />;
}
