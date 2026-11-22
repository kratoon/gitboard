import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Board, ColumnsInfo, RepoInfo, ViewId, ViewsInfo } from '../core/types';
import { api } from './api';
import { ApiError } from './client';

export const errorMessage = (error: unknown): string => (error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error));

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

const csv = (text: string) => text.split(',').map((part) => part.trim()).filter(Boolean);

export function AddRepoDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (repo: RepoInfo) => void }) {
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    const repo = await api.addRepo(source.trim(), name.trim() || undefined);
    onAdded(repo);
  });
  return (
    <Modal title="Add repository" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Local path or SSH URL
          <input autoFocus value={source} onChange={(e) => setSource(e.target.value)} placeholder="/path/to/repo  or  git@github.com:org/repo.git" required />
        </label>
        <p className="hint">SSH remotes are cloned into a Gitboard-managed folder using your SSH setup. Hooks are not run.</p>
        <label>
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || source.trim() === ''}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function RemoveRepoDialog({ repo, onClose, onRemoved }: { repo: RepoInfo; onClose: () => void; onRemoved: () => void }) {
  const { busy, error, submit } = useSubmit(async () => {
    await api.removeRepo(repo.id);
    onRemoved();
  });
  return (
    <Modal title="Remove repository" onClose={onClose}>
      <form onSubmit={submit}>
        <p>
          Remove <strong>{repo.name}</strong> from Gitboard? The repository and its issues are not deleted.
        </p>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="danger" disabled={busy}>Remove</button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteIssueDialog({
  issueRef,
  title,
  childCount,
  onClose,
  onConfirm,
}: {
  issueRef: string;
  title: string;
  childCount: number;
  onClose: () => void;
  /** Deletes the issue; the caller reports failures itself. */
  onConfirm: (unlinkChildren: boolean) => Promise<void>;
}) {
  const [unlink, setUnlink] = useState(false);
  const { busy, submit } = useSubmit(() => onConfirm(unlink));
  return (
    <Modal title="Delete issue" onClose={onClose}>
      <form onSubmit={submit}>
        <p>
          Delete <strong>{issueRef}</strong> {title}? Its Markdown file is removed. This cannot be undone from Gitboard, but Git keeps the history.
        </p>
        {childCount > 0 && (
          <label>
            <input type="checkbox" checked={unlink} onChange={(e) => setUnlink(e.target.checked)} /> Detach its {childCount} child issue(s)
          </label>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="danger" disabled={busy} autoFocus>Delete</button>
        </div>
      </form>
    </Modal>
  );
}

export function CreateIssueDialog({
  repoId,
  board,
  onClose,
  onCreated,
}: {
  repoId: string;
  board: Board;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<'story' | 'epic'>('story');
  const [priority, setPriority] = useState('');
  const [labels, setLabels] = useState('');
  const [parent, setParent] = useState('');
  const [status, setStatus] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    const issue = await api.createIssue(repoId, {
      title,
      project: board.project.key,
      type,
      ...(status ? { status } : {}),
      ...(priority ? { priority: priority as 'low' } : {}),
      ...(labels.trim() ? { labels: csv(labels) } : {}),
      ...(type === 'story' && parent ? { parent } : {}),
    });
    onCreated(issue.id);
  });
  return (
    <Modal title={`New issue in ${board.project.key}`} onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <div className="row">
          <label>
            Type
            <select value={type} onChange={(e) => setType(e.target.value as 'story' | 'epic')}>
              <option value="story">Story</option>
              <option value="epic">Epic</option>
            </select>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">(none)</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">(first column)</option>
              {board.columns.map((column) => (
                <option key={column.id} value={column.id}>{column.name}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Labels (comma separated)
          <input value={labels} onChange={(e) => setLabels(e.target.value)} />
        </label>
        {type === 'story' && board.epics.length > 0 && (
          <label>
            Epic
            <select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">(none)</option>
              {board.epics.map((epic) => (
                <option key={epic.id} value={epic.id}>{epic.title}</option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || title.trim() === ''}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function CreateProjectDialog({ repoId, onClose, onCreated }: { repoId: string; onClose: () => void; onCreated: (key: string) => void }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    const project = await api.createProject(repoId, key, name || key);
    onCreated(project.key);
  });
  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Key
          <input autoFocus value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="AUTH" maxLength={10} required />
        </label>
        <p className="hint">2–10 characters: an uppercase letter followed by uppercase letters or digits. The key cannot be changed later.</p>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Authentication" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || key === ''}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ColumnsDialog({ repoId, board, onClose, onSaved }: { repoId: string; board: Board; onClose: () => void; onSaved: () => void }) {
  const project = board.project.key;
  const [info, setInfo] = useState<ColumnsInfo | null>(null);
  const [text, setText] = useState('');
  const [doneText, setDoneText] = useState('');
  const [remap, setRemap] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.showColumns(repoId, project).then((loaded) => {
      setInfo(loaded);
      setText(loaded.columns.map((c) => c.id).join(', '));
      setDoneText(loaded.columns.filter((c) => c.done).map((c) => c.id).join(', '));
    }, (err: unknown) => setError(errorMessage(err)));
  }, [repoId, project]);

  // Saving states every column's done flag explicitly, so what you see here is what is stored.
  const columnObjects = () => {
    const doneIds = csv(doneText);
    return csv(text).map((id) => ({ id, done: doneIds.includes(id) }));
  };

  const remapObject = (): Record<string, string> | undefined => {
    const pairs = csv(remap).map((pair) => pair.split('=').map((s) => s.trim()));
    return pairs.length === 0 ? undefined : Object.fromEntries(pairs.map(([from, to]) => [from ?? '', to ?? '']));
  };
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={`Columns for ${project}`} onClose={onClose}>
      <p className="hint">
        Currently from: <strong>{info?.source ?? '…'}</strong>. A project override replaces the repository columns, which replace the built-in To Do / In Progress / Done.
      </p>
      <label>
        Column ids, in order (comma separated)
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label>
        Done columns (comma separated, from the ids above)
        <input value={doneText} onChange={(e) => setDoneText(e.target.value)} placeholder="done" />
      </label>
      <p className="hint">Done columns are hidden in the backlog (unless "Show done" is ticked) and count as finished in epic progress.</p>
      <label>
        Move issues from removed columns (old=new, comma separated)
        <input value={remap} onChange={(e) => setRemap(e.target.value)} placeholder="in-progress=todo" />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions wrap">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" onClick={() => void run(() => api.resetColumns(repoId, project, remapObject()))} disabled={info?.source !== 'project'}>
          Reset project override
        </button>
        <button type="button" onClick={() => void run(() => api.setColumns(repoId, columnObjects(), undefined, remapObject()))}>Save for whole repository</button>
        <button type="button" className="primary" onClick={() => void run(() => api.setColumns(repoId, columnObjects(), project, remapObject()))}>
          Save for {project}
        </button>
      </div>
    </Modal>
  );
}

/** Labels for every view the UI can render. `Record<ViewId, ...>` makes the compiler flag a missing one. */
export const VIEW_LABELS: Record<ViewId, { label: string; hint: string }> = {
  kanban: { label: 'Board', hint: 'Kanban columns with drag and drop' },
  backlog: { label: 'Backlog', hint: 'Open work as an ordered list, grouped by status' },
};
const ALL_VIEWS = Object.keys(VIEW_LABELS) as ViewId[];

export function ViewsDialog({ repoId, board, onClose, onSaved }: { repoId: string; board: Board; onClose: () => void; onSaved: () => void }) {
  const project = board.project.key;
  const [info, setInfo] = useState<ViewsInfo | null>(null);
  const [enabled, setEnabled] = useState<ViewId[]>([]);
  const [first, setFirst] = useState<ViewId | ''>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.showViews(repoId, project).then((loaded) => {
      setInfo(loaded);
      setEnabled(loaded.views);
      setFirst(loaded.views[0] ?? '');
    }, (err: unknown) => setError(errorMessage(err)));
  }, [repoId, project]);

  const toggle = (id: ViewId) => {
    const next = enabled.includes(id) ? enabled.filter((v) => v !== id) : ALL_VIEWS.filter((v) => v === id || enabled.includes(v));
    setEnabled(next);
    if (!next.includes(first as ViewId)) setFirst(next[0] ?? '');
  };
  // The first entry is the default view.
  const ordered = first === '' ? enabled : [first, ...enabled.filter((v) => v !== first)];

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={`Views for ${project}`} onClose={onClose}>
      <p className="hint">
        Currently from: <strong>{info?.source ?? '…'}</strong>. A project setting replaces the repository setting, which replaces the built-in default (all views).
      </p>
      <fieldset className="view-options">
        {ALL_VIEWS.map((id) => (
          <label key={id} className="check-row">
            <input type="checkbox" checked={enabled.includes(id)} onChange={() => toggle(id)} />
            <span>
              <strong>{VIEW_LABELS[id].label}</strong>
              <span className="muted small"> {VIEW_LABELS[id].hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        Default view
        <select value={first} onChange={(e) => setFirst(e.target.value as ViewId)} disabled={enabled.length === 0}>
          {enabled.map((id) => (
            <option key={id} value={id}>{VIEW_LABELS[id].label}</option>
          ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions wrap">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" onClick={() => void run(() => api.resetViews(repoId, project))} disabled={info?.source !== 'project'}>
          Reset project setting
        </button>
        <button type="button" disabled={enabled.length === 0} onClick={() => void run(() => api.setViews(repoId, ordered))}>
          Save for whole repository
        </button>
        <button type="button" className="primary" disabled={enabled.length === 0} onClick={() => void run(() => api.setViews(repoId, ordered, project))}>
          Save for {project}
        </button>
      </div>
    </Modal>
  );
}

