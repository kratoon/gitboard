import { GitboardError, formatZodError } from '../errors';
import { ColumnsSchema, type Column, type ColumnsInfo, type RepoConfig } from '../types';

/** Gitboard's built-in statuses, used when neither the project nor the repo defines columns (ADR-0011). */
export const DEFAULT_COLUMNS: readonly Column[] = [
  { id: 'todo', name: 'To Do' },
  { id: 'in-progress', name: 'In Progress' },
  { id: 'done', name: 'Done' },
];

export function titleCase(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface StoredColumn {
  id: string;
  name?: string | undefined;
}

export function withNames(columns: readonly StoredColumn[]): Column[] {
  return columns.map((column) => ({ id: column.id, name: column.name ?? titleCase(column.id) }));
}

/** Validates user-supplied columns and returns them in their stored form (name only when given). */
export function normaliseColumns(
  input: ReadonlyArray<string | { id: string; name?: string | undefined }>,
): Array<{ id: string; name?: string }> {
  const objects = input.map((c) => (typeof c === 'string' ? { id: c } : c.name === undefined ? { id: c.id } : { id: c.id, name: c.name }));
  const result = ColumnsSchema.safeParse(objects);
  if (!result.success) throw new GitboardError('INVALID_INPUT', `Invalid columns: ${formatZodError(result.error)}`);
  return result.data.map((c) => (c.name === undefined ? { id: c.id } : { id: c.id, name: c.name }));
}

/**
 * Resolves a project's columns: the project override, else the repo override, else the built-in default.
 * An override replaces the layer below; it never merges (ADR-0011).
 */
export function effectiveColumns(config: RepoConfig, projectKey?: string): ColumnsInfo {
  const project = projectKey === undefined ? undefined : config.projects.find((p) => p.key === projectKey);
  const base = projectKey === undefined ? {} : { project: projectKey };
  if (project?.columns) return { ...base, columns: withNames(project.columns), source: 'project' };
  if (config.columns) return { ...base, columns: withNames(config.columns), source: 'repo' };
  return { ...base, columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), source: 'builtin' };
}
