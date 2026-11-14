import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Board as BoardData, GitStatus, RepoInfo } from '../core/types';
import { api } from './api';
import { Board, type Placement } from './Board';
import { AddRepoDialog, ColumnsDialog, CreateIssueDialog, CreateProjectDialog, RemoveRepoDialog, errorMessage } from './Dialogs';
import { IssueDrawer } from './IssueDrawer';
import { applyMove } from './optimistic';

type DialogName = 'repo' | 'remove' | 'issue' | 'project' | 'columns' | null;

const store = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage can be unavailable; the UI works without it */
    }
  },
};

interface Filters {
  q: string;
  priority: string;
  label: string;
  parent: string;
}
const NO_FILTERS: Filters = { q: '', priority: '', label: '', parent: '' };

export function App() {
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [repoId, setRepoId] = useState<string | null>(() => store.get('gitboard.repo'));
  const [boards, setBoards] = useState<BoardData[] | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [visible, setVisible] = useState<Set<string> | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showEpics, setShowEpics] = useState(true);

  const repo = useMemo(() => repos?.find((r) => r.id === repoId) ?? repos?.[0], [repos, repoId]);
  const ready = repo !== undefined && repo.exists && repo.initialized;

  const fail = useCallback((error: unknown) => {
    setToast(errorMessage(error));
    window.setTimeout(() => setToast(null), 6000);
  }, []);

  const refreshRepos = useCallback(async () => {
    try {
      setRepos(await api.listRepos());
    } catch (error) {
      fail(error);
      setRepos([]);
    }
  }, [fail]);

  const reload = useCallback(async () => {
    if (!repo || !ready) return;
    try {
      const [board, status] = await Promise.all([api.board(repo.id), api.gitStatus(repo.id)]);
      setBoards(board);
      setGit(status);
    } catch (error) {
      fail(error);
    }
  }, [repo, ready, fail]);

  useEffect(() => {
    void refreshRepos();
  }, [refreshRepos]);

  useEffect(() => {
    if (repo) store.set('gitboard.repo', repo.id);
    setBoards(null);
    setGit(null);
    setVisible(null);
    setOpenId(null);
    setFilters(NO_FILTERS);
    setProjectKey(repo ? store.get(`gitboard.project.${repo.id}`) : null);
  }, [repo?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Reflect changes made outside the app (agents, editors, git checkout).
  useEffect(() => {
    if (!repo || !ready) return;
    return api.subscribe(repo.id, () => {
      setTick((t) => t + 1);
      void reload();
    });
  }, [repo?.id, ready, reload]);

  const board = boards?.find((b) => b.project.key === projectKey) ?? boards?.[0];
  useEffect(() => {
    if (board && repo) store.set(`gitboard.project.${repo.id}`, board.project.key);
  }, [board?.project.key, repo?.id]);

  const filtersActive = Object.values(filters).some((value) => value !== '');
  useEffect(() => {
    if (!repo || !ready || !board) return;
    if (!filtersActive) {
      setVisible(null);
      return;
    }
    const handle = window.setTimeout(() => {
      api
        .listIssues(repo.id, {
          project: board.project.key,
          ...(filters.q ? { q: filters.q } : {}),
          ...(filters.priority ? { priority: filters.priority as 'low' } : {}),
          ...(filters.label ? { label: filters.label } : {}),
          ...(filters.parent ? { parent: filters.parent } : {}),
        })
        .then((list) => setVisible(new Set(list.map((issue) => issue.id))), fail);
    }, 180);
    return () => window.clearTimeout(handle);
  }, [repo?.id, ready, board?.project.key, filters, filtersActive, tick, fail]);

  const epicTitles = useMemo(() => new Map((board?.epics ?? []).map((e) => [e.id, e.title])), [board]);
  const labels = useMemo(
    () => [...new Set((board?.columns ?? []).flatMap((c) => c.issues.flatMap((i) => i.labels)))].sort(),
    [board],
  );

  async function handleMove(id: string, status: string, placement: Placement) {
    if (!repo) return;
    setBoards((previous) => previous && applyMove(previous, id, status, placement));
    try {
      await api.moveIssue(repo.id, { ref: id, status, ...placement });
    } catch (error) {
      fail(error);
    } finally {
      await reload();
    }
  }

  const header = (
    <header className="topbar">
      <div className="brand">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="var(--accent)" />
          <rect x="6" y="7" width="5" height="18" rx="1.5" fill="#fff" />
          <rect x="13.5" y="7" width="5" height="12" rx="1.5" fill="#fff" />
          <rect x="21" y="7" width="5" height="8" rx="1.5" fill="#fff" />
        </svg>
        Gitboard
      </div>
      <div className="repo-picker">
        <select
          aria-label="Repository"
          value={repo?.id ?? ''}
          onChange={(e) => setRepoId(e.target.value)}
          disabled={!repos || repos.length === 0}
        >
          {(repos ?? []).map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
          {(!repos || repos.length === 0) && <option value="">No repositories</option>}
        </select>
        <button onClick={() => setDialog('repo')}>Add repository</button>
        {repo && <button onClick={() => setDialog('remove')} title="Remove from Gitboard (does not delete the repository)">Remove</button>}
      </div>
      <span className="spacer" />
      {git?.isGitRepo && (
        <span className="git-chip" title={git.dirty ? `${git.changes} uncommitted change(s) under .gitboard/. Gitboard never commits for you.` : 'No uncommitted .gitboard changes'}>
          ⎇ {git.branch}
          {git.detached ? ' (detached)' : ''}
          {git.dirty && <span className="dirty"> ● {git.changes} uncommitted</span>}
        </span>
      )}
    </header>
  );

  if (repos === null) return <div className="app">{header}<p className="pad muted">Loading…</p></div>;

  if (repos.length === 0) {
    return (
      <div className="app">
        {header}
        <main className="welcome">
          <h1>Welcome to Gitboard</h1>
          <p>Issues live as Markdown files in your Git repositories. Add a repository to see its board.</p>
          <button className="primary" onClick={() => setDialog('repo')}>Add a repository</button>
          <p className="hint">You can also use the command line: <code>gitboard init</code> in any repository.</p>
        </main>
        {dialog === 'repo' && (
          <AddRepoDialog
            onClose={() => setDialog(null)}
            onAdded={(added) => {
              setDialog(null);
              setRepoId(added.id);
              void refreshRepos();
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="app">
      {header}
      {toast && <div className="toast" role="alert">{toast}</div>}

      {repo && !repo.exists && (
        <main className="welcome">
          <h1>{repo.name} is missing</h1>
          <p>The folder <code>{repo.path}</code> no longer exists. Remove it from Gitboard or restore the folder.</p>
        </main>
      )}

      {repo && repo.exists && !repo.initialized && (
        <main className="welcome">
          <h1>Set up {repo.name}</h1>
          <p>This repository does not use Gitboard yet. Initialising creates a <code>.gitboard/</code> folder with a default project; commit it to share the board.</p>
          <button
            className="primary"
            onClick={() =>
              void api.initRepo(repo.id).then(refreshRepos, fail)
            }
          >
            Initialise Gitboard
          </button>
        </main>
      )}

      {ready && repo && (
        <>
          <div className="toolbar">
            <nav className="tabs" aria-label="Projects">
              {(boards ?? []).map((b) => (
                <button
                  key={b.project.key}
                  className={`tab${b.project.key === board?.project.key ? ' active' : ''}`}
                  onClick={() => {
                    setProjectKey(b.project.key);
                    setFilters(NO_FILTERS);
                  }}
                  title={b.project.name}
                >
                  <strong>{b.project.key}</strong> {b.project.name !== b.project.key && <span className="muted">{b.project.name}</span>}
                </button>
              ))}
              <button className="tab add" onClick={() => setDialog('project')} title="New project">＋</button>
            </nav>
            <span className="spacer" />
            <input
              className="search"
              type="search"
              placeholder="Search issues…"
              aria-label="Search issues"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
            <select aria-label="Filter by priority" value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
              <option value="">Any priority</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <select aria-label="Filter by label" value={filters.label} onChange={(e) => setFilters({ ...filters, label: e.target.value })}>
              <option value="">Any label</option>
              {labels.map((label) => (
                <option key={label} value={label}>{label}</option>
              ))}
            </select>
            <select aria-label="Filter by epic" value={filters.parent} onChange={(e) => setFilters({ ...filters, parent: e.target.value })}>
              <option value="">Any epic</option>
              {(board?.epics ?? []).map((epic) => (
                <option key={epic.id} value={epic.id}>{epic.title}</option>
              ))}
            </select>
            <button onClick={() => setFilters(NO_FILTERS)} disabled={!filtersActive} title={filtersActive ? 'Clear search and filters' : 'No search or filters to clear'}>
              Clear
            </button>
            <button onClick={() => setDialog('columns')} disabled={!board} title="Edit columns">Columns</button>
            <button className="primary" onClick={() => setDialog('issue')} disabled={!board}>New issue</button>
          </div>

          {!boards && <p className="pad muted">Loading board…</p>}
          {boards && boards.length === 0 && (
            <main className="welcome">
              <h1>No projects yet</h1>
              <p>Create a project to start adding issues.</p>
              <button className="primary" onClick={() => setDialog('project')}>New project</button>
            </main>
          )}
          {board && (
            <div className="workspace">
              <Board board={board} visible={visible} epicTitles={epicTitles} onOpen={setOpenId} onMove={(id, status, placement) => void handleMove(id, status, placement)} />
              {showEpics ? (
                <aside className="epics">
                <header>
                  <h3>Epics</h3>
                  <button onClick={() => setShowEpics(false)} aria-label="Hide epics" title="Hide epics">›</button>
                </header>
                <>
                    {board.epics.length === 0 && <p className="muted small">No epics. Create an issue of type Epic to group stories.</p>}
                    {board.epics.map((epic) => (
                      <div key={epic.id} className={`epic-item${filters.parent === epic.id ? ' selected' : ''}`}>
                        <button className="link" onClick={() => setOpenId(epic.id)}>{epic.title}</button>
                        <div className="progress" aria-label={`${epic.progress.done} of ${epic.progress.total} done`}>
                          <div style={{ width: epic.progress.total === 0 ? '0%' : `${(100 * epic.progress.done) / epic.progress.total}%` }} />
                        </div>
                        <div className="epic-foot">
                          <span className="muted small">{epic.progress.done}/{epic.progress.total} done · {epic.status}</span>
                          <button className="link small" onClick={() => setFilters({ ...filters, parent: filters.parent === epic.id ? '' : epic.id })}>
                            {filters.parent === epic.id ? 'Clear filter' : 'Filter'}
                          </button>
                        </div>
                      </div>
                    ))}
                </>
                </aside>
              ) : (
                <button className="epics-tab" onClick={() => setShowEpics(true)} aria-label="Show epics" title="Show epics">
                  <span className="chevron" aria-hidden="true">‹</span>
                  <span className="vertical">Epics ({board.epics.length})</span>
                </button>
              )}
            </div>
          )}

          {openId && (
            <IssueDrawer
              repoId={repo.id}
              issueId={openId}
              board={board}
              tick={tick}
              onClose={() => setOpenId(null)}
              onChanged={() => void reload()}
              onFilterEpic={(id) => {
                setFilters({ ...NO_FILTERS, parent: id });
                setOpenId(null);
              }}
            />
          )}
        </>
      )}

      {dialog === 'repo' && (
        <AddRepoDialog
          onClose={() => setDialog(null)}
          onAdded={(added) => {
            setDialog(null);
            setRepoId(added.id);
            void refreshRepos();
          }}
        />
      )}
      {dialog === 'remove' && repo && (
        <RemoveRepoDialog
          repo={repo}
          onClose={() => setDialog(null)}
          onRemoved={() => {
            setDialog(null);
            setRepoId(null);
            void refreshRepos();
          }}
        />
      )}
      {dialog === 'issue' && repo && board && (
        <CreateIssueDialog
          repoId={repo.id}
          board={board}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog(null);
            void reload();
            setOpenId(id);
          }}
        />
      )}
      {dialog === 'project' && repo && (
        <CreateProjectDialog
          repoId={repo.id}
          onClose={() => setDialog(null)}
          onCreated={(key) => {
            setDialog(null);
            setProjectKey(key);
            void reload();
          }}
        />
      )}
      {dialog === 'columns' && repo && board && (
        <ColumnsDialog repoId={repo.id} board={board} onClose={() => setDialog(null)} onSaved={() => void reload()} />
      )}
    </div>
  );
}
