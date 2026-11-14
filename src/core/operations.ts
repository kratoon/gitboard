/**
 * The operation registry (ADR-9b13ab6). Every business operation is declared here exactly once, with its
 * input schema, handler and CLI command name. The HTTP server mounts these generically and each CLI
 * command binds flags to the same input schema, so the two adapters cannot drift apart.
 */
import type { z } from 'zod';
import { GitboardError, formatZodError } from './errors';
import {
  checkItem,
  createIssue,
  deleteIssue,
  getBacklog,
  getBoard,
  getIssue,
  listIssues,
  moveIssue,
  updateIssue,
  type ServiceContext,
} from './issues/service';
import {
  changeColumns,
  convertConfig,
  createProject,
  deleteProject,
  initRepo,
  listProjects,
  loadConfig,
  resetColumns,
  setColumns,
  showColumns,
  updateProject,
} from './projects/config';
import { resetViews, setViews, showViews } from './projects/views';
import { getGitStatus } from './repos/git-status';
import { listRepos, registerRepo, removeRepo, requireInitialized, resolveRepo, setDefaultRepo } from './repos/registry';
import { installSkills, skillsStatus, syncSkills } from './skills/install';
import type { Repo } from './storage/repo-files';
import {
  BacklogGetInput,
  BoardGetInput,
  ColumnsResetInput,
  ConfigConvertInput,
  ColumnsSetInput,
  ColumnsShowInput,
  EmptyInput,
  IssueCheckInput,
  IssueCreateInput,
  IssueDeleteInput,
  IssueListInput,
  IssueMoveInput,
  IssueRefInput,
  IssueUpdateInput,
  ProjectCreateInput,
  ProjectKeyInput,
  ProjectUpdateInput,
  RepoAddInput,
  RepoInitInput,
  RepoRefInput,
  SkillsInput,
  ViewsResetInput,
  ViewsSetInput,
  ViewsShowInput,
} from './types';
import { validateRepo } from './validation/validate';

export type OperationScope = 'global' | 'repo' | 'repo-uninitialized';
export type Surface = 'cli' | 'http';

export interface OperationContext {
  cwd?: string | undefined;
  repo?: Repo | undefined;
  warnings: string[];
}

export interface Operation {
  name: string;
  description: string;
  scope: OperationScope;
  readOnly: boolean;
  surfaces: Surface[];
  /** The CLI command path that exposes this operation. A test verifies every one exists. */
  cli: string;
  input: z.ZodTypeAny;
  handler: (ctx: OperationContext, input: never) => Promise<unknown>;
}

function define<S extends z.ZodTypeAny>(
  op: Omit<Operation, 'input' | 'handler'> & { input: S; handler: (ctx: OperationContext, input: z.output<S>) => Promise<unknown> },
): Operation {
  return op as unknown as Operation;
}

const service = (ctx: OperationContext): ServiceContext => ({ warn: (message) => ctx.warnings.push(message) });
const repoOf = (ctx: OperationContext): Repo => {
  if (!ctx.repo) throw new GitboardError('NOT_IN_REPO', 'No repository selected.');
  return ctx.repo;
};
const cwdOf = (ctx: OperationContext): string => ctx.cwd ?? '.';
const BOTH: Surface[] = ['cli', 'http'];

