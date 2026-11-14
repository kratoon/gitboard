/**
 * Which views a project offers (ADR-9082368). Resolved exactly like columns (ADR-c680df6): the project's own
 * list, else the repository's list, else the built-in default. An override replaces the layer below.
 */
import { loadConfig, requireProject, updateConfig } from './config';
import type { Repo } from '../storage/repo-files';
import { VIEW_IDS, type ColumnSource, type RepoConfig, type ViewId, type ViewsInfo } from '../types';

/** Enabled when neither the project nor the repository says otherwise. The first one is the default view. */
export const BUILTIN_VIEWS: readonly ViewId[] = VIEW_IDS;

export function isViewId(value: string): value is ViewId {
  return (VIEW_IDS as readonly string[]).includes(value);
}

function known(list: readonly string[] | undefined): ViewId[] {
  return [...new Set((list ?? []).filter(isViewId))];
}

/**
 * Unknown ids (from a newer Gitboard, or a typo in a hand-edited file) are ignored; a list with no known
 * view left is skipped as if it were not set. `validate` reports them.
 */
export function effectiveViews(config: RepoConfig, projectKey?: string): ViewsInfo {
  const base = projectKey === undefined ? {} : { project: projectKey };
  const project = projectKey === undefined ? undefined : config.projects.find((p) => p.key === projectKey);
  const layers: Array<[ColumnSource, readonly string[] | undefined]> = [
    ['project', project?.views],
    ['repo', config.views],
  ];
  for (const [source, list] of layers) {
    const views = known(list);
    if (views.length > 0) return { ...base, views, source };
  }
  return { ...base, views: [...BUILTIN_VIEWS], source: 'builtin' };
}

export async function showViews(repo: Repo, project?: string): Promise<ViewsInfo> {
  const { config } = await loadConfig(repo);
  if (project !== undefined) requireProject(config, project);
  return effectiveViews(config, project);
}

/** Enables exactly these views for the repository, or for one project when `project` is given. */
export async function setViews(repo: Repo, input: { views: readonly ViewId[]; project?: string | undefined }): Promise<ViewsInfo> {
  const config = await updateConfig(repo, (draft) => {
    if (input.project !== undefined) requireProject(draft, input.project).views = [...input.views];
    else draft.views = [...input.views];
  });
  return effectiveViews(config, input.project);
}

/** Removes an override so the layer below applies again. */
export async function resetViews(repo: Repo, input: { project?: string | undefined }): Promise<ViewsInfo> {
  const config = await updateConfig(repo, (draft) => {
    if (input.project !== undefined) delete requireProject(draft, input.project).views;
    else delete draft.views;
  });
  return effectiveViews(config, input.project);
}
