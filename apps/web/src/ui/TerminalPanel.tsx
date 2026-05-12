import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import type { WorkspaceTab } from "@cloudx/shared";

export function TerminalPanel({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: "#101318",
        foreground: "#d7dde8",
        cursor: "#8bd3ff",
        selectionBackground: "#26415f"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminal.writeln(`Cloudx tab ${tab.title}`);
    terminal.writeln(`cwd: ${tab.cwd}`);
    terminal.writeln("");

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws/terminal/${tab.id}`);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string) as { type: string; data?: string };
      if (message.type === "data" && message.data) {
        terminal.write(message.data);
      }
    });
    terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    });
    resizeObserver.observe(containerRef.current);

    terminalRef.current = terminal;
    fitRef.current = fit;

    return () => {
      resizeObserver.disconnect();
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [tab.id, tab.cwd, tab.title]);

  useEffect(() => {
    if (active) {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    }
  }, [active]);

  return <div className="terminal-panel" ref={containerRef} />;
}
