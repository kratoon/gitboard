/**
 * Repo configuration (`.gitboard/config.yaml`, or `config.json`): projects, column overrides and views
 * (ADR-18de7e0, ADR-c680df6, ADR-9082368, ADR-6c9f71b).
 */
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { isSeq, parseDocument, stringify as stringifyYaml, type Document } from 'yaml';
import { GitboardError, formatZodError } from '../errors';
import { loadIssues, saveChanges } from '../issues/store';
import {
  createGitboardFiles,
  isInitialized,
  openRepo,
  readConfigFile,
  replaceConfigFile,
  writeConfigFile,
  type ConfigFile,
  type ConfigFormat,
  type Repo,
} from '../storage/repo-files';
import {
  PROJECT_KEY_PATTERN,
  RepoConfigSchema,
  type ColumnsChangeResult,
  type ColumnsInfo,
  type ConfigConvertResult,
  type ProjectCreateInput,
  type ProjectInfo,
  type ProjectUpdateInput,
  type RepoConfig,
  type RepoInitInput,
} from '../types';
import { effectiveColumns, normaliseColumns, titleCase, withNames } from './columns';

export interface LoadedConfig {
  config: RepoConfig;
  hash: string;
  format: ConfigFormat;
  /** File name inside `.gitboard/`. */
  name: string;
}

/** YAML by default (comments allowed); JSON when asked for. */
export function serializeConfig(config: RepoConfig, format: ConfigFormat = 'yaml'): string {
  return format === 'json' ? `${JSON.stringify(config, null, 2)}\n` : stringifyYaml(config, { lineWidth: 0 });
}

