/**
 * Web-safe types and schemas (ADR-9b13ab6).
 *
 * This is the only core module the web app may import. It must stay free of Node imports: only `zod`
 * and plain TypeScript. Schemas here are the single source of validation for frontmatter, config and
 * operation inputs.
 */
import { z } from 'zod';
import { REPO_SLUG_PATTERN } from './repos/slug';

// Pure helpers the web app needs (types.ts is its only core import).
export { resolveSlug, type SlugMatch } from './repos/slug';

export const ID_PATTERN = /^[0-9a-f]{12}$/;
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
export const COLUMN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const ISSUE_TYPES = ['story', 'epic'] as const;
export type Priority = (typeof PRIORITIES)[number];
export type IssueType = (typeof ISSUE_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------------------------

export const IdSchema = z.string().regex(ID_PATTERN, 'must be 12 lowercase hex characters');
export const ProjectKeySchema = z
  .string()
  .regex(PROJECT_KEY_PATTERN, 'must be 2-10 characters: an uppercase letter followed by uppercase letters or digits');
const IsoDateSchema = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO-8601 date');
const LabelSchema = z.string().trim().min(1).max(64);

export const ColumnSchema = z
  .object({
    id: z.string().regex(COLUMN_ID_PATTERN, 'must be lowercase letters, digits and dashes'),
    name: z.string().trim().min(1).optional(),
    /**
     * Marks a column as "done" (completed or closed work). If no column in a list sets this, the last
     * column counts as done, as before (ADR-f8d6236).
     */
    done: z.boolean().optional(),
  })
  .strict();
export const ColumnsSchema = z
  .array(ColumnSchema)
  .min(1, 'at least one column is required')
  .refine((cols) => new Set(cols.map((c) => c.id)).size === cols.length, 'column ids must be unique');

// ---------------------------------------------------------------------------------------------
// Views (ADR-9082368)
// ---------------------------------------------------------------------------------------------

/** The views Gitboard knows how to present a project with. */
export const VIEW_IDS = ['kanban', 'backlog'] as const;
export type ViewId = (typeof VIEW_IDS)[number];
export const ViewIdSchema = z.enum(VIEW_IDS);
/**
 * Stored lists tolerate ids this version does not know (for example from a newer Gitboard): they are
 * ignored when resolving views and reported by `validate`.
 */
export const StoredViewsSchema = z.array(z.string().min(1)).min(1, 'at least one view is required');

/** Columns of the child-issue table in an epic's detail (FEAT-130c757). */
export const EPIC_COLUMN_IDS = ['ref', 'title', 'status', 'priority', 'labels'] as const;
export type EpicColumnId = (typeof EPIC_COLUMN_IDS)[number];
export const StoredEpicColumnsSchema = z.array(z.string().min(1)).min(1, 'at least one epic column is required');

// ---------------------------------------------------------------------------------------------
// Stored data: repo config and issue frontmatter
// ---------------------------------------------------------------------------------------------

export const ProjectDefSchema = z
  .object({
    key: ProjectKeySchema,
    name: z.string().trim().min(1),
    description: z.string().optional(),
    columns: ColumnsSchema.optional(),
    views: StoredViewsSchema.optional(),
    epicColumns: StoredEpicColumnsSchema.optional(),
  })
  .passthrough();

export const RepoConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    /** Portable repository id for web URLs; needed only when the repository has no `origin` (FEAT-130c757). */
    id: z.string().trim().regex(REPO_SLUG_PATTERN, 'must be lowercase letters, digits, dots, dashes and slashes').optional(),
    columns: ColumnsSchema.optional(),
    views: StoredViewsSchema.optional(),
    epicColumns: StoredEpicColumnsSchema.optional(),
    projects: z.array(ProjectDefSchema).default([]),
  })
  .passthrough();
export type RepoConfig = z.output<typeof RepoConfigSchema>;
export type ProjectDef = z.output<typeof ProjectDefSchema>;

