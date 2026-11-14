import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';
import type { Board as BoardData, BoardColumn, Issue } from '../core/types';

export interface Placement {
  before?: string;
  after?: string;
  position?: 'top' | 'bottom';
}

interface BoardProps {
  board: BoardData;
  /** Issue ids that match the active filters, or null when nothing is filtered. */
  visible: Set<string> | null;
  epicTitles: Map<string, string>;
  onOpen: (id: string) => void;
  onMove: (id: string, status: string, placement: Placement) => void;
}

function CardBody({ issue, epicTitle }: { issue: Issue; epicTitle: string | undefined }) {
  const done = issue.checklist.filter((c) => c.checked).length;
  return (
    <>
      <div className="card-top">
        <span className="ref">{issue.ref}</span>
        {issue.priority && <span className={`badge priority-${issue.priority}`}>{issue.priority}</span>}
      </div>
      <div className="card-title">{issue.title}</div>
      {(issue.labels.length > 0 || epicTitle || issue.checklist.length > 0) && (
        <div className="card-meta">
          {epicTitle && <span className="chip epic" title="Epic">{epicTitle}</span>}
          {issue.labels.map((label) => (
            <span key={label} className="chip">{label}</span>
          ))}
          {issue.checklist.length > 0 && (
            <span className="check-count" title="Checklist">
              ☑ {done}/{issue.checklist.length}
            </span>
          )}
        </div>
      )}
    </>
  );
}

function Card({ issue, epicTitle, onOpen }: { issue: Issue; epicTitle: string | undefined; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: issue.id,
    data: { type: 'card', status: issue.status },
  });
  return (
    <article
      ref={setNodeRef}
      className="card"
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      onClick={() => onOpen(issue.id)}
      {...attributes}
      {...listeners}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(issue.id);
        else listeners?.onKeyDown?.(event);
      }}
    >
      <CardBody issue={issue} epicTitle={epicTitle} />
    </article>
  );
}

function Column({
  column,
  visible,
  epicTitles,
  onOpen,
}: {
  column: BoardColumn;
  visible: Set<string> | null;
  epicTitles: Map<string, string>;
  onOpen: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column.id}`, data: { type: 'column', status: column.id } });
  const shown = visible ? column.issues.filter((issue) => visible.has(issue.id)) : column.issues;
  return (
    <section className={`column${isOver ? ' over' : ''}`} aria-label={column.name}>
      <header className="column-header">
        <h3>{column.name}</h3>
        <span className="count" title={visible ? 'matching / total' : 'issues'}>
          {visible ? `${shown.length} / ${column.issues.length}` : column.issues.length}
        </span>
      </header>
      <div ref={setNodeRef} className="cards">
        <SortableContext items={shown.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
          {shown.map((issue) => (
            <Card key={issue.id} issue={issue} epicTitle={issue.parent ? epicTitles.get(issue.parent) : undefined} onOpen={onOpen} />
          ))}
        </SortableContext>
        {shown.length === 0 && <div className="empty-column">{visible ? 'No matches' : 'Drop issues here'}</div>}
      </div>
    </section>
  );
}

export function Board({ board, visible, epicTitles, onOpen, onMove }: BoardProps) {
  const [dragging, setDragging] = useState<Issue | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columnOf = (issueId: string): BoardColumn | undefined => board.columns.find((c) => c.issues.some((i) => i.id === issueId));

  const handleStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setDragging(columnOf(id)?.issues.find((i) => i.id === id) ?? null);
  };

  const handleEnd = (event: DragEndEvent) => {
    setDragging(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const from = columnOf(activeId);
    if (!from) return;

    if (overId.startsWith('col:')) {
      onMove(activeId, overId.slice(4), { position: 'bottom' });
      return;
    }
    const target = columnOf(overId);
    if (!target || activeId === overId) return;
    const list = visible ? target.issues.filter((i) => visible.has(i.id)) : target.issues;
    const overIndex = list.findIndex((i) => i.id === overId);
    const activeIndex = list.findIndex((i) => i.id === activeId);
    const movingDown = target.id === from.id && activeIndex >= 0 && activeIndex < overIndex;
    onMove(activeId, target.id, movingDown ? { after: overId } : { before: overId });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={handleStart} onDragEnd={handleEnd} onDragCancel={() => setDragging(null)}>
      <div className="columns">
        {board.columns.map((column) => (
          <Column key={column.id} column={column} visible={visible} epicTitles={epicTitles} onOpen={onOpen} />
        ))}
      </div>
      <DragOverlay>
        {dragging ? (
          <article className="card dragging">
            <CardBody issue={dragging} epicTitle={dragging.parent ? epicTitles.get(dragging.parent) : undefined} />
          </article>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
