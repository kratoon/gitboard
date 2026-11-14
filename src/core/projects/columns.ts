import { GitboardError, formatZodError } from '../errors';
import { ColumnsSchema, type Column, type ColumnsInfo, type RepoConfig } from '../types';

/** Gitboard's built-in statuses, used when neither the project nor the repo defines columns (ADR-c680df6). */
export const DEFAULT_COLUMNS: readonly Column[] = [
  { id: 'todo', name: 'To Do', done: false },
  { id: 'in-progress', name: 'In Progress', done: false },
  { id: 'done', name: 'Done', done: true },
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
  done?: boolean | undefined;
}

/**
 * Which columns are done (ADR-f8d6236). If any column says so explicitly (true or false), only columns marked
 * `done: true` are done. If none does, the last of several columns is done, which is how configs written
 * before the flag existed keep working.
 */
function doneFlags(columns: readonly StoredColumn[]): boolean[] {
  if (columns.some((column) => column.done !== undefined)) return columns.map((column) => column.done === true);
  return columns.map((_, index) => columns.length > 1 && index === columns.length - 1);
}

/** Fills in display names and the resolved done flag. */
export function withNames(columns: readonly StoredColumn[]): Column[] {
  const done = doneFlags(columns);
  return columns.map((column, index) => ({ id: column.id, name: column.name ?? titleCase(column.id), done: done[index] === true }));
}

/** Validates user-supplied columns and returns them in their stored form (name only when given). */
export function normaliseColumns(
  input: ReadonlyArray<string | StoredColumn>,
): Array<{ id: string; name?: string; done?: boolean }> {
  const stored = (c: string | StoredColumn) => {
    const column = typeof c === 'string' ? { id: c } : c;
    return {
      id: column.id,
      ...(column.name !== undefined ? { name: column.name } : {}),
      ...(column.done !== undefined ? { done: column.done } : {}),
    };
  };
  const result = ColumnsSchema.safeParse(input.map(stored));
  if (!result.success) throw new GitboardError('INVALID_INPUT', `Invalid columns: ${formatZodError(result.error)}`);
  return result.data.map(stored);
}

/**
 * Resolves a project's columns: the project override, else the repo override, else the built-in default.
 * An override replaces the layer below; it never merges (ADR-c680df6).
 */
export function effectiveColumns(config: RepoConfig, projectKey?: string): ColumnsInfo {
  const project = projectKey === undefined ? undefined : config.projects.find((p) => p.key === projectKey);
  const base = projectKey === undefined ? {} : { project: projectKey };
  if (project?.columns) return { ...base, columns: withNames(project.columns), source: 'project' };
  if (config.columns) return { ...base, columns: withNames(config.columns), source: 'repo' };
  return { ...base, columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), source: 'builtin' };
}