/** Unknown keys pass through so user extensions survive writes (ADR-30abf7d). */
export const IssueFrontmatterSchema = z
  .object({
    id: IdSchema,
    title: z.string().trim().min(1),
    status: z.string().trim().min(1),
    project: ProjectKeySchema,
    type: z.enum(ISSUE_TYPES).default('story'),
    priority: z.enum(PRIORITIES).optional(),
    labels: z.array(z.string()).default([]),
    parent: IdSchema.optional(),
    rank: z.string().min(1).optional(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema.optional(),
  })
  .passthrough();
export type IssueFrontmatter = z.output<typeof IssueFrontmatterSchema>;

// ---------------------------------------------------------------------------------------------
// Operation inputs (shared by CLI, HTTP and tests)
// ---------------------------------------------------------------------------------------------

const ColumnInputSchema = z.union([
  z.string().regex(COLUMN_ID_PATTERN, 'must be lowercase letters, digits and dashes').transform((id) => ({ id })),
  ColumnSchema,
]);

export const RepoAddInput = z.object({ source: z.string().trim().min(1), name: z.string().trim().min(1).optional() });
export const RepoRefInput = z.object({ repo: z.string().trim().min(1) });
export const EmptyInput = z.object({});
export const RepoInitInput = z.object({
  columns: z.array(ColumnInputSchema).min(1).optional(),
  projectKey: ProjectKeySchema.optional(),
  projectName: z.string().trim().min(1).optional(),
});

export const ProjectCreateInput = z.object({
  key: ProjectKeySchema,
  name: z.string().trim().min(1),
  description: z.string().optional(),
  columns: z.array(ColumnInputSchema).min(1).optional(),
});
export const ProjectUpdateInput = z.object({
  key: ProjectKeySchema,
  name: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
});
export const ProjectKeyInput = z.object({ key: ProjectKeySchema });

const RemapSchema = z.record(z.string(), z.string());
export const ColumnsShowInput = z.object({ project: ProjectKeySchema.optional() });
export const ColumnsSetInput = z.object({
  columns: z.array(ColumnInputSchema).min(1),
  project: ProjectKeySchema.optional(),
  remap: RemapSchema.optional(),
});
export const ColumnsResetInput = z.object({ project: ProjectKeySchema.optional(), remap: RemapSchema.optional() });

export const IssueListInput = z.object({
  project: ProjectKeySchema.optional(),
  status: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(ISSUE_TYPES).optional(),
  parent: z.string().trim().min(1).optional(),
  q: z.string().optional(),
});
export const IssueRefInput = z.object({ ref: z.string().trim().min(1) });
export const IssueCreateInput = z.object({
  title: z.string().trim().min(1),
  body: z.string().optional(),
  project: ProjectKeySchema.optional(),
  type: z.enum(ISSUE_TYPES).optional(),
  status: z.string().trim().min(1).optional(),
  priority: z.enum(PRIORITIES).optional(),
  labels: z.array(LabelSchema).optional(),
  parent: z.string().trim().min(1).optional(),
});
export const IssueUpdateInput = z.object({
  ref: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  body: z.string().optional(),
  status: z.string().trim().min(1).optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  labels: z.array(LabelSchema).optional(),
  addLabels: z.array(LabelSchema).optional(),
  removeLabels: z.array(LabelSchema).optional(),
  project: ProjectKeySchema.optional(),
  /** An issue ref, or `null` to remove the parent. */
  parent: z.string().trim().min(1).nullable().optional(),
  rank: z.string().min(1).nullable().optional(),
  /** Reject with CONFLICT if the file changed since the caller read it. */
  expectedHash: z.string().optional(),
});
export const IssueMoveInput = z.object({
  ref: z.string().trim().min(1),
  status: z.string().trim().min(1).optional(),
  before: z.string().trim().min(1).optional(),
  after: z.string().trim().min(1).optional(),
  position: z.enum(['top', 'bottom']).optional(),
  expectedHash: z.string().optional(),
});
export const IssueDeleteInput = z.object({ id: IdSchema, unlinkChildren: z.boolean().optional() });
export const IssueCheckInput = z.object({
  ref: z.string().trim().min(1),
  /** 1-based position among the issue's checklist items. */
  index: z.number().int().min(1),
  checked: z.boolean().optional(),
  expectedHash: z.string().optional(),
});
export const ConfigConvertInput = z.object({ to: z.enum(['yaml', 'json']).optional() });
export const BoardGetInput = z.object({ project: ProjectKeySchema.optional() });
export const BacklogGetInput = z.object({
  project: ProjectKeySchema.optional(),
  /** Also include the last column (the "done" column), which is hidden by default. */
  includeDone: z.boolean().optional(),
});

const UniqueViewList = z
  .array(ViewIdSchema)
  .min(1, 'at least one view is required')
  .refine((views) => new Set(views).size === views.length, 'views must be unique');
export const ViewsShowInput = z.object({ project: ProjectKeySchema.optional() });
export const ViewsSetInput = z.object({ views: UniqueViewList, project: ProjectKeySchema.optional() });
export const ViewsResetInput = z.object({ project: ProjectKeySchema.optional() });

export const SkillsInput = z.object({
  agents: z.array(z.string().trim().min(1)).optional(),
  global: z.boolean().optional(),
  mode: z.enum(['copy', 'link']).optional(),
  path: z.string().optional(),
  force: z.boolean().optional(),
});

export type RepoAddInput = z.input<typeof RepoAddInput>;
export type RepoInitInput = z.input<typeof RepoInitInput>;
export type ProjectCreateInput = z.input<typeof ProjectCreateInput>;
export type ProjectUpdateInput = z.input<typeof ProjectUpdateInput>;
export type ColumnsSetInput = z.input<typeof ColumnsSetInput>;
export type ColumnsResetInput = z.input<typeof ColumnsResetInput>;
export type IssueListInput = z.input<typeof IssueListInput>;
export type IssueCreateInput = z.input<typeof IssueCreateInput>;
export type IssueUpdateInput = z.input<typeof IssueUpdateInput>;
export type IssueMoveInput = z.input<typeof IssueMoveInput>;
export type IssueDeleteInput = z.input<typeof IssueDeleteInput>;
export type IssueCheckInput = z.input<typeof IssueCheckInput>;
export type ConfigConvertInput = z.input<typeof ConfigConvertInput>;
export type BoardGetInput = z.input<typeof BoardGetInput>;
export type BacklogGetInput = z.input<typeof BacklogGetInput>;
export type ViewsSetInput = z.input<typeof ViewsSetInput>;
export type ViewsResetInput = z.input<typeof ViewsResetInput>;

// ---------------------------------------------------------------------------------------------
// Operation outputs
// ---------------------------------------------------------------------------------------------

export interface Column {
  id: string;
  name: string;
  /** True for columns that hold finished work (ADR-f8d6236). Always resolved, never undefined. */
  done: boolean;
}
export type ColumnSource = 'project' | 'repo' | 'builtin';
export interface ColumnsInfo {
  project?: string;
  columns: Column[];
  source: ColumnSource;
}

export interface ConfigConvertResult {
  /** File names inside `.gitboard/`. Equal when the config already had the requested format. */
  from: string;
  to: string;
  changed: boolean;
}

export interface ColumnsChangeResult extends ColumnsInfo {
  /** Issues whose status was remapped because their column was removed. */
  remapped: number;
}

export interface ChecklistItem {
  /** 1-based. */
  index: number;
  text: string;
  checked: boolean;
}

export interface Issue {
  id: string;
  /** The issue key shown to people: `KEY-<shortest unique prefix, min 7>`. Named `ref` in the API. */
  ref: string;
  title: string;
  status: string;
  project: string;
  type: IssueType;
  priority?: Priority;
  labels: string[];
  parent?: string;
  rank?: string;
  createdAt: string;
  updatedAt?: string;
  body: string;
  /** Content hash, for optimistic concurrency (`expectedHash`). */
  hash: string;
  checklist: ChecklistItem[];
}
export type IssueSummary = Pick<Issue, 'id' | 'ref' | 'title' | 'status' | 'project' | 'type'>;

export interface EpicProgress {
  total: number;
  /** Children in any of the project's done columns (ADR-f8d6236). */
  done: number;
  byStatus: Record<string, number>;
}
/** A child of an epic, with what the epic's child table can show. */
export interface EpicChild extends IssueSummary {
  priority?: Priority;
  labels: string[];
}

export interface IssueDetail extends Issue {
  parentIssue?: IssueSummary;
  children?: EpicChild[];
  progress?: EpicProgress;
}

export interface ProjectInfo {
  key: string;
  name: string;
  description?: string;
  /** Present only when the project overrides the repo columns. */
  columns?: Column[];
  issueCount: number;
}

export interface BoardColumn extends Column {
  issues: Issue[];
}
/** Which views are enabled for a project, and which layer decided (ADR-9082368). */
export interface ViewsInfo {
  project?: string;
  views: ViewId[];
  source: ColumnSource;
}
export interface Board {
  project: ProjectInfo;
  columnSource: ColumnSource;
  views: ViewsInfo;
  /** Columns of the child table in an epic's detail, resolved from the config. */
  epicColumns: EpicColumnId[];
  columns: BoardColumn[];
  epics: Array<IssueSummary & { progress: EpicProgress }>;
}
/** The project's open work as an ordered list, grouped by status (done columns are hidden unless asked for). */
export interface Backlog {
  project: ProjectInfo;
  views: ViewsInfo;
  sections: BoardColumn[];
  /** Ids of the project's done columns, which are hidden unless asked for (ADR-f8d6236). */
  doneStatuses: string[];
  /** Issues in the done columns that were left out. */
  hiddenCount: number;
  epics: Array<IssueSummary & { progress: EpicProgress }>;
}

export interface Problem {
  code: string;
  message: string;
  file?: string;
  id?: string;
}
export interface ValidateResult {
  ok: boolean;
  problems: Problem[];
  issueCount: number;
}

export interface RepoInfo {
  id: string;
  name: string;
  path: string;
  source: 'local' | 'remote';
  remoteUrl?: string;
  initialized: boolean;
  exists: boolean;
  isDefault: boolean;
  /** Portable URL path of the repository: `owner/name`, `provider/owner/name` on a conflict, or the config id. */
  slug: string;
  slugBase: string;
  provider?: string;
  slugSource: 'config' | 'origin' | 'registry';
}

export interface GitStatus {
  isGitRepo: boolean;
  branch?: string;
  detached?: boolean;
  /** True when there are uncommitted changes under `.gitboard/`. */
  dirty: boolean;
  changes: number;
}

export interface MoveResult {
  issue: Issue;
  /** Neighbouring issues that were assigned a rank so the move could be placed (ADR-95e910d). */
  reranked: string[];
}
export interface DeleteResult {
  id: string;
  unlinked: string[];
}

export interface SkillLocationResult {
  path: string;
  kind: 'canonical' | 'agent';
  mode: 'copy' | 'link';
  status: 'installed' | 'updated' | 'unchanged' | 'conflict' | 'outdated' | 'missing' | 'modified';
  agents: string[];
}
export interface SkillsResult {
  version: string;
  locations: SkillLocationResult[];
}
