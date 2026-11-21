import { ActionMenu } from './ActionMenu';
import { InlineSelect } from './InlineSelect';
import { CopyButton } from './CopyButton';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Board, EpicColumnId, IssueDetail } from '../core/types';
import { api } from './api';
import { ApiError } from './client';
import { DeleteIssueDialog, errorMessage } from './Dialogs';
import { LinkedText, internalClick, useLinks } from './links';
import { Markdown } from './markdown';

const EPIC_COLUMN_LABELS: Record<EpicColumnId, string> = { key: 'Key', title: 'Title', status: 'Status', priority: 'Priority', labels: 'Labels' };

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
}

export function IssueDrawer({ variant = 'drawer', repoId, issueId, board, tick, onClose, onChanged }: Props) {
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
  const [addingLabel, setAddingLabel] = useState(false);
  const [draft, setDraft] = useState<string | null>(null); // body being edited
  const [confirmDelete, setConfirmDelete] = useState(false);
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
      if (event.key === 'Escape' && !confirmDelete && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmDelete]);

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
  const epicColumns: EpicColumnId[] = board?.epicColumns ?? ['key', 'title', 'status'];
  const statusKnown = columns.some((c) => c.id === issue.status);
  const epics = (board?.epics ?? []).filter((e) => e.id !== issue.id);
  const editing = draft !== null;
  const pagePath = links?.resolve(issue.ref) ?? null;
  const parentPath = issue.parentIssue ? (links?.resolve(issue.parentIssue.ref) ?? null) : null;

  const statusOptions = [
    ...(statusKnown ? [] : [{ value: issue.status, label: `${issue.status} (unknown)` }]),
    ...columns.map((c) => ({ value: c.id, label: c.name })),
  ];
  const priorityOptions = [
    { value: '', label: '(none)' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'urgent', label: 'Urgent' },
  ];
  const epicOptions = [{ value: '', label: '(none)' }, ...epics.map((e) => ({ value: e.id, label: e.title }))];
  const fieldsPanel = (
    <>
      <div className="fields">
        <InlineSelect label="Status" value={issue.status} options={statusOptions} onChange={(value) => void save({ status: value })} />
        <InlineSelect
          label="Priority"
          value={issue.priority ?? ''}
          options={priorityOptions}
          onChange={(value) => void save({ priority: value === '' ? null : value })}
        />
        {issue.type === 'story' && (
          <InlineSelect
            label="Epic"
            value={issue.parent ?? ''}
            options={epicOptions}
            onChange={(value) => void save({ parent: value === '' ? null : value })}
          />
        )}
      </div>

      <div className="labels">
        {issue.labels.map((label) => (
          <span key={label} className="chip removable">
            {label}
            <button aria-label={`Remove label ${label}`} onClick={() => void save({ removeLabels: [label] })}>×</button>
          </span>
        ))}
        {addingLabel ? (
          <input
            className="label-input"
            placeholder="Label name"
            aria-label="New label"
            autoFocus
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            onBlur={() => {
              setAddingLabel(false);
              setLabelInput('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && labelInput.trim() !== '') {
                void save({ addLabels: [labelInput.trim()] });
                setLabelInput('');
                setAddingLabel(false);
              } else if (e.key === 'Escape') {
                setAddingLabel(false);
                setLabelInput('');
              }
            }}
          />
        ) : (
          <button type="button" className="chip add-chip" onClick={() => setAddingLabel(true)}>+ Add label</button>
        )}
      </div>
    </>
  );
  const metaPanel = (
    <footer className="drawer-footer">
      <span className="muted small">
        id {issue.id} · created {new Date(issue.createdAt).toLocaleString()}
        {issue.updatedAt ? ` · updated ${new Date(issue.updatedAt).toLocaleString()}` : ''}
      </span>
    </footer>
  );

  return (
    <aside className={shell} aria-label="Issue details">
      <header className="drawer-header">
        {issue.parentIssue &&
          (parentPath !== null && links ? (
            <a className="ref issue-key" href={parentPath} title={issue.parentIssue.title} onClick={internalClick(links, parentPath)}>{issue.parentIssue.ref}</a>
          ) : (
            <span className="ref" title={issue.parentIssue.title}>{issue.parentIssue.ref}</span>
          ))}
        {issue.parentIssue && <span className="ref" aria-hidden="true">/</span>}
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
        <DeleteIssueDialog
          issueRef={issue.ref}
          title={issue.title}
          childCount={issue.children?.length ?? 0}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async (unlinkChildren) => {
            const ok = await guarded(() => api.deleteIssue(repoId, issue.id, unlinkChildren));
            if (ok) {
              onChanged();
              onClose();
            } else {
              setConfirmDelete(false); // the error or conflict banner explains why
            }
          }}
        />
      )}

      <div className={page ? 'drawer-body page-body' : 'drawer-body'}>
        <div className={page ? 'page-main' : 'contents'}>
          <input
            className="title-input"
            value={title}
            aria-label="Title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() !== '' && title !== issue.title && void save({ title })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />

          {!page && fieldsPanel}

          {issue.progress && (
            <section>
              <h4>Progress</h4>
              <div className="progress" aria-label={`${issue.progress.done} of ${issue.progress.total} done`}>
                <div style={{ width: issue.progress.total === 0 ? '0%' : `${(100 * issue.progress.done) / issue.progress.total}%` }} />
              </div>
              <p className="muted">{issue.progress.done} of {issue.progress.total} done</p>
              <table className="children-table">
              <thead>
                <tr>
                  {epicColumns.map((id) => (
                    <th key={id}>{EPIC_COLUMN_LABELS[id]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(issue.children ?? []).map((child) => {
                  const path = links?.resolve(child.ref) ?? null;
                  const cell: Record<EpicColumnId, ReactNode> = {
                    key:
                      path !== null && links ? (
                        <a className="ref issue-key" href={path} onClick={internalClick(links, path)}>{child.ref}</a>
                      ) : (
                        <span className="ref">{child.ref}</span>
                      ),
                    title: <LinkedText text={child.title} />,
                    status: <span className="chip">{columns.find((c) => c.id === child.status)?.name ?? child.status}</span>,
                    priority: child.priority ? <span className={`badge priority-${child.priority}`}>{child.priority}</span> : null,
                    labels: child.labels.length > 0 ? <div className="chip-row">{child.labels.map((label) => <span key={label} className="chip">{label}</span>)}</div> : null,
                  };
                  return (
                    <tr key={child.id}>
                      {epicColumns.map((id) => (
                        <td key={id} className={`col-${id}`}>{cell[id]}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
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

        </div>
        {page ? (
          <div className="page-side">
            {fieldsPanel}
            {metaPanel}
          </div>
        ) : (
          metaPanel
        )}
      </div>
    </aside>
  );
}
