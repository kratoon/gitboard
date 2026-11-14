/**
 * Repo configuration (`.gitboard/config.json`): projects and column overrides (ADR-0009, ADR-0011).
 */
import path from 'node:path';
import { GitboardError, formatZodError } from '../errors';
import { loadIssues, saveChanges } from '../issues/store';
import { createGitboardFiles, isInitialized, openRepo, readConfigFile, writeConfigFile, type Repo } from '../storage/repo-files';
import {
  PROJECT_KEY_PATTERN,
  RepoConfigSchema,
  type ColumnsChangeResult,
  type ColumnsInfo,
  type ProjectCreateInput,
  type ProjectInfo,
  type ProjectUpdateInput,
  type RepoConfig,
  type RepoInitInput,
} from '../types';
import { effectiveColumns, normaliseColumns, withNames } from './columns';

export interface LoadedConfig {
  config: RepoConfig;
  hash: string;
}

export function serializeConfig(config: RepoConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function loadConfig(repo: Repo): Promise<LoadedConfig> {
  const file = await readConfigFile(repo);
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch (error) {
    throw new GitboardError('INVALID_CONFIG', `.gitboard/config.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = RepoConfigSchema.safeParse(raw);
  if (!result.success) throw new GitboardError('INVALID_CONFIG', `.gitboard/config.json is invalid: ${formatZodError(result.error)}`);
  return { config: result.data, hash: file.hash };
}

/** Read-modify-write. The file is only rewritten when the data actually changes. */
export async function updateConfig(repo: Repo, mutate: (config: RepoConfig) => void): Promise<RepoConfig> {
  const loaded = await loadConfig(repo);
  const next = structuredClone(loaded.config);
  mutate(next);
  if (JSON.stringify(next) === JSON.stringify(loaded.config)) return loaded.config;
  const parsed = RepoConfigSchema.safeParse(next);
  if (!parsed.success) throw new GitboardError('INVALID_CONFIG', formatZodError(parsed.error));
  await writeConfigFile(repo, serializeConfig(parsed.data), loaded.hash);
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------------

/** `gitboard` becomes `GITB`, `my-cool-app` becomes `MCA`; falls back to `MAIN`. */
export function deriveProjectKey(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const raw = words.length > 1 ? words.map((w) => w.charAt(0)).join('') : (words[0] ?? '');
  const key = raw.toUpperCase().replace(/^[0-9]+/, '').slice(0, 4);
  return PROJECT_KEY_PATTERN.test(key) ? key : 'MAIN';
}

export interface InitResult {
  root: string;
  projectKey: string;
}

export async function initRepo(root: string, input: RepoInitInput = {}): Promise<InitResult> {
  const repo = await openRepo(root);
  if (await isInitialized(repo)) throw new GitboardError('ALREADY_INITIALIZED', 'This repository already has a .gitboard/config.json.');
  const name = input.projectName ?? path.basename(repo.root);
  const key = input.projectKey ?? deriveProjectKey(name);
  const config: RepoConfig = { version: 1, projects: [{ key, name }] };
  if (input.columns) config.columns = normaliseColumns(input.columns);
  const parsed = RepoConfigSchema.parse(config);
  await createGitboardFiles(repo, serializeConfig(parsed));
  return { root: repo.root, projectKey: key };
}

// ---------------------------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------------------------

export function requireProject(config: RepoConfig, key: string) {
  const project = config.projects.find((p) => p.key === key);
  if (!project) {
    const known = config.projects.map((p) => p.key).join(', ') || '(none)';
    throw new GitboardError('PROJECT_NOT_FOUND', `Unknown project ${key}. Known projects: ${known}.`);
  }
  return project;
}

export async function listProjects(repo: Repo): Promise<ProjectInfo[]> {
  const { config } = await loadConfig(repo);
  const { issues } = await loadIssues(repo);
  return config.projects.map((project) => projectInfo(project, issues.filter((i) => i.fm.project === project.key).length));
}

function projectInfo(project: RepoConfig['projects'][number], issueCount: number): ProjectInfo {
  return {
    key: project.key,
    name: project.name,
    ...(project.description !== undefined ? { description: project.description } : {}),
    ...(project.columns ? { columns: withNames(project.columns) } : {}),
    issueCount,
  };
}

export async function createProject(repo: Repo, input: ProjectCreateInput): Promise<ProjectInfo> {
  const columns = input.columns ? normaliseColumns(input.columns) : undefined;
  let created!: RepoConfig['projects'][number];
  await updateConfig(repo, (config) => {
    if (config.projects.some((p) => p.key === input.key)) {
      throw new GitboardError('DUPLICATE_PROJECT', `Project ${input.key} already exists.`);
    }
    created = {
      key: input.key,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(columns ? { columns } : {}),
    };
    config.projects.push(created);
  });
  return projectInfo(created, 0);
}

export async function updateProject(repo: Repo, input: ProjectUpdateInput): Promise<ProjectInfo> {
  let updated!: RepoConfig['projects'][number];
  await updateConfig(repo, (config) => {
    const project = requireProject(config, input.key);
    if (input.name !== undefined) project.name = input.name;
    if (input.description === null) delete project.description;
    else if (input.description !== undefined) project.description = input.description;
    updated = project;
  });
  const { issues } = await loadIssues(repo);
  return projectInfo(updated, issues.filter((i) => i.fm.project === input.key).length);
}

export async function deleteProject(repo: Repo, key: string): Promise<{ key: string }> {
  const { issues } = await loadIssues(repo);
  const count = issues.filter((i) => i.fm.project === key).length;
  if (count > 0) {
    throw new GitboardError('PROJECT_NOT_EMPTY', `Project ${key} still has ${count} issue(s). Move or delete them first.`);
  }
  await updateConfig(repo, (config) => {
    requireProject(config, key);
    config.projects = config.projects.filter((p) => p.key !== key);
  });
  return { key };
}

// ---------------------------------------------------------------------------------------------
// columns
// ---------------------------------------------------------------------------------------------

export async function showColumns(repo: Repo, project?: string): Promise<ColumnsInfo> {
  const { config } = await loadConfig(repo);
  if (project !== undefined) requireProject(config, project);
  return effectiveColumns(config, project);
}

type StoredColumns = Array<{ id: string; name?: string }> | undefined;

/**
 * Sets or clears the column override of the repo or of one project. Refuses to orphan issues: statuses
 * that disappear must be mapped to a surviving status with `remap`.
 */
export async function changeColumns(
  repo: Repo,
  scope: { project?: string | undefined },
  next: StoredColumns,
  remap: Record<string, string> = {},
): Promise<ColumnsChangeResult> {
  const { config } = await loadConfig(repo);
  if (scope.project !== undefined) requireProject(config, scope.project);

  const proposed = structuredClone(config);
  if (scope.project !== undefined) {
    const project = requireProject(proposed, scope.project);
    if (next) project.columns = next;
    else delete project.columns;
  } else if (next) {
    proposed.columns = next;
  } else {
    delete proposed.columns;
  }

  const { issues } = await loadIssues(repo);
  const unresolved = new Map<string, number>();
  const toRemap: Array<{ issue: (typeof issues)[number]; to: string }> = [];
  for (const issue of issues) {
    const before = effectiveColumns(config, issue.fm.project).columns.map((c) => c.id);
    const after = effectiveColumns(proposed, issue.fm.project).columns.map((c) => c.id);
    if (before.join() === after.join() || after.includes(issue.fm.status)) continue;
    const target = remap[issue.fm.status];
    if (target !== undefined && after.includes(target)) toRemap.push({ issue, to: target });
    else unresolved.set(issue.fm.status, (unresolved.get(issue.fm.status) ?? 0) + 1);
  }
  if (unresolved.size > 0) {
    const list = [...unresolved].map(([status, n]) => `${status} (${n})`).join(', ');
    throw new GitboardError(
      'ORPHANED_STATUS',
      `This change would leave issues in statuses that no longer exist: ${list}. Map them to a remaining status with --remap old=new.`,
      { statuses: Object.fromEntries(unresolved) },
    );
  }

  await updateConfig(repo, (draft) => {
    if (scope.project !== undefined) {
      const project = requireProject(draft, scope.project);
      if (next) project.columns = next;
      else delete project.columns;
    } else if (next) {
      draft.columns = next;
    } else {
      delete draft.columns;
    }
  });
  for (const { issue, to } of toRemap) await saveChanges(repo, issue, { fm: { status: to } });

  return { ...effectiveColumns(proposed, scope.project), remapped: toRemap.length };
}

export async function setColumns(
  repo: Repo,
  input: { columns: ReadonlyArray<string | { id: string; name?: string | undefined }>; project?: string | undefined; remap?: Record<string, string> | undefined },
): Promise<ColumnsChangeResult> {
  return changeColumns(repo, { project: input.project }, normaliseColumns(input.columns), input.remap);
}

export async function resetColumns(
  repo: Repo,
  input: { project?: string | undefined; remap?: Record<string, string> | undefined },
): Promise<ColumnsChangeResult> {
  return changeColumns(repo, { project: input.project }, undefined, input.remap);
}