function parseConfigFile(file: ConfigFile): RepoConfig {
  let raw: unknown;
  if (file.format === 'json') {
    try {
      raw = JSON.parse(file.text);
    } catch (error) {
      throw new GitboardError('INVALID_CONFIG', `.gitboard/${file.name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const doc = parseDocument(file.text);
    if (doc.errors.length > 0) {
      throw new GitboardError('INVALID_CONFIG', `.gitboard/${file.name} is not valid YAML: ${doc.errors[0]?.message ?? 'unknown error'}`);
    }
    raw = doc.toJS() ?? {}; // an empty file is an empty config
  }
  const result = RepoConfigSchema.safeParse(raw);
  if (!result.success) throw new GitboardError('INVALID_CONFIG', `.gitboard/${file.name} is invalid: ${formatZodError(result.error)}`);
  return result.data;
}

export async function loadConfig(repo: Repo): Promise<LoadedConfig> {
  const file = await readConfigFile(repo);
  return { config: parseConfigFile(file), hash: file.hash, format: file.format, name: file.name };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** How list items are recognised across edits: a string is itself, an object is its `id` or `key`. */
function identityOf(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  if (isPlainObject(item)) {
    if (typeof item.id === 'string') return item.id;
    if (typeof item.key === 'string') return item.key;
  }
  return undefined;
}

function identities(list: unknown[]): string[] | null {
  const ids = list.map(identityOf);
  return ids.every((id): id is string => id !== undefined) && new Set(ids).size === ids.length ? ids : null;
}

/**
 * Patches a list whose items can be recognised (columns, projects, views): kept items are edited in place,
 * removed ones deleted and new ones inserted, so comments on the other items survive. Returns false when the
 * items were reordered, which the caller handles by rewriting the list.
 */
function patchKeyedList(doc: Document, path: Array<string | number>, from: unknown[], to: unknown[], fromIds: string[], toIds: string[]): boolean {
  const kept = fromIds.filter((id) => toIds.includes(id));
  if (!isDeepStrictEqual(kept, toIds.filter((id) => fromIds.includes(id)))) return false;
  for (let i = fromIds.length - 1; i >= 0; i--) if (!toIds.includes(fromIds[i] as string)) doc.deleteIn([...path, i]);
  const seq = doc.getIn(path, true);
  toIds.forEach((id, i) => {
    const oldIndex = fromIds.indexOf(id);
    if (oldIndex >= 0) patchDocument(doc, [...path, i], from[oldIndex], to[i]);
    else if (isSeq(seq)) seq.items.splice(i, 0, doc.createNode(to[i]));
    else doc.setIn([...path, i], to[i]);
  });
  return true;
}

/** Edits `doc` so that it represents `to`, changing as little as possible so comments survive. */
function patchDocument(doc: Document, path: Array<string | number>, from: unknown, to: unknown): void {
  if (isDeepStrictEqual(from, to)) return;
  if (path.length === 0 && !(isPlainObject(from) && isPlainObject(to))) {
    doc.contents = doc.createNode(to) as typeof doc.contents;
    return;
  }
  if (isPlainObject(from) && isPlainObject(to)) {
    for (const key of Object.keys(from)) if (!(key in to)) doc.deleteIn([...path, key]);
    for (const [key, value] of Object.entries(to)) {
      if (!(key in from)) doc.setIn([...path, key], value);
      else patchDocument(doc, [...path, key], from[key], value);
    }
  } else if (Array.isArray(from) && Array.isArray(to)) {
    const fromIds = identities(from);
    const toIds = identities(to);
    if (fromIds && toIds) {
      if (patchKeyedList(doc, path, from, to, fromIds, toIds)) return;
      doc.setIn(path, to); // reordered: rewrite the list
      return;
    }
    const common = Math.min(from.length, to.length);
    for (let i = 0; i < common; i++) patchDocument(doc, [...path, i], from[i], to[i]);
    for (let i = from.length - 1; i >= to.length; i--) doc.deleteIn([...path, i]);
    for (let i = common; i < to.length; i++) doc.addIn(path, to[i]);
  } else {
    doc.setIn(path, to);
  }
}

/**
 * Applies the new config to the existing YAML text, keeping comments and layout. The result is checked
 * against what was asked for; if it does not match, the file is regenerated (losing comments) rather than
 * ever writing something different.
 */
function patchYamlText(text: string, after: RepoConfig): string {
  const doc = parseDocument(text);
  if (doc.errors.length === 0) {
    try {
      patchDocument(doc, [], doc.toJS() ?? {}, after);
      const patched = doc.toString({ lineWidth: 0 });
      const check = parseDocument(patched);
      if (check.errors.length === 0 && isDeepStrictEqual(check.toJS(), JSON.parse(JSON.stringify(after)))) return patched;
    } catch {
      /* fall through to a clean rewrite */
    }
  }
  return stringifyYaml(after, { lineWidth: 0 });
}

/** Read-modify-write in the file's own format. The file is only rewritten when the data actually changes. */
export async function updateConfig(repo: Repo, mutate: (config: RepoConfig) => void): Promise<RepoConfig> {
  const file = await readConfigFile(repo);
  const loaded = parseConfigFile(file);
  const next = structuredClone(loaded);
  mutate(next);
  if (isDeepStrictEqual(next, loaded)) return loaded;
  const parsed = RepoConfigSchema.safeParse(next);
  if (!parsed.success) throw new GitboardError('INVALID_CONFIG', formatZodError(parsed.error));
  const text = file.format === 'json' ? serializeConfig(parsed.data, 'json') : patchYamlText(file.text, parsed.data);
  await writeConfigFile(repo, text, file.hash);
  return parsed.data;
}

/** Moves the config to another format (`config.yaml` or `config.json`). YAML comments do not survive a move to JSON. */
export async function convertConfig(repo: Repo, to: ConfigFormat = 'yaml'): Promise<ConfigConvertResult> {
  const file = await readConfigFile(repo);
  if (file.format === to) return { from: file.name, to: file.name, changed: false };
  const newName = to === 'yaml' ? 'config.yaml' : 'config.json';
  await replaceConfigFile(repo, newName, serializeConfig(parseConfigFile(file), to), file.hash);
  return { from: file.name, to: newName, changed: true };
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
  if (await isInitialized(repo)) throw new GitboardError('ALREADY_INITIALIZED', 'This repository already has a Gitboard config in .gitboard/.');
  const name = input.projectName ?? path.basename(repo.root);
  const key = input.projectKey ?? deriveProjectKey(name);
  const config: RepoConfig = {
    version: 1,
    ...(input.columns ? { columns: normaliseColumns(input.columns) } : {}),
    projects: [{ key, name }],
  };
  const parsed = RepoConfigSchema.parse(config);
  await createGitboardFiles(repo, serializeConfig(parsed, 'yaml'), 'config.yaml');
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

type StoredColumns = Array<{ id: string; name?: string; done?: boolean }> | undefined;

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
  input: { columns: ReadonlyArray<string | { id: string; name?: string | undefined; done?: boolean | undefined }>; project?: string | undefined; remap?: Record<string, string> | undefined },
): Promise<ColumnsChangeResult> {
  // A column that keeps its id keeps its "done" flag unless the caller says otherwise (ADR-f8d6236), so
  // reordering or renaming columns never silently changes what counts as done.
  const { config } = await loadConfig(repo);
  // Only `done: true` needs carrying: once any column says something, unmarked columns are not done.
  // A custom display name ("To Do") is carried too, so re-setting ids does not turn it into "Todo".
  const existing = effectiveColumns(config, input.project).columns;
  const wasDone = new Set(existing.filter((c) => c.done).map((c) => c.id));
  let carried = input.columns.map((column) => {
    let entry: { id: string; name?: string | undefined; done?: boolean | undefined } = typeof column === 'string' ? { id: column } : column;
    const previous = existing.find((e) => e.id === entry.id);
    if (entry.name === undefined && previous && previous.name !== titleCase(previous.id)) entry = { ...entry, name: previous.name };
    return entry.done === undefined && wasDone.has(entry.id) ? { ...entry, done: true } : entry;
  });
  // A list that deliberately had no done column keeps it that way instead of falling back to "the last one".
  const saysNothing = carried.every((c) => c.done === undefined);
  if (saysNothing && existing.length > 1 && wasDone.size === 0) carried = carried.map((c) => ({ ...c, done: false }));
  return changeColumns(repo, { project: input.project }, normaliseColumns(carried), input.remap);
}

export async function resetColumns(
  repo: Repo,
  input: { project?: string | undefined; remap?: Record<string, string> | undefined },
): Promise<ColumnsChangeResult> {
  return changeColumns(repo, { project: input.project }, undefined, input.remap);
}