export const operations: readonly Operation[] = [
  // --- repositories -------------------------------------------------------------------------
  define({
    name: 'repo.add', description: 'Register a local repository or clone and register an SSH remote.',
    scope: 'global', readOnly: false, surfaces: BOTH, cli: 'repo add', input: RepoAddInput,
    handler: (_ctx, input) => registerRepo(input.source, input.name),
  }),
  define({
    name: 'repo.list', description: 'List registered repositories.',
    scope: 'global', readOnly: true, surfaces: BOTH, cli: 'repo list', input: EmptyInput,
    handler: () => listRepos(),
  }),
  define({
    name: 'repo.remove', description: 'Remove a repository from the registry without deleting it.',
    scope: 'global', readOnly: false, surfaces: BOTH, cli: 'repo remove', input: RepoRefInput,
    handler: (_ctx, input) => removeRepo(input.repo),
  }),
  define({
    name: 'repo.default', description: 'Set the repository used when running outside any repo.',
    scope: 'global', readOnly: false, surfaces: BOTH, cli: 'repo default', input: RepoRefInput,
    handler: (_ctx, input) => setDefaultRepo(input.repo),
  }),
  define({
    name: 'repo.init', description: 'Initialise Gitboard in a repository.',
    scope: 'repo-uninitialized', readOnly: false, surfaces: BOTH, cli: 'init', input: RepoInitInput,
    handler: async (ctx, input) => {
      // Idempotent: on an initialised repo nothing is rewritten; it is only (re)registered.
      const repo = repoOf(ctx);
      let created = true;
      let projectKey: string | undefined;
      try {
        projectKey = (await initRepo(repo.root, input)).projectKey;
      } catch (error) {
        if (!(error instanceof GitboardError && error.code === 'ALREADY_INITIALIZED')) throw error;
        created = false;
        projectKey = (await loadConfig(repo)).config.projects[0]?.key;
        if (input.columns !== undefined || input.projectKey !== undefined || input.projectName !== undefined) {
          ctx.warnings.push(
            'Already initialised, so --columns, --project-key and --project-name were ignored. Use `gitboard columns set` or `gitboard project create` to change them.',
          );
        }
      }
      // Register the repo so the web UI lists it (a no-op if already registered). A directory that is
      // not a Git repository is still initialised, just not registered.
      let registered = false;
      try {
        await registerRepo(repo.root);
        registered = true;
      } catch (error) {
        const ignorable = error instanceof GitboardError && (error.code === 'NOT_A_GIT_REPO' || error.code === 'GIT_MISSING');
        if (!ignorable) throw error;
      }
      return { root: repo.root, ...(projectKey !== undefined ? { projectKey } : {}), created, registered };
    },
  }),

  // --- projects -----------------------------------------------------------------------------
  define({
    name: 'project.create', description: 'Create a project (a group of issues identified by a key).',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'project create', input: ProjectCreateInput,
    handler: (ctx, input) => createProject(repoOf(ctx), input),
  }),
  define({
    name: 'project.list', description: 'List projects.',
    scope: 'repo', readOnly: true, surfaces: BOTH, cli: 'project list', input: EmptyInput,
    handler: (ctx) => listProjects(repoOf(ctx)),
  }),
  define({
    name: 'project.update', description: 'Rename a project or change its description.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'project update', input: ProjectUpdateInput,
    handler: (ctx, input) => updateProject(repoOf(ctx), input),
  }),
  define({
    name: 'project.delete', description: 'Delete an empty project.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'project delete', input: ProjectKeyInput,
    handler: (ctx, input) => deleteProject(repoOf(ctx), input.key),
  }),

  // --- columns ------------------------------------------------------------------------------
  define({
    name: 'columns.show', description: 'Show the effective columns and which layer defines them.',
    scope: 'repo', readOnly: true, surfaces: BOTH, cli: 'columns show', input: ColumnsShowInput,
    handler: (ctx, input) => showColumns(repoOf(ctx), input.project),
  }),
  define({
    name: 'columns.set', description: 'Override the columns of the repo or of one project.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'columns set', input: ColumnsSetInput,
    handler: (ctx, input) => setColumns(repoOf(ctx), input),
  }),
  define({
    name: 'columns.reset', description: 'Remove a column override so the layer below applies.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'columns reset', input: ColumnsResetInput,
    handler: (ctx, input) => resetColumns(repoOf(ctx), input),
  }),

  // --- config -------------------------------------------------------------------------------
  define({
    name: 'config.convert', description: 'Convert the repository config between YAML (default) and JSON.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'config convert', input: ConfigConvertInput,
    handler: (ctx, input) => convertConfig(repoOf(ctx), input.to),
  }),

  // --- views --------------------------------------------------------------------------------
  define({
    name: 'views.show', description: 'Show which views are enabled and which layer decides.',
    scope: 'repo', readOnly: true, surfaces: BOTH, cli: 'views show', input: ViewsShowInput,
    handler: (ctx, input) => showViews(repoOf(ctx), input.project),
  }),
  define({
    name: 'views.set', description: 'Enable specific views for the repository, or for one project.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'views set', input: ViewsSetInput,
    handler: (ctx, input) => setViews(repoOf(ctx), input),
  }),
  define({
    name: 'views.reset', description: 'Remove a views override so the layer below applies.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'views reset', input: ViewsResetInput,
    handler: (ctx, input) => resetViews(repoOf(ctx), input),
  }),

  // --- issues -------------------------------------------------------------------------------
  define({
    name: 'issue.list', description: 'List issues, optionally filtered.',
    scope: 'repo', readOnly: true, surfaces: BOTH, cli: 'issue list', input: IssueListInput,
    handler: (ctx, input) => listIssues(repoOf(ctx), input, service(ctx)),
  }),
  define({
    name: 'issue.get', description: 'Show one issue, including children and progress for epics.',
    scope: 'repo', readOnly: true, surfaces: BOTH, cli: 'issue show', input: IssueRefInput,
    handler: (ctx, input) => getIssue(repoOf(ctx), input.ref, service(ctx)),
  }),
  define({
    name: 'issue.create', description: 'Create an issue.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'issue create', input: IssueCreateInput,
    handler: (ctx, input) => createIssue(repoOf(ctx), input, service(ctx)),
  }),
  define({
    name: 'issue.update', description: 'Update issue metadata or body.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'issue update', input: IssueUpdateInput,
    handler: (ctx, input) => updateIssue(repoOf(ctx), input, service(ctx)),
  }),
  define({
    name: 'issue.move', description: 'Change an issue status and/or position within its column.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'issue move', input: IssueMoveInput,
    handler: (ctx, input) => moveIssue(repoOf(ctx), input, service(ctx)),
  }),
  define({
    name: 'issue.delete', description: 'Delete an issue (requires the full id).',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'issue delete', input: IssueDeleteInput,
    handler: (ctx, input) => deleteIssue(repoOf(ctx), input),
  }),
  define({
    name: 'issue.check', description: 'Check or uncheck a checklist item in an issue.',
    scope: 'repo', readOnly: false, surfaces: BOTH, cli: 'issue check', input: IssueCheckInput,
    handler: (ctx, input) => checkItem(repoOf(ctx), input, service(ctx)),
  }),

  // --- board, validation, git ---------------------------------------------------------------
  define({
    name: 'board.get', description: 'Get the board: columns with their issues, per project.',
    scope: 'repo', readOnly: true, surfaces: BOTH, cli: 'board', input: BoardGetInput,
    handler: (ctx, input) => getBoard(repoOf(ctx), input),
  }),
  define({
    name: 'backlog.get', description: 'Get the backlog: open work as an ordered list grouped by status.',
    scope: 'repo', readOnly: true, surfaces: BOTH, cli: 'backlog', input: BacklogGetInput,
    handler: (ctx, input) => getBacklog(repoOf(ctx), input),
  }),
  define({
    name: 'validate', description: 'Check issue storage for problems.',
    scope: 'repo', readOnly: true, surfaces: BOTH, cli: 'validate', input: EmptyInput,
    handler: (ctx) => validateRepo(repoOf(ctx)),
  }),
  define({
    name: 'git.status', description: 'Current branch and uncommitted .gitboard changes (read-only).',
    scope: 'repo', readOnly: true, surfaces: BOTH, cli: 'status', input: EmptyInput,
    handler: (ctx) => getGitStatus(repoOf(ctx)),
  }),

  // --- agent skills (CLI only) --------------------------------------------------------------
  define({
    name: 'skills.install', description: 'Install the Gitboard agent skill.',
    scope: 'global', readOnly: false, surfaces: ['cli'], cli: 'skills install', input: SkillsInput,
    handler: (ctx, input) => installSkills({ cwd: cwdOf(ctx), ...input }),
  }),
  define({
    name: 'skills.sync', description: 'Update installed copies of the Gitboard agent skill.',
    scope: 'global', readOnly: false, surfaces: ['cli'], cli: 'skills sync', input: SkillsInput,
    handler: (ctx, input) => syncSkills({ cwd: cwdOf(ctx), ...input }),
  }),
  define({
    name: 'skills.status', description: 'Report the state of installed agent skills.',
    scope: 'global', readOnly: true, surfaces: ['cli'], cli: 'skills status', input: SkillsInput,
    handler: (ctx, input) => skillsStatus({ cwd: cwdOf(ctx), ...input }),
  }),
];

