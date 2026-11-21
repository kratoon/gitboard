/**
 * Which columns the child-issue table of an epic shows (FEAT-130c757). Resolved like views: the project's own
 * list, else the repository's list, else the built-in default. An override replaces the layer below.
 */
import { EPIC_COLUMN_IDS, type EpicColumnId, type RepoConfig } from '../types';

export const BUILTIN_EPIC_COLUMNS: readonly EpicColumnId[] = ['key', 'title', 'status'];

export function isEpicColumnId(value: string): value is EpicColumnId {
  return (EPIC_COLUMN_IDS as readonly string[]).includes(value);
}

/** Unknown ids are ignored, and a list with no known column left is skipped; `validate` reports them. */
export function effectiveEpicColumns(config: RepoConfig, projectKey?: string): EpicColumnId[] {
  const project = projectKey === undefined ? undefined : config.projects.find((p) => p.key === projectKey);
  for (const list of [project?.epicColumns, config.epicColumns]) {
    const columns = [...new Set((list ?? []).filter(isEpicColumnId))];
    if (columns.length > 0) return columns;
  }
  return [...BUILTIN_EPIC_COLUMNS];
}
