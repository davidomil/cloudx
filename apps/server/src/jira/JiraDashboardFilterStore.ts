import { randomUUID } from "node:crypto";

import {
  JIRA_FILTER_JQL_MAX_LENGTH,
  JIRA_FILTER_NAME_MAX_LENGTH,
  JIRA_SAVED_FILTER_LIMIT,
  type JiraFilterState,
  type JiraSavedFilter,
  type JiraSaveFilterInput
} from "@cloudx/shared";

import type { PluginDataStore } from "../plugins/PluginDataStore.js";

const STORAGE_KEY = "jira-dashboard-filters";

export class JiraDashboardFilterStore {
  private mutations = Promise.resolve();

  constructor(private readonly data: PluginDataStore) {}

  async list(signal?: AbortSignal): Promise<JiraFilterState> {
    await this.mutations;
    signal?.throwIfAborted();
    const state = await this.read();
    signal?.throwIfAborted();
    return state;
  }

  async get(id: string, signal?: AbortSignal): Promise<JiraSavedFilter> {
    return requireFilter(await this.list(signal), filterId(id));
  }

  save(input: JiraSaveFilterInput, signal?: AbortSignal): Promise<JiraFilterState> {
    return this.change((state) => {
      const id = input.id === undefined ? randomUUID() : requireFilter(state, filterId(input.id)).id;
      const filter = parseFilter({ ...input, id });
      if (state.filters.some((candidate) => candidate.id !== id && candidate.name.toLowerCase() === filter.name.toLowerCase())) {
        throw new Error("A Jira filter with this name already exists.");
      }
      const index = state.filters.findIndex((candidate) => candidate.id === id);
      if (index < 0) state.filters.push(filter);
      else state.filters[index] = filter;
      state.selectedFilterId = id;
      return state;
    }, signal);
  }

  delete(id: string, signal?: AbortSignal): Promise<JiraFilterState> {
    return this.change((state) => {
      const filter = requireFilter(state, filterId(id));
      state.filters = state.filters.filter((candidate) => candidate.id !== filter.id);
      if (state.selectedFilterId === filter.id) state.selectedFilterId = null;
      return state;
    }, signal);
  }

  select(id: string | null, signal?: AbortSignal): Promise<JiraFilterState> {
    return this.change((state) => {
      state.selectedFilterId = id === null ? null : requireFilter(state, filterId(id)).id;
      return state;
    }, signal);
  }

  private async read(): Promise<JiraFilterState> {
    const stored = await this.data.read(STORAGE_KEY);
    return stored === undefined ? { filters: [], selectedFilterId: null } : parseState(stored);
  }

  private change(update: (state: JiraFilterState) => JiraFilterState, signal?: AbortSignal): Promise<JiraFilterState> {
    const result = this.mutations.then(async () => {
      signal?.throwIfAborted();
      const next = parseState(update(await this.read()));
      signal?.throwIfAborted();
      await this.data.write(STORAGE_KEY, next);
      return next;
    });
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }
}

function parseState(value: unknown): JiraFilterState {
  const state = record(value, "Jira filter state");
  if (!Array.isArray(state.filters) || state.filters.length > JIRA_SAVED_FILTER_LIMIT) {
    throw new Error(`Jira filters must be an array of at most ${JIRA_SAVED_FILTER_LIMIT} saved filters.`);
  }
  const filters = state.filters.map(parseFilter);
  if (new Set(filters.map((filter) => filter.id)).size !== filters.length) {
    throw new Error("Jira saved filter IDs must be unique.");
  }
  if (new Set(filters.map((filter) => filter.name.toLowerCase())).size !== filters.length) {
    throw new Error("Jira saved filter names must be unique.");
  }
  const selectedFilterId = state.selectedFilterId === null ? null : filterId(state.selectedFilterId);
  const parsed = { filters, selectedFilterId };
  if (selectedFilterId !== null) requireFilter(parsed, selectedFilterId);
  return parsed;
}

function parseFilter(value: unknown): JiraSavedFilter {
  const filter = record(value, "Jira saved filter");
  return {
    id: filterId(filter.id),
    name: boundedText(filter.name, "Jira filter name", JIRA_FILTER_NAME_MAX_LENGTH),
    jql: boundedText(filter.jql, "Jira filter JQL", JIRA_FILTER_JQL_MAX_LENGTH)
  };
}

function requireFilter(state: JiraFilterState, id: string): JiraSavedFilter {
  const filter = state.filters.find((candidate) => candidate.id === id);
  if (!filter) throw new Error(`Jira saved filter ${id} does not exist.`);
  return filter;
}

function filterId(value: unknown): string {
  return boundedText(value, "Jira filter ID", 100);
}

function boundedText(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(`${label} must be a non-empty string of at most ${limit} characters.`);
  }
  return value.trim();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
