import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JiraFilterState } from "@cloudx/shared";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";

describe("Jira filter HTTP hooks", () => {
  it("creates, edits, selects and deletes filters through the production hooks and restores them after restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-filter-http-"));
    const config = loadConfig({
      CLOUDX_ALLOWED_ROOTS: root,
      CLOUDX_TRUSTED_ORIGINS: "http://localhost",
      CLOUDX_DATA_DIR: path.join(root, ".cloudx"),
      CLOUDX_APP_SERVER_ENABLED: "false",
      CLOUDX_AUTOMATION_START_DISABLED: "true",
      CLOUDX_LOG_LEVEL: "silent"
    });
    let app = await buildServer(config);
    const call = async (hookId: string, input: Record<string, unknown> = {}): Promise<JiraFilterState> => {
      const response = await app.inject({ method: "POST", url: `/api/hooks/${hookId}`, payload: { input } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().result as JiraFilterState;
    };

    try {
      await expect(call("jira.filters.list")).resolves.toEqual({ filters: [], selectedFilterId: null });
      const first = await call("jira.filters.save", { name: "Team backlog", jql: "project = ENG ORDER BY created ASC" });
      const firstId = first.selectedFilterId!;
      const second = await call("jira.filters.save", { name: "Unassigned", jql: "assignee IS EMPTY" });
      const edited = await call("jira.filters.save", { id: firstId, name: "Open team backlog", jql: "project = ENG AND resolution IS EMPTY" });
      expect(edited).toMatchObject({ selectedFilterId: firstId, filters: [
        { id: firstId, name: "Open team backlog", jql: "project = ENG AND resolution IS EMPTY" },
        { id: second.selectedFilterId, name: "Unassigned" }
      ] });

      await app.close();
      app = await buildServer(config);
      await expect(call("jira.filters.list")).resolves.toEqual(edited);
      await expect(call("jira.filters.select", { filterId: second.selectedFilterId })).resolves.toMatchObject({ selectedFilterId: second.selectedFilterId });
      await expect(call("jira.filters.delete", { id: firstId })).resolves.toMatchObject({ selectedFilterId: second.selectedFilterId, filters: [{ name: "Unassigned" }] });
      await expect(call("jira.filters.select", { filterId: null })).resolves.toMatchObject({ selectedFilterId: null });
      await call("jira.filters.select", { filterId: second.selectedFilterId });
      await expect(call("jira.filters.delete", { id: second.selectedFilterId })).resolves.toEqual({ filters: [], selectedFilterId: null });
    } finally {
      await app.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid hook input and unknown filters without changing saved state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-filter-validation-"));
    const config = loadConfig({
      CLOUDX_ALLOWED_ROOTS: root,
      CLOUDX_TRUSTED_ORIGINS: "http://localhost",
      CLOUDX_DATA_DIR: path.join(root, ".cloudx"),
      CLOUDX_APP_SERVER_ENABLED: "false",
      CLOUDX_AUTOMATION_START_DISABLED: "true",
      CLOUDX_LOG_LEVEL: "silent"
    });
    const app = await buildServer(config);
    try {
      const saved = await app.inject({ method: "POST", url: "/api/hooks/jira.filters.save", payload: { input: { name: "Bugs", jql: "type = Bug" } } });
      expect(saved.statusCode, saved.body).toBe(200);
      for (const [hookId, input, message] of [
        ["jira.filters.save", { name: "Missing query" }, "missing required input: jql"],
        ["jira.filters.save", { name: " ", jql: "type = Bug" }, "non-empty string"],
        ["jira.filters.save", { name: "x".repeat(101), jql: "type = Bug" }, "100 characters"],
        ["jira.filters.save", { name: "Long query", jql: "x".repeat(10_001) }, "10000 characters"],
        ["jira.filters.save", { name: "New", jql: "type = Bug", extra: true }, "does not accept input: extra"],
        ["jira.filters.save", { name: "bugs", jql: "project = ENG" }, "name already exists"],
        ["jira.filters.select", {}, "missing required input: filterId"],
        ["jira.filters.select", { filterId: 42 }, "must be string"],
        ["jira.filters.select", { filterId: "missing" }, "does not exist"],
        ["jira.filters.delete", { id: "missing" }, "does not exist"],
        ["jira.filters.save", { id: "missing", name: "Missing filter", jql: "project = ENG" }, "does not exist"],
        ["jira.dashboard.list", { filterId: "" }, "must NOT have fewer than 1 characters"]
      ] as const) {
        const response = await app.inject({ method: "POST", url: `/api/hooks/${hookId}`, payload: { input } });
        expect(response.statusCode, `${hookId}: ${response.body}`).toBeGreaterThanOrEqual(400);
        expect(response.json().message).toContain(message);
      }
      const listed = await app.inject({ method: "POST", url: "/api/hooks/jira.filters.list", payload: { input: {} } });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual(saved.json());
    } finally {
      await app.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
