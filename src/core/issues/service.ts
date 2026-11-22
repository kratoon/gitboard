/**
 * Issue business rules: projects, statuses, parents, ordering and issue keys. Every operation here is
 * the single implementation used by the CLI, the HTTP server and tests (ADR-9b13ab6).
 */
import { GitboardError } from '../errors';
import { nowIso } from '../runtime';
import { loadConfig, requireProject } from '../projects/config';
import { effectiveColumns } from '../projects/columns';
import { effectiveEpicColumns } from '../projects/epic-columns';
import { effectiveViews } from '../projects/views';
import { deleteIssueFile, type Repo } from '../storage/repo-files';
import type {
  Backlog,
  Board,
  BoardColumn,
  DeleteResult,
  EpicProgress,
  Issue,
  IssueCheckInput,
  IssueCreateInput,
  IssueDeleteInput,
  IssueDetail,
  IssueListInput,
  IssueMoveInput,
  IssueSummary,
  IssueUpdateInput,
  MoveResult,
  ProjectInfo,
  RepoConfig,
} from '../types';
import { shortPrefixLengths } from './id';
import { checklistOf, setChecklistItem } from './parse';
import { implicitKey, keyBetween, keysBetween } from './rank';
import { createStoredIssue, loadIssues, saveChanges, type IdSource, type StoredIssue } from './store';

export interface ServiceContext {
  warn: (message: string) => void;
}
const quiet: ServiceContext = { warn: () => undefined };

const DEFAULT_BODY = '## Description\n\n## Acceptance Criteria\n\n';

// ---------------------------------------------------------------------------------------------
// Snapshot and views
// ---------------------------------------------------------------------------------------------

interface Snapshot {
  config: RepoConfig;
  issues: StoredIssue[];
  byId: Map<string, StoredIssue>;
  lengths: Map<string, number>;
}

async function snapshot(repo: Repo): Promise<Snapshot> {
  const { config } = await loadConfig(repo);
  const { issues } = await loadIssues(repo);
  return {
    config,
    issues,
    byId: new Map(issues.map((issue) => [issue.id, issue])),
    lengths: shortPrefixLengths(issues.map((issue) => issue.id)),
  };
}

function toIssue(stored: StoredIssue, lengths: Map<string, number>): Issue {
  const { fm } = stored;
  return {
    id: stored.id,
    ref: `${fm.project}-${stored.id.slice(0, lengths.get(stored.id) ?? 7)}`,
    title: fm.title,
    status: fm.status,
    project: fm.project,
    type: fm.type,
    ...(fm.priority !== undefined ? { priority: fm.priority } : {}),
    labels: fm.labels,
    ...(fm.parent !== undefined ? { parent: fm.parent } : {}),
    ...(fm.rank !== undefined ? { rank: fm.rank } : {}),
    createdAt: fm.createdAt,
    ...(fm.updatedAt !== undefined ? { updatedAt: fm.updatedAt } : {}),
    body: stored.body,
    hash: stored.hash,
    checklist: checklistOf(stored.body),
  };
}

function toSummary(issue: Issue): IssueSummary {
  return { id: issue.id, ref: issue.ref, title: issue.title, status: issue.status, project: issue.project, type: issue.type };
}

/** Where a card sorts: its rank, or the key derived from priority and creation time (ADR-95e910d). */
export function sortKey(issue: StoredIssue): string {
  return issue.fm.rank ?? implicitKey(issue.fm.priority, issue.fm.createdAt, issue.id);
}

/** Order within a column: by sort key, ties broken by id. */
export function compareIssues(a: StoredIssue, b: StoredIssue): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

function progressFor(snap: Snapshot, epic: StoredIssue): EpicProgress {
  const children = snap.issues.filter((i) => i.fm.parent === epic.id);
  const columns = effectiveColumns(snap.config, epic.fm.project).columns;
  const byStatus: Record<string, number> = Object.fromEntries(columns.map((c) => [c.id, 0]));
  for (const child of children) byStatus[child.fm.status] = (byStatus[child.fm.status] ?? 0) + 1;
  const done = columns.filter((c) => c.done).reduce((sum, c) => sum + (byStatus[c.id] ?? 0), 0);
  return { total: children.length, done, byStatus };
}

// ---------------------------------------------------------------------------------------------
// Issue keys (ADR-18de7e0)
// ---------------------------------------------------------------------------------------------

const REF_WITH_KEY = /^([A-Z][A-Z0-9]{1,9})-([0-9a-f]{4,12})$/;
const REF_BARE = /^[0-9a-f]{4,12}$/;

