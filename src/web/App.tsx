import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveSlug, type Backlog as BacklogData, type Board as BoardData, type GitStatus, type Issue, type IssueType, type RepoInfo, type ViewId } from '../core/types';
import { api } from './api';
import { Backlog, type IssuePatch } from './Backlog';
import { Board } from './Board';
import type { Placement } from './dnd';
import {
  AddRepoDialog,
  ColumnsDialog,
  CreateIssueDialog,
  CreateProjectDialog,
  RemoveRepoDialog,
  VIEW_LABELS,
  ViewsDialog,
  errorMessage,
} from './Dialogs';
import { IssueDrawer } from './IssueDrawer';
import { LinksProvider, type Links, type ResolvedRef } from './links';
import { applyMove, moveInColumns } from './optimistic';
import { cameFromApp, issuePath, repoPath, useRoute } from './route';

type DialogName = 'repo' | 'remove' | 'issue' | 'project' | 'columns' | 'views' | null;

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
  const [route, navigate] = useRoute();
  const [repoId, setRepoId] = useState<string | null>(() => store.get('gitboard.repo'));
  const [boards, setBoards] = useState<BoardData[] | null>(null);
  const [backlogs, setBacklogs] = useState<BacklogData[] | null>(null);
  const [includeDone, setIncludeDone] = useState(false);
  const [viewChoice, setViewChoice] = useState<ViewId | null>(null);
  // What the next reload should fetch, kept in refs so `reload` stays stable.
  const wantBacklog = useRef(false);
  const wantDone = useRef(false);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [visible, setVisible] = useState<Set<string> | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showEpics, setShowEpics] = useState(true);

  // The URL decides the repository when it names one; otherwise the remembered choice does.
  const slugMatch = useMemo(() => (route.slug !== null && repos ? resolveSlug(repos, route.slug) : null), [repos, route.slug]);
  const repo = useMemo(
    () => (route.slug !== null ? (slugMatch?.kind === 'found' ? slugMatch.repo : undefined) : (repos?.find((r) => r.id === repoId) ?? repos?.[0])),
    [repos, repoId, route.slug, slugMatch],
  );
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
      const [board, status, backlog] = await Promise.all([
        api.board(repo.id),
        api.gitStatus(repo.id),
        wantBacklog.current ? api.backlog(repo.id, wantDone.current) : Promise.resolve(null),
      ]);
      setBoards(board);
      setGit(status);
      if (backlog) setBacklogs(backlog);
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
    setBacklogs(null);
    setGit(null);
    setVisible(null);
    setOpenId(null);
    setFilters(NO_FILTERS);
    setProjectKey(repo ? store.get(`gitboard.project.${repo.id}`) : null);
  }, [repo?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Make the address bar name the repository, so the URL can be shared.
  useEffect(() => {
    if (route.slug === null && repo) navigate(repoPath(repo.slug), { replace: true });
  }, [route.slug, repo?.slug, navigate]);

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

  // The server says which views a project offers (config per repo, overridable per project); the first
  // one is the default. The user's last pick is remembered per project when it is still enabled.
  const viewKey = repo && board ? `gitboard.view.${repo.id}.${board.project.key}` : null;
  useEffect(() => {
    setViewChoice(viewKey ? (store.get(viewKey) as ViewId | null) : null);
  }, [viewKey]);
  const enabledViews: ViewId[] = board?.views.views ?? ['kanban'];
  const view: ViewId = viewChoice !== null && enabledViews.includes(viewChoice) ? viewChoice : (enabledViews[0] ?? 'kanban');
  const chooseView = (next: ViewId) => {
    setViewChoice(next);
    if (viewKey) store.set(viewKey, next);
  };
  wantBacklog.current = view === 'backlog';
  wantDone.current = includeDone;
  useEffect(() => {
    if (view === 'backlog') void reload();
  }, [view, includeDone, reload]);
  const backlog = backlogs?.find((b) => b.project.key === board?.project.key);

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

  // Issue keys found in text link only when they match an issue of this repository.
  const links = useMemo<Links | null>(() => {
    if (!repo || !boards) return null;
    const issues = new Map<string, Array<{ id: string; ref: string; title: string; type: IssueType }>>();
    const byPath = new Map<string, ResolvedRef>();
    for (const b of boards) {
      const all = [...b.columns.flatMap((c) => c.issues), ...b.epics];
      issues.set(b.project.key, all.map((i) => ({ id: i.id, ref: i.ref, title: i.title, type: i.type })));
      for (const i of all) byPath.set(issuePath(repo.slug, i.ref), { path: issuePath(repo.slug, i.ref), ref: i.ref, title: i.title, type: i.type });
    }
    return {
      navigate,
      resolve: (text) => {
        const dash = text.indexOf('-');
        const found = issues.get(text.slice(0, dash))?.find((i) => i.id.startsWith(text.slice(dash + 1)));
        return found ? { path: issuePath(repo.slug, found.ref), ref: found.ref, title: found.title, type: found.type } : null;
      },
      byPath: (path) => byPath.get(path) ?? null,
    };
  }, [repo, boards, navigate]);

  const closePage = useCallback(() => {
    if (cameFromApp()) window.history.back();
    else if (repo) navigate(repoPath(repo.slug));
  }, [repo, navigate]);

  const epicTitles = useMemo(() => new Map((board?.epics ?? []).map((e) => [e.id, e.title])), [board]);
  const labels = useMemo(
    () => [...new Set((board?.columns ?? []).flatMap((c) => c.issues.flatMap((i) => i.labels)))].sort(),
    [board],
  );

  async function handleMove(id: string, status: string, placement: Placement) {
    if (!repo) return;
    setBoards((previous) => previous && applyMove(previous, id, status, placement));
    setBacklogs((previous) => previous?.map((b) => ({ ...b, sections: moveInColumns(b.sections, id, status, placement) })) ?? null);
    try {
      await api.moveIssue(repo.id, { ref: id, status, ...placement });
    } catch (error) {
      fail(error);
    } finally {
      await reload();
    }
  }

  // Inline edits in the backlog rows; `expectedHash` makes a stale row fail instead of overwriting.
  async function handleUpdate(issue: Issue, patch: IssuePatch) {
    if (!repo) return;
    try {
      await api.updateIssue(repo.id, {
        ref: issue.id,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority as 'low' | null } : {}),
        expectedHash: issue.hash,
      });
    } catch (error) {
      fail(error);
    } finally {
      await reload();
    }
  }

  async function handleQuickCreate(status: string, title: string) {
    if (!repo || !board) return;
    try {
      await api.createIssue(repo.id, { title, project: board.project.key, status });
    } catch (error) {
      fail(error);
      throw error; // keep what the user typed
    } finally {
      await reload();
    }
  }

  const header = (
    <header className="topbar">
      <a
        className="brand"
        href={repo ? repoPath(repo.slug) : '/'}
        title="Back to the board"
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          navigate(repo ? repoPath(repo.slug) : '/');
        }}
      >
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="var(--accent)" />
          <rect x="6" y="7" width="5" height="18" rx="1.5" fill="#fff" />
          <rect x="13.5" y="7" width="5" height="12" rx="1.5" fill="#fff" />
          <rect x="21" y="7" width="5" height="8" rx="1.5" fill="#fff" />
        </svg>
        Gitboard
      </a>
      <div className="repo-picker">
        <select
          aria-label="Repository"
          value={repo?.id ?? ''}
          onChange={(e) => {
            const next = repos?.find((r) => r.id === e.target.value);
            setRepoId(e.target.value);
            if (next) navigate(repoPath(next.slug));
          }}
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
              void refreshRepos().then(() => navigate(repoPath(added.slug)));
            }}
          />
        )}
      </div>
    );
  }

  return (
    <LinksProvider value={links}>
    <div className="app">
      {header}
      {toast && <div className="toast" role="alert">{toast}</div>}

      {route.slug !== null && !repo && (
        <main className="welcome">
          {slugMatch?.kind === 'ambiguous' ? (
            <>
              <h1>{route.slug} matches several repositories</h1>
              <p>Use the provider in the address, for example:</p>
              <ul className="plain">
                {slugMatch.repos.map((r) => (
                  <li key={r.id}><a href={repoPath(r.slug)} onClick={(e) => { e.preventDefault(); navigate(repoPath(r.slug)); }}>{r.slug}</a> <span className="muted">({r.path})</span></li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <h1>Repository not found</h1>
              <p>No repository registered in Gitboard has the address <code>{route.slug}</code>. Add it with <em>Add repository</em>, then open the link again.</p>
            </>
          )}
          <button onClick={() => navigate('/', { replace: true })}>Go to my repositories</button>
        </main>
      )}

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

      {ready && repo && route.ref !== null && (
        <IssueDrawer
          variant="page"
          repoId={repo.id}
          issueId={route.ref}
          board={board}
          tick={tick}
          onClose={closePage}
          onChanged={() => void reload()}
        />
      )}

      {ready && repo && route.ref === null && (
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
            {enabledViews.length > 1 && (
              <div className="view-switch" role="tablist" aria-label="View">
                {enabledViews.map((id) => (
                  <button key={id} role="tab" aria-selected={id === view} className={`seg${id === view ? ' active' : ''}`} onClick={() => chooseView(id)}>
                    {VIEW_LABELS[id].label}
                  </button>
                ))}
              </div>
            )}
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
            <button onClick={() => setDialog('views')} disabled={!board} title="Choose which views this project offers">Views</button>
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
              {view === 'backlog' ? (
                backlog ? (
                  <Backlog
                    backlog={backlog}
                    statuses={board.columns}
                    visible={visible}
                    epicTitles={epicTitles}
                    includeDone={includeDone}
                    onIncludeDone={setIncludeDone}
                    onOpen={setOpenId}
                    onMove={(id, status, placement) => void handleMove(id, status, placement)}
                    onUpdate={(issue, patch) => void handleUpdate(issue, patch)}
                    onCreate={handleQuickCreate}
                  />
                ) : (
                  <p className="pad muted">Loading backlog…</p>
                )
              ) : (
                <Board board={board} visible={visible} epicTitles={epicTitles} onOpen={setOpenId} onMove={(id, status, placement) => void handleMove(id, status, placement)} />
              )}
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
            void refreshRepos().then(() => navigate(repoPath(added.slug)));
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
            navigate('/', { replace: true });
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
      {dialog === 'views' && repo && board && (
        <ViewsDialog repoId={repo.id} board={board} onClose={() => setDialog(null)} onSaved={() => void reload()} />
      )}
      {dialog === 'columns' && repo && board && (
        <ColumnsDialog repoId={repo.id} board={board} onClose={() => setDialog(null)} onSaved={() => void reload()} />
      )}
    </div>
    </LinksProvider>
  );
}
