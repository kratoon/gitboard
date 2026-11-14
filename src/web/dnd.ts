import { KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useState } from 'react';
import type { BoardColumn, Issue } from '../core/types';

/** Where a dragged card should land, expressed the way the `issue.move` operation takes it. */
export interface Placement {
  before?: string;
  after?: string;
  position?: 'top' | 'bottom';
}

/**
 * Shared drag-and-drop behaviour for every view that shows issues in status groups (board columns and
 * backlog sections). It only translates a drop into an `issue.move` request; the server decides the order.
 * Droppable groups use the id `col:<status>`; cards use their issue id.
 */
export function useColumnDnd(
  columns: BoardColumn[],
  visible: Set<string> | null,
  onMove: (id: string, status: string, placement: Placement) => void,
) {
  const [dragging, setDragging] = useState<Issue | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columnOf = (issueId: string): BoardColumn | undefined => columns.find((c) => c.issues.some((i) => i.id === issueId));

  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setDragging(columnOf(id)?.issues.find((i) => i.id === id) ?? null);
  };

  const onDragEnd = (event: DragEndEvent) => {
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

  return { sensors, dragging, onDragStart, onDragEnd, onDragCancel: () => setDragging(null) };
}