function resolveRef(snap: Snapshot, ref: string, ctx: ServiceContext): StoredIssue {
  const withKey = REF_WITH_KEY.exec(ref);
  const prefix = withKey ? (withKey[2] ?? '') : ref.toLowerCase();
  if (!withKey && !REF_BARE.test(prefix)) {
    throw new GitboardError('INVALID_INPUT', `Invalid issue key "${ref}". Use a short id (a3f91c2), KEY-shortid (AUTH-a3f91c2) or the full 12-character id.`);
  }
  const matches = snap.issues.filter((issue) => issue.id.startsWith(prefix));
  if (matches.length === 0) throw new GitboardError('ISSUE_NOT_FOUND', `Issue not found: ${ref}`);
  if (matches.length > 1) {
    const refs = matches.map((m) => toIssue(m, snap.lengths).ref).join(', ');
    throw new GitboardError('AMBIGUOUS_ID', `Issue key "${ref}" matches ${matches.length} issues (${refs}). Use more characters.`);
  }
  const found = matches[0] as StoredIssue;
  const key = withKey?.[1];
  if (key !== undefined && key !== found.fm.project) {
    ctx.warn(`Issue key ${ref} names project ${key}, but the issue is in project ${found.fm.project}. Resolved by id.`);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------

function normaliseLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter((label) => label !== ''))];
}

function assertStatus(config: RepoConfig, project: string, status: string, hint?: string): void {
  const { columns } = effectiveColumns(config, project);
  if (!columns.some((column) => column.id === status)) {
    const valid = columns.map((column) => column.id).join(', ');
    throw new GitboardError('INVALID_STATUS', `Status "${status}" is not valid in project ${project}. Valid statuses: ${valid}.${hint ? ` ${hint}` : ''}`);
  }
}

