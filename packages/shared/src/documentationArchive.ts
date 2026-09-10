export interface DocumentationArchiveExportJob {
  id: string;
  status: "running" | "complete" | "failed";
  stage: string;
  progress?: number;
  error?: string;
  filename?: string;
}
