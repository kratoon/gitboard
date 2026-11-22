import { CopyButton } from './CopyButton';
import { LinkedText } from './links';
import { DndContext, DragOverlay, closestCorners, useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { Backlog as BacklogData, BoardColumn, Column, Issue } from '../core/types';
import { useColumnDnd, type Placement } from './dnd';

export interface IssuePatch {
  status?: string;
  priority?: string | null;
}

interface BacklogProps {
  backlog: BacklogData;
  /** Every status of the project, including the done column, for the inline status picker. */
  statuses: Column[];
  visible: Set<string> | null;
  epicTitles: Map<string, string>;
  includeDone: boolean;
  onIncludeDone: (include: boolean) => void;
  onOpen: (id: string) => void;
  onMove: (id: string, status: string, placement: Placement) => void;
  onUpdate: (issue: Issue, patch: IssuePatch) => void;
  onCreate: (status: string, title: string) => Promise<void>;
}

// Controls inside a row must neither open the issue nor start a drag.
const isolate = {
  onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  onKeyDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
};

function Row({
  issue,
  epicTitle,
  statuses,
  onOpen,
  onUpdate,
}: {
  issue: Issue;
  epicTitle: string | undefined;
  statuses: Column[];
  onOpen: (id: string) => void;
  onUpdate: (issue: Issue, patch: IssuePatch) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: issue.id,
    data: { type: 'card', status: issue.status },
  });
  const done = issue.checklist.filter((c) => c.checked).length;
  return (
    <article
      ref={setNodeRef}
      className="row"
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      onClick={() => onOpen(issue.id)}
      {...attributes}
      {...listeners}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Enter') onOpen(issue.id);
        else listeners?.onKeyDown?.(event);
      }}
    >
      <span className="ref">{issue.ref}</span>
      <CopyButton value={issue.ref} label={`Copy issue key ${issue.ref}`} />
      <span className="row-title"><LinkedText text={issue.title} /></span>
      <span className="row-meta">
        {epicTitle && <span className="chip epic" title="Epic">{epicTitle}</span>}
        {issue.labels.map((label) => (
          <span key={label} className="chip">{label}</span>
        ))}
        {issue.checklist.length > 0 && (
          <span className="check-count" title="Checklist">☑ {done}/{issue.checklist.length}</span>
        )}
      </span>
      <select
        className="row-select"
        aria-label={`Priority of ${issue.ref}`}
        value={issue.priority ?? ''}
        {...isolate}
        onChange={(e) => onUpdate(issue, { priority: e.target.value === '' ? null : e.target.value })}
      >
        <option value="">No priority</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="urgent">Urgent</option>
      </select>
      <select
        className="row-select"
        aria-label={`Status of ${issue.ref}`}
        value={issue.status}
        {...isolate}
        onChange={(e) => onUpdate(issue, { status: e.target.value })}
      >
        {statuses.some((s) => s.id === issue.status) ? null : <option value={issue.status}>{issue.status} (unknown)</option>}
        {statuses.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </article>
  );
}

function QuickAdd({ status, onCreate }: { status: string; onCreate: (status: string, title: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  if (!open) {
    return (
      <button className="quick-add-button" onClick={() => setOpen(true)}>
        ＋ Add issue
      </button>
    );
  }
  const submit = async () => {
    const value = title.trim();
    if (value === '' || busy) return;
    setBusy(true);
    try {
      await onCreate(status, value);
      setTitle('');
      input.current?.focus(); // keep adding
    } catch {
      /* the caller shows the error; the text stays so nothing is lost */
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="quick-add">
      <input
        ref={input}
        autoFocus
        value={title}
        placeholder="What needs to be done? Enter to add, Esc to close"
        aria-label="New issue title"
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') {
            setOpen(false);
            setTitle('');
          }
        }}
      />
    </div>
  );
}

function Section({
  section,
  visible,
  epicTitles,
  statuses,
  collapsed,
  onToggle,
  onOpen,
  onUpdate,
  onCreate,
}: {
  section: BoardColumn;
  visible: Set<string> | null;
  epicTitles: Map<string, string>;
  statuses: Column[];
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
  onUpdate: (issue: Issue, patch: IssuePatch) => void;
  onCreate: (status: string, title: string) => Promise<void>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${section.id}`, data: { type: 'column', status: section.id } });
  const shown = visible ? section.issues.filter((issue) => visible.has(issue.id)) : section.issues;
  return (
    <section ref={setNodeRef} className={`bl-section${isOver ? ' over' : ''}`} aria-label={section.name}>
      <header className="bl-header" onClick={onToggle} role="button" tabIndex={0} aria-expanded={!collapsed} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}>
        <span className="chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <h3>{section.name}</h3>
        {section.done && <span className="done-mark" title="Done column" aria-label="Done column">✓</span>}
        <span className="count">{visible ? `${shown.length} / ${section.issues.length}` : section.issues.length}</span>
      </header>
      {!collapsed && (
        <div className="bl-rows">
          <SortableContext items={shown.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
            {shown.map((issue) => (
              <Row key={issue.id} issue={issue} epicTitle={issue.parent ? epicTitles.get(issue.parent) : undefined} statuses={statuses} onOpen={onOpen} onUpdate={onUpdate} />
            ))}
          </SortableContext>
          {shown.length === 0 && <div className="empty-column">{visible ? 'No matches' : 'Nothing here. Drop an issue or add one.'}</div>}
          <QuickAdd status={section.id} onCreate={onCreate} />
        </div>
      )}
    </section>
  );
}

export function Backlog({ backlog, statuses, visible, epicTitles, includeDone, onIncludeDone, onOpen, onMove, onUpdate, onCreate }: BacklogProps) {
  const dnd = useColumnDnd(backlog.sections, visible, onMove);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const hasDoneColumn = backlog.doneStatuses.length > 0;
  const open = backlog.sections.reduce((sum, s) => sum + s.issues.length, 0);

  return (
    <div className="backlog">
      <div className="bl-bar">
        <span className="muted">
          {open} {includeDone ? 'issues' : 'open issues'}
        </span>
        {hasDoneColumn && (
          <label className="inline-check">
            <input type="checkbox" checked={includeDone} onChange={(e) => onIncludeDone(e.target.checked)} />
            Show done{!includeDone && backlog.hiddenCount > 0 ? ` (${backlog.hiddenCount})` : ''}
          </label>
        )}
      </div>
      <DndContext sensors={dnd.sensors} collisionDetection={closestCorners} onDragStart={dnd.onDragStart} onDragEnd={dnd.onDragEnd} onDragCancel={dnd.onDragCancel}>
        {backlog.sections.map((section) => (
          <Section
            key={section.id}
            section={section}
            visible={visible}
            epicTitles={epicTitles}
            statuses={statuses}
            collapsed={collapsed.has(section.id)}
            onToggle={() => toggle(section.id)}
            onOpen={onOpen}
            onUpdate={onUpdate}
            onCreate={onCreate}
          />
        ))}
        <DragOverlay>
          {dnd.dragging ? (
            <article className="row dragging">
              <span className="ref">{dnd.dragging.ref}</span>
              <span className="row-title">{dnd.dragging.title}</span>
            </article>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
