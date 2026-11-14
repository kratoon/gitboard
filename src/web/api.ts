/** Typed wrappers over the operation names. No logic: each function is one operation call. */
import type {
  Board,
  ColumnsChangeResult,
  ColumnsInfo,
  DeleteResult,
  GitStatus,
  Issue,
  IssueCheckInput,
  IssueCreateInput,
  IssueDetail,
  IssueListInput,
  IssueMoveInput,
  IssueUpdateInput,
  MoveResult,
  ProjectInfo,
  RepoInfo,
} from '../core/types';
import { createHttpClient, type GitboardClient } from './client';

export function createApi(client: GitboardClient) {
  const global = async <T>(op: string, input: unknown = {}) => (await client.call<T>(op, input)).data;
  const repo = async <T>(repoId: string, op: string, input: unknown = {}) => (await client.call<T>(op, input, repoId)).data;

  return {
    subscribe: client.subscribe.bind(client),

    listRepos: () => global<RepoInfo[]>('repo.list'),
    addRepo: (source: string, name?: string) => global<RepoInfo>('repo.add', { source, name }),
    removeRepo: (repoRef: string) => global<{ id: string; name: string }>('repo.remove', { repo: repoRef }),
    initRepo: (repoId: string) => repo<{ root: string; projectKey?: string; created: boolean; registered: boolean }>(repoId, 'repo.init'),

    board: (repoId: string) => repo<Board[]>(repoId, 'board.get'),
    gitStatus: (repoId: string) => repo<GitStatus>(repoId, 'git.status'),
    listIssues: (repoId: string, filter: IssueListInput) => repo<Issue[]>(repoId, 'issue.list', filter),
    getIssue: (repoId: string, ref: string) => repo<IssueDetail>(repoId, 'issue.get', { ref }),
    createIssue: (repoId: string, input: IssueCreateInput) => repo<Issue>(repoId, 'issue.create', input),
    updateIssue: (repoId: string, input: IssueUpdateInput) => repo<Issue>(repoId, 'issue.update', input),
    moveIssue: (repoId: string, input: IssueMoveInput) => repo<MoveResult>(repoId, 'issue.move', input),
    checkItem: (repoId: string, input: IssueCheckInput) => repo<Issue>(repoId, 'issue.check', input),
    deleteIssue: (repoId: string, id: string, unlinkChildren?: boolean) => repo<DeleteResult>(repoId, 'issue.delete', { id, unlinkChildren }),

    createProject: (repoId: string, key: string, name: string) => repo<ProjectInfo>(repoId, 'project.create', { key, name }),
    showColumns: (repoId: string, project?: string) => repo<ColumnsInfo>(repoId, 'columns.show', { project }),
    setColumns: (repoId: string, columns: string[], project?: string, remap?: Record<string, string>) =>
      repo<ColumnsChangeResult>(repoId, 'columns.set', { columns, project, remap }),
    resetColumns: (repoId: string, project?: string, remap?: Record<string, string>) =>
      repo<ColumnsChangeResult>(repoId, 'columns.reset', { project, remap }),
  };
}

export type Api = ReturnType<typeof createApi>;
export const api: Api = createApi(createHttpClient());