export function getOperation(name: string): Operation {
  const op = operations.find((candidate) => candidate.name === name);
  if (!op) throw new GitboardError('OPERATION_NOT_FOUND', `Unknown operation: ${name}`);
  return op;
}

export interface ExecuteOptions {
  /** Directory used to find the enclosing repository (CLI). */
  cwd?: string | undefined;
  /** Explicit repository: a registry id or name, or a path (CLI `--repo`, HTTP route parameter). */
  repo?: string | undefined;
  /** Restrict repo-scoped operations to registered repositories (HTTP server; ADR-b9d4018). */
  registeredOnly?: boolean | undefined;
}

export interface ExecuteResult<T = unknown> {
  data: T;
  warnings: string[];
}

/** The single entry point used by both the CLI and the HTTP server. */
export async function executeOperation(name: string, rawInput: unknown, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  const op = getOperation(name);
  const parsed = op.input.safeParse(rawInput ?? {});
  if (!parsed.success) throw new GitboardError('INVALID_INPUT', formatZodError(parsed.error), parsed.error.issues);

  const ctx: OperationContext = { cwd: options.cwd, warnings: [] };
  if (op.scope !== 'global') {
    const resolved = await resolveRepo({ repo: options.repo, cwd: options.cwd, registeredOnly: options.registeredOnly });
    ctx.repo = op.scope === 'repo' ? await requireInitialized(resolved) : resolved.repo;
  }
  const data = await (op.handler as (ctx: OperationContext, input: unknown) => Promise<unknown>)(ctx, parsed.data);
  return { data, warnings: ctx.warnings };
}

// Re-exported for adapters that need a pure-function view of column changes.
export { changeColumns };
