import { useEffect, useState } from "react";
import { FileText, Folder, RefreshCw } from "lucide-react";

import type { WorkspaceTab } from "@cloudx/shared";

import { runTabAction } from "../api.js";

interface DirectoryEntry {
  name: string;
  type: "directory" | "file";
}

interface DirectoryResult {
  path: string;
  entries: DirectoryEntry[];
}

interface OpenFileResult {
  path: string;
  truncated: boolean;
  content: string;
}

export function FileBrowserPanel({ tab }: { tab: WorkspaceTab }) {
  const [relativePath, setRelativePath] = useState("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [opened, setOpened] = useState<OpenFileResult | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void loadDirectory("");
  }, [tab.id]);

  async function loadDirectory(path: string) {
    setError(undefined);
    try {
      const result = await runTabAction<DirectoryResult>(tab.id, "list_directory", { relativePath: path });
      setRelativePath(path);
      setEntries(result.entries);
      setOpened(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openFile(name: string) {
    setError(undefined);
    try {
      const filePath = relativePath ? `${relativePath}/${name}` : name;
      const result = await runTabAction<OpenFileResult>(tab.id, "open_file", { relativePath: filePath });
      setOpened(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="file-browser-panel">
      <div className="file-browser-toolbar">
        <button onClick={() => void loadDirectory(parentPath(relativePath))}>..</button>
        <span>{relativePath || "."}</span>
        <button onClick={() => void loadDirectory(relativePath)} title="Refresh">
          <RefreshCw size={15} />
        </button>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="file-browser-body">
        <div className="file-list">
          {entries.map((entry) => (
            <button key={`${entry.type}:${entry.name}`} onClick={() => (entry.type === "directory" ? void loadDirectory(relativePath ? `${relativePath}/${entry.name}` : entry.name) : void openFile(entry.name))}>
              {entry.type === "directory" ? <Folder size={15} /> : <FileText size={15} />}
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
        <pre className="file-preview">{opened ? `${opened.path}${opened.truncated ? "\n[truncated]\n" : "\n\n"}${opened.content}` : "Select a file to preview it."}</pre>
      </div>
    </div>
  );
}

function parentPath(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}
