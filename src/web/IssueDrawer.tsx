import { ActionMenu } from './ActionMenu';
import { CopyButton } from './CopyButton';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Board, IssueDetail } from '../core/types';
import { api } from './api';
import { ApiError } from './client';
import { errorMessage } from './Dialogs';
import { LinkedText, internalClick, useLinks } from './links';
import { Markdown } from './markdown';

interface Props {
  /** `drawer` is the side panel; `page` shows the same content as the issue's own page (FEAT-130c757). */
  variant?: 'drawer' | 'page';
  repoId: string;
  issueId: string;
  board: Board | undefined;
  /** Increments whenever files change on disk. */
  tick: number;
  onClose: () => void;
  onChanged: () => void;
  onFilterEpic: (id: string) => void;
}

export function IssueDrawer({ variant = 'drawer', repoId, issueId, board, tick, onClose, onChanged, onFilterEpic }: Props) {
  const links = useLinks();
  const page = variant === 'page';
  const shell = page ? 'drawer issue-page' : 'drawer';
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [title, setTitle] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [draft, setDraft] = useState<string | null>(null); // body being edited
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [unlink, setUnlink] = useState(false);
  const draftBase = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await api.getIssue(repoId, issueId);
      setLoadError(null);
      setIssue((previous) => {
        if (draft !== null && previous && previous.hash !== loaded.hash && loaded.hash !== draftBase.current) setExternalChange(true);
        return loaded;
      });
      setTitle((current) => (current === '' || draft === null ? loaded.title : current));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [repoId, issueId, draft]);

  useEffect(() => {
    setIssue(null);
    setDraft(null);
    setConflict(false);
    setExternalChange(false);
    setError(null);
    setConfirmDelete(false);
  }, [issueId]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function guarded(action: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') setConflict(true);
      else setError(errorMessage(err));
      return false;
    }
  }

  async function save(patch: Record<string, unknown>) {
    if (!issue) return;
    const ok = await guarded(() => api.updateIssue(repoId, { ref: issue.id, ...patch, expectedHash: issue.hash }));
    if (ok) {
      await load();
      onChanged();
    }
  }

  if (loadError && !issue) {
    return (
      <aside className={shell}>
        <header className="drawer-header">
          <button onClick={onClose}>Close</button>
        </header>
        <p className="error pad">{loadError}</p>
      </aside>
    );
  }
  if (!issue) {
    return (
      <aside className={shell}>
        <p className="pad muted">Loading…</p>
      </aside>
    );
  }

  const columns = board?.columns ?? [];
  const statusKnown = columns.some((c) => c.id === issue.status);
  const epics = (board?.epics ?? []).filter((e) => e.id !== issue.id);
  const editing = draft !== null;
  const pagePath = links?.resolve(issue.ref) ?? null;

  return (
    <aside className={shell} aria-label="Issue details">
      <header className="drawer-header">
        {!page && pagePath !== null && links ? (
          <a className="ref issue-key" href={pagePath} title="Open this issue on its own page" onClick={internalClick(links, pagePath)}>{issue.ref}</a>
        ) : (
          <span className="ref">{issue.ref}</span>
        )}
        <CopyButton value={issue.ref} label={`Copy reference ${issue.ref}`} />
        <span className={`chip ${issue.type === 'epic' ? 'epic' : ''}`}>{issue.type}</span>
        <span className="spacer" />
        <ActionMenu actions={[{ label: 'Delete issue…', danger: true, onSelect: () => setConfirmDelete(true) }]} />
        {!page && <button onClick={onClose} aria-label="Close">✕</button>}
      </header>

      {(conflict || externalChange) && (
        <div className="banner warn">
          <span>
            {conflict ? 'This issue changed on disk since you opened it, so your change was not saved.' : 'This issue was changed on disk while you were editing.'}
          </span>
          <button
            onClick={() => {
              setConflict(false);
              setExternalChange(false);
              setDraft(null);
              void load();
            }}
          >
            Reload{editing ? ' (discard my edits)' : ''}
          </button>
        </div>
      )}
      {error && <div className="banner error-banner">{error}</div>}
      {confirmDelete && (
        <div className="confirm">
          <p>Delete this issue? Its Markdown file is removed.</p>
          {(issue.children?.length ?? 0) > 0 && (
            <label>
              <input type="checkbox" checked={unlink} onChange={(e) => setUnlink(e.target.checked)} /> Detach its {issue.children?.length} child issue(s)
            </label>
          )}
          <div className="actions">
            <button onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button
              className="danger"
              onClick={async () => {
                const ok = await guarded(() => api.deleteIssue(repoId, issue.id, unlink));
                if (ok) {
                  onChanged();
                  onClose();
                }
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}

      <div className="drawer-body">
        <input
          className="title-input"
          value={title}
          aria-label="Title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() !== '' && title !== issue.title && void save({ title })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />

        <div className="fields">
          <label>
            Status
            <select value={issue.status} onChange={(e) => void save({ status: e.target.value })}>
              {!statusKnown && <option value={issue.status}>{issue.status} (unknown)</option>}
              {columns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={issue.priority ?? ''} onChange={(e) => void save({ priority: e.target.value === '' ? null : e.target.value })}>
              <option value="">(none)</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          {issue.type === 'story' && (
            <label>
              Epic
              <select value={issue.parent ?? ''} onChange={(e) => void save({ parent: e.target.value === '' ? null : e.target.value })}>
                <option value="">(none)</option>
                {epics.map((epic) => (
                  <option key={epic.id} value={epic.id}>{epic.title}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="labels">
          {issue.labels.map((label) => (
            <span key={label} className="chip removable">
              {label}
              <button aria-label={`Remove label ${label}`} onClick={() => void save({ removeLabels: [label] })}>×</button>
            </span>
          ))}
          <input
            className="label-input"
            placeholder="Add label…"
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && labelInput.trim() !== '') {
                void save({ addLabels: [labelInput.trim()] });
                setLabelInput('');
              }
            }}
          />
        </div>

        {issue.progress && (
          <section>
            <h4>Progress</h4>
            <div className="progress" aria-label={`${issue.progress.done} of ${issue.progress.total} done`}>
              <div style={{ width: issue.progress.total === 0 ? '0%' : `${(100 * issue.progress.done) / issue.progress.total}%` }} />
            </div>
            <p className="muted">{issue.progress.done} of {issue.progress.total} done</p>
            <ul className="children">
              {(issue.children ?? []).map((child) => (
                <li key={child.id}>
                  <span className="ref">{child.ref}</span> <LinkedText text={child.title} /> <span className="chip">{child.status}</span>
                </li>
              ))}
            </ul>
            <button onClick={() => onFilterEpic(issue.id)}>Show only these on the board</button>
          </section>
        )}

        {issue.checklist.length > 0 && (
          <section>
            <h4>Checklist</h4>
            <ul className="checklist">
              {issue.checklist.map((item) => (
                <li key={item.index}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.checked}
                      disabled={editing}
                      onChange={() =>
                        void guarded(() => api.checkItem(repoId, { ref: issue.id, index: item.index, checked: !item.checked, expectedHash: issue.hash })).then(async (ok) => {
                          if (ok) {
                            await load();
                            onChanged();
                          }
                        })
                      }
                    />
                    <span className={item.checked ? 'done-text' : ''}>{item.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <div className="section-head">
            <h4>Description</h4>
            {!editing && (
              <button
                onClick={() => {
                  draftBase.current = issue.hash;
                  setDraft(issue.body);
                }}
              >
                Edit
              </button>
            )}
          </div>
          {editing ? (
            <>
              <textarea className="body-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows={14} aria-label="Markdown body" />
              <div className="actions">
                <button onClick={() => setDraft(null)}>Cancel</button>
                <button
                  className="primary"
                  onClick={async () => {
                    const ok = await guarded(() => api.updateIssue(repoId, { ref: issue.id, body: draft, expectedHash: issue.hash }));
                    if (ok) {
                      setDraft(null);
                      await load();
                      onChanged();
                    }
                  }}
                >
                  Save
                </button>
              </div>
            </>
          ) : issue.body.trim() === '' ? (
            <p className="muted">No description.</p>
          ) : (
            <Markdown source={issue.body} />
          )}
        </section>

        <footer className="drawer-footer">
          <span className="muted small">
            id {issue.id} · created {new Date(issue.createdAt).toLocaleString()}
            {issue.updatedAt ? ` · updated ${new Date(issue.updatedAt).toLocaleString()}` : ''}
          </span>
        </footer>
      </div>
    </aside>
  );
}
