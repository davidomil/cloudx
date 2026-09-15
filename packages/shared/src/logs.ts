export const CLOUDX_LOG_SOURCES = [
  { id: "current", label: "Current server run", description: "Recent server logs since this CloudX process started. Respects CLOUDX_LOG_LEVEL; cleared on restart." },
  { id: "services", label: "All installed services", description: "Systemd journal for the installed CloudX server, terminal broker, ASR, and documentation services." },
  { id: "server", label: "Server service", description: "Systemd journal for cloudx.service." },
  { id: "terminals", label: "Terminal service", description: "Systemd journal for cloudx-terminal.service." },
  { id: "asr", label: "ASR service", description: "Systemd journal for cloudx-asr.service." },
  { id: "documentation", label: "Documentation service", description: "Systemd journal for cloudx-documentation.service." }
] as const;

export type CloudxLogSource = typeof CLOUDX_LOG_SOURCES[number]["id"];

export interface CloudxLogsResponse {
  source: CloudxLogSource;
  content: string;
  capturedAt: string;
  truncated: boolean;
}