function assertParent(parent: StoredIssue, project: string, childType: 'story' | 'epic'): void {
  if (childType === 'epic') throw new GitboardError('BAD_PARENT', 'An epic cannot have a parent.');
  if (parent.fm.type !== 'epic') throw new GitboardError('BAD_PARENT', `Issue ${parent.id} is not an epic, so it cannot be a parent.`);
  if (parent.fm.project !== project) {
    throw new GitboardError('BAD_PARENT', `Epic ${parent.id} is in project ${parent.fm.project}, but the issue is in project ${project}.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------------------------

export async function listIssues(repo: Repo, filter: IssueListInput = {}, ctx: ServiceContext = quiet): Promise<Issue[]> {
  const snap = await snapshot(repo);
  if (filter.project !== undefined) requireProject(snap.config, filter.project);
  const parentId = filter.parent === undefined ? undefined : resolveRef(snap, filter.parent, ctx).id;
  const query = filter.q?.trim().toLowerCase();
  const label = filter.label?.toLowerCase();

  const selected = snap.issues.filter((issue) => {
    const { fm } = issue;
    if (filter.project !== undefined && fm.project !== filter.project) return false;
    if (filter.status !== undefined && fm.status !== filter.status) return false;
    if (filter.priority !== undefined && (fm.priority ?? 'medium') !== filter.priority) return false;
    if (filter.type !== undefined && fm.type !== filter.type) return false;
    if (parentId !== undefined && fm.parent !== parentId) return false;
    if (label !== undefined && !fm.labels.some((l) => l.toLowerCase() === label)) return false;
    if (query) {
      // `KEY-id` lets an issue key of any short length (KEY-6930f51) match, and the project key alone matches too.
      const haystack = `${fm.title}\n${issue.body}\n${issue.id}\n${fm.project}-${issue.id}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const projectOrder = new Map(snap.config.projects.map((p, i) => [p.key, i]));
  const statusIndex = (issue: StoredIssue) =>
    effectiveColumns(snap.config, issue.fm.project).columns.findIndex((c) => c.id === issue.fm.status);
  selected.sort((a, b) => {
    const byProject = (projectOrder.get(a.fm.project) ?? 999) - (projectOrder.get(b.fm.project) ?? 999);
    if (byProject !== 0) return byProject;
    const sa = statusIndex(a);
    const sb = statusIndex(b);
    if (sa !== sb) return (sa < 0 ? 999 : sa) - (sb < 0 ? 999 : sb);
    return compareIssues(a, b);
  });
  return selected.map((issue) => toIssue(issue, snap.lengths));
}

export async function getIssue(repo: Repo, ref: string, ctx: ServiceContext = quiet): Promise<IssueDetail> {
  const snap = await snapshot(repo);
  const stored = resolveRef(snap, ref, ctx);
  const detail: IssueDetail = toIssue(stored, snap.lengths);
  const parent = stored.fm.parent === undefined ? undefined : snap.byId.get(stored.fm.parent);
  if (parent) detail.parentIssue = toSummary(toIssue(parent, snap.lengths));
  if (stored.fm.type === 'epic') {
    detail.children = snap.issues
      .filter((i) => i.fm.parent === stored.id)
      .sort(compareIssues)
      .map((child) => {
        const issue = toIssue(child, snap.lengths);
        return { ...toSummary(issue), ...(issue.priority !== undefined ? { priority: issue.priority } : {}), labels: issue.labels };
      });
    detail.progress = progressFor(snap, stored);
  }
  return detail;
}

function boardFor(snap: Snapshot, project: RepoConfig['projects'][number]): Board {
  const info = effectiveColumns(snap.config, project.key);
  const own = snap.issues.filter((i) => i.fm.project === project.key);
  // Epics are not cards in the status columns; they are listed separately with their progress (ADR-6369337).
  const cards = own.filter((i) => i.fm.type !== 'epic');
  const columns: BoardColumn[] = info.columns.map((column) => ({
    ...column,
    issues: cards
      .filter((i) => i.fm.status === column.id)
      .sort(compareIssues)
      .map((i) => toIssue(i, snap.lengths)),
  }));
  // Issues whose status is not a column (for example after an external edit) stay visible.
  const known = new Set(info.columns.map((c) => c.id));
  for (const status of [...new Set(cards.map((i) => i.fm.status))].filter((s) => !known.has(s))) {
    columns.push({
      id: status,
      name: `${status} (unknown)`,
      done: false,
      issues: cards
        .filter((i) => i.fm.status === status)
        .sort(compareIssues)
        .map((i) => toIssue(i, snap.lengths)),
    });
  }
  const projectInfo: ProjectInfo = {
    key: project.key,
    name: project.name,
    ...(project.description !== undefined ? { description: project.description } : {}),
    ...(project.columns ? { columns: info.columns } : {}),
    issueCount: own.length,
  };
  return {
    project: projectInfo,
    columnSource: info.source,
    views: effectiveViews(snap.config, project.key),
    epicColumns: effectiveEpicColumns(snap.config, project.key),
    columns,
    epics: own
      .filter((i) => i.fm.type === 'epic')
      .sort(compareIssues)
      .map((epic) => ({ ...toSummary(toIssue(epic, snap.lengths)), progress: progressFor(snap, epic) })),
  };
}

export async function getBoard(repo: Repo, input: { project?: string | undefined } = {}): Promise<Board[]> {
  const snap = await snapshot(repo);
  if (input.project !== undefined) requireProject(snap.config, input.project);
  return snap.config.projects.filter((p) => input.project === undefined || p.key === input.project).map((p) => boardFor(snap, p));
}

/**
 * The backlog view's data (ADR-9082368): the same cards and order as the board, flattened into sections by
 * status. Columns flagged done (ADR-f8d6236) are left out unless `includeDone` is set.
 */
export async function getBacklog(
  repo: Repo,
  input: { project?: string | undefined; includeDone?: boolean | undefined } = {},
): Promise<Backlog[]> {
  const snap = await snapshot(repo);
  if (input.project !== undefined) requireProject(snap.config, input.project);
  return snap.config.projects
    .filter((p) => input.project === undefined || p.key === input.project)
    .map((project): Backlog => {
      const board = boardFor(snap, project);
      const doneStatuses = effectiveColumns(snap.config, project.key).columns.filter((c) => c.done).map((c) => c.id);
      const hidden = input.includeDone ? [] : board.columns.filter((c) => doneStatuses.includes(c.id));
      return {
        project: board.project,
        views: board.views,
        sections: board.columns.filter((c) => !hidden.includes(c)),
        doneStatuses,
        hiddenCount: hidden.reduce((sum, c) => sum + c.issues.length, 0),
        epics: board.epics,
      };
    });
}

// ---------------------------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------------------------

export async function createIssue(
  repo: Repo,
  input: IssueCreateInput,
  ctx: ServiceContext = quiet,
  source: IdSource = {},
): Promise<Issue> {
  const snap = await snapshot(repo);
  const type = input.type ?? 'story';

  let project = input.project;
  if (project === undefined) {
    const only = snap.config.projects.length === 1 ? snap.config.projects[0] : undefined;
    if (!only) {
      const known = snap.config.projects.map((p) => p.key).join(', ') || '(none; create one with `gitboard project create`)';
      throw new GitboardError('MISSING_INPUT', `A project is required. Known projects: ${known}.`);
    }
    project = only.key;
  }
  requireProject(snap.config, project);

  const columns = effectiveColumns(snap.config, project).columns;
  const status = input.status ?? (columns[0]?.id as string);
  assertStatus(snap.config, project, status);

  let parentId: string | undefined;
  if (input.parent !== undefined) {
    const parent = resolveRef(snap, input.parent, ctx);
    assertParent(parent, project, type);
    parentId = parent.id;
  }
  if (type === 'epic' && input.parent !== undefined) throw new GitboardError('BAD_PARENT', 'An epic cannot have a parent.');

  const stored = await createStoredIssue(
    repo,
    {
      title: input.title,
      status,
      project,
      type,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      labels: normaliseLabels(input.labels ?? []),
      ...(parentId !== undefined ? { parent: parentId } : {}),
      createdAt: nowIso(),
    },
    input.body ?? DEFAULT_BODY,
    source,
  );
  const lengths = shortPrefixLengths([...snap.issues.map((i) => i.id), stored.id]);
  return toIssue(stored, lengths);
}

export async function updateIssue(repo: Repo, input: IssueUpdateInput, ctx: ServiceContext = quiet): Promise<Issue> {
  const snap = await snapshot(repo);
  const stored = resolveRef(snap, input.ref, ctx);
  const { fm } = stored;
  const changes: Record<string, unknown> = {};

  const projectChanging = input.project !== undefined && input.project !== fm.project;
  const project = input.project ?? fm.project;
  if (projectChanging) {
    requireProject(snap.config, project);
    if (fm.type === 'epic' && snap.issues.some((i) => i.fm.parent === stored.id)) {
      throw new GitboardError('HAS_CHILDREN', 'This epic has child issues in its current project. Reparent or unlink them before moving the epic.');
    }
    if (fm.parent !== undefined && input.parent === undefined) {
      throw new GitboardError('BAD_PARENT', 'This issue has a parent in its current project. Clear it with `--no-parent` (or set a parent in the new project) when changing project.');
    }
    changes.project = project;
  }

  const statusChanging = input.status !== undefined && input.status !== fm.status;
  if (statusChanging || projectChanging) {
    const status = input.status ?? fm.status;
    assertStatus(snap.config, project, status, projectChanging && input.status === undefined ? 'Pass a status that exists in the new project.' : undefined);
    changes.status = status;
  }

  if (input.title !== undefined) changes.title = input.title;
  if (input.priority !== undefined) changes.priority = input.priority === null ? undefined : input.priority;
  if (input.labels !== undefined || input.addLabels !== undefined || input.removeLabels !== undefined) {
    const removed = new Set(input.removeLabels ?? []);
    changes.labels = normaliseLabels([...(input.labels ?? fm.labels), ...(input.addLabels ?? [])]).filter((l) => !removed.has(l));
  }
  if (input.parent === null) {
    changes.parent = undefined;
  } else if (input.parent !== undefined) {
    const parent = resolveRef(snap, input.parent, ctx);
    if (parent.id === stored.id) throw new GitboardError('BAD_PARENT', 'An issue cannot be its own parent.');
    assertParent(parent, project, fm.type);
    changes.parent = parent.id;
  }
  if (input.rank !== undefined) changes.rank = input.rank === null ? undefined : input.rank;

  const result = await saveChanges(repo, stored, { fm: changes, ...(input.body !== undefined ? { body: input.body } : {}) }, input.expectedHash);
  return toIssue(result.stored, snap.lengths);
}

interface Placement {
  rank: string;
  assign: Array<{ issue: StoredIssue; rank: string }>;
}

/**
 * Chooses a rank for a card inserted at `index` of `column` (the column without the moved card): any key
 * between its two neighbours' sort keys, so only the moved card is written. The one exception is a column
 * whose neighbours cannot be separated (equal or inverted keys left by a merge, or a hand-edited rank that is
 * not a valid key); then the whole column is re-ranked (ADR-95e910d).
 */
function computePlacement(column: StoredIssue[], index: number): Placement {
  const prev = column[index - 1];
  const next = column[index];
  const before = prev ? sortKey(prev) : null;
  // Top of the column: stay above every card that is ever derived or ranked later, not just above the
  // current first card, so "top" keeps meaning top. Keys starting with `h` are the derived ones.
  const after = next ? (before === null && sortKey(next).startsWith('h') ? 'a0' : sortKey(next)) : null;
  if (before !== null && after !== null && before >= after) return rebalance(column, index);
  try {
    return { rank: keyBetween(before, after), assign: [] };
  } catch {
    return rebalance(column, index);
  }
}

function rebalance(column: StoredIssue[], index: number): Placement {
  const keys = keysBetween(null, null, column.length + 1);
  const assign: Placement['assign'] = [];
  let k = 0;
  column.forEach((issue, i) => {
    if (i === index) k++;
    const rank = keys[k++] as string;
    if (issue.fm.rank !== rank) assign.push({ issue, rank });
  });
  return { rank: keys[index] as string, assign };
}

export async function moveIssue(repo: Repo, input: IssueMoveInput, ctx: ServiceContext = quiet): Promise<MoveResult> {
  const snap = await snapshot(repo);
  const stored = resolveRef(snap, input.ref, ctx);
  const { fm } = stored;
  const positions = [input.before, input.after, input.position].filter((v) => v !== undefined).length;
  if (positions > 1) throw new GitboardError('INVALID_INPUT', 'Use only one of --before, --after, --top or --bottom.');

  const status = input.status ?? fm.status;
  const statusChanging = status !== fm.status;
  if (statusChanging) assertStatus(snap.config, fm.project, status);

  if (!statusChanging && positions === 0) {
    return { issue: toIssue(stored, snap.lengths), reranked: [] };
  }

  // A plain status change says nothing about order, so no card is ranked: the issue drops the rank it had in
  // its old column and sorts among the unranked cards (by priority, then creation time). Only this issue's
  // file changes. Any explicit position (--top, --bottom, --before, --after, or a drag in the UI) ranks it.
  if (positions === 0) {
    const result = await saveChanges(repo, stored, { fm: { status, rank: undefined } }, input.expectedHash);
    return { issue: toIssue(result.stored, snap.lengths), reranked: [] };
  }

  const inColumn = snap.issues.filter((i) => i.fm.project === fm.project && i.fm.status === status);
  const column = inColumn.filter((i) => i.id !== stored.id).sort(compareIssues);

  let index = column.length; // default: bottom of the target column
  if (input.position === 'top') index = 0;
  if (input.before !== undefined || input.after !== undefined) {
    const anchor = resolveRef(snap, (input.before ?? input.after) as string, ctx);
    const at = column.findIndex((i) => i.id === anchor.id);
    if (at < 0) {
      throw new GitboardError('INVALID_POSITION', `Issue ${anchor.id} is not in the "${status}" column of project ${fm.project}.`);
    }
    index = input.before !== undefined ? at : at + 1;
  }

  // Dropping a card where it already is must not touch any file.
  if (!statusChanging && inColumn.sort(compareIssues).findIndex((i) => i.id === stored.id) === index) {
    return { issue: toIssue(stored, snap.lengths), reranked: [] };
  }

  const placement = computePlacement(column, index);
  for (const { issue, rank } of placement.assign) await saveChanges(repo, issue, { fm: { rank } });
  const result = await saveChanges(
    repo,
    stored,
    { fm: { ...(statusChanging ? { status } : {}), rank: placement.rank } },
    input.expectedHash,
  );
  return { issue: toIssue(result.stored, snap.lengths), reranked: placement.assign.map((a) => a.issue.id) };
}

export async function deleteIssue(repo: Repo, input: IssueDeleteInput): Promise<DeleteResult> {
  const snap = await snapshot(repo);
  const stored = snap.byId.get(input.id);
  const children = snap.issues.filter((i) => i.fm.parent === input.id);
  if (children.length > 0 && !input.unlinkChildren) {
    throw new GitboardError('HAS_CHILDREN', `Issue ${input.id} is the parent of ${children.length} issue(s). Delete or reparent them, or pass --unlink-children.`);
  }
  for (const child of children) await saveChanges(repo, child, { fm: { parent: undefined } });
  await deleteIssueFile(repo, input.id, stored?.hash);
  return { id: input.id, unlinked: children.map((c) => c.id) };
}

export async function checkItem(repo: Repo, input: IssueCheckInput, ctx: ServiceContext = quiet): Promise<Issue> {
  const snap = await snapshot(repo);
  const stored = resolveRef(snap, input.ref, ctx);
  const rest = setChecklistItem(stored.parsed.rest, input.index, input.checked ?? true);
  if (rest === null) {
    const count = checklistOf(stored.body).length;
    throw new GitboardError('INVALID_INPUT', `Issue ${stored.id} has no checklist item ${input.index} (it has ${count}).`);
  }
  const result = await saveChanges(repo, stored, { fm: {}, rest }, input.expectedHash);
  return toIssue(result.stored, snap.lengths);
}
