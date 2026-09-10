export const JIRA_FILTER_NAME_MAX_LENGTH = 100;
export const JIRA_FILTER_JQL_MAX_LENGTH = 10_000;
export const JIRA_SAVED_FILTER_LIMIT = 100;

export interface JiraSavedFilter {
  id: string;
  name: string;
  jql: string;
}

export interface JiraFilterState extends Record<string, unknown> {
  filters: JiraSavedFilter[];
  selectedFilterId: string | null;
}

export interface JiraSaveFilterInput {
  id?: string;
  name: string;
  jql: string;
}
